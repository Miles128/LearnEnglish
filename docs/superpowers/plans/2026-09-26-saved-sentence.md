# 顺手收一句（好句摘录）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Reader 划选一句英文、一次点击存下来，在生词页第 5 个 tab「句子」里按时间倒序安静地翻，并能跳回原文那一段。

**Architecture:** 一张 `saved_sentences` 表 + 一个 `db/sentences.rs` 仓储 + 三个 Tauri command；前端在既有划词浮窗上加一个**可选**动作（只有 Reader 传，Home 不传），列表组件独立于复习语义。出处以快照存在句子行里，源文章被清理后句子仍可读。

**Tech Stack:** Rust（rusqlite/bundled SQLite、chrono、uuid、ts-rs）、React 19 + TS + react-router-dom 7（HashRouter）、vitest（node 环境，只收 `src/**/*.test.ts`）。

**Spec:** `docs/superpowers/specs/2026-09-26-saved-sentence-design.md` —— 本计划逐条实现它，取舍理由在那份文件里，冲突时以 spec 为准并向用户确认。

## Global Constraints

- 不引入任何新依赖（npm / cargo 都不加；`uuid`、`chrono`、`serde_json` 已在用）。
- 迁移号：`db/mod.rs` 当前 `const LATEST_VERSION: i64 = 14`，本功能为 **v15**。话题底座设计已约定排在 v16，不得并占。
- 绝不碰复习链路：`srs.rs`、`vocab`/`memory` 表、`due_memory`、Vocab 的生词/短语/已认识/查词四个 tab 的既有行为一律不改。
- 无 API Key 时本功能必须照常工作（它不调 LLM）。
- 用户可见文案是中文白话，不出现英文技术词。
- 跑测试前先关桌面会话（`tauri dev` 会重编译抢焦点）：`node scripts/stop-desktop.mjs`。
- 提交只 `git add` 本任务点名的文件，不要 `git add -A`（工作区有其他人未完成的改动）。

## File map

| File | 责任 |
|---|---|
| `src-tauri/src/db/mod.rs` | `mod sentences;` + `pub use sentences::*;` + v15 迁移 |
| `src-tauri/src/db/sentences.rs` | 表的全部读写与校验（含自己的单测） |
| `src-tauri/src/commands/sentences.rs` | 三个 `#[tauri::command]` 薄层 |
| `src-tauri/src/commands/mod.rs` / `lib.rs` | 注册模块与 handler |
| `src/api/sentences.ts` → `src/api/index.ts` / `types.ts` | invoke 封装并进门面 |
| `src/components/SelectionPopover.tsx` / `WordPopoverShell.tsx` | 多一个可选动作按钮 |
| `src/components/ReaderParagraph.tsx` | 段落容器带 `data-para-index` |
| `src/pages/Reader.tsx` | 记住选区段落、执行保存、响应跳转载荷 |
| `src/components/SavedSentences.tsx` / `src/pages/Vocab.tsx` / `src/App.css` | 「句子」tab |

---

### Task 1: `saved_sentences` 表 + 仓储 + 单测

**Files:**
- Create: `src-tauri/src/db/sentences.rs`
- Modify: `src-tauri/src/db/mod.rs`（模块声明区 7–20 行；`const LATEST_VERSION` 586 行；`migrate` 内 v14 块之后、`if stored < LATEST_VERSION` 兜底之前）
- Test: 同文件 `#[cfg(test)] mod tests`（与 `db/lookups.rs:125` 同地同形，不进 `db_tests.rs`）

**Interfaces:**
- Consumes: `articles(id, title, source)` 只读；`crate::error::AppError`（`AppError::msg(&str)`，`?` 直接吃 `rusqlite::Error`）
- Produces:
  - `pub struct SavedSentence { id: String, article_id: Option<String>, quote: String, para_index: i64, source_title: String, source_url: String, created_at: String }`（`#[ts(export)]`）
  - `pub fn insert_sentence_if_absent(conn: &Connection, article_id: Option<&str>, quote: &str, para_index: i64) -> Result<SavedSentence, AppError>`
  - `pub fn list_sentences(conn: &Connection, limit: usize, offset: usize) -> Result<Vec<SavedSentence>, AppError>`
  - `pub fn delete_sentence(conn: &Connection, id: &str) -> Result<(), AppError>`

- [ ] **Step 1: 写失败的单测**

新建 `src-tauri/src/db/sentences.rs`，先只放 `#[cfg(test)]`：

