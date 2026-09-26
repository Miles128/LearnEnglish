# chunks.json 数据来源与许可

`src/data/chunks.json` 是打包进 App 的词块表（3,241 条），仿 `word-levels.json` 走
只读 JSON + 前端懒加载。运行时行格式：`[key, zh, en, type, [labels…]]`；`type ∈
{idiom, phrasal, collocation, slang}`；`labels` 承载语域（正/口/俚/粗/诙）+ 场景
（时/财/法/军/外/学/科/医/体）+ 变体（英/美/澳/加），空数组=中性。

## 词块成员（"哪些是词块"）

| 源 | 许可 | 贡献 | 说明 |
|---|---|---|---|
| **ECDICT**（`scripts/.cache/ecdict.csv`） | MIT | 36.6 万带空格词组 → 中文 + 词频回填引擎 | 已在 word-details.json 使用 |
| **baiango/english_idioms** (GitHub) | Unlicense（公有领域） | ~1,000 习语 + 英文释义 | 习义 0 命中 ECDICT 中文，走 LLM/人工补 |
| **WithEnglishWeCan/generated-english-phrasal-verbs** (GitHub) | **无 LICENSE** | 仅借用其"短语动词**名单**"（事实层面），不拷其任何英文释义串 | 释义由 ECDICT 或 LLM 自产 |
| **手工精校种子** (`chunks.seed.json`, gitignore) | 自产 | 385 条 B2+/C1/C2 时政·财经·法律高频块 | 唯一人工过一遍 type/labels |

## 中文释义

- 命中 ECDICT（MIT）→ 直引首义（超长多义截断到 ≤18 汉字，剥掉 `<美俚>` `[法]` 域前缀）。
- 未命中 ECDICT 的真词块（wec/baiango）→ 由 QwenWork Agent 按"意译+词块 type+label"直接产出，**零 DeepSeek API 消耗**。
- 习语（`kick the bucket` 类）人工按引申意译，不做字面直译。

## 手工补录：连字符高频块（17 条，管线之后）

源表里连字符块只有 11 条（baiango 带来），而时政·财经新闻里成批的连字符复合词
既不在 CEFR-J（`word-levels.json`）也不在源池里。这一批是本项目自产（意译 +
type/labels 人工判），**重跑管线后需再叠加**（2026-09-25 的一次重跑曾把它们
整批冲掉，已重新补回）：

`blue-chip · cut-off · do-gooder · face-saving · far-left · far-right ·
free-rider · hard-line · hard-power · have-nots · know-how · left-wing ·
long-awaited · middle-of-the-road · one-off · right-wing · risk-averse`

同批另外 7 条（`also-ran · low-key · make-or-break · quick-fix ·
record-breaking · second-guess · thought-provoking`）已由该次重跑正式入库，
不再算手工补丁。

匹配规则见 `src/wordLevels.ts`：词块键与文本窗口都按空格/连字符归一，所以
`far-right` 与 `far right` 两种写法都亮；歧义拼法（`fast track`、`know how`、
`also ran` 等，见 `AMBIGUOUS_SPACED_KEYS`）只在作者写了连字符时才认。

## 明确丢弃

- **Gutenberg MOBY Part-of-Speech**（虽公有领域，但多词条目 85% 是拉丁语/学科术语，非学习者词块，且 ECDICT 无词组频率可救）。已剔除。
- 牛津短语动词/搭配词典、`The Oxford Phrase List` 等——商业不可再分发。
- Wiktionary 短语分类——CC BY-SA share-alike 会传染本资产许可，暂不用。
- 网上 SEO "100 common phrasal verbs" 类榜单——多为付费站抄录、许可不清。

## 复现管线

一次性构建，管线脚本在 `chunks-vendor/`（同样 gitignore，仅本地保留）：
`merge.mjs → type-from-src.mjs → prune.mjs → slice.mjs → (子 agent 分批 gloss-sN.tsv) → merge-gloss.mjs → emit-chunks.mjs`。
如需再扩充：重跑管线，或按上文许可策略从 Wiktionary/EVP 增量导入并**先出风险清单再入库**。

## 归属

ECDICT © skywind3000 (MIT)；baiango/english_idioms Unlicense；运行时词块表本身
= 项目自产（LLM 意译 + 人工精选），可随本项目许可分发。
