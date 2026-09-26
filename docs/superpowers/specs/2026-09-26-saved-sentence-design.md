# 顺手收一句（好句摘录）

日期：2026-09-26 状态：已批准设计，待实施计划

## 0. 用户事实（决定形态的前提）

- 实际用法：**读文章 + 顺手查词，从不复习**（同 `2026-09-26-topic-registry-design.md` §0）。
- 被问到"收下来一句之后，你期望以后怎么再碰到它"，答：**偶尔翻翻就行**。不是写素材库、不是分类归档、不是待复习项。
- 推论：这个功能的成功标准是"**不产生负担**"，而不是"被高效利用"。因此禁止一切把它变成任务的设计：不计数、不提醒、不做未读徽标、不做统计卡、不要求起名或分类。

## 1. Goal

读到一句写得好的英文，一次点击留下它；哪天想翻，能在一个安静的列表里按时间看到它，并能回到原文那一段。

## 2. Non-goals

- 不进生词/短语库（`memory` 表），不进 SRS 队列，不参与 `srs.rs` 任何逻辑。
- 不做中文释义生成、不做翻译调用（有 Key 也不调，避免每次收藏都等一次网络）。
- 不做分类、标签、笔记本、导出（生词页已有 CSV 导出，只覆盖词汇，本功能不加）。
- 不做回看提醒或"你上次收的句子"之类的重现机制。

## 3. 数据

新表 `saved_sentences`：

| 列 | 说明 |
|---|---|
| `id` | TEXT PK |
| `article_id` | TEXT，可空（仅作回原文的跳板） |
| `quote` | 所选原文，单段内 |
| `para_index` | INTEGER，该段在 `content_text` 段落序列里的序号 |
| `source_title` / `source_url` | **写入时的快照**，不 JOIN `articles` |
| `created_at` | RFC3339 |

存快照而不 JOIN 的理由：刷新管线的 purge 只处理 `origin='rss'` 的旧文，但用户导入与 URL 收录的文章仍可能被删；句子是用户主动留下的，不能因为源文章被清掉就跟着丢出处。`article_id` 只用于"点开回原文"，文章已不存在时列表照常显示、点击提示原文已不在。

定位用 `para_index` 而非字符偏移：正文不被重建是话题设计的 Non-goal（不重建已入库正文），段落序号因此稳定；跳转时若该序号越界（极少数改过正文的旧文），退化为在正文里做 `quote` 前 40 字符的子串查找，找不到就只打开文章不滚动。不做段落 ID 表。

迁移沿用 `db/mod.rs` 现有风格：`user_version` 逐版推进（当前最高 14；本功能占 **v15**，话题底座排在其后用 v16 —— 两份计划共用一个迁移号分配，避免撞号），`CREATE TABLE IF NOT EXISTS`，不写回滚。

## 4. 交互