```rust
#[cfg(test)]
mod tests {
    use super::*;

    /// v15 建表语句与 `migrate` 里的保持一字不差；articles 只留本测试要用的列。
    fn setup() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE articles (id TEXT PRIMARY KEY, title TEXT NOT NULL, url TEXT NOT NULL DEFAULT '', source TEXT NOT NULL DEFAULT '');
             INSERT INTO articles (id, title, url, source) VALUES
               ('a1', 'The Fed holds rates', 'https://ex.com/a1', 'Reuters'),
               ('a2', 'A ceasefire frays', 'https://ex.com/a2', 'AP');
             CREATE TABLE IF NOT EXISTS saved_sentences (
                id TEXT PRIMARY KEY,
                article_id TEXT,
                quote TEXT NOT NULL,
                para_index INTEGER NOT NULL DEFAULT -1,
                source_title TEXT NOT NULL DEFAULT '',
                source_url TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL
             );",
        )
        .unwrap();
        conn
    }

    #[test]
    fn insert_snapshots_source_from_the_article_row() {
        let conn = setup();
        let saved = insert_sentence_if_absent(&conn, Some("a1"), "Policymakers struck a cautious tone.", 2).unwrap();
        assert_eq!(saved.source_title, "The Fed holds rates");
        assert_eq!(saved.source_url, "https://ex.com/a1");
        assert_eq!(saved.para_index, 2);
        assert!(!saved.id.is_empty());
    }

    #[test]
    fn list_is_newest_first_and_honours_limit_offset() {
        // 顺序用显式写入的 created_at 控制：两条 `Utc::now()` 可能同刻，
        // 拿它断言倒序会是假测试。
        let conn = setup();
        for (i, quote) in ["oldest", "middle", "newest"].iter().enumerate() {
            conn.execute(
                "INSERT INTO saved_sentences (id, article_id, quote, para_index, source_title, source_url, created_at)
                 VALUES (?1, 'a1', ?2, 0, 'T', 'u', ?3)",
                params![format!("s{i}"), quote, format!("2026-09-2{i}T00:00:00+00:00")],
            )
            .unwrap();
        }
        let rows = list_sentences(&conn, 10, 0).unwrap();
        assert_eq!(
            rows.iter().map(|r| r.quote.as_str()).collect::<Vec<_>>(),
            vec!["newest", "middle", "oldest"]
        );
        let page = list_sentences(&conn, 1, 1).unwrap();
        assert_eq!(page.len(), 1);
        assert_eq!(page[0].quote, "middle");
    }

    #[test]
    fn insert_is_idempotent_per_article_and_quote() {
        let conn = setup();
        let first = insert_sentence_if_absent(&conn, Some("a1"), "Same sentence.", 1).unwrap();
        let again = insert_sentence_if_absent(&conn, Some("a1"), "  Same sentence. ", 4).unwrap();
        assert_eq!(first.id, again.id, "重复收藏返回既有行");
        assert_eq!(again.para_index, 1, "既有行的段落归属不被后一次覆盖");
        assert_eq!(list_sentences(&conn, 10, 0).unwrap().len(), 1);
    }

    #[test]
    fn same_quote_in_another_article_is_its_own_row() {
        let conn = setup();
        insert_sentence_if_absent(&conn, Some("a1"), "A repeated line.", 0).unwrap();
        insert_sentence_if_absent(&conn, Some("a2"), "A repeated line.", 3).unwrap();
        assert_eq!(list_sentences(&conn, 10, 0).unwrap().len(), 2);
    }

    #[test]
    fn insert_rejects_blank_and_oversize_quotes() {
        let conn = setup();
        assert!(insert_sentence_if_absent(&conn, Some("a1"), "   ", 0).is_err());
        let long: String = "x".repeat(MAX_QUOTE_CHARS + 1);
        assert!(insert_sentence_if_absent(&conn, Some("a1"), &long, 0).is_err());
        let edge = "y".repeat(MAX_QUOTE_CHARS);
        assert!(insert_sentence_if_absent(&conn, Some("a1"), &edge, 0).is_ok());
        assert_eq!(list_sentences(&conn, 10, 0).unwrap().len(), 1);
    }

    #[test]
    fn insert_survives_missing_or_null_article() {
        let conn = setup();
        let orphan = insert_sentence_if_absent(&conn, None, "An ownerless line.", 0).unwrap();
        assert_eq!(orphan.source_title, "");
        assert_eq!(orphan.source_url, "");
        // 文章被清掉之后，已存的句子仍要能列出来（快照不 JOIN）。
        conn.execute("DELETE FROM articles", []).unwrap();
        assert_eq!(list_sentences(&conn, 10, 0).unwrap().len(), 1);
    }

    #[test]
    fn delete_removes_exactly_one_row() {
        let conn = setup();
        let saved = insert_sentence_if_absent(&conn, Some("a1"), "Doomed sentence.", 1).unwrap();
        insert_sentence_if_absent(&conn, Some("a1"), "Keeper.", 0).unwrap();
        delete_sentence(&conn, &saved.id).unwrap();
        let rows = list_sentences(&conn, 10, 0).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].quote, "Keeper.");
        assert!(delete_sentence(&conn, &saved.id).is_err(), "再删同一条要报错而不是静默");
    }
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd src-tauri && cargo test sentences 2>&1 | tail -20`
Expected: 编译失败 —— `cannot find function insert_sentence_if_absent` / `cannot find type SavedSentence`。

