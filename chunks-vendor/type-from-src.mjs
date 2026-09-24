import fs from "node:fs";

// Derive type from provenance for the real pool (wec=phrasal, baiango=idiom, else collocation).
// Never overwrites a type I already hand-authored.
const rows = fs.readFileSync("chunks-vendor/chunks.pool.tsv", "utf8").split("\n").filter(Boolean).map((l) => l.split("\t"));
let set = 0;
for (const r of rows) {
  let [key, src, zh, en, type, labels] = r;
  if (type && type.trim()) continue;
  if (src.includes("baiango")) type = "idiom";
  else if (src.includes("wec")) type = "phrasal";
  else type = "collocation";
  r[4] = type;
  set++;
}
fs.writeFileSync("chunks-vendor/chunks.pool.tsv", rows.map((r) => r.join("\t")).join("\n") + "\n");
const typed = rows.filter((r) => r[4]).length;
const pending = rows.filter((r) => !r[2] || r[2] === "__LLM_PENDING__");
console.log(`派生 type ${set} 条 | 池子带 type: ${typed}/${rows.length}`);
const pb = pending.filter((r) => r[1].includes("baiango")).length;
const pw = pending.filter((r) => r[1].includes("wec")).length;
console.log(`待补译: ${pending.length} (baiango ${pb} / wec ${pw})`);
console.log("\n=== 下一批 150 条(baiango 优先) ===");
pending.sort((a, b) => (a[1].includes("baiango") ? 0 : 1) - (b[1].includes("baiango") ? 0 : 1) || a[0].localeCompare(b[0]));
for (const r of pending.slice(0, 150)) process.stdout.write(r[0] + "\n");
