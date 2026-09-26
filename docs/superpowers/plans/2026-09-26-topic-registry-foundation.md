# 话题底座（Stage 1：注册表 + 归入 + 实测）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把每篇入库文章归入一个"活话题"（能归入就不新立，新立只能生大类），并在**真实语料上回填 200 篇、量出它到底碎不碎**——这是本阶段唯一的交付物。

**Architecture:** 两张新表（`topics` / `article_topics`）+ 一个纯 Rust 的候选重叠打分 + 一次 LLM 终判（带解析层的硬约束校验）。判定偏向归入，因为碎比错更难修。话题会沉降（45 天无新文章退出候选池），并提供一键合并与近重检出作为人工兜底。

**Tech Stack:** Rust（rusqlite/bundled SQLite、chrono、serde_json、reqwest via 既有 `vocab::chat_json_array`）、ts-rs（本阶段不导出前端类型：没有界面消费）。

**Spec:** `docs/superpowers/specs/2026-09-26-topic-registry-design.md` §3 + §9 第 1 步 + §11。**本计划只做 Stage 1**：spec §9 第 2–4 步（侧边栏话题节、话题页、前情提要、对照卡、术语线）各需一份独立计划，且按 spec 的明文要求必须等本阶段的实测结果出来再盖——实测不达标就上界面，等于在碎掉的底座上盖楼。

**Spec 覆盖缺口（实施前须知）:** spec §3.1 列了 5 张表，其中 `topic_recaps` / `compare_cards` / `article_chunks` 属 Stage 2–4，本计划**不建**（YAGNI：没有消费方）。§3.1 的 `topics`/`article_topics` 全部建齐。

## Global Constraints

- 不引入任何新依赖：无 embedding、无聚类库、无语义模型、无 npm/cargo 新增（spec §2 Non-goals 第一条）。
- 迁移号：`db/mod.rs` 当前 `const LATEST_VERSION: i64 = 14`；顺手收一句计划占 v15，**本计划占 v16**。若执行时 v15 尚未合并，则本计划的迁移号顺位前移为 15，并同步改 `2026-09-26-saved-sentence.md` 的号，两者不得同号。
- 不改 `rank.rs` 的兴趣打分，不改 `tags_json` 的生成与用法：标签继续作为打分信号，只是本阶段之后不再当浏览入口（那是 Stage 2 的界面改动，不在这里）。
- 现有 `fill_missing_tags` / `fill_missing_card_zh` 的行为与数据一律不动。
- 无 API Key 时：command 返回 0、enrich 返回中文错误、刷新不报错（与既有 enrich 完全一致）。
- 所有阈值（45 天沉降、候选 top-5、key_terms 上限 60、共用词 ≥2 拒绝新立）写成 `const`，供 Task 7 实测后一次性校准；**不做成用户可配置项**。
- 跑测试前先 `node scripts/stop-desktop.mjs`。提交只 `git add` 点名文件（工作区有未完成的抽取相关改动）。

## File map

| File | 责任 |
|---|---|
| `src-tauri/src/db/mod.rs` | `mod topics;` + re-export + v16 迁移（两张表） |
| `src-tauri/src/db/topics.rs` | 话题行/边读写、`token_set` 与候选打分（纯函数）、key_terms 累积淘汰、沉降、合并、近重检出 |
| `src-tauri/src/db/articles.rs` | `articles_missing_topic`（照 `articles_missing_tags:782`） |
| `src-tauri/src/vocab.rs` | `TopicCandidate`/`TopicAssignOut`、`assign_article_topics`（LLM）、`validate_assignment`（纯校验，拒绝分支全部可测） |
| `src-tauri/src/feeds/enrich.rs` | `fill_missing_topics` + `TOPICS_PER_REFRESH`（复用既有 `run_with_split`） |
| `src-tauri/src/feeds/{mod,pipeline}.rs` | 导出与刷新挂钩 |
| `src-tauri/src/commands/articles.rs` + `lib.rs` | `fill_missing_topics` command |
| `src-tauri/src/feeds/tests.rs` | `#[ignore]` 的真实语料回填实测（照既有 `audit_live_coverage_report` 的形状） |

---

### Task 1: 两张表 + `Topic` 结构 + 基础读写

**Files:**
- Create: `src-tauri/src/db/topics.rs`
- Modify: `src-tauri/src/db/mod.rs`（模块声明 7–20 行；`const LATEST_VERSION` 586 行；v15 块之后）
- Test: `src-tauri/src/db/topics.rs` 内 `#[cfg(test)] mod tests`

**Interfaces:**
- Consumes: `crate::error::AppError`；`articles` 表只读
- Produces:
  - `pub struct Topic { id: String, name: String, blurb: String, key_terms: Vec<String>, status: TopicStatus, created_at: String, last_seen_at: String, merged_into: Option<String> }`，`pub enum TopicStatus { Active, Dormant, Merged }`（`as_str`/`from_str`）
  - `pub fn create_topic(conn, name: &str, blurb: &str, key_terms: &[String]) -> Result<Topic, AppError>`
  - `pub fn get_topic(conn, id: &str) -> Result<Option<Topic>, AppError>`
  - `pub fn list_active_topics(conn) -> Result<Vec<Topic>, AppError>`
  - `pub fn attach_article_topic(conn, article_id: &str, topic_id: &str) -> Result<(), AppError>`（幂等）
  - `pub fn article_topic_ids(conn, article_id: &str) -> Result<Vec<String>, AppError>`

- [ ] **Step 1: 写失败的单测**

`src-tauri/src/db/topics.rs`：

```rust
#[cfg(test)]
mod tests {
    use super::*;

    fn setup() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE articles (id TEXT PRIMARY KEY);
             INSERT INTO articles (id) VALUES ('a1'), ('a2');
             CREATE TABLE topics (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                blurb TEXT NOT NULL DEFAULT '',
                key_terms_json TEXT NOT NULL DEFAULT '[]',
                status TEXT NOT NULL DEFAULT 'active',
                created_at TEXT NOT NULL,
                last_seen_at TEXT NOT NULL,
                merged_into TEXT
             );
             CREATE TABLE article_topics (
                article_id TEXT NOT NULL,
                topic_id TEXT NOT NULL,
                PRIMARY KEY (article_id, topic_id)
             );",
        )
        .unwrap();
        conn
    }

    #[test]
    fn create_read_roundtrip_keeps_key_terms() {
        let conn = setup();
        let t = create_topic(&conn, "美联储与利率", "美国货币政策与利率决定", &["fed".into(), "rate".into()]).unwrap();
        assert_eq!(t.status, TopicStatus::Active);
        let got = get_topic(&conn, &t.id).unwrap().unwrap();
        assert_eq!(got.name, "美联储与利率");
        assert_eq!(got.key_terms, vec!["fed", "rate"]);
        assert_eq!(list_active_topics(&conn).unwrap().len(), 1);
    }

    #[test]
    fn create_rejects_blank_name() {
        let conn = setup();
        assert!(create_topic(&conn, "   ", "b", &[]).is_err());
    }

    #[test]
    fn create_deduplicates_by_name_case_and_space_insensitive() {
        let conn = setup();
        let a = create_topic(&conn, "US Election", "", &[]).unwrap();
        let b = create_topic(&conn, "us  election", "", &[]);
        match b {
            Ok(existing) => assert_eq!(existing.id, a.id),
            Err(e) => panic!("同名（忽略大小写与空格）应返回既有话题，却报错：{e}"),
        }
        assert_eq!(list_active_topics(&conn).unwrap().len(), 1, "同名不得立出第二条");
    }

    #[test]
    fn attach_is_idempotent_and_caps_at_two_per_article() {
        let conn = setup();
        let t1 = create_topic(&conn, "T1", "", &[]).unwrap();
        let t2 = create_topic(&conn, "T2", "", &[]).unwrap();
        let t3 = create_topic(&conn, "T3", "", &[]).unwrap();
        attach_article_topic(&conn, "a1", &t1.id).unwrap();
        attach_article_topic(&conn, "a1", &t1.id).unwrap();
        assert_eq!(article_topic_ids(&conn, "a1").unwrap().len(), 1);
        attach_article_topic(&conn, "a1", &t2.id).unwrap();
        assert!(attach_article_topic(&conn, "a1", &t3.id).is_err(), "每篇最多 2 个话题");
        // 边表允许一篇挂两个话题，但不允许同一对重复。
        assert_eq!(
            conn.query_row::<i64, _, _>("SELECT COUNT(*) FROM article_topics", [], |r| r.get(0)).unwrap(),
            2
        );
    }

    #[test]
    fn attach_rejects_unknown_rows() {
        let conn = setup();
        let t = create_topic(&conn, "T", "", &[]).unwrap();
        assert!(attach_article_topic(&conn, "nope", &t.id).is_err());
        assert!(attach_article_topic(&conn, "a1", "nope").is_err());
    }
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd src-tauri && cargo test topics 2>&1 | tail -15`
Expected: 编译失败 —— `cannot find function create_topic`。

- [ ] **Step 3: 写实现**

加在测试模块之前：

