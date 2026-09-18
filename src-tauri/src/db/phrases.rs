use super::PhraseItem;
use crate::error::AppError;
use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension};

fn map_phrase(row: &rusqlite::Row<'_>) -> rusqlite::Result<PhraseItem> {
    Ok(PhraseItem {
        id: row.get(0)?,
        phrase: row.get(1)?,
        meaning_zh: row.get(2)?,
        usage: row.get(3)?,
        context_sentence: row.get(4)?,
        article_id: row.get(5)?,
        status: row.get(6)?,
        interval_days: row.get(7)?,
        reps: row.get(8)?,
        consecutive_know: row.get(9)?,
        next_review_at: row.get(10)?,
        created_at: row.get(11)?,
    })
}

const PHRASE_SELECT: &str = "SELECT id,phrase,meaning_zh,usage,context_sentence,article_id,status,interval_days,reps,consecutive_know,next_review_at,created_at FROM phrases";

pub fn insert_phrase(conn: &Connection, item: &PhraseItem) -> Result<(), AppError> {
    conn.execute(
        "INSERT INTO phrases (id,phrase,meaning_zh,usage,context_sentence,article_id,status,interval_days,reps,consecutive_know,next_review_at,created_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)",
        params![
            item.id,
            item.phrase,
            item.meaning_zh,
            item.usage,
            item.context_sentence,
            item.article_id,
            item.status,
            item.interval_days,
            item.reps,
            item.consecutive_know,
            item.next_review_at,
            item.created_at
        ],
    )
    .map_err(AppError::from)?;
    Ok(())
}

pub fn list_phrases(
    conn: &Connection,
    status: Option<&str>,
) -> Result<Vec<PhraseItem>, AppError> {
    let mut sql = String::from(PHRASE_SELECT);
    if status.is_some() {
        sql.push_str(" WHERE status=?1");
    }
    sql.push_str(" ORDER BY created_at DESC");
    let mut stmt = conn.prepare(&sql).map_err(AppError::from)?;
    let rows = match status {
        Some(s) => stmt
            .query_map(params![s], map_phrase)
            .map_err(AppError::from)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(AppError::from)?,
        None => stmt
            .query_map([], map_phrase)
            .map_err(AppError::from)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(AppError::from)?,
    };
    Ok(rows)
}

pub fn get_phrase(conn: &Connection, id: &str) -> Result<Option<PhraseItem>, AppError> {
    conn.query_row(
        &format!("{PHRASE_SELECT} WHERE id=?1"),
        params![id],
        map_phrase,
    )
    .optional()
    .map_err(AppError::from)
}

/// Case-insensitive lookup by phrase text (exact, whitespace-normalized).
pub fn get_phrase_by_text(
    conn: &Connection,
    phrase: &str,
) -> Result<Option<PhraseItem>, AppError> {
    let normalized = phrase.split_whitespace().collect::<Vec<_>>().join(" ");
    conn.query_row(
        &format!("{PHRASE_SELECT} WHERE lower(phrase)=lower(?1) ORDER BY created_at ASC LIMIT 1"),
        params![normalized],
        map_phrase,
    )
    .optional()
    .map_err(AppError::from)
}

/// Phrases due for review (oldest due first).
pub fn due_phrases(conn: &Connection) -> Result<Vec<PhraseItem>, AppError> {
    let now = Utc::now().to_rfc3339();
    let mut stmt = conn
        .prepare(&format!(
            "{PHRASE_SELECT} WHERE status='learning' AND next_review_at <= ?1 ORDER BY next_review_at ASC LIMIT 50"
        ))
        .map_err(AppError::from)?;
    let rows = stmt
        .query_map(params![now], map_phrase)
        .map_err(AppError::from)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(AppError::from)?;
    Ok(rows)
}

pub fn update_phrase_meta(conn: &Connection, item: &PhraseItem) -> Result<(), AppError> {
    conn.execute(
        "UPDATE phrases SET meaning_zh=?1, usage=?2, context_sentence=?3, article_id=?4 WHERE id=?5",
        params![
            item.meaning_zh,
            item.usage,
            item.context_sentence,
            item.article_id,
            item.id
        ],
    )
    .map_err(AppError::from)?;
    Ok(())
}

pub fn update_phrase_review(conn: &Connection, item: &PhraseItem) -> Result<(), AppError> {
    conn.execute(
        "UPDATE phrases SET status=?1, interval_days=?2, reps=?3, consecutive_know=?4, next_review_at=?5 WHERE id=?6",
        params![
            item.status,
            item.interval_days,
            item.reps,
            item.consecutive_know,
            item.next_review_at,
            item.id
        ],
    )
    .map_err(AppError::from)?;
    Ok(())
}

pub fn set_phrase_status(conn: &Connection, id: &str, status: &str) -> Result<(), AppError> {
    conn.execute(
        "UPDATE phrases SET status=?1 WHERE id=?2",
        params![status, id],
    )
    .map_err(AppError::from)?;
    Ok(())
}

pub fn delete_phrase(conn: &Connection, id: &str) -> Result<(), AppError> {
    conn.execute("DELETE FROM phrases WHERE id=?1", params![id])
        .map_err(AppError::from)?;
    Ok(())
}