- [ ] **Step 3: 写仓储实现**

把下面内容加在 `src-tauri/src/db/sentences.rs` 的测试模块**之前**：

```rust
//! 好句摘录：用户主动留下的单句，不进复习链路、不调 LLM。

use crate::error::AppError;
use chrono::Utc;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// 一行摘录。出处是写入时的快照，因此源文章被 purge 之后仍可阅读。
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct SavedSentence {
    pub id: String,
    pub article_id: Option<String>,
    pub quote: String,
    /// 段落在 `content_text` 段落序列里的序号；-1 = 未知。
    pub para_index: i64,
    pub source_title: String,
    pub source_url: String,
    pub created_at: String,
}

/// 防御边界：Reader 的划词对选区本就有 120 字符上限（超出根本不弹浮窗），
/// 这里留出余量，挡住直接调用 command 的超长入参。
pub const MAX_QUOTE_CHARS: usize = 200;

const SENTENCE_COLS: &str =
    "id,article_id,quote,para_index,source_title,source_url,created_at";

fn map_sentence(row: &rusqlite::Row<'_>) -> rusqlite::Result<SavedSentence> {
    Ok(SavedSentence {
        id: row.get(0)?,
        article_id: row.get(1)?,
        quote: row.get(2)?,
        para_index: row.get(3)?,
        source_title: row.get(4)?,
        source_url: row.get(5)?,
        created_at: row.get(6)?,
    })
}

/// 同一篇里的同一句只有一行：命中既有行时原样返回它（含既有 `para_index`）。
pub fn insert_sentence_if_absent(
    conn: &Connection,
    article_id: Option<&str>,
    quote: &str,
    para_index: i64,
) -> Result<SavedSentence, AppError> {
    let quote = quote.trim();
    if quote.is_empty() {
        return Err(AppError::msg("句子是空的"));
    }
    if quote.chars().count() > MAX_QUOTE_CHARS {
        return Err(AppError::msg(format!(
            "句子太长（最多 {MAX_QUOTE_CHARS} 个字符）"
        )));
    }
    if let Some(existing) = conn
        .query_row(
            &format!("SELECT {SENTENCE_COLS} FROM saved_sentences
                      WHERE quote=?1 AND IFNULL(article_id,'') = IFNULL(?2,'')"),
            params![quote, article_id],
            |row| map_sentence(row),
        )
        .ok()
    {
        return Ok(existing);
    }
    // 出处由后端从库里读出，前端传什么都伪造不了。
    let (source_title, source_url) = match article_id {
        Some(id) => conn
            .query_row(
                "SELECT title, url FROM articles WHERE id=?1",
                params![id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .unwrap_or_else(|_| (String::new(), String::new())),
        None => (String::new(), String::new()),
    };
    let row = SavedSentence {
        id: uuid::Uuid::new_v4().to_string(),
        article_id: article_id.map(str::to_string),
        quote: quote.to_string(),
        para_index,
        source_title,
        source_url,
        created_at: Utc::now().to_rfc3339(),
    };
    conn.execute(
        "INSERT INTO saved_sentences
            (id, article_id, quote, para_index, source_title, source_url, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            row.id,
            row.article_id,
            row.quote,
            row.para_index,
            row.source_title,
            row.source_url,
            row.created_at,
        ],
    )?;
    Ok(row)
}

/// 最新优先的一页摘录。
pub fn list_sentences(
    conn: &Connection,
    limit: usize,
    offset: usize,
) -> Result<Vec<SavedSentence>, AppError> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {SENTENCE_COLS} FROM saved_sentences
         ORDER BY created_at DESC, rowid DESC LIMIT ?1 OFFSET ?2"
    ))?;
    let rows = stmt
        .query_map(params![limit as i64, offset as i64], map_sentence)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

pub fn delete_sentence(conn: &Connection, id: &str) -> Result<(), AppError> {
    let changed = conn.execute("DELETE FROM saved_sentences WHERE id=?1", params![id])?;
    if changed == 0 {
        return Err(AppError::msg("这条摘录已不在"));
    }
    Ok(())
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd src-tauri && cargo test sentences 2>&1 | tail -25`
Expected: 7 个测试全绿（`test result: ok. 7 passed`；`list` 那条断言刻意写成与时间戳无关的形式，若仍失败说明排序写错了）。