```rust
//! 活话题注册表：话题由语料自己长出来，不预设清单（spec §3）。

/// 每篇最多挂几个话题（spec §3.1）。`attach_article_topic` 与 LLM 提示词共用这一个数。
pub const MAX_TOPICS_PER_ARTICLE: i64 = 2;

use crate::error::AppError;
use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

/// 一个话题。`key_terms` 是它的代表英文词，既是候选打分的依据，也随归入累积。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Topic {
    pub id: String,
    pub name: String,
    pub blurb: String,
    pub key_terms: Vec<String>,
    pub status: TopicStatus,
    pub created_at: String,
    pub last_seen_at: String,
    pub merged_into: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub enum TopicStatus {
    Active,
    Dormant,
    Merged,
}

impl TopicStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Active => "active",
            Self::Dormant => "dormant",
            Self::Merged => "merged",
        }
    }

    fn from_str(s: &str) -> Self {
        match s {
            "dormant" => Self::Dormant,
            "merged" => Self::Merged,
            _ => Self::Active,
        }
    }
}

const TOPIC_COLS: &str =
    "id,name,blurb,key_terms_json,status,created_at,last_seen_at,merged_into";

fn map_topic(row: &rusqlite::Row<'_>) -> rusqlite::Result<Topic> {
    let key_terms_json: String = row.get(3)?;
    let status: String = row.get(4)?;
    Ok(Topic {
        id: row.get(0)?,
        name: row.get(1)?,
        blurb: row.get(2)?,
        key_terms: serde_json::from_str(&key_terms_json).unwrap_or_default(),
        status: TopicStatus::from_str(&status),
        created_at: row.get(5)?,
        last_seen_at: row.get(6)?,
        merged_into: row.get(7)?,
    })
}

/// 名字去重键：小写 + 压掉所有空白。「US Election」与「us election」是同一条。
fn name_key(name: &str) -> String {
    name.chars()
        .filter(|c| !c.is_whitespace())
        .flat_map(char::to_lowercase)
        .collect()
}

pub fn create_topic(
    conn: &Connection,
    name: &str,
    blurb: &str,
    key_terms: &[String],
) -> Result<Topic, AppError> {
    let name = name.trim();
    if name.is_empty() {
        return Err(AppError::msg("话题名为空"));
    }
    let needle = name_key(name);
    // 同名的 active/dormant 话题直接复用：新立一条同名话题就是"碎"的开始。
    if let Some(existing) = conn
        .prepare(&format!("SELECT {TOPIC_COLS} FROM topics"))?
        .query_map([], map_topic)?
        .filter_map(Result::ok)
        .find(|t| t.status != TopicStatus::Merged && name_key(&t.name) == needle)
    {
        return Ok(existing);
    }
    let now = Utc::now().to_rfc3339();
    let topic = Topic {
        id: uuid::Uuid::new_v4().to_string(),
        name: name.to_string(),
        blurb: blurb.trim().to_string(),
        key_terms: key_terms.to_vec(),
        status: TopicStatus::Active,
        created_at: now.clone(),
        last_seen_at: now,
        merged_into: None,
    };
    conn.execute(
        "INSERT INTO topics (id,name,blurb,key_terms_json,status,created_at,last_seen_at,merged_into)
         VALUES (?1,?2,?3,?4,?5,?6,?7,NULL)",
        params![
            topic.id,
            topic.name,
            topic.blurb,
            serde_json::to_string(&topic.key_terms)?,
            topic.status.as_str(),
            topic.created_at,
            topic.last_seen_at,
        ],
    )?;
    Ok(topic)
}

pub fn get_topic(conn: &Connection, id: &str) -> Result<Option<Topic>, AppError> {
    Ok(conn
        .query_row(
            &format!("SELECT {TOPIC_COLS} FROM topics WHERE id=?1"),
            params![id],
            |row| map_topic(row),
        )
        .optional()?)
}

/// 候选池与侧边栏都只取 active（spec §3.3 第 2 件）。
pub fn list_active_topics(conn: &Connection) -> Result<Vec<Topic>, AppError> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {TOPIC_COLS} FROM topics WHERE status='active' ORDER BY last_seen_at DESC"
    ))?;
    Ok(stmt.query_map([], |row| map_topic(row))?.collect::<Result<Vec<_>, _>>()?)
}

pub fn attach_article_topic(
    conn: &Connection,
    article_id: &str,
    topic_id: &str,
) -> Result<(), AppError> {
    let known = conn
        .query_row("SELECT 1 FROM topics WHERE id=?1", params![topic_id], |_| Ok(()))
        .optional()?
        .is_some();
    if !known {
        return Err(AppError::msg(format!("话题不存在：{topic_id}")));
    }
    let has_article = conn
        .query_row("SELECT 1 FROM articles WHERE id=?1", params![article_id], |_| Ok(()))
        .optional()?
        .is_some();
    if !has_article {
        return Err(AppError::msg(format!("文章不存在：{article_id}")));
    }
    let already: i64 = conn.query_row(
        "SELECT COUNT(*) FROM article_topics WHERE article_id=?1 AND topic_id=?2",
        params![article_id, topic_id],
        |r| r.get(0),
    )?;
    if already > 0 {
        return Ok(());
    }
    let count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM article_topics WHERE article_id=?1",
        params![article_id],
        |r| r.get(0),
    )?;
    if count >= MAX_TOPICS_PER_ARTICLE {
        return Err(AppError::msg("一篇文章最多挂两个话题"));
    }
    conn.execute(
        "INSERT INTO article_topics (article_id, topic_id) VALUES (?1, ?2)",
        params![article_id, topic_id],
    )?;
    Ok(())
}

pub fn article_topic_ids(conn: &Connection, article_id: &str) -> Result<Vec<String>, AppError> {
    let mut stmt = conn.prepare(
        "SELECT topic_id FROM article_topics WHERE article_id=?1 ORDER BY rowid",
    )?;
    Ok(stmt.query_map(params![article_id], |r| r.get(0))?.collect::<Result<Vec<_>, _>>()?)
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd src-tauri && cargo test topics 2>&1 | tail -15`
Expected: 5 个测试全绿。

- [ ] **Step 5: 加 v16 迁移与模块注册**

`src-tauri/src/db/mod.rs`：`mod sentences;` 之后加 `mod topics;`，`pub use sentences::*;` 之后加 `pub use topics::*;`；`const LATEST_VERSION: i64 = 15;`（Task 顺手收一句已推到的值）→ `16`；v15 块之后加：

```rust
    if stored < 16 {
        // 活话题注册表（spec §3.1）。沉降/合并是这张表上的状态位，不另开表。
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS topics (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                blurb TEXT NOT NULL DEFAULT '',
                key_terms_json TEXT NOT NULL DEFAULT '[]',
                status TEXT NOT NULL DEFAULT 'active',
                created_at TEXT NOT NULL,
                last_seen_at TEXT NOT NULL,
                merged_into TEXT
             );
             CREATE TABLE IF NOT EXISTS article_topics (
                article_id TEXT NOT NULL,
                topic_id TEXT NOT NULL,
                PRIMARY KEY (article_id, topic_id)
             );
             CREATE INDEX IF NOT EXISTS idx_topic_articles_article ON article_topics(article_id);
             CREATE INDEX IF NOT EXISTS idx_topic_articles_topic ON article_topics(topic_id);
             CREATE INDEX IF NOT EXISTS idx_topics_status_seen ON topics(status, last_seen_at DESC);",
        )?;
        conn.pragma_update(None, "user_version", 16)?;
        stored = 16;
    }
```

- [ ] **Step 6: 全量后端测试**

Run: `cd src-tauri && cargo test 2>&1 | tail -15`
Expected: 全绿，无 `incomplete schema migration`。

- [ ] **Step 7: 提交**

```bash
git add src-tauri/src/db/topics.rs src-tauri/src/db/mod.rs
git commit -m "feat(topics): topic registry tables and repository basics"
```

---

### Task 2: 便宜的候选挑选（纯函数：token 集 + 重叠打分）

**Files:**
- Modify: `src-tauri/src/db/topics.rs`（追加纯函数 + 测试）

**Interfaces:**
- Consumes: 无（纯字符串运算，不碰库）
- Produces:
  - `pub fn token_set(text: &str) -> std::collections::HashSet<String>`
  - `pub fn topic_overlap(article_tokens: &HashSet<String>, key_terms: &[String]) -> f64`
  - `pub fn pick_candidates(topics: &[Topic], article_tokens: &HashSet<String>, want: usize) -> Vec<&Topic>`
  - `pub const CANDIDATE_TOP_N: usize = 5;`

- [ ] **Step 1: 写失败的单测**

