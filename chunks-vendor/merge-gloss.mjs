import fs from "node:fs";

// Fold all hand-authored gloss batches (chunks-vendor/gloss-*.tsv) into chunks.pool.tsv.
// Gloss row: key \t zh \t en \t type [ \t labels(,分开) ]
// Pool row:  key \t src \t zh \t en \t type \t labels(,分开)
const norm = (s) =>
  s.toLowerCase().replace(/[{}"]/g, "").replace(/[\u2019\u02BC']/g, "'").replace(/\s+/g, " ").trim();

const FIX_TYPE = { proverb: "idiom", "phrasal verb": "phrasal", idiomatic: "idiom" };
const normType = (t) => {
  t = (t || "").trim().toLowerCase();
  if (FIX_TYPE[t]) return FIX_TYPE[t];
  return ["idiom", "phrasal", "collocation", "slang"].includes(t) ? t : "";
};

const gloss = new Map();
for (const f of fs.readdirSync("chunks-vendor").filter((n) => /^gloss-.*\.tsv$/.test(n))) {
  for (const line of fs.readFileSync(`chunks-vendor/${f}`, "utf8").split("\n").filter(Boolean)) {
    const [k, zh, en, type, labels] = line.split("\t");
    if (!k || !zh) continue;
    gloss.set(norm(k), {
      zh: zh.trim(),
      en: (en || "").trim(),
      type: normType(type),
      labels: (labels || "").trim(),
    });
  }
}

const rows = fs
  .readFileSync("chunks-vendor/chunks.pool.tsv", "utf8")
  .split("\n")
  .filter(Boolean)
  .map((l) => l.split("\t"));

let filled = 0;
const seen = new Set();
const out = [];
for (const r of rows) {
  let [key, src, zh, en, type, labels] = r;
  const nk = norm(key);
  if (seen.has(nk)) continue; // drop quote-variant dup
  seen.add(nk);
  if ((zh === "__LLM_PENDING__" || !zh) && gloss.has(nk)) {
    const g = gloss.get(nk);
    zh = g.zh; en = g.en; type = g.type || type; labels = g.labels || labels;
    filled++;
  }
  out.push([key, src, zh || "__LLM_PENDING__", en || "", type || "", labels || ""].join("\t"));
}
fs.writeFileSync("chunks-vendor/chunks.pool.tsv", out.join("\n") + "\n");

const pending = out.filter((l) => l.split("\t")[2] === "__LLM_PENDING__");
const realPending = pending.filter((l) => l.split("\t")[1] !== "moby-pos");
console.log(`本批折入 ${filled} 条 | 池子 ${out.length} 行 | 仍待译 ${realPending.length} (真词块)`);
const typed = out.filter((l) => l.split("\t")[4]).length;
console.log(`已有 type 的行: ${typed}/${out.length}`);
