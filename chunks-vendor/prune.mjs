import fs from "node:fs";

const pool = fs.readFileSync("chunks-vendor/chunks.pool.tsv","utf8").split("\n").filter(Boolean).map((l)=>l.split("\t"));
const before = pool.length;
const real = pool.filter((r)=>r[1] !== "moby-pos"); // drop pure MOBY-only
fs.writeFileSync("chunks-vendor/chunks.pool.tsv", real.map((r)=>r.join("\t")).join("\n")+"\n");

const pending = real.filter((r)=>!r[2] || r[2]==="__LLM_PENDING__");
fs.writeFileSync("chunks-vendor/target-real.txt", pending.map((r)=>r[0]).join("\n")+"\n");
const bySrc={}; for(const r of pending){const s=r[1].includes("wec")?"wec":r[1].includes("baiango")?"baiango":"?";bySrc[s]=(bySrc[s]||0)+1;}
console.log(`剔除纯MOBY: ${before} → ${real.length} (删 ${before-real.length})`);
console.log(`真词块池中待译: ${pending.length}`, bySrc);
console.log("\n=== 批次2 待译 (前150, 已按源排 baiango 优先) ===");
pending.sort((a,b)=>a[1].localeCompare(b[1])||a[0].localeCompare(b[0]));
fs.writeFileSync("chunks-vendor/target-real.txt", pending.map((r)=>r[0]).join("\n")+"\n");
for(const r of pending.slice(0,150)) process.stdout.write(r[0].replace(/[^a-z0-9' -]/g,"").trim()+"\n");