```rust
    #[test]
    fn token_set_lowercases_stops_and_splits_hyphens() {
        let t = token_set("The Fed's rate-cut plan, says Wall Street");
        assert!(t.contains("fed"));
        assert!(t.contains("rate"), "连字符应切开：rate-cut → rate/cut");
        assert!(t.contains("cut"));
        assert!(!t.contains("the"), "停用词不入集");
        assert!(!t.contains("says"));
        assert!(!t.contains("plan"), "词长 <4 的常见动词/名词按停用处理");
        assert!(t.contains("street"));
    }

    #[test]
    fn overlap_is_share_over_topic_side_not_article_side() {
        // 分母固定取话题规模：命中了它多少词才算数，
        // 否则一个 60 词的长话题会因为词多而更容易被选中。
        let a = token_set("fed rate hold inflation economy growth forecast outlook");
        let big = vec!["fed".into(), "rate".into(), "inflation".into(), "hold".into(),
                       "dollar".into(), "bond".into(), "yield".into(), "treasury".into()];
        let small = vec!["fed".into(), "rate".into()];
        let big_score = topic_overlap(&a, &big);
        let small_score = topic_overlap(&a, &small);
        assert!((big_score - 0.5).abs() < 1e-9, "4/8：{big_score}");
        assert!((small_score - 1.0).abs() < 1e-9, "2/2：{small_score}");
        assert!(small_score > big_score);
    }

    #[test]
    fn overlap_of_an_empty_key_term_list_is_zero_not_nan() {
        let a = token_set("fed rate hold inflation");
        assert_eq!(topic_overlap(&a, &[]), 0.0);
    }

    #[test]
    fn candidates_exclude_zero_overlap_and_long_lists_do_not_dominate() {
        // 一条 60 词的话题若只命中 2 个词，必须排在一条 4 词命中 3 个的话题之后：
        // "长表霸屏"是本步最容易静默发生的错误。
        let big = Topic { key_terms: (0..60).map(|i| format!("term{i:02}")).chain(std::iter::once("fed".into())).collect(), ..blank("big") };
        let focused = Topic { key_terms: vec!["fed".into(), "rate".into(), "hold".into()], ..blank("focused") };
        let unrelated = Topic { key_terms: vec!["election".into()], ..blank("unrelated") };
        let a = token_set("fed holds rate while inflation cools");
        let picked: Vec<&str> = pick_candidates(&[big, focused, unrelated], &a, 5)
            .into_iter().map(|t| t.id.as_str()).collect();
        assert_eq!(picked, vec!["focused", "big"], "零重合的 unrelated 不进候选");
    }

    #[test]
    fn candidates_are_capped_at_top_n() {
        let topics: Vec<Topic> = (0..9)
            .map(|i| Topic { key_terms: vec!["fed".into(), "rate".into(), format!("extra{i}")], ..blank(&format!("t{i}")) })
            .collect();
        let a = token_set("fed rate");
        assert_eq!(pick_candidates(&topics, &a, CANDIDATE_TOP_N).len(), CANDIDATE_TOP_N);
    }
```

`blank` 是本任务的测试助手（放在 `mod tests` 内）：

```rust
    fn blank(id: &str) -> Topic {
        Topic {
            id: id.into(),
            name: id.into(),
            blurb: String::new(),
            key_terms: Vec::new(),
            status: TopicStatus::Active,
            created_at: "2026-01-01T00:00:00+00:00".into(),
            last_seen_at: "2026-01-01T00:00:00+00:00".into(),
            merged_into: None,
        }
    }
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd src-tauri && cargo test topics::tests 2>&1 | tail -12`
Expected: 编译失败 —— `cannot find function token_set`。

- [ ] **Step 3: 写实现**

```rust
/// 送给 LLM 终判的候选数量（spec §3.2）。
pub const CANDIDATE_TOP_N: usize = 5;
/// 正文取多少字符参与候选打分：再多只是噪声，且回填 200 篇时要省钱省时。
pub const ARTICLE_TOKEN_WINDOW_CHARS: usize = 600;

/// 停用词只放"会污染重合度"的高频功能词与新闻套话，不做完整词表。
const STOPWORDS: &[&str] = &[
    "says", "said", "say", "told", "tell", "adds", "add", "write", "wrote", "notes",
    "according", "after", "before", "while", "with", "from", "into", "over", "under",
    "about", "that", "this", "these", "those", "what", "when", "where", "which", "who",
    "will", "would", "could", "should", "have", "have", "been", "being", "their", "there",
    "here", "more", "most", "other", "some", "such", "only", "then", "than", "also",
    "just", "very", "too", "how", "why", "new", "news", "year", "years", "day", "week",
    "today", "yesterday", "people", "world", "country", "states", "united", "report",
];

/// 小写、按非字母切词（连字符与空格同等）、去停用词、丢掉 3 字符以下。
/// 短词（a/the/of）重合度没有信息量，而 3 字符以下的实义词（GDP 类全大写已被
/// 小写化后长度 3 保留）太少见，不值得为它放宽噪声。
pub fn token_set(text: &str) -> std::collections::HashSet<String> {
    text.to_lowercase()
        .split(|c: char| !c.is_alphabetic())
        .filter(|w| w.chars().count() >= 4)
        .filter(|w| !STOPWORDS.contains(w))
        .map(str::to_string)
        .collect()
}

/// 本文命中了该话题多少词：交集 / 话题词表规模（见测试里的理由）。
pub fn topic_overlap(
    article_tokens: &std::collections::HashSet<String>,
    key_terms: &[String],
) -> f64 {
    if key_terms.is_empty() {
        return 0.0;
    }
    let hits = key_terms
        .iter()
        .filter(|k| article_tokens.contains(k.trim().to_lowercase().as_str()))
        .count();
    hits as f64 / key_terms.len() as f64
}

/// 取重合度最高的前 `want` 个候选；零重合的不进（否则等于给 LLM 塞噪声）。
/// 同分时按 id 稳定排序，保证同一篇文重跑得到同一批候选。
pub fn pick_candidates<'a>(
    topics: &'a [Topic],
    article_tokens: &std::collections::HashSet<String>,
    want: usize,
) -> Vec<&'a Topic> {
    let mut scored: Vec<(f64, &'a Topic)> = topics
        .iter()
        .map(|t| (topic_overlap(article_tokens, &t.key_terms), t))
        .filter(|(score, _)| *score > 0.0)
        .collect();
    scored.sort_by(|a, b| {
        b.0.partial_cmp(&a.0)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.1.id.cmp(&b.1.id))
    });
    scored.truncate(want);
    scored.into_iter().map(|(_, t)| t).collect()
}
```

注意 `STOPWORDS` 里 `"have"` 写重了一次 —— 顺手删掉重复项（不影响正确性，但会招 clippy）。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd src-tauri && cargo test topics::tests 2>&1 | tail -12`
Expected: 全绿。若 `plan/plan` 类词意外被保留或 `candidates_exclude_zero_overlap...` 的期望顺序变了，是停用词/平键的问题，按实际输出校正**测试**前先确认实现意图。

- [ ] **Step 5: 提交**

```bash
git add src-tauri/src/db/topics.rs
git commit -m "feat(topics): keyword-overlap candidate scoring without a semantic model"
```

---

### Task 3: LLM 终判 + 解析层硬约束（`validate_assignment` 是可测的那个函数）

**Files:**
- Modify: `src-tauri/src/vocab.rs`（在 `assign_article_tags:262` 之后加一节）
- Test: `src-tauri/src/vocab.rs` 内 `#[cfg(test)] mod tests`

**Interfaces:**
- Consumes: 既有 `chat_json_array(cfg, system, payload, label)`、`ensure_configured`；Task 2 的 `Topic`
- Produces:
  - `pub struct TopicCandidate { id: String, name: String, blurb: String }`（`Serialize`）
  - `pub struct TopicArticleIn { title: String, summary_zh: String, candidates: Vec<TopicCandidate> }`（`Serialize`）
  - `pub struct NewTopicIn { name: String, blurb: String, key_terms: Vec<String>, why_not_existing: String }`（`Deserialize`）
  - `pub struct TopicAssignOut { topic_ids: Vec<String>, new_topic: Option<NewTopicIn> }`（`Deserialize, Default`）
  - `pub enum TopicDecision { AssignTo(Vec<String>), Create(NewTopicIn), Rejected(&'static str) }`（`Debug/PartialEq`）
  - `pub fn validate_assignment(out: &TopicAssignOut, candidates: &[TopicCandidate], existing: &[Topic]) -> TopicDecision`
  - `pub fn assign_article_topics(cfg: &AppConfig, inputs: &[TopicArticleIn]) -> Result<Vec<TopicAssignOut>, AppError>`

- [ ] **Step 1: 写失败的单测（每条拒绝分支都要有一条）**

