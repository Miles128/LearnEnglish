import fs from "node:fs";

const norm = (s) =>
  s.trim().toLowerCase().replace(/[\u2019\u02BC']/g, "'").replace(/\s+/g, " ");

// RFC4180 CSV parser (same strategy as scripts/build-dict.mjs)
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
    if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (ch !== "\r") field += ch;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

// 1) ECDICT: key(contains space) -> Chinese translation (MIT source, safe to copy)
const ecdict = fs.readFileSync("scripts/.cache/ecdict.csv", "utf8");
const rows = parseCsv(ecdict);
const header = rows[0];
const iw = header.indexOf("word");
const it = header.indexOf("translation");
const ec = new Map();
for (let i = 1; i < rows.length; i++) {
  const r = rows[i];
  const w = r[iw];
  const t = r[it];
  if (!w || !t) continue;
  if (!w.includes(" ")) continue;
  const k = norm(w);
  const zh = t.replace(/\s+/g, " ").trim();
  if (zh && !ec.has(k)) ec.set(k, zh);
}
console.log("ECDICT 带空格词组映射:", ec.size);

// 2) Merge the three vendor pools into one key set, tracking sources
const out = new Map();
function add(k, src) {
  k = norm(k);
  if (k.length < 3 || /\d/.test(k)) return;
  const cur = out.get(k);
  if (cur) {
    if (!cur.src.includes(src)) cur.src += "+" + src;
  } else {
    out.set(k, { key: k, src });
  }
}

const wec = JSON.parse(fs.readFileSync("chunks-vendor/wec_phrasal.json", "utf8"));
for (const k of Object.keys(wec)) add(k, "wec-phrasal"); // membership only (no license)

for (const line of fs
  .readFileSync("chunks-vendor/baiango_idioms.csv", "utf8")
  .split(/\r?\n/)) {
  let s = line.trim();
  if (!s) continue;
  s = s.replace(/^"/, "").replace(/"$/, ""); // strip CSV wrapper quotes
  const parts = s.split(">>");
  if (parts.length < 2) continue;
  const idiom = parts[0].replace(/^\{/, "").replace(/\}$/, "").trim();
  if (idiom.split(/\s+/).length > 8) continue; // drop full proverbs, keep chunks
  add(idiom, "baiango-idiom");
}

for (const line of fs.readFileSync("chunks-vendor/mobypos.txt", "utf8").split("\n")) {
  const ph = line.split("\\")[0].trim();
  if (!ph) continue;
  const toks = ph.split(/\s+/);
  if (toks.length < 2 || toks.length > 5) continue;
  if (!toks.every((t) => /^[a-z][a-z'-]{1,19}$/.test(t))) continue;
  add(ph, "moby-pos");
}

// 3) Attach ECDICT Chinese where available; mark the rest as LLM-PENDING
let hit = 0;
const pool = [];
for (const { key, src } of out.values()) {
  const zh = ec.get(key) || "";
  if (zh) hit++;
  pool.push({ key, src, zh });
}
pool.sort(
  (a, b) => (a.zh ? 0 : 1) - (b.zh ? 0 : 1) || a.key.localeCompare(b.key),
);
fs.writeFileSync(
  "chunks-vendor/chunks.pool.tsv",
  pool.map((r) => [r.key, r.src, r.zh || "__LLM_PENDING__"].join("\t")).join("\n") +
    "\n",
);

const gaps = pool.filter((r) => !r.zh);
const gapBySrc = {};
for (const g of gaps) for (const s of g.src.split("+")) gapBySrc[s] = (gapBySrc[s] || 0) + 1;

console.log("池子总数:", pool.length, "| 命中ECDICT中文:", hit, "| 缺口:", gaps.length);
console.log("缺口按来源:", gapBySrc);
console.log("\n=== 缺口抽样: baiango-idiom (前8) ===");
for (const g of gaps.filter((x) => x.src.includes("baiango")).slice(0, 8))
  console.log(`${g.key}\t<${g.src}>`);
console.log("\n=== 缺口抽样: moby-pos only (前20, 未挂ECDICT中文) ===");
for (const g of gaps.filter((x) => x.src === "moby-pos").slice(0, 20))
  console.log(`${g.key}`);

// list the pure-English-source gaps (idioms) that most deserve LLM gloss
const idiomGaps = gaps.filter((g) => g.src.includes("baiango"));
fs.writeFileSync(
  "chunks-vendor/llm-gloss-request.txt",
  gaps.map((g) => g.key).join("\n") + "\n",
);
console.log("\n待 LLM 补义清单 -> chunks-vendor/llm-gloss-request.txt 条数:", gaps.length);