- [ ] **Step 5: 加 v15 迁移并接上模块**

`src-tauri/src/db/mod.rs` 三处改动：

1. 模块声明区（`mod memory;` 之后）加 `mod sentences;`，re-export 区（`pub use memory::*;` 之后）加 `pub use sentences::*;`
2. `const LATEST_VERSION: i64 = 14;` → `15`
3. v14 块之后、`if stored < LATEST_VERSION` 兜底之前插入：

```rust
    if stored < 15 {
        // 好句摘录：单句 + 出处快照（见 docs/superpowers/specs/
        // 2026-09-26-saved-sentence-design.md）。不接复习链路。
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS saved_sentences (
                id TEXT PRIMARY KEY,
                article_id TEXT,
                quote TEXT NOT NULL,
                para_index INTEGER NOT NULL DEFAULT -1,
                source_title TEXT NOT NULL DEFAULT '',
                source_url TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL
             );
             CREATE INDEX IF NOT EXISTS idx_sentences_created ON saved_sentences(created_at DESC);",
        )?;
        conn.pragma_update(None, "user_version", 15)?;
        stored = 15;
    }
```

- [ ] **Step 6: 跑全量后端测试确认迁移没打断既有链路**

Run: `cd src-tauri && cargo test 2>&1 | tail -25`
Expected: 全绿，且 `migrate` 相关测试无 `incomplete schema migration`。若出现该错误，说明 `LATEST_VERSION` 与 `user_version` 戳没对上。

- [ ] **Step 7: 提交**

```bash
git add src-tauri/src/db/sentences.rs src-tauri/src/db/mod.rs
git commit -m "feat(sentences): saved-sentence table, repository and v15 migration"
```

---

### Task 2: command 层 + 前端 api 门面

**Files:**
- Create: `src-tauri/src/commands/sentences.rs`
- Modify: `src-tauri/src/commands/mod.rs`（`pub mod memory;` 之后）
- Modify: `src-tauri/src/lib.rs`（`generate_handler!` 列表内，`commands::memory::clear_lookups,` 之后）
- Create: `src/api/sentences.ts`
- Modify: `src/api/index.ts`、`src/api/types.ts`
- Modify: `src/api/index.test.ts`（两处模块清单）

**Interfaces:**
- Consumes: Task 1 的三个 `db::` 函数；`crate::commands::spawn_db`；`DbState::lock_read/lock_write`
- Produces: Tauri command `save_sentence(article_id: Option<String>, quote: String, para_index: Option<i64>) -> SavedSentence`、`list_sentences(limit: Option<i64>, offset: Option<i64>) -> Vec<SavedSentence>`、`delete_sentence(id: String) -> ()`；前端 `api.saveSentence/listSentences/deleteSentence`

- [ ] **Step 1: command 薄层**

`src-tauri/src/commands/sentences.rs`：

```rust
use crate::db::{self, DbState, SavedSentence};
use crate::error::AppError;
use tauri::AppHandle;

/// 收一句。写库很快（无网络），但仍在 blocking 池里跑，与其余写命令一致。
#[tauri::command]
pub async fn save_sentence(
    app: AppHandle,
    article_id: Option<String>,
    quote: String,
    para_index: Option<i64>,
) -> Result<SavedSentence, AppError> {
    crate::commands::spawn_db(app, move |state| {
        let conn = state.lock_write()?;
        db::insert_sentence_if_absent(
            &conn,
            article_id.as_deref(),
            &quote,
            para_index.unwrap_or(-1),
        )
    })
    .await
}

#[tauri::command]
pub fn list_sentences(
    state: tauri::State<'_, DbState>,
    limit: Option<i64>,
    offset: Option<i64>,
) -> Result<Vec<SavedSentence>, AppError> {
    let conn = state.lock_read()?;
    db::list_sentences(
        &conn,
        usize::try_from(limit.unwrap_or(200)).unwrap_or(200),
        usize::try_from(offset.unwrap_or(0)).unwrap_or(0),
    )
}

#[tauri::command]
pub fn delete_sentence(
    state: tauri::State<'_, DbState>,
    id: String,
) -> Result<(), AppError> {
    let conn = state.lock_write()?;
    db::delete_sentence(&conn, &id)
}
```