```rust
    fn cand(id: &str, name: &str) -> TopicCandidate {
        TopicCandidate { id: id.into(), name: name.into(), blurb: String::new() }
    }

    fn topic(id: &str, name: &str, terms: &[&str]) -> Topic {
        Topic { id: id.into(), name: name.into(), key_terms: terms.iter().map(|t| t.to_string()).collect(), ..blank_topic() }
    }

    fn new_topic(name: &str, why: &str, terms: &[&str]) -> NewTopicIn {
        NewTopicIn {
            name: name.into(),
            blurb: "一句话界定".into(),
            key_terms: terms.iter().map(|t| t.to_string()).collect(),
            why_not_existing: why.into(),
        }
    }

    fn existing_pool() -> Vec<Topic> {
        vec![
            topic("t1", "美联储与利率", &["fed", "rate", "inflation"]),
            topic("t2", "国会与立法", &["congress", "senate", "bill"]),
            topic("t3", "乌克兰战争", &["ukraine", "russia", "missile"]),
        ]
    }

    fn three_cands() -> Vec<TopicCandidate> {
        vec![cand("t1", "美联储与利率"), cand("t2", "国会与立法"), cand("t3", "乌克兰战争")]
    }

    #[test]
    fn assigning_to_known_candidates_is_accepted_in_order() {
        let out = TopicAssignOut { topic_ids: vec!["t3".into(), "t1".into()], new_topic: None };
        assert_eq!(
            validate_assignment(&out, &three_cands(), &existing_pool()),
            TopicDecision::AssignTo(vec!["t3".into(), "t1".into()])
        );
    }

    #[test]
    fn assigning_beyond_two_topics_is_rejected() {
        let out = TopicAssignOut { topic_ids: vec!["t1".into(), "t2".into(), "t3".into()], new_topic: None };
        assert!(matches!(validate_assignment(&out, &three_cands(), &existing_pool()), TopicDecision::Rejected(_)));
    }

    #[test]
    fn assigning_the_same_topic_twice_is_deduplicated() {
        let out = TopicAssignOut { topic_ids: vec!["t1".into(), "t1".into()], new_topic: None };
        assert_eq!(validate_assignment(&out, &three_cands(), &existing_pool()),
                   TopicDecision::AssignTo(vec!["t1".into()]));
    }

    #[test]
    fn invented_topic_id_is_rejected_not_resurrected() {
        // 模型很爱现编 id；这种必须整条判失败，不能"当作新话题"收下。
        let out = TopicAssignOut { topic_ids: vec!["t9".into()], new_topic: None };
        assert!(matches!(validate_assignment(&out, &three_cands(), &existing_pool()), TopicDecision::Rejected(_)));
    }

    #[test]
    fn assign_and_create_are_mutually_exclusive() {
        let out = TopicAssignOut { topic_ids: vec!["t1".into()], new_topic: Some(new_topic("中东", "都不合适", &["israel"])) };
        assert!(matches!(validate_assignment(&out, &three_cands(), &existing_pool()), TopicDecision::Rejected(_)));
    }

    #[test]
    fn empty_answer_is_rejected() {
        let out = TopicAssignOut { topic_ids: vec![], new_topic: None };
        assert!(matches!(validate_assignment(&out, &three_cands(), &existing_pool()), TopicDecision::Rejected(_)));
    }

    #[test]
    fn a_specific_event_name_is_rejected_as_a_new_topic() {
        // 新立只允许大类。带年份/月份/序数这类"为本文临时造的名字"必须挡下。
        let out = TopicAssignOut { topic_ids: vec![], new_topic: Some(new_topic("9 月 FOMC 决议", "美联储与利率 不涵盖决定本身 国会与立法 无关 乌克兰战争 无关", &["fed", "fomc"])) };
        assert!(matches!(validate_assignment(&out, &three_cands(), &existing_pool()), TopicDecision::Rejected(_)));
    }

    #[test]
    fn a_new_topic_needs_at_least_two_key_terms() {
        let out = TopicAssignOut { topic_ids: vec![], new_topic: Some(new_topic("人工智能与芯片", "美联储与利率 不相关 国会与立法 不相关 乌克兰战争 不相关", &["chip"])) };
        assert!(matches!(validate_assignment(&out, &three_cands(), &existing_pool()), TopicDecision::Rejected(_)));
    }

    #[test]
    fn why_must_name_every_candidate_or_the_new_topic_is_rejected() {
        let out = TopicAssignOut { topic_ids: vec![], new_topic: Some(new_topic("人工智能与芯片", "都不太合适", &["chip", "ai"])) };
        assert!(matches!(validate_assignment(&out, &three_cands(), &existing_pool()), TopicDecision::Rejected(_)));
    }

    #[test]
    fn a_full_why_that_names_every_candidate_opens_a_new_topic() {
        let why = "美联储与利率讲的是货币政策，本文是芯片出口管制；国会与立法只覆盖立法程序，本文主体是行政部门决定；乌克兰战争是欧洲战事，与东亚半导体无关。";
        let out = TopicAssignOut { topic_ids: vec![], new_topic: Some(new_topic("半导体与出口管制", why, &["chip", "export"])) };
        match validate_assignment(&out, &three_cands(), &existing_pool()) {
            TopicDecision::Create(n) => assert_eq!(n.name, "半导体与出口管制"),
            other => panic!("应当放行新立，实得 {other:?}"),
        }
    }

    #[test]
    fn a_new_topic_sharing_two_key_terms_with_an_existing_one_folds_into_it() {
        // 新立名与既有 active 话题共用 ≥2 个 key_terms → 拒绝新立，转为归入。
        let why = "美联储与利率 是货币政策 本文不同；国会与立法 是立法；乌克兰战争 是战事。";
        let out = TopicAssignOut { topic_ids: vec![], new_topic: Some(new_topic("美国利率前景", why, &["fed", "rate", "treasury"])) };
        assert_eq!(validate_assignment(&out, &three_cands(), &existing_pool()),
                   TopicDecision::AssignTo(vec!["t1".into()]));
    }
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd src-tauri && cargo test validate_assignment 2>&1 | tail -12`
Expected: 编译失败 —— 类型未定义。

- [ ] **Step 3: 写类型与校验**

```rust
/// 送给模型的一个候选话题。
#[derive(Serialize, Clone, Debug)]
pub struct TopicCandidate {
    pub id: String,
    pub name: String,
    pub blurb: String,
}

/// 一篇待判定文章 + 它的候选池（每篇不同，所以候选随条目一起送）。
#[derive(Clone, Serialize)]
pub struct TopicArticleIn {
    pub title: String,
    pub summary_zh: String,
    pub candidates: Vec<TopicCandidate>,
}

#[derive(Deserialize, Clone, Debug, PartialEq)]
pub struct NewTopicIn {
    pub name: String,
    #[serde(default)]
    pub blurb: String,
    #[serde(default)]
    pub key_terms: Vec<String>,
    #[serde(default)]
    pub why_not_existing: String,
}

#[derive(Deserialize, Default, Debug)]
pub struct TopicAssignOut {
    #[serde(default)]
    pub topic_ids: Vec<String>,
    #[serde(default)]
    pub new_topic: Option<NewTopicIn>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum TopicDecision {
    AssignTo(Vec<String>),
    Create(NewTopicIn),
    /// 判定失败原因；调用方把本篇留空待重试（spec §3.2 的硬约束组）。
    Rejected(&'static str),
}

/// 新立名字里"为本文临时造"的特征：数字、月份/序数、以及过短即弃。
fn looks_like_a_one_off_event(name: &str) -> bool {
    name.chars().any(|c| c.is_ascii_digit())
        || name.contains('月')
        || name.contains('周')
        || name.contains('第')
        || name.chars().count() < 4
}

/// 与既有话题共用多少个 key_terms（大小写无关）。
fn shared_terms(a: &[String], b: &[String]) -> usize {
    let lowered: std::collections::HashSet<String> = a.iter().map(|t| t.trim().to_lowercase()).collect();
    b.iter().filter(|t| lowered.contains(&t.trim().to_lowercase())).count()
}

/// 解析层的硬约束。目的只有一个：碎比错更难修，所以判定偏向归入。
/// 与既有话题共用 ≥2 词时不是拒绝而是**折进**重合度最高的那条（spec §3.2 最后一条）。
pub fn validate_assignment(
    out: &TopicAssignOut,
    candidates: &[TopicCandidate],
    existing: &[Topic],
) -> TopicDecision {
    let ids: Vec<String> = {
        let mut seen: Vec<String> = Vec::new();
        for id in &out.topic_ids {
            let id = id.trim();
            if id.is_empty() || seen.iter().any(|s| s == id) {
                continue;
            }
            seen.push(id.to_string());
        }
        seen
    };
    if !ids.is_empty() {
        // 归入与新立互斥。
        if out.new_topic.is_some() {
            return TopicDecision::Rejected("同时给了归入和新立");
        }
        if ids.len() > 2 {
            return TopicDecision::Rejected("一篇文章最多两个话题");
        }
        // 只认候选池里的 id：模型现编的 id 一律判失败。
        if ids.iter().any(|id| !candidates.iter().any(|c| &c.id == id)) {
            return TopicDecision::Rejected("话题 id 不在候选池里");
        }
        return TopicDecision::AssignTo(ids);
    }
    let Some(new) = out.new_topic.clone() else {
        return TopicDecision::Rejected("既没归入也没新立");
    };
    let name = new.name.trim();
    if name.is_empty() {
        return TopicDecision::Rejected("新立名为空");
    }
    if looks_like_a_one_off_event(name) {
        return TopicDecision::Rejected("新立必须是能覆盖一个月的大类");
    }
    let key_terms: Vec<String> = new
        .key_terms
        .iter()
        .map(|t| t.trim().to_lowercase())
        .filter(|t| !t.is_empty())
        .collect();
    if key_terms.len() < 2 {
        return TopicDecision::Rejected("新立话题至少需要两个代表词");
    }
    // why_not_existing 必须逐个点名候选；候选为 0 时（话题库还空）不要求。
    let why = new.why_not_existing.trim();
    if !candidates.is_empty() {
        let named = candidates.iter().filter(|c| why.contains(&c.name)).count();
        if named < candidates.len() {
            return TopicDecision::Rejected("新立理由没有点名每个候选");
        }
    }
    // 与既有话题撞车 → 折进重合度最高的那条，而不是立新的。
    let best = existing
        .iter()
        .filter(|t| t.status == crate::db::TopicStatus::Active)
        .map(|t| (shared_terms(&key_terms, &t.key_terms), t))
        .filter(|(n, _)| *n >= 2)
        .max_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.id.cmp(&b.1.id)));
    if let Some((_, fold)) = best {
        if candidates.iter().any(|c| c.id == fold.id) {
            return TopicDecision::AssignTo(vec![fold.id.clone()]);
        }
        return TopicDecision::Rejected("新立与既有话题词表重合，但它不在候选池里");
    }
    TopicDecision::Create(NewTopicIn {
        name: name.to_string(),
        blurb: new.blurb.trim().to_string(),
        key_terms,
        why_not_existing: why.to_string(),
    })
}
```

`existing_pool()` / `blank_topic()` 这两个测试助手需要在 `vocab.rs` 的 `mod tests` 里可用：`blank_topic()` 照 Task 2 的 `blank` 写一份（构造一个 active 的 `Topic`），并在测试模块顶部 `use crate::db::Topic;`。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd src-tauri && cargo test validate_assignment 2>&1 | tail -12`
Expected: 11 个测试全绿（Step 1 里每条 `#[test]` 对应一条拒绝/放行分支，缺哪个补哪个，不要合并）。

- [ ] **Step 5: 加 LLM 批量调用**

