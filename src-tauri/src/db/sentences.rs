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