- **入口**：只在 Reader 生效。`Reader.tsx` 与 `Home.tsx` 共用同一个浮窗壳（`WordPopoverShell` → `SelectionPopover`），所以「收一句」是 `WordPopoverShell`/`SelectionPopover` 的**可选 prop**（`onSaveSentence?: () => void`），只有 Reader 传；Home 的划词不出现该按钮。按钮进现有底部动作区（`pop-link` 那一排，`onAddVocab` / `onAddPhrase` / `onToggleKnown` 之旁）。
- **显示条件**：传了 `onSaveSentence` 且选区是多词（复用 `wordResolve.ts` 既有的 `isPhraseSelection`）。单词选区不显示 —— 单词已有生词/短语两条通路，再加一个只会让人犹豫点哪个。
- **长度上限来自现状**：`Reader.tsx` 的 `onMouseUp` 对选区有 **120 字符上限**，超过根本不弹浮窗。因此本功能天然只覆盖"一句"，不需要新加 UI 限制；Rust 侧的 200 字符上限纯属防御（正常 UI 路径打不到）。
- **反馈**：点击后按钮就地变成「已收到」，1.2 秒后浮窗关闭。不弹窗、不跳转、不出现输入框。重复收同一句：`quote` 完全相同且 `article_id` 相同时直接返回既有行（幂等），界面同样显示「已收到」，不提示"已存在"。
- **段落归属**：给 `ReaderParagraph` 的外层 `.para-block` 加 `data-para-index`，`Reader` 在 `onMouseUp` 里从 `sel.anchorNode` 往上 `closest('[data-para-index]')` 取序号存进 ref（不改 `useWordPopover` 的共享入参形状）；若 `anchorNode` 与 `focusNode` 落在不同序号（跨段），本次不显示该按钮 —— 猜归属段落不如老实承认收不下。
- **列表**：生词页第 5 个 tab「句子」（现有顺序：生词 / 短语组合 / 已认识 / 查词）。`created_at` 倒序，一行一句：英文原句 + 灰色小字出处（源名 + 日期）。点句子 → 跳 Reader 并定位到该段。删除是行尾一个 × ，无确认框（一行文本的删除代价太低，加确认就变成负担）。
- **跳转与既有滚动记忆的冲突**：`Reader` 读完后会用 `shiyan:scroll:<id>` 恢复上次的滚动位置（`useArticle.ts` 的 `loadScroll`）。从句子列表进来时必须以 `para_index` 为准：跳转载荷带 `paraIndex`（react-router 的 location state），命中则滚到该段并跳过恢复，未命中才走原逻辑。
- **空态**：一句话都没收时，tab 显示一行白话说明（读到好句子，选中它就能收进来），不放插画、不放引导步骤。

## 5. 校验（在 Rust 侧做，前端不猜）

- `quote` 去首尾空白后非空，长度 ≤ 200 字符（UI 现状最多只能选出 120 字符，这个上限是防御边界的余量）；超限返回中文错误，前端在浮窗内以现有错误样式显示。
- `para_index ≥ 0` 且来自前端当前渲染的段落序号。
- `source_title` / `source_url` 由后端从 `article_id` 读出来写快照，前端不传，避免伪造。

## 6. 界面与文件落点

| 层 | 改动 |
|---|---|
| `db/mod.rs` | `LATEST_VERSION` 14→15 + v15 建表 |
| `db/sentences.rs`（新） | `SavedSentence`（ts-rs 导出）+ `insert_sentence_if_absent` / `list_sentences` / `delete_sentence`，形状照 `db/lookups.rs`（含同文件 `#[cfg(test)] mod tests` + 内存 SQLite） |
| `commands/sentences.rs`（新） | 三个 command：写走 `spawn_db`，读走 `state.lock_read()`，与 `commands/memory.rs` 同形 |
| `src-tauri/src/lib.rs` | `mod`/`use` 注册 + `generate_handler!` 三个入口；`src-tauri/src/commands/mod.rs` 加 `pub mod sentences;` |
| `src/api/sentences.ts`（新） | `apiSentences = { saveSentence, listSentences, deleteSentence }`，与 `api/memory.ts` 同形 |
| `src/api/index.ts` | 把 `apiSentences` 并进门面 `api` |
| `src/api/types.ts` | re-export ts-rs 生成的 `SavedSentence` |
| `src/components/SelectionPopover.tsx` | 新增可选 prop `onSaveSentence?: () => void` 与 `savedSentence?: boolean`，底部动作区按它们出现 |
| `src/components/WordPopoverShell.tsx` | 透传两个新 prop（Home 不传 → 按钮不出现） |
| `src/components/ReaderParagraph.tsx` | 外层 `.para-block` 加 `data-para-index` |
| `src/pages/Reader.tsx` | `onMouseUp` 记录选区段落序号到 ref；接 `saveSentence`；跳转载荷命中时按段落定位并跳过滚动恢复 |
| `src/pages/Vocab.tsx` | tabs 数组增 `["sentences", "句子"]` |
| `src/components/SavedSentences.tsx`（新） | 列表 + 删除 + 跳转；**不复用 `MemoryLibrary`**（它的 props 全绕着复习状态与 LLM enrichment，硬套会拖进复习语义）；行式列表形状可照 `LookupHistory.tsx` |
| `src/App.css` | 列表与按钮样式，沿用现有 `pop-link` / 行式列表类 |