```rust
/// 批量话题判定。输入顺序 = 输出顺序；判定本身由 `validate_assignment` 负责，
/// 这里只负责要到 JSON。
pub fn assign_article_topics(
    cfg: &AppConfig,
    inputs: &[TopicArticleIn],
) -> Result<Vec<TopicAssignOut>, AppError> {
    if inputs.is_empty() {
        return Ok(vec![]);
    }
    ensure_configured(cfg)?;
    let system = r#"You file English news articles into a learner's topic registry.
You get a JSON array of {title, summary_zh, candidates:[{id,name,blurb}]}.
Return ONLY a JSON array of the same length; each item is either
  {"topic_ids":["<id>"],"new_topic":null}
or
  {"topic_ids":[],"new_topic":{"name":"…","blurb":"…","key_terms":["…","…"],"why_not_existing":"…"}}.

Rules, in priority order:
1. If ANY candidate covers the article, choose it. Filing under an existing topic is always preferred.
2. Only when no candidate fits may you create one. A new topic must be a BROAD CATEGORY that still covers next month's coverage of this subject: never a specific event, date, or headline.
3. topic_ids must be copied verbatim from that article's candidates. Never invent an id.
4. Choose 1 topic; use 2 only when the article genuinely sits at a crossroads. Never more than 2.
5. why_not_existing must name every single candidate in that article's candidate list and say in one clause why each does not fit. If you cannot, choose a candidate instead.
6. name and blurb are Simplified Chinese. key_terms are 3-8 lowercase English words that identify this topic.
No markdown fences, no commentary."#;
    let payload = serde_json::to_string(inputs)?;
    let out: Vec<TopicAssignOut> = chat_json_array(cfg, system, &payload, "article topics")?;
    if out.len() != inputs.len() {
        return Err(AppError::msg(format!(
            "topic assignment count mismatch: got {} expected {}",
            out.len(),
            inputs.len()
        )));
    }
    Ok(out)
}
```

- [ ] **Step 6: 编译 + 全量测试**

Run: `cd src-tauri && cargo test 2>&1 | tail -12`
Expected: 全绿（本任务的 LLM 调用不在单测里打网络，与 `translate_article_cards` 同样只测解析与边界）。

- [ ] **Step 7: 提交**

```bash
git add src-tauri/src/vocab.rs
git commit -m "feat(topics): LLM assignment with parse-layer anti-fragmentation constraints"
```

---

### Task 4: 归入落库 + key_terms 累积与淘汰

**Files:**
- Modify: `src-tauri/src/db/topics.rs`
- Test: 同文件测试模块

**Interfaces:**
- Consumes: Task 1 的 `create_topic`/`attach_article_topic`/`get_topic`；Task 2 的 `token_set`；Task 3 的 `TopicDecision`/`NewTopicIn`
- Produces:
  - `pub fn apply_topic_decision(conn, article_id: &str, decision: &TopicDecision, article_tokens: &HashSet<String>) -> Result<Option<String>, AppError>`（返回失败原因；`None` = 成功）
  - `pub fn merge_key_terms(existing: &[String], incoming: &[String], cap: usize) -> Vec<String>`
  - `pub const KEY_TERMS_CAP: usize = 60;`

- [ ] **Step 1: 写失败的单测**

```rust
    #[test]
    fn merge_key_terms_dedupes_case_and_caps_at_the_limit() {
        let existing: Vec<String> = (0..58).map(|i| format!("term{i:02}")).collect();
        let merged = merge_key_terms(&existing, &["TERM00".into(), "fresh".into()], KEY_TERMS_CAP);
        assert_eq!(merged.len(), KEY_TERMS_CAP, "超出上限时按低频淘汰");
        assert!(merged.contains(&"fresh".into()));
        assert_eq!(merged.iter().filter(|t| **t == "term00").count(), 1, "大小写不重复");
    }

    #[test]
    fn merge_key_terms_evicts_lowest_document_frequency() {
        // 计数在 JSON 里以 "word" 或 "word:3" 存；无计数按 1 算。
        let existing = vec!["rare:1".to_string(), "hot:9".to_string()];
        let merged = merge_key_terms(&existing, &["newcomer".into()], 2);
        assert_eq!(merged, vec!["hot".to_string(), "newcomer".to_string()]);
    }

    #[test]
    fn apply_create_makes_the_topic_and_attaches_it() {
        let conn = setup();
        let decision = TopicDecision::Create(NewTopicIn {
            name: "人工智能与芯片".into(),
            blurb: "AI 与半导体".into(),
            key_terms: vec!["chip".into(), "ai".into()],
            why_not_existing: "…".into(),
        });
        let tokens = token_set("chipmaker expands AI output");
        assert_eq!(apply_topic_decision(&conn, "a1", &decision, &tokens), None);
        assert_eq!(article_topic_ids(&conn, "a1").unwrap().len(), 1);
        let topic = get_topic(&conn, &article_topic_ids(&conn, "a1").unwrap()[0])
            .unwrap()
            .expect("新立的话题必须查得到");
        assert_eq!(topic.name, "人工智能与芯片");
        // 本文的词被并入话题，为下一篇的候选打分积累证据。
        assert!(topic.key_terms.contains(&"chip".into()));
        assert!(topic.key_terms.contains(&"ai".into()) || topic.key_terms.len() >= 2);
    }

    #[test]
    fn apply_assign_bumps_last_seen_and_accumulates_terms() {
        let conn = setup();
        let t = create_topic(&conn, "美联储与利率", "", &["fed".into()]).unwrap();
        let before = t.last_seen_at.clone();
        let decision = TopicDecision::AssignTo(vec![t.id.clone()]);
        let tokens = token_set("fed holds rate and signals patience");
        assert_eq!(apply_topic_decision(&conn, "a1", &decision, &tokens), None);
        let after = get_topic(&conn, &t.id).unwrap().unwrap();
        assert!(after.last_seen_at >= before, "归入必须续命，否则 45 天沉降会误杀活跃话题");
        assert!(after.key_terms.iter().any(|k| k.starts_with("rate")));
    }

    #[test]
    fn apply_rejected_decision_writes_nothing() {
        let conn = setup();
        assert_eq!(
            apply_topic_decision(&conn, "a1", &TopicDecision::Rejected("x"), &token_set("fed rate")),
            Some("x")
        );
        assert!(article_topic_ids(&conn, "a1").unwrap().is_empty());
        assert!(list_active_topics(&conn).unwrap().is_empty());
    }

    #[test]
    fn apply_assign_to_unknown_topic_reports_failure_without_panicking() {
        let conn = setup();
        let decision = TopicDecision::AssignTo(vec!["nope".into()]);
        let reason = apply_topic_decision(&conn, "a1", &decision, &token_set("fed rate hold"));
        assert!(matches!(reason, Some(_)), "id 不存在要报错而不是静默");
    }
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd src-tauri && cargo test topics::tests 2>&1 | tail -12`
Expected: 编译失败 —— `cannot find function merge_key_terms`。

- [ ] **Step 3: 写实现**

```rust
/// 话题词表上限（spec §3.2）。
pub const KEY_TERMS_CAP: usize = 60;

/// 一个 key_term 的文档频率（JSON 里写作 `word:3`；无冒号按 1 算）。
fn term_count(term: &str) -> u32 {
    term.rsplit_once(':')
        .and_then(|(_, n)| n.parse::<u32>().ok())
        .unwrap_or(1)
}

fn term_word(term: &str) -> &str {
    // 只有 "word:number" 形态才剥；词本身不含冒号。
    term.rsplit_once(':').map(|(w, _)| w).unwrap_or(term)
}

/// 新词并入既有词表，大小写与空格归一，超上限时淘汰最低频的那些。
pub fn merge_key_terms(existing: &[String], incoming: &[String], cap: usize) -> Vec<String> {
    let mut counts: std::collections::BTreeMap<String, u32> = std::collections::BTreeMap::new();
    for term in existing.iter().chain(incoming.iter()) {
        let word = term_word(term).trim().to_lowercase();
        if word.is_empty() {
            continue;
        }
        *counts.entry(word).or_insert(0) += term_count(term);
    }
    let mut rows: Vec<(String, u32)> = counts.into_iter().collect();
    rows.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    rows.truncate(cap);
    rows.into_iter().map(|(w, c)| if c > 1 { format!("{w}:{c}") } else { w }).collect()
}

/// 把一次判定写进库：归入 → 续命 + 累积词；新立 → 建话题 + 挂文章。
/// 返回 `Some(原因)` 表示本篇留空待重试（不做静默降级）。
pub fn apply_topic_decision(
    conn: &Connection,
    article_id: &str,
    decision: &crate::vocab::TopicDecision,
    article_tokens: &std::collections::HashSet<String>,
) -> Option<&'static str> {
    use crate::vocab::TopicDecision;
    let ids = match decision {
        TopicDecision::Rejected(reason) => return Some(reason),
        TopicDecision::Create(new) => {
            let mut terms = new.key_terms.clone();
            terms.extend(article_tokens.iter().cloned());
            let topic = match create_topic(conn, &new.name, &new.blurb, &merge_key_terms(&[], &terms, KEY_TERMS_CAP)) {
                Ok(t) => t,
                Err(_) => return Some("新立话题写库失败"),
            };
            vec![topic.id]
        }
        TopicDecision::AssignTo(ids) => ids.clone(),
    };
    let mut attached = 0usize;
    for id in &ids {
        // 累积证据 + 续命；失败原因要带出来，否则回填日志上一片空洞。
        match get_topic(conn, id) {
            Ok(Some(topic)) => {
                let merged = merge_key_terms(&topic.key_terms, &article_tokens.iter().cloned().collect::<Vec<_>>(), KEY_TERMS_CAP);
                let now = Utc::now().to_rfc3339();
                if let Err(_) = conn.execute(
                    "UPDATE topics SET key_terms_json=?1, last_seen_at=?2 WHERE id=?3",
                    params![serde_json::to_string(&merged).unwrap_or_else(|_| "[]".into()), now, id],
                ) { continue; }
            }
            Ok(None) => continue,
            Err(_) => continue,
        }
        if attach_article_topic(conn, article_id, id).is_err() {
            continue;
        }
        attached += 1;
    }
    if attached == 0 {
        return Some("话题判定写库没有落任何一条边");
    }
    None
}
```

