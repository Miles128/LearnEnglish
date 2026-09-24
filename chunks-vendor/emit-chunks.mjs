import fs from "node:fs";

const cleanKey = (s) =>
  s.toLowerCase().replace(/[{}"]/g, "").replace(/[\u2019\u02BC']/g, "'").replace(/\s+/g, " ").trim().replace(/[?!.,;:]+$/, "").replace(/^[?!.,;:]+/, "");
const inSet = new Set(fs.readFileSync("chunks-vendor/reject.txt","utf8").split("\n").map(cleanKey).filter(Boolean));
const toLabels = (s) => (s||"").split(",").map((x)=>x.trim()).filter(Boolean);

// Keep hover gloss concise: only trim the verbose ECDICT multi-sense blobs (>18 chars),
// never touch my hand/agent/seed glosses (all short).
function trimZh(zh) {
  let s = (zh || "").trim();
  s = s.replace(/\\n/g, "；").replace(/\n/g, "；");
  s = s.replace(/^(\s*(n|v|vt|vi|adj|adv|prep|conj|pron|int|aux|na)\.\s*)+/i, "");
  s = s.replace(/^[<\[（(【][^\]>）】]*[>\]）】]\s*/, ""); // strip leading <美俚> [法] (口)
  if (s.length <= 18) return s.trim();
  s = s.split(/[;；/｜|,，、]/)[0];
  s = s.replace(/^[<\[（(【][^\]>）】]*[>\]）】]\s*/, "");
  if (s.length > 18) {
    const i = s.search(/\s/);
    if (i > 2 && i <= 18) s = s.slice(0, i);
  }
  s = s.trim();
  return s.length ? s : zh.trim().slice(0, 16);
}

const map = new Map(); // key -> [key, zh, en, type, labels]

// pool rows (auto/ECDICT + my batches + subagent batches)
for (const line of fs.readFileSync("chunks-vendor/chunks.pool.tsv","utf8").split("\n").filter(Boolean)) {
  const [key, src, zh, en, type, labels] = line.split("\t");
  if (!zh || zh === "__LLM_PENDING__") continue;         // untranslated/reject
  if (src === "moby-pos") continue;                        // MOBY junk already pruned, belt-and-suspenders
  const k = cleanKey(key);
  if (!k || !k.includes(" ") || inSet.has(k)) continue;    // single words & rejects never ship
  map.set(k, [k, trimZh(zh), (en||"").trim(), (type||"collocation").trim(), toLabels(labels)]);
}
const fromPool = map.size;

// curated seed wins for keys it defines (human-authored 时政财经法律 gloss), keeps pool `en` if seed lacks
for (const r of JSON.parse(fs.readFileSync("chunks.seed.json","utf8"))) {
  const [term, type, , , zh, label] = r;
  const k = cleanKey(term);
  if (!k || !k.includes(" ")) continue;
  const prev = map.get(k);
  const labels = toLabels(label);
  map.set(k, [k, trimZh(zh), prev ? prev[2] : "", type || prev?.[3] || "collocation", labels]);
}
const seedCount = JSON.parse(fs.readFileSync("chunks.seed.json","utf8")).length;

const rows = [...map.values()].sort((a,b)=>a[0].localeCompare(b[0]));
fs.mkdirSync("src/data",{recursive:true});
fs.writeFileSync("src/data/chunks.json", JSON.stringify(rows));

const dist={}; for(const r of rows) dist[r[3]]=(dist[r[3]]||0)+1;
console.log(`写出 src/data/chunks.json | 总 ${rows.length} 条 (池子译入 ${fromPool} + 手工种子 ${seedCount})`);
console.log("type 分布:", dist);
const labeled = rows.filter(r=>r[4].length).length;
console.log("带 label 的:", labeled);
console.log("\n抽样:"); for(const r of rows.filter((_,i)=>i%Math.ceil(rows.length/10)===0).slice(0,10)) console.log("  "+JSON.stringify(r));