`src-tauri/src/commands/mod.rs`：`pub mod memory;` 之后加 `pub mod sentences;`
`src-tauri/src/lib.rs`：`commands::memory::clear_lookups,` 之后加三行

```rust
            commands::sentences::save_sentence,
            commands::sentences::list_sentences,
            commands::sentences::delete_sentence,
```

- [ ] **Step 2: 编译 + 生成 ts-rs 绑定**

Run: `node scripts/stop-desktop.mjs; cd src-tauri && cargo test 2>&1 | tail -15`
Expected: 全绿；`src-tauri/bindings/SavedSentence.ts` 出现（ts-rs 在 `cargo test` 时导出）。
先确认：`ls src-tauri/bindings/SavedSentence.ts` —— 若不存在，说明 `#[ts(export)]` 没生效，回到 Task 1 Step 3 检查 derive。

- [ ] **Step 3: 写前端会依赖的失败断言**

`src/api/index.test.ts` 的两个清单都缺 `apiSentences` 时测试应红。先跑一次确认它是绿的（基线）：

Run: `node scripts/stop-desktop.mjs; pnpm test 2>&1 | tail -8`
Expected: PASS（此时尚未加模块）。

- [ ] **Step 4: 加 api 模块并进门面**

`src/api/sentences.ts`：

```ts
import { invoke } from "@tauri-apps/api/core";
import type { SavedSentence } from "./types";

export const apiSentences = {
  saveSentence: (articleId: string | null, quote: string, paraIndex: number | null) =>
    invoke<SavedSentence>("save_sentence", {
      articleId: articleId ?? null,
      quote,
      paraIndex: paraIndex ?? null,
    }),
  listSentences: (limit = 200) =>
    invoke<SavedSentence[]>("list_sentences", { limit, offset: null }),
  deleteSentence: (id: string) => invoke<void>("delete_sentence", { id }),
};
```

`src/api/types.ts`：`export type { LookupEntry } ...` 之后加

```ts
export type { SavedSentence } from "../../src-tauri/bindings/SavedSentence";
```

`src/api/index.ts`：

```ts
import { apiSentences } from "./sentences";
// ...
export const api = {
  ...apiConfig,
  ...apiFeeds,
  ...apiArticles,
  ...apiMemory,
  ...apiSentences,
  ...apiData,
};
```

- [ ] **Step 5: 更新门面测试的模块清单**

`src/api/index.test.ts`：`import { apiMemory } from "./memory";` 之后加 `import { apiSentences } from "./sentences";`；两处清单各加一项 —— `const modules = { apiConfig, apiFeeds, apiArticles, apiMemory, apiSentences, apiData };` 与 `for (const mod of [apiConfig, apiFeeds, apiArticles, apiMemory, apiSentences, apiData])`。

- [ ] **Step 6: 跑测试确认通过**

Run: `node scripts/stop-desktop.mjs; pnpm test 2>&1 | tail -12`
Expected: PASS，且「has no key collisions」仍绿（`saveSentence`/`listSentences`/`deleteSentence` 与 `apiMemory` 的 `addMemory`/`listMemory` 不重名）。

- [ ] **Step 7: 提交**

```bash
git add src-tauri/src/commands/sentences.rs src-tauri/src/commands/mod.rs src-tauri/src/lib.rs src-tauri/bindings/SavedSentence.ts src/api/sentences.ts src/api/index.ts src/api/types.ts src/api/index.test.ts
git commit -m "feat(sentences): save/list/delete commands and frontend api facade"
```

---

### Task 3: 划词浮窗「收一句」+ Reader 段落归属

**Files:**
- Modify: `src/components/ReaderParagraph.tsx`（`.para-block` 外层 div；Props 增 `paraIndex`）
- Modify: `src/components/SelectionPopover.tsx`（Props + `.pop-actions` 区）
- Modify: `src/components/WordPopoverShell.tsx`（透传）
- Modify: `src/pages/Reader.tsx`（`onMouseUp` 记段落；保存动作；渲染处传参）
- Test: `src/components/ReaderParagraph.test.ts` 不收 DOM，本任务无新前端测试（见 spec §7）