上面用了 `Result` 上的 `.unwrap_or_else` 与忽略错误 —— 实施时把 `if let Err(_) = conn.execute(...)` 与 `Err(_) => continue` 这类"吞错误"改成正经分支并把错误文本带进 `Some(reason)`：**这条函数是碎不碎的唯一落库口，静默吞掉失败就等于把实测数据弄脏**（Task 7 的数字全部来自它）。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd src-tauri && cargo test topics::tests 2>&1 | tail -15`
Expected: 全绿。

- [ ] **Step 5: 提交**

```bash
git add src-tauri/src/db/topics.rs
git commit -m "feat(topics): persist decisions with key-term accumulation and eviction"
```

---

### Task 5: 防碎另两件 —— 沉降、合并、近重检出

**Files:**
- Modify: `src-tauri/src/db/topics.rs`
- Test: 同文件测试模块

**Interfaces:**
- Consumes: Task 1 的表读写；`topics.merged_into` / `status`
- Produces:
  - `pub fn settle_dormant_topics(conn, now: &DateTime<Utc>) -> Result<usize, AppError>` + `pub const DORMANT_AFTER_DAYS: i64 = 45;`
  - `pub fn merge_topics(conn, from_ids: &[String], into_id: &str) -> Result<Topic, AppError>`
  - `pub struct NearDuplicatePair { pub a_id: String, pub b_id: String, pub shared: usize }`
  - `pub fn list_near_duplicate_topics(conn, min_shared: usize, limit: usize) -> Result<Vec<NearDuplicatePair>, AppError>`

- [ ] **Step 1: 写失败的单测**

```rust
    /// 直接改写 last_seen_at 来模拟时间流逝（不 sleep、不注入时钟）。
    fn stamp(conn: &Connection, id: &str, when: &str) {
        conn.execute("UPDATE topics SET last_seen_at=?1 WHERE id=?2", params![when, id]).unwrap();
    }

    #[test]
    fn settle_dormant_only_touches_stale_active_rows() {
        let conn = setup();
        let old = create_topic(&conn, "老话题", "", &[]).unwrap();
        let fresh = create_topic(&conn, "新话题", "", &[]).unwrap();
        stamp(&conn, &old.id, "2020-01-01T00:00:00+00:00");
        let now = Utc.with_ymd_and_hms(2020, 3, 1).unwrap(); // 60 天后
        assert_eq!(settle_dormant_topics(&conn, &now).unwrap(), 1);
        assert_eq!(get_topic(&conn, &old.id).unwrap().unwrap().status, TopicStatus::Dormant);
        assert_eq!(get_topic(&conn, &fresh.id).unwrap().unwrap().status, TopicStatus::Active);
        // dormant 退出候选池，但历史文章仍挂在它名下（边不动）。
        assert!(!list_active_topics(&conn).unwrap().iter().any(|t| t.id == old.id));
        assert!(conn
            .query_row::<i64, _, _>("SELECT COUNT(*) FROM topics WHERE id=?1", params![old.id], |r| r.get(0))
            .unwrap() == 1);
    }

    #[test]
    fn settle_is_idempotent() {
        let conn = setup();
        let old = create_topic(&conn, "老话题", "", &[]).unwrap();
        stamp(&conn, &old.id, "2020-01-01T00:00:00+00:00");
        let now = Utc.with_ymd_and_hms(2021, 1, 1).unwrap();
        assert_eq!(settle_dormant_topics(&conn, &now).unwrap(), 1);
        assert_eq!(settle_dormant_topics(&conn, &now).unwrap(), 0);
    }

    #[test]
    fn merge_moves_articles_and_terms_and_tombstones_the_source() {
        let conn = setup();
        let into = create_topic(&conn, "美联储与利率", "", &["fed".into()]).unwrap();
        let from = create_topic(&conn, "美国利率", "", &["rate".into()]).unwrap();
        attach_article_topic(&conn, "a1", &from.id).unwrap();
        attach_article_topic(&conn, "a2", &into.id).unwrap();
        let merged = merge_topics(&conn, &[from.id.clone()], &into.id).unwrap();
        assert!(merged.key_terms.contains(&"fed".into()));
        assert!(merged.key_terms.contains(&"rate".into()));
        // from 的文章改挂到 into 名下。
        assert_eq!(article_topic_ids(&conn, "a1").unwrap(), vec![into.id.clone()]);
        assert_eq!(get_topic(&conn, &from.id).unwrap().unwrap().status, TopicStatus::Merged);
        assert_eq!(get_topic(&conn, &from.id).unwrap().unwrap().merged_into.as_deref(), Some(into.id.as_str()));
        assert_eq!(
            conn.query_row::<i64, _, _>("SELECT COUNT(*) FROM article_topics", [], |r| r.get(0)).unwrap(),
            2,
            "合并不能凭空多出一条边"
        );
    }

    #[test]
    fn merge_into_a_dead_target_is_rejected() {
        let conn = setup();
        let from = create_topic(&conn, "A", "", &[]).unwrap();
        assert!(merge_topics(&conn, &[from.id.clone()], "nope").is_err());
        // 自己合并到自己必须是错的。
        assert!(merge_topics(&conn, &[from.id.clone()], &from.id).is_err());
    }

    #[test]
    fn merge_rejects_an_already_merged_source_once() {
        let conn = setup();
        let into = create_topic(&conn, "Into", "", &[]).unwrap();
        let from = create_topic(&conn, "From", "", &[]).unwrap();
        merge_topics(&conn, &[from.id.clone()], &into.id).unwrap();
        // 第二次是幂等的（不报错、也不再改变任何东西）——界面重复点击不该炸。
        merge_topics(&conn, &[from.id.clone()], &into.id).unwrap();
        assert_eq!(get_topic(&conn, &from.id).unwrap().unwrap().status, TopicStatus::Merged);
    }

    #[test]
    fn near_duplicates_surface_word_sharing_pairs_not_themselves() {
        let conn = setup();
        let a = create_topic(&conn, "美联储与利率", "", &["fed".into(), "rate".into(), "inflation".into()]).unwrap();
        let b = create_topic(&conn, "美国利率前景", "", &["fed".into(), "rate".into(), "treasuries".into()]).unwrap();
        let c = create_topic(&conn, "乌克兰战争", "", &["ukraine".into(), "missile".into()]).unwrap();
        let pairs = list_near_duplicate_topics(&conn, 2, 10).unwrap();
        let ids: Vec<&str> = pairs.iter().flat_map(|p| [p.a_id.as_str(), p.b_id.as_str()]).collect();
        assert!(ids.contains(&a.id.as_str()) && ids.contains(&b.id.as_str()), "a/b 共用 fed+rate");
        assert!(!ids.contains(&c.id.as_str()), "只共用 0 个词的 c 不该出现");
        for p in &pairs {
            assert_ne!(p.a_id, p.b_id, "一条话题不该和自己配成近重");
            assert_eq!(p.shared, 2);
        }
    }
```

测试模块顶部需要 `use chrono::{DateTime, TimeZone, Utc};`。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd src-tauri && cargo test topics::tests 2>&1 | tail -12`
Expected: 编译失败 —— `cannot find function settle_dormant_topics`。

- [ ] **Step 3: 写实现**

