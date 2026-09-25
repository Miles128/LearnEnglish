import fs from "node:fs";

// Reads config.local.json (OpenAI-compatible, same shape as src-tauri/src/vocab.rs)
// and fills the __LLM_PENDING__ Chinese glosses in chunks.pool.tsv.
// SAFETY: without an explicit --limit N (>0) or --all, it does a 30-row SMOKE TEST only.

const cfg = JSON.parse(fs.readFileSync("config.local.json", "utf8"));
const { base_url, api_key, model } = cfg;
if (!base_url || !api_key || !model || api_key.includes("YOUR_API_KEY")) {
  console.error("config.local.json 缺 base_url/api_key/model，先配置再跑。");
  process.exit(1);
}
function chatUrl(b) {
  const base = b.trim().replace(/\/+$/, "");
  if (base.endsWith("/chat/completions")) return base;
  if ((base.endsWith("api.deepseek.com") || base.endsWith("api.openai.com")) && !base.endsWith("/v1"))
    return `${base}/v1/chat/completions`;
  return `${base}/chat/completions`;
}
const URL_ = chatUrl(base_url);

const args = process.argv.slice(2);
const hasAll = args.includes("--all");
const limitArg = Number((args.find((a) => a.startsWith("--limit=")) || "").split("=")[1] || 0);
const onlySrc = (args.find((a) => a.startsWith("--only-src=")) || "").split("=")[1] || "";
const BATCH = 15; // deepseek-flash spends reasoning tokens; keep batches small

const POOL = "chunks-vendor/chunks.pool.tsv";
let rows = fs
  .readFileSync(POOL, "utf8")
  .split("\n")
  .filter(Boolean)
  .map((l) => {
    const [key, src, zh, en, type] = l.split("\t");
    return { key, src, zh: zh === "__LLM_PENDING__" || !zh ? "" : zh, en: en || "", type: type || "" };
  });

let pending = rows.filter((r) => !r.zh);
if (onlySrc) pending = pending.filter((r) => r.src.includes(onlySrc));
// smoke default: 30; explicit --limit=N; --all = everything
const cap = hasAll ? pending.length : limitArg > 0 ? limitArg : Math.min(30, pending.length);
const batch = pending.slice(0, cap);
console.log(`pending=${pending.length} 本次处理=${batch.length} (${hasAll ? "全量" : limitArg ? `限 ${limitArg}` : "冒烟"})  target=${URL_}`);

const SYSTEM =
  "你在为中文母语、C1+ 水平的英语学习者编纂『英语词块(chunks)』词典。对每个给定短语输出：" +
  "en=简短英文释义(≤10词，用你自己的话，别照抄词典)；" +
  "zh=地道中文释义(≤14字，意译，习语按引申义不要字面直译)；" +
  "type=三选一：idiom(习语/俚语)|phrasal(短语动词)|collocation(固定搭配)。" +
  'phrase 字段原样回传。只输出 JSON：{"glosses":[{"phrase":"","en":"","zh":"","type":""}]}';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function glossOnce(phrases) {
  const body = {
    model,
    temperature: 0.2,
    response_format: { type: "json_object" },
    max_tokens: 6000, // generous: reasoning model inflates token use
    messages: [
      { role: "system", content: SYSTEM },
      { role: "user", content: JSON.stringify(phrases) },
    ],
  };
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const resp = await fetch(URL_, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${api_key}` },
        body: JSON.stringify(body),
      });
      if (resp.status === 429 || resp.status >= 500) throw new Error(`http ${resp.status}`);
      if (!resp.ok) throw new Error(`http ${resp.status}: ${(await resp.text()).slice(0, 160)}`);
      const data = await resp.json();
      const content = data?.choices?.[0]?.message?.content;
      if (!content) throw new Error("empty content");
      const obj = JSON.parse(content);
      const map = new Map();
      for (const g of obj.glosses || []) {
        if (!g.phrase) continue;
        map.set(g.phrase.trim().toLowerCase().replace(/\s+/g, " "), g);
      }
      return map;
    } catch (e) {
      if (attempt === 2) {
        console.log(`  batch failed: ${e.message}`);
        return new Map();
      }
      await sleep(600 << attempt);
    }
  }
  return new Map();
}

const byKey = new Map(rows.map((r) => [r.key, r]));
let filled = 0;
for (let i = 0; i < batch.length; i += BATCH) {
  const slice = batch.slice(i, i + BATCH);
  const map = await glossOnce(slice.map((r) => r.key));
  for (const r of slice) {
    const g = map.get(r.key);
    if (g && (g.zh || "").trim()) {
      r.zh = String(g.zh).trim();
      r.en = String(g.en || "").trim();
      r.type = String(g.type || "").trim();
      filled++;
    }
  }
  process.stdout.write(`  ${Math.min(i + BATCH, batch.length)}/${batch.length} (filled ${filled})\n`);
  await sleep(150); // be gentle on rate limits
}

fs.writeFileSync(
  POOL,
  rows
    .map((r) => [r.key, r.src, r.zh || "__LLM_PENDING__", r.en || "", r.type || ""].join("\t"))
    .join("\n") + "\n",
);
console.log(`\n本次补译 ${filled} 条 -> ${POOL}。仍未填: ${rows.filter((r) => !r.zh).length}`);
console.log("=== 抽样(前12) ===");
for (const r of batch.slice(0, 12)) console.log(`${r.key}\t[${r.type}]\t${r.zh}\t| ${r.en}`);