## 7. 测试

- Rust 单测（写在 `db/sentences.rs` 自己的 `#[cfg(test)] mod tests`，与 `db/lookups.rs` 同地同形，不进 `db_tests.rs`）：同文同篇幂等（两次插入返回同一 id）、200 字符边界、空/纯空白拒绝、`list_sentences` 按 `created_at` 倒序、删除后不残、`article_id` 为 NULL 时仍可插入与列出。
- 迁移本身要有测试：v15 在已有 v14 库上可重复执行（`CREATE TABLE IF NOT EXISTS` 幂等）、`LATEST_VERSION` 与 `user_version` 一致（否则 `migrate` 末尾的 incomplete 检查会红）。
- 既有前端测试要跟着改：`src/api/index.test.ts` 把参与门面合并的模块**逐个列死**（无键冲突 + 每个模块的键都在门面上），新增 `apiSentences` 必须同时加进那两处数组，否则 `pnpm test` 红。这是改既有断言，不为新逻辑另写用例。
- `SavedSentences` 组件本身不写 vitest：vitest 是 node 环境、只收 `src/**/*.test.ts`（无 DOM），组件渲染测不了；跳转定位那段是 DOM 行为，交给本节末的真机清单。
- 验收前跑：`node scripts/stop-desktop.mjs` → `pnpm test` → `pnpm build` → `cd src-tauri && cargo test`（生成 ts-rs 绑定也靠这一步）。
- 真机（浏览器模式 invoke 不可用）：`pnpm dev:desktop` 走一遍 —— 选一句收、重收同一句不产生第二行、列表点进去落在正确段落、删掉后刷新仍在不在、源文章被 purge 之后句子与出处快照仍可见、Home 划词确认没有出现该按钮。

## 8. 落地顺序

1. `saved_sentences` 表 + `db/sentences.rs` + `commands/sentences.rs` + 注册（含单测）。
2. `SelectionPopover` / `WordPopoverShell` / `Reader` 接线：能收、能显示「已收到」。
3. `Vocab` 的「句子」tab + 删除 + 跳转定位。

理由：第 1 步做完就能用 `cargo test` 验证幂等与边界；第 2 步是价值最小闭环（收得下来）；第 3 步没有它也成立，但没第 3 步收进去的句子看不到，所以不可省。

## 9. 验收标准

- [ ] Reader 里选中一句（多词），浮窗出现「收一句」，点一次即完成，无输入框、无弹窗
- [ ] 单个词的选区不出现该按钮；Home 里划词不出现该按钮
- [ ] 同一篇同一句收两次只有一行
- [ ] 生词页第 5 个 tab 列出句子，倒序，出处显示源名与日期
- [ ] 点句子跳到该篇并定位到对应段落；跳过既有的滚动恢复；越界旧文退回子串查找或仅打开文章，不报错
- [ ] 源文章被清掉后，句子与出处快照仍在列表里
- [ ] 空白/超 200 字符的入参返回中文错误，浮窗不崩
- [ ] 复习相关界面（生词/短语队列、SRS、统计）无任何行为变化
- [ ] 老库升级后 `user_version` 为 15；`pnpm test` / `pnpm build` / `cargo test` 全绿

## 10. 已知风险

- **可能真的没人翻**：按他自述这是"偶尔翻翻"，若两周后 tab 从未打开过，正确的处置是删掉这个 tab 而不是加提醒。
- **入口挤**：浮窗底部已有三个动作，第四个会让"加生词"这类高频动作的相对位置变化；实施时按现有 `pop-link` 排布实测宽度，必要时把「收一句」放第二序位（短语之后），观察一次再定。
- **120 字符上限顺带锁死了"收一段"**：现状 `onMouseUp` 超过 120 字符不弹浮窗，所以这个功能只能收一句。若日后想收整段，得先动选区上限，而那会同时改变划词翻译的行为 —— 不在本设计内，别顺手改。