```rust
/// 多少天没有新文章归入就沉底（spec §3.3 第 2 件）。
pub const DORMANT_AFTER_DAYS: i64 = 45;

/// 一次 UPDATE 完成沉降；不需要后台任务（刷新时顺手跑）。
pub fn settle_dormant_topics(conn: &Connection, now: &DateTime<Utc>) -> Result<usize, AppError> {
    let cutoff = now - chrono::Duration::days(DORMANT_AFTER_DAYS);
    Ok(conn.execute(
        "UPDATE topics SET status='dormant'
          WHERE status='active' AND last_seen_at < ?1",
        params![cutoff.to_rfc3339()],
    )?)
}

/// 把若干条并到主话题下：重写边、合并词表、源条打 tombstone。
/// 幂等：重跑不改变结果，因此界面重复点击安全。
pub fn merge_topics(conn: &Connection, from_ids: &[String], into_id: &str) -> Result<Topic, AppError> {
    let mut into = get_topic(conn, into_id)?
        .ok_or_else(|| AppError::msg(format!("目标话题不存在：{into_id}")))?;
    if into.status == TopicStatus::Merged {
        return Err(AppError::msg("目标话题已经被合并走了"));
    }
    for from_id in from_ids {
        if from_id == into_id {
            return Err(AppError::msg("不能把话题合并进它自己"));
        }
        let Some(from) = get_topic(conn, from_id)? else { continue };
        if from.status == TopicStatus::Merged && from.merged_into.as_deref() == Some(into_id) {
            continue;
        }
        conn.execute(
            "INSERT OR IGNORE INTO article_topics (article_id, topic_id)
             SELECT article_id, ?1 FROM article_topics WHERE topic_id=?2",
            params![into_id, from_id],
        )?;
        conn.execute("DELETE FROM article_topics WHERE topic_id=?1", params![from_id])?;
        into.key_terms = merge_key_terms(&into.key_terms, &from.key_terms, KEY_TERMS_CAP);
        conn.execute(
            "UPDATE topics SET key_terms_json=?1, status='merged', merged_into=?2 WHERE id=?3",
            params![serde_json::to_string(&into.key_terms)?, into_id, from_id],
        )?;
    }
    conn.execute(
        "UPDATE topics SET key_terms_json=?1 WHERE id=?2",
        params![serde_json::to_string(&into.key_terms)?, into_id],
    )?;
    into.last_seen_at = conn
        .query_row("SELECT last_seen_at FROM topics WHERE id=?1", params![into_id], |r| r.get(0))?;
    Ok(into)
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct NearDuplicatePair {
    pub a_id: String,
    pub b_id: String,
    pub shared: usize,
}

/// 词表重合度最高的若干对 active 话题，供界面提示"这两条像是一条"（spec §3.3 第 3 件）。
/// 只看 active：dormant/merged 的旧线不该再被提议合并。
pub fn list_near_duplicate_topics(
    conn: &Connection,
    min_shared: usize,
    limit: usize,
) -> Result<Vec<NearDuplicatePair>, AppError> {
    let topics = list_active_topics(conn)?;
    let mut pairs: Vec<NearDuplicatePair> = Vec::new();
    for (i, a) in topics.iter().enumerate() {
        for b in topics.iter().skip(i + 1) {
            let shared = a
                .key_terms
                .iter()
                .map(|t| term_word(t).to_lowercase())
                .filter(|t| {
                    b.key_terms
                        .iter()
                        .any(|k| term_word(k).to_lowercase() == *t)
                })
                .count();
            if shared >= min_shared {
                pairs.push(NearDuplicatePair { a_id: a.id.clone(), b_id: b.id.clone(), shared });
            }
        }
    }
    pairs.sort_by(|x, y| y.shared.cmp(&x.shared).then_with(|| x.a_id.cmp(&y.a_id)));
    pairs.truncate(limit);
    Ok(pairs)
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd src-tauri && cargo test topics::tests 2>&1 | tail -20`
Expected: 全绿。`merge_into_a_dead_target_is_rejected` 里"合并进不存在的 id"必须 `Err` 而非静默。

- [ ] **Step 5: 提交**

```bash
git add src-tauri/src/db/topics.rs
git commit -m "feat(topics): dormancy settling, manual merge and near-duplicate detection"
```

---

### Task 6: 回填管线 + command + 刷新挂钩

**Files:**
- Modify: `src-tauri/src/db/articles.rs`（`articles_missing_tags:782` 之后）
- Modify: `src-tauri/src/feeds/enrich.rs`（`fill_missing_tags:134` 之后）
- Modify: `src-tauri/src/feeds/mod.rs:49`（re-export 列表）
- Modify: `src-tauri/src/feeds/pipeline.rs:390` 附近（tags 之后）
- Modify: `src-tauri/src/commands/articles.rs:179` 附近
- Modify: `src-tauri/src/lib.rs`（`generate_handler!`）
- Test: `src-tauri/src/feeds/enrich.rs` 测试模块（不联网的部分）

**Interfaces:**
- Consumes: Task 1–5 全部；既有 `run_with_split`、`vocab::assign_article_topics`、`Article{ id, title, summary_zh, content_text }`
- Produces: `db::articles_missing_topic(conn, limit) -> Vec<Article>`、`feeds::fill_missing_topics(db, cfg, limit, on_progress) -> Result<usize, AppError>`、`pub const TOPICS_PER_REFRESH: usize = 40;`、Tauri command `fill_missing_topics(limit)`

- [ ] **Step 1: 取待判文章**

`src-tauri/src/db/articles.rs`，紧跟 `articles_missing_tags` 之后（同形，条件换成"没有任何话题边"）：

```rust
/// 尚未归入任何话题的全文文章，最新优先 —— 话题回填的输入。
/// 用 NOT EXISTS 而不是 LEFT JOIN：一篇挂两个话题时不能出现两行。
pub fn articles_missing_topic(conn: &Connection, limit: usize) -> Result<Vec<Article>, AppError> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {ARTICLE_COLS} FROM articles
         WHERE quality='fulltext'
           AND NOT EXISTS (SELECT 1 FROM article_topics at WHERE at.article_id = articles.id)
         ORDER BY fetched_at DESC
         LIMIT ?1"
    ))?;
    let rows = stmt
        .query_map(params![limit as i64], map_article)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}
```

- [ ] **Step 2: enrich 作业（照 `fill_missing_tags` 的形状）**

`src-tauri/src/feeds/enrich.rs`：

```rust
/// 每次刷新处理多少篇话题判定。比 tags 小：每篇还要带 5 个候选进 prompt。
pub const TOPICS_PER_REFRESH: usize = 40;
/// 回填时每批送多少篇（话题判定的 prompt 比 tags 大，批次相应小）。
const TOPIC_CHUNK: usize = 8;

/// 给尚未归入话题的文章补话题（spec §3.4）。
/// 与 tags 不同：每篇的候选池不同，因此必须先读 active 话题再逐篇挑候选。
pub fn fill_missing_topics(
    db: &DbState,
    cfg: &AppConfig,
    limit: usize,
    mut on_progress: impl FnMut(usize, usize),
) -> Result<usize, AppError> {
    if cfg.api_key.trim().is_empty() {
        return Err(AppError::msg("请先在设置中配置 API Key（config.local.json）"));
    }
    let missing = {
        let conn = db.lock_read()?;
        db::articles_missing_topic(&conn, limit)?
    };
    if missing.is_empty() {
        on_progress(0, 0);
        return Ok(0);
    }
    let total = missing.len();
    let mut done = 0usize;
    let mut processed = 0usize;
    let mut last_err: Option<String> = None;
    on_progress(0, total);

    for chunk in missing.chunks(TOPIC_CHUNK) {
        // 候选池每批重读一次：同批里前一篇新立的话题对后一篇就该可见。
        let pool = {
            let conn = db.lock_read()?;
            db::list_active_topics(&conn)?
        };
        let inputs: Vec<vocab::TopicArticleIn> = chunk
            .iter()
            .map(|a| {
                let tokens = db::token_set(&format!("{} {}", a.title, db::clip_body(&a.content_text)));
                let cands = db::pick_candidates(&pool, &tokens, db::CANDIDATE_TOP_N)
                    .into_iter()
                    .map(|t| vocab::TopicCandidate { id: t.id.clone(), name: t.name.clone(), blurb: t.blurb.clone() })
                    .collect();
                (tokens, vocab::TopicArticleIn { title: a.title.clone(), summary_zh: a.summary_zh.clone(), candidates: cands })
            })
            .collect();
        let refs: Vec<vocab::TopicArticleIn> = inputs.iter().map(|(_, i)| i.clone()).collect();
        let mut job = |batch: &[vocab::TopicArticleIn]| vocab::assign_article_topics(cfg, batch);
        let (rows, err) = run_with_split(&refs, &mut job);
        let usable = rows.iter().filter(|r| r.is_some()).count();
        if let Some(e) = err {
            last_err = Some(format!("话题判定（第 {}–{} 条）：{e}", processed + 1, processed + refs.len()));
        }
        {
            let conn = db.lock_write()?;
            for (((tokens, input), row), article) in inputs.iter().zip(rows).zip(chunk.iter()) {
                let Some(out) = row else { continue };
                let decision = vocab::validate_assignment(&out, &input.candidates, &pool);
                if let Some(reason) = db::apply_topic_decision(&conn, &article.id, &decision, tokens) {
                    last_err = Some(format!("话题判定（{}）：{reason}", article.title));
                    continue;
                }
                done += 1;
            }
        }
        processed += refs.len();
        on_progress(processed, total);
        if usable == 0 {
            return Err(AppError::msg(last_err.unwrap_or_else(|| "话题判定失败".into())));
        }
    }
    if done == 0 {
        return Err(AppError::msg(
            last_err.unwrap_or_else(|| "所有话题判定都被约束挡下".into()),
        ));
    }
    Ok(done)
}
```

上面用到的 `db::clip_body` 现在不存在 —— 在 `db/topics.rs` 末尾加一个（别用 `vocab::clip_zh`，那是给中文按字符裁剪的，语义不同）：

```rust
/// 正文取前 `ARTICLE_TOKEN_WINDOW_CHARS` 个字符参与候选打分。
pub fn clip_body(content: &str) -> String {
    content.chars().take(ARTICLE_TOKEN_WINDOW_CHARS).collect()
}
```

- [ ] **Step 3: 导出 + 刷新挂钩 + command**

`src-tauri/src/feeds/mod.rs`：re-export 列表加 `fill_missing_topics, TOPICS_PER_REFRESH`。
`src-tauri/src/feeds/pipeline.rs`：在 `fill_missing_tags(...)` 那段之后，照它现有的 `match` 与 `emit` 写法加一支同样结构的调用（作业名 `topics`，`on_progress` 复用同一事件发送），并在其后加 `let _ = settle_dormant_topics(&conn, &Utc::now());` —— 沉降只在刷新时跑一次（spec §3.3）。
`src-tauri/src/commands/articles.rs`：

```rust
/// 回填话题（有界；刷新时也会顺带跑一小批）。
#[tauri::command]
pub async fn fill_missing_topics(app: AppHandle, limit: Option<usize>) -> Result<usize, AppError> {
    let cfg = crate::config::load_config()?;
    if cfg.api_key.trim().is_empty() {
        return Ok(0);
    }
    crate::commands::spawn_db(app, move |state| {
        feeds::fill_missing_topics(state, &cfg, limit.unwrap_or(200), |_, _| {})
    })
    .await
}
```