**Interfaces:**
- Consumes: Task 2 的 `api.saveSentence`；`wordResolve.isPhraseSelection`；`useWordPopover` 的 `popover` / `closePopover`
- Produces: `SelectionPopover` 可选 props `onSaveSentence?: () => void`、`sentenceSaved?: boolean`；`ReaderParagraph` 必填 prop `paraIndex: number`，DOM 上 `data-para-index`；Reader 内部 `savedSentence` state 与 `selParaRef`

- [ ] **Step 1: 段落容器带序号**

`src/components/ReaderParagraph.tsx`：`type Props` 增 `paraIndex: number;`，解构列表加上它，渲染改为：

```tsx
  return (
    <div className="para-block" data-para-index={paraIndex}>
```

`src/pages/Reader.tsx` 里渲染 `ReaderParagraph` 的地方（`.map` 循环内）补 `paraIndex={index}` —— 沿用该循环已有的下标名，不新造索引变量。

Run: `node scripts/stop-desktop.mjs; pnpm test 2>&1 | tail -6`
Expected: PASS（`ReaderParagraph.test.ts` 只测 `shouldAnnotateMarkdownTag`，不受影响）。

- [ ] **Step 2: 浮窗多一个可选动作**

`src/components/SelectionPopover.tsx`：`type Props` 在 `onToggleKnown?: () => void;` 之后加

```ts
  /** Present only in Reader for multi-word selections: keep the sentence. */
  onSaveSentence?: () => void;
  /** Set once the current selection has been saved. */
  sentenceSaved?: boolean;
```

组件签名解构里加 `onSaveSentence, sentenceSaved`，`.pop-actions` 内 `onToggleKnown` 那块之后加：

```tsx
        {onSaveSentence ? (
          <button
            className="pop-link"
            onClick={onSaveSentence}
            disabled={sentenceSaved}
          >
            {sentenceSaved ? "已收到" : "收一句"}
          </button>
        ) : null}
```

- [ ] **Step 3: 壳层只在多词选区时透传**

`src/components/WordPopoverShell.tsx`：`type Props` 加 `onSaveSentence?: () => void;` 与 `sentenceSaved?: boolean;`（会被 `...rest` 带进 `SelectionPopover`，因此**不必**改函数体，但必须写在 Props 上否则 TS 报错）。

Run: `node scripts/stop-desktop.mjs; pnpm test 2>&1 | tail -8`
Expected: PASS（`tsc --noEmit` 通过 = 类型接上了）。

- [ ] **Step 4: Reader 记住选区落在哪一段**

`src/pages/Reader.tsx` 在 `onMouseUp` 之前加一个工具（模块级，不放组件内，避免每次 render 重建）：

```tsx
/** 选区两端所在段的序号；跨段（含取不到）返回 null。 */
function selectionParaIndex(sel: Selection | null): number | null {
  const at = (node: Node | null) =>
    (node?.parentElement ?? null)?.closest("[data-para-index]")?.getAttribute("data-para-index") ?? null;
  const a = at(sel?.anchorNode ?? null);
  const b = at(sel?.focusNode ?? null);
  if (a === null || a !== b) return null;
  return Number(a);
}
```

`onMouseUp` 内 `const text = sel?.toString().trim() ?? "";` 之后、`await showMeaning(...)` 之前加：

```tsx
    selParaRef.current = selectionParaIndex(sel);
    setSavedSentence(false);
```

组件内（与 `const [showDone, setShowDone] = useState(false);` 相邻处）加：

```tsx
  const selParaRef = useRef<number | null>(null);
  const [savedSentence, setSavedSentence] = useState(false);
```

- [ ] **Step 5: 保存动作与渲染接线**

`onMouseUp` 之后加：

```tsx
  /** 收当前选区为一句。只认 anchor/focus 同段的选择。 */
  async function saveCurrentSentence() {
    const quote = popover?.text.trim() ?? "";
    if (!quote || !id) return;
    try {
      await api.saveSentence(id, quote, selParaRef.current);
      setSavedSentence(true);
      window.setTimeout(() => closePopover(), 1200);
    } catch (e) {
      setError(String(e));
    }
  }
```

渲染处 `<WordPopoverShell ...>` 内加两行（`onToggleKnown` 之后）：

