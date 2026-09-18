#!/usr/bin/env node
/**
 * One-time build of the bundled word-details asset.
 *
 * Sources (both open, see src/data/word-details.SOURCES.md):
 *  - ECDICT (MIT)              — multi-sense Chinese translations, POS,
 *                                Collins/Oxford tags, frequency ranks, word forms
 *  - Tatoeba (CC BY 2.0 FR)    — English example sentences with Chinese translations
 *
 * Output: src/data/word-details.json — one row per headword already present in
 * src/data/word-levels.json, so the app only ships words it can actually show.
 *
 * Usage: node scripts/build-dict.mjs [--max-examples 2] [--min-freq 20000]
 */

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CACHE = join(ROOT, "scripts/.cache");
const LEVElS = join(ROOT, "src/data/word-levels.json");
const OUT = join(ROOT, "src/data/word-details.json");
const SOURCES = join(ROOT, "src/data/word-details.SOURCES.md");

const args = process.argv.slice(2);
const argValue = (flag, dflt) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const MAX_EXAMPLES = Number(argValue("--max-examples", "2"));
/** Only keep detail rows for words within this frequency rank (0 = all). */
const MIN_FREQ = Number(argValue("--min-freq", "0"));

const ECDICT_URL =
  "https://ghproxy.net/https://raw.githubusercontent.com/skywind3000/ECDICT/master/ecdict.csv";
const TATOEBA = "https://downloads.tatoeba.org/exports/per_language";
const FILES = [
  { url: ECDICT_URL, file: "ecdict.csv" },
  { url: `${TATOEBA}/eng/eng_sentences.tsv.bz2`, file: "eng_sentences.tsv.bz2" },
  {
    url: `${TATOEBA}/eng/eng-cmn_links.tsv.bz2`,
    file: "eng-cmn_links.tsv.bz2",
  },
  {
    url: `${TATOEBA}/cmn/cmn_sentences.tsv.bz2`,
    file: "cmn_sentences.tsv.bz2",
  },
];

function log(...parts) {
  console.log("[build-dict]", ...parts);
}

function download() {
  mkdirSync(CACHE, { recursive: true });
  for (const { url, file } of FILES) {
    const path = join(CACHE, file);
    if (existsSync(path) && statSync(path).size > 0) {
      log("cached", file, `${(statSync(path).size / 1e6).toFixed(1)}MB`);
      continue;
    }
    log("downloading", url);
    execFileSync("curl", ["-sS", "--max-time", "1800", "-o", path, url], {
      stdio: "inherit",
    });
    log("saved", file, `${(statSync(path).size / 1e6).toFixed(1)}MB`);
  }
}

/** Decompress a .bz2 next to the source (cached) and return the text path. */
function decompress(file) {
  const bz2 = join(CACHE, file);
  const plain = bz2.replace(/\.bz2$/, "");
  if (existsSync(plain) && statSync(plain).size > 0) return plain;
  log("bunzip2", file);
  execFileSync("bash", ["-c", `bzip2 -dc "${bz2}" > "${plain}"`], {
    stdio: "inherit",
  });
  return plain;
}

/** Minimal RFC4180 CSV parser (quoted fields may contain newlines/commas). */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      quoted = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (ch !== "\r") {
      field += ch;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function parseEcdict(targets) {
  const path = join(CACHE, "ecdict.csv");
  log("parsing ECDICT…");
  const rows = parseCsv(readFileSync(path, "utf8"));
  const header = rows[0];
  const idx = Object.fromEntries(header.map((h, i) => [h, i]));
  const out = new Map();
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const word = (row[idx.word] ?? "").trim().toLowerCase();
    if (!word || !targets.has(word) || out.has(word)) continue;
    const senses = (row[idx.translation] ?? "")
      .split("\n")
      .map((s) => s.replace(/\s+/g, " ").trim())
      .filter(Boolean);
    const exchange = (row[idx.exchange] ?? "").trim();
    // `0:lemma` in exchange is the base form ECDICT already knows.
    const lemma = exchange
      .split("/")
      .find((part) => part.startsWith("0:"))
      ?.slice(2)
      .trim();
    const rank = Number(row[idx.frq]) || Number(row[idx.bnc]) || 0;
    out.set(word, {
      senses,
      phonetic: (row[idx.phonetic] ?? "").trim(),
      pos: (row[idx.pos] ?? "").trim(),
      collins: Number(row[idx.collins]) || 0,
      oxford: Number(row[idx.oxford]) || 0,
      rank,
      lemma: lemma || "",
    });
  }
  log("ECDICT matched", out.size, "of", targets.size, "headwords");
  return out;
}