`src-tauri/src/lib.rs`：`commands::articles::fill_missing_tags,` 之后加 `commands::articles::fill_missing_topics,`。

- [ ] **Step 4: 全量后端测试**

Run: `cd src-tauri && cargo test 2>&1 | tail -15`
Expected: 全绿。这一步**不**联网：`fill_missing_topics` 的联网路径留给 Task 7 的实测，与既有 `fill_missing_tags` 的测试覆盖一致。

- [ ] **Step 5: 提交**

```bash
git add src-tauri/src/db/articles.rs src-tauri/src/db/topics.rs src-tauri/src/feeds/enrich.rs src-tauri/src/feeds/mod.rs src-tauri/src/feeds/pipeline.rs src-tauri/src/commands/articles.rs src-tauri/src/lib.rs
git commit -m "feat(topics): backfill pipeline, refresh hook and command"
```

---

### Task 7: 真实语料实测 —— 本阶段唯一算数的验收

**Files:**
- Modify: `src-tauri/src/feeds/tests.rs`（追加一个 `#[ignore]` 测试，照既有 `audit_live_coverage_report` 的形状）

**Interfaces:**
- Consumes: `db::open`、`config::load_config`、Task 6 的 `feeds::fill_missing_topics`、Task 1–5 的全部读写
- Produces: 打印到 stdout 并写 `/tmp/shiyan-topics-report.json` 的实测报表

- [ ] **Step 1: 写实测**

`src-tauri/src/feeds/tests.rs` 末尾：

```rust
/// 真实语料回填实测（spec §9 第 1 步：先量碎不碎，再往上盖界面）。
/// 在**副本**上跑，绝不碰用户现库。
/// 用法：见下面 Step 2 的两条命令。
#[test]
#[ignore = "写库并联网；只在人工发起时跑"]
fn topic_backfill_report_on_live_corpus_copy() {
    let db_path = std::env::var("SHIYAN_TOPIC_DB").expect("SHIYAN_TOPIC_DB=<sqlite 副本路径>");
    let limit: usize = std::env::var("SHIYAN_TOPIC_LIMIT")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(200);

    let conn = rusqlite::Connection::open(&db_path).unwrap();
    crate::db::migrate_for_test(&conn); // Task 7 Step 3 定义：跑到当前 LATEST_VERSION
    let db = crate::db::DbState::for_path_copy(db_path.into()).unwrap();
    let cfg = crate::config::load_config().expect("需要 config.local.json 里的 API Key");

    let written = crate::feeds::fill_missing_topics(&db, &cfg, limit, |done, total| {
        eprintln!("回填 {done}/{total}");
    })
    .expect("回填整体失败：先查 API Key 与网络");

    // 报表口径全部在这里算，跑完一次就覆盖上一次的结果。
    let topics = crate::db::list_active_topics(&conn).unwrap();
    let mut rows: Vec<serde_json::Value> = Vec::new();
    let mut empty_topics = 0;
    for t in &topics {
        let n: i64 = conn
            .query_row("SELECT COUNT(*) FROM article_topics WHERE topic_id=?1", rusqlite::params![t.id], |r| r.get(0))
            .unwrap();
        if n == 0 { empty_topics += 1; }
        rows.push(serde_json::json!({ "name": t.name, "articles": n, "key_terms": t.key_terms.len() }));
    }
    let dupes = crate::db::list_near_duplicate_topics(&conn, 2, 50).unwrap();
    let mut report = String::new();
    report.push_str(&format!("判定成功 {written} 篇；active 话题 {} 条（其中 0 篇挂着 {empty_topics} 条）\n", topics.len()));
    report.push_str(&format!("近重对（共用 ≥2 词）：{} 对\n", dupes.len()));
    for d in &dupes {
        let a = crate::db::get_topic(&conn, &d.a_id).unwrap().unwrap();
        let b = crate::db::get_topic(&conn, &d.b_id).unwrap().unwrap();
        report.push_str(&format!("  {} ↔ {}  共用 {} 词\n", a.name, b.name, d.shared));
    }
    rows.sort_by_key(|r| -(r["articles"].as_i64().unwrap_or(0)));
    report.push_str("文章数最多的 15 条：\n");
    for r in rows.iter().take(15) {
        report.push_str(&format!("  {:>4}  {}", r["articles"].as_i64().unwrap_or(0), r["name"].as_str().unwrap_or("")));
        report.push('\n');
    }
    std::fs::write("/tmp/shiyan-topics-report.json", serde_json::to_string_pretty(&topics.iter().map(|t| serde_json::json!({"name": t.name, "key_terms": t.key_terms})).collect::<Vec<_>>()).unwrap()).unwrap();
    println!("{report}");
}
```

- [ ] **Step 2: 定义两个只在测试里用的助手**

`src-tauri/src/db/mod.rs` 末尾：

```rust
/// 测试专用：把连接迁移到当前 `LATEST_VERSION`（`open_db` 依赖 Tauri 路径解析）。
#[cfg(test)]
pub(crate) fn migrate_for_test(conn: &Connection) {
    migrate(conn).unwrap();
}
```

`DbState::for_path_copy` 同样加在 `db/mod.rs`，`#[cfg(test)]`：与 `open` 相同但只建一个连接、不做 legacy 目录迁移。若嫌改动大，退路是照 `audit_live_coverage_report` 现有的做法 —— 它就是用 env 传路径、内部自己开连接，读那段现成代码抄同一个形状，不要另发明一套。

- [ ] **Step 3: 跑一次（真实调用 LLM，约 200 篇）**

```bash
# 1) 先做只读快照：库是 WAL 模式，直接复制 .db 会拿到半新半旧的数据
APP="$HOME/Library/Application Support/com.sihai.shiyan"
cp "$APP/shiyan.db" /tmp/shiyan-topics.db
[ -f "$APP/shiyan.db-wal" ] && cp "$APP/shiyan.db-wal" /tmp/shiyan-topics.db-wal
sqlite3 /tmp/shiyan-topics.db "PRAGMA wal_checkpoint(TRUNCATE);" >/dev/null

# 2) 回填并出报表（约 25 批 LLM 调用；单线程、跑完才打印）
SHIYAN_TOPIC_DB=/tmp/shiyan-topics.db SHIYAN_TOPIC_LIMIT=200 \
  cargo test -- --ignored --nocapture topic_backfill_report_on_live_corpus_copy 2>/tmp/topics-run.log
```

Expected: 末尾一段中文报表。**口径要交代清楚再下判断**：`active 话题数` 分母是这 200 篇的判定结果，不是全库。

- [ ] **Step 4: 按 spec §10 判是否达标**

- active 话题数 < 60
- 近重对 ≤ 5，且每对都能一眼看出"确实是一件事"（人工看报表里的名字对）
- 0 篇挂着的话题 = 0（有则说明新立后没有文章真的归进去，多半是候选池太窄）
- 抽 3 条同一事件跨两周的报道，确认它们落在同一条话题名下（直接查 `/tmp/shiyan-topics.db`：`SELECT t.name, count(*) FROM article_topics at JOIN topics t ON t.id=at.topic_id GROUP BY t.id ORDER BY 2 DESC LIMIT 20;`）

不达标时的处置顺序（写死在这里，避免临场发挥）：
1. `looks_like_a_one_off_event` 过严（大类名里合法出现数字，如「G7 峰会」）→ 放宽为只拒绝"含具体日期形态"（`\d+月\d+日`），改 `vocab.rs` 常量分支，重跑；
2. 新立过多（话题数 ≥ 60）→ 把 `why_not_existing` 的点名要求从"每个候选"提到"每个候选且每条理由 ≥8 字"，并把共用词阈值从 2 降到 1（`apply` 侧与 `list_near_duplicate_topics` 同步改），重跑；
3. 归入过粗（一条话题挂掉 >40% 的文章）→ 把 `CANDIDATE_TOP_N` 从 5 降到 3，让模型少看几个筐，重跑。

每轮改完必须重跑 Step 3（副本可复用，但要把上一版报表 `cp` 走再对比 —— 报表路径固定，会被覆盖）。

- [ ] **Step 5: 把实测结论回写 spec**

在 `docs/superpowers/specs/2026-09-26-topic-registry-design.md` §11 之后追加一节「实测结果（2026-09-XX）」：跑了几篇、active 话题数、近重对数、做过哪一项校准（以及为什么）。**这一节是 Stage 2/3/4 计划的入场券**：没有它不开下一份计划。

- [ ] **Step 6: 提交**

```bash
git add src-tauri/src/feeds/tests.rs src-tauri/src/db/mod.rs docs/superpowers/specs/2026-09-26-topic-registry-design.md
git commit -m "test(topics): live-corpus backfill measurement and calibration notes"
```

---

## 收尾核对（对照 spec §3 与 §9 第 1 步）

- [ ] Stage 1 不开任何界面：`git diff main --stat` 里不得出现 `src/` 下的任何文件（前端零改动是本阶段的有意约束）
- [ ] `topics` 全部列都被写路径用到；`topic_recaps`/`compare_cards`/`article_chunks` 三张表未提前建
- [ ] 无 API Key：`pnpm dev:desktop` 下刷新一次，不报错、不出现半成品话题（spec §3.4 第三条）
- [ ] `node scripts/stop-desktop.mjs` → `pnpm test` → `pnpm build` → `cd src-tauri && cargo test` 全绿