```tsx
          onSaveSentence={
            selParaRef.current === null ? undefined : () => void saveCurrentSentence()
          }
          sentenceSaved={savedSentence}
```

`selParaRef.current === null` 时不给按钮 —— 跨段与取不到序号一律不假装收得下。

- [ ] **Step 6: 类型检查**

Run: `node scripts/stop-desktop.mjs; pnpm test 2>&1 | tail -8 && pnpm build 2>&1 | tail -8`
Expected: `pnpm test` PASS、`pnpm build` 成功（build 才做完整 `tsc`，能抓到未用变量/类型不匹配）。

- [ ] **Step 7: 提交**

```bash
git add src/components/ReaderParagraph.tsx src/components/SelectionPopover.tsx src/components/WordPopoverShell.tsx src/pages/Reader.tsx
git commit -m "feat(reader): save the selected sentence from the popover"
```

---

### Task 4: 生词页「句子」tab + 跳回原文段落

**Files:**
- Create: `src/components/SavedSentences.tsx`
- Modify: `src/pages/Vocab.tsx`（tabs 数组 + 分支渲染）
- Modify: `src/pages/Reader.tsx`（读 location state，按段落定位并跳过滚动恢复）
- Modify: `src/App.css`

**Interfaces:**
- Consumes: Task 2 的 `api.listSentences` / `api.deleteSentence`；Task 3 的 `data-para-index`；`useArticle.ts` 的 `loadScroll`（本任务要在有跳转载荷时**不**用它）
- Produces: 路由 `/article/:id` 接受 `location.state = { paraIndex: number }`

- [ ] **Step 1: 列表组件**

`src/components/SavedSentences.tsx`（形状照 `LookupHistory.tsx`，但不带任何复习动作）：

```tsx
import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, type SavedSentence } from "../api";
import { useToast } from "./Toaster";

/** 好句摘录：安静的一列，不计数、不提醒、不参与复习。 */
export default function SavedSentences() {
  const [rows, setRows] = useState<SavedSentence[]>([]);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();
  const toast = useToast();

  const load = useCallback(async () => {
    setError(null);
    try {
      setRows(await api.listSentences(500));
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function remove(row: SavedSentence) {
    try {
      await api.deleteSentence(row.id);
      setRows((prev) => prev.filter((r) => r.id !== row.id));
    } catch (e) {
      toast.err(String(e));
    }
  }

  function open(row: SavedSentence) {
    if (!row.article_id) {
      toast.err("原文已不在库里，只能看这一句了");
      return;
    }
    navigate(`/article/${row.article_id}`, { state: { paraIndex: row.para_index } });
  }

  if (error) return <p className="err-inline">{error}</p>;
  if (rows.length === 0)
    return (
      <p className="muted">
        还没有句子。阅读时选中一句英文，点浮窗里的「收一句」即可留下。
      </p>
    );

  return (
    <ul className="sentence-list">
      {rows.map((row) => (
        <li key={row.id} className="sentence-row">
          <button className="sentence-quote" onClick={() => open(row)}>
            {row.quote}
          </button>
          <div className="sentence-meta muted">
            {row.source_title || "本地导入"} · {row.created_at.slice(0, 10)}
            <button className="sentence-del" onClick={() => void remove(row)} aria-label="删除这句">
              ×
            </button>
          </div>
        </li>
      ))}
    </ul>
  );
}
```

- [ ] **Step 2: 挂进 Vocab 的第 5 个 tab**

`src/pages/Vocab.tsx`：`import LookupHistory ...` 处加 `import SavedSentences from "../components/SavedSentences";`；tabs 数组 `["lookups", "查词"],` 之后加 `["sentences", "句子"],`；渲染分支在 `library === "lookups" ?` 之后加一支：

```tsx
      ) : library === "sentences" ? (
        <SavedSentences />
```

Run: `node scripts/stop-desktop.mjs; pnpm test 2>&1 | tail -6 && pnpm build 2>&1 | tail -6`
Expected: 全绿（`library` 的类型由 `as const` 数组自动推出，不需要手写联合）。

- [ ] **Step 3: Reader 按段落定位**

`src/pages/Reader.tsx`：顶部 import 补 `useLocation`（与已有 `react-router-dom` 的 import 合并）。组件内加：

```tsx
  const location = useLocation();
  const jumpPara = (location.state as { paraIndex?: number } | null)?.paraIndex ?? null;
```

把「Restore the previous scroll offset」那个 effect（`restoredRef`）改成：跳转载荷优先，命中则跳过滚动恢复。

