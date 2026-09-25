import fs from "node:fs";
const norm = (s) => s.toLowerCase().replace(/[{}"?"]/g, "").replace(/[\u2019\u02BC']/g, "'").replace(/\s+/g, " ").trim();

// Load reject keys (any reject-*.tsv) so we never gloss/ship them.
const rejects = new Set();
for (const f of fs.readdirSync("chunks-vendor").filter((n) => /^reject-.*\.tsv$/.test(n)))
  for (const l of fs.readFileSync(`chunks-vendor/${f}`, "utf8").split("\n").filter(Boolean)) rejects.add(norm(l));
fs.writeFileSync("chunks-vendor/reject.txt", [...rejects].join("\n") + "\n");

const rows = fs.readFileSync("chunks-vendor/chunks.pool.tsv", "utf8").split("\n").filter(Boolean).map((l) => l.split("\t"));
const pending = rows
  .filter((r) => (!r[2] || r[2] === "__LLM_PENDING__") && r[1] !== "moby-pos" && r[0].includes(" ") && !rejects.has(norm(r[0])))
  .map((r) => r[0]);

const SLICE = 180;
const n = Math.ceil(pending.length / SLICE);
for (let i = 0; i < n; i++) {
  fs.writeFileSync(`chunks-vendor/slice-${i + 1}.txt`, pending.slice(i * SLICE, (i + 1) * SLICE).join("\n") + "\n");
}
console.log(`剩余待译(真词块·有多空格·非reject): ${pending.length} → 切成 ${n} 个 slice-*.txt (每片≤${SLICE})`);
console.log("reject 累计:", rejects.size);