function readSentenceFile(path) {
  const map = new Map();
  const text = readFileSync(path, "utf8");
  for (const line of text.split("\n")) {
    if (!line) continue;
    const tab = line.indexOf("\t");
    if (tab < 0) continue;
    map.set(line.slice(0, tab), line.slice(tab + 1));
  }
  return map;
}

const WORD_RE = /[A-Za-z][A-Za-z'-]*/g;

/** Examples per headword from Tatoeba English↔Chinese pairs. */
function buildExamples(targets) {
  log("parsing Tatoeba…");
  const eng = readSentenceFile(decompress("eng_sentences.tsv.bz2"));
  const cmn = readSentenceFile(decompress("cmn_sentences.tsv.bz2"));
  const links = readFileSync(
    decompress("eng-cmn_links.tsv.bz2"),
    "utf8",
  ).split("\n");

  const examples = new Map(); // word -> [{ en, zh }]
  let pairs = 0;

  for (const line of links) {
    if (!line) continue;
    const [a, b] = line.split("\t");
    const en = eng.get(a);
    const zh = cmn.get(b);
    if (!en || !zh) continue;
    pairs++;
    const words = en.toLowerCase().match(WORD_RE) ?? [];
    const wordCount = words.length;
    // Short, complete sentences make better examples.
    if (wordCount < 4 || wordCount > 22) continue;
    const seen = new Set();
    for (const raw of words) {
      if (seen.has(raw) || !targets.has(raw)) continue;
      seen.add(raw);
      const list = examples.get(raw) ?? [];
      if (list.length >= MAX_EXAMPLES * 3) continue;
      if (list.some((ex) => ex.en === en)) continue;
      list.push({ en, zh });
      examples.set(raw, list);
    }
  }
  log("Tatoeba pairs", pairs, "| words with examples", examples.size);

  for (const [word, list] of examples) {
    list.sort((x, y) => x.en.length - y.en.length);
    examples.set(word, list.slice(0, MAX_EXAMPLES));
  }
  return examples;
}

function main() {
  const levels = JSON.parse(readFileSync(LEVElS, "utf8"));
  const targets = new Set(levels.map((row) => String(row[0]).toLowerCase()));
  log("headwords:", targets.size);

  download();
  const details = parseEcdict(targets);
  const examples = buildExamples(targets);

  // Row: [word, senses(\n), phonetic, pos, collins, oxford, rank, lemma, ex…]
  const rows = [];
  let withExamples = 0;
  for (const word of targets) {
    const d = details.get(word);
    const ex = examples.get(word) ?? [];
    if (ex.length > 0) withExamples++;
    if (!d && ex.length === 0) continue;
    if (MIN_FREQ > 0 && d && d.rank > MIN_FREQ) continue;
    const flat = [];
    for (const e of ex) flat.push(e.en, e.zh);
    rows.push([
      word,
      (d?.senses ?? []).join("\n"),
      d?.phonetic ?? "",
      d?.pos ?? "",
      d?.collins ?? 0,
      d?.oxford ?? 0,
      d?.rank ?? 0,
      d?.lemma ?? "",
      ...flat,
    ]);
  }
  rows.sort((a, b) => a[0].localeCompare(b[0]));

  writeFileSync(OUT, JSON.stringify(rows));
  const size = statSync(OUT).size;
  log(
    "wrote",
    OUT,
    `${rows.length} rows`,
    `${(size / 1e6).toFixed(2)}MB`,
    `| ${withExamples} words with examples`,
  );

  writeFileSync(
    SOURCES,
    `# word-details.json 数据来源与许可

本文件由 \`node scripts/build-dict.mjs\` 生成，合并以下两个开放数据源：

## ECDICT
- 仓库：https://github.com/skywind3000/ECDICT
- 许可：MIT
- 用途：多义中文释义、词性、柯林斯星级、牛津 3000/5000、BNC/COCA 词频、词形变化（lemma）
- 字段来源：\`ecdict.csv\`（word / phonetic / definition / translation / pos / collins / oxford / tag / bnc / frq / exchange）

## Tatoeba
- 站点：https://tatoeba.org  ·  下载：https://downloads.tatoeba.org/exports/
- 许可：CC BY 2.0 FR（部分句子 CC0 1.0）— 使用需署名
- 用途：英文例句 + 中文对照翻译（eng_sentences / cmn_sentences / eng-cmn_links）

如需重新生成，请保留上述署名信息。
`,
  );
}

main();