```tsx
  const restoredRef = useRef<string | null>(null);
  useEffect(() => {
    if (!id || view !== "ready" || restoredRef.current === id) return;
    restoredRef.current = id;
    if (jumpPara !== null) {
      const scrollToPara = () => {
        const el = document.querySelector<HTMLElement>(
          jumpPara >= 0
            ? `[data-para-index="${jumpPara}"]`
            : '[data-para-index="0"]',
        );
        if (el) el.scrollIntoView({ block: "start", behavior: "auto" });
        // 消费一次：从别处再进来时不该继续往这段跳。
        window.history.replaceState({}, "");
      };
      requestAnimationFrame(scrollToPara);
      return;
    }
    const y = loadScroll(id);
    if (y && y > 0) {
      requestAnimationFrame(() => window.scrollTo({ top: y, behavior: "auto" }));
    }
  }, [id, view, jumpPara]);
```

`para_index` 为 -1（跨段/取不到时的存档值）时落到第 0 段；序号越界则 `querySelector` 落空、只打开文章不滚动，不报错。

Run: `node scripts/stop-desktop.mjs; pnpm build 2>&1 | tail -6`
Expected: build 成功。

- [ ] **Step 4: 样式**

`src/App.css` 末尾（`/* 好句摘录 */` 一段）：

```css
.sentence-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 14px; }
.sentence-row { border-bottom: 1px solid var(--line, rgba(0,0,0,.08)); padding-bottom: 12px; }
.sentence-quote { display: block; background: none; border: 0; padding: 0; text-align: left;
  font: inherit; line-height: 1.6; cursor: pointer; color: inherit; }
.sentence-quote:hover { text-decoration: underline; }
.sentence-meta { display: flex; align-items: center; gap: 8px; margin-top: 6px; font-size: 12px; }
.sentence-del { margin-left: auto; background: none; border: 0; cursor: pointer;
  font-size: 16px; line-height: 1; color: inherit; opacity: .45; }
.sentence-del:hover { opacity: 1; }
```

先确认既有 CSS 变量名：`grep -n -- "--line" src/App.css | head -3`，若项目里没有 `--line` 这个自定义属性，把 `var(--line, …)` 换成相邻列表（`.lookup-*` 那一类）实际用的颜色，别留一个不存在的变量。

- [ ] **Step 5: 真机走一遍（浏览器模式 invoke 不可用，必须桌面）**

Run: `pnpm dev:desktop`

逐项确认，任何一条不成立就停下修，不要标完成：
1. 打开一篇文章，选中一句英文 → 浮窗出现「加入生词库」「加入短语组合」「收一句」，点「收一句」→ 变「已收到」→ 浮窗自行关闭；
2. 只点一个词 → 浮窗没有「收一句」；
3. 回到同一篇选同一句再收 → 列表里仍只有一行；
4. 去生词页「句子」tab → 有这句，出处标题与日期对；
5. 点这句 → 跳到 Reader 并停在它所在的那一段（不是上次读到的位置）；
6. 从 Home 再进同一篇 → 恢复的是正常滚动位置，不重复跳；
7. 行尾 × 删除 → 行消失，重开 App 不复活；
8. 回主界面划词（Home）→ 浮窗没有「收一句」。

桌面会话结束执行 `pnpm clean:rust`。

- [ ] **Step 6: 全量验证**

Run: `node scripts/stop-desktop.mjs; pnpm test 2>&1 | tail -6 && pnpm build 2>&1 | tail -6 && (cd src-tauri && cargo test 2>&1 | tail -12)`
Expected: 三者全绿。

- [ ] **Step 7: 提交**

```bash
git add src/components/SavedSentences.tsx src/pages/Vocab.tsx src/pages/Reader.tsx src/App.css
git commit -m "feat(vocab): saved-sentence tab with jump back to paragraph"
```

---

## 收尾核对（对照 spec §9）

- [ ] spec §9 的九条验收逐条打勾，其中"源文章被清掉后快照仍在"用命令行验证：先收一句，再 `sqlite3` 删掉那篇 `articles` 行，`list_sentences` 仍返回它（Task 1 Step 1 的 `insert_survives_missing_or_null_article` 已覆盖等价逻辑，真机不必再手工删库）
- [ ] 复习链路零改动：`git diff main --stat` 里不出现 `srs.rs`、`db/memory.rs`、`Vocab` 的四个既有 tab 的分支逻辑
