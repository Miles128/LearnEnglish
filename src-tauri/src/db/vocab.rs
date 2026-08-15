use super::VocabItem;
use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension};

fn map_vocab(row: &rusqlite::Row<'_>) -> rusqlite::Result<VocabItem> {
    let collocations_json: String = row.get(4)?;
    let collocations: Vec<String> =
        serde_json::from_str(&collocations_json).unwrap_or_default();
    Ok(VocabItem {
        id: row.get(0)?,
        term: row.get(1)?,
        definition_zh: row.get(2)?,
        word_type: row.get(3)?,
        collocations,
        context_sentence: row.get(5)?,
        article_id: row.get(6)?,
        status: row.get(7)?,
        interval_days: row.get(8)?,
        reps: row.get(9)?,
        consecutive_know: row.get(10)?,
        next_review_at: row.get(11)?,
        created_at: row.get(12)?,
    })
}

const VOCAB_SELECT: &str = "SELECT id,term,definition_zh,word_type,collocations_json,context_sentence,article_id,status,interval_days,reps,consecutive_know,next_review_at,created_at FROM vocab";

pub fn insert_vocab(conn: &Connection, item: &VocabItem) -> Result<(), String> {
    let collocations_json =
        serde_json::to_string(&item.collocations).map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO vocab (id,term,definition_zh,word_type,collocations_json,context_sentence,article_id,status,interval_days,reps,consecutive_know,next_review_at,created_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)",
        params![
            item.id,
            item.term,
            item.definition_zh,
            item.word_type,
            collocations_json,
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
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn list_vocab(conn: &Connection, status: Option<&str>) -> Result<Vec<VocabItem>, String> {
    let mut sql = String::from(VOCAB_SELECT);
    if status.is_some() {
        sql.push_str(" WHERE status=?1");
    }
    sql.push_str(" ORDER BY created_at DESC");
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = match status {
        Some(s) => stmt
            .query_map(params![s], map_vocab)
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?,
        None => stmt
            .query_map([], map_vocab)
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?,
    };
    Ok(rows)
}

pub fn get_vocab(conn: &Connection, id: &str) -> Result<Option<VocabItem>, String> {
    let sql = format!("{VOCAB_SELECT} WHERE id=?1");
    conn.query_row(&sql, params![id], map_vocab)
        .optional()
        .map_err(|e| e.to_string())
}

/// Case-insensitive lookup by term (oldest row wins).
pub fn get_vocab_by_term(conn: &Connection, term: &str) -> Result<Option<VocabItem>, String> {
    let sql = format!("{VOCAB_SELECT} WHERE lower(term)=lower(?1) ORDER BY created_at ASC LIMIT 1");
    conn.query_row(&sql, params![term.trim()], map_vocab)
        .optional()
        .map_err(|e| e.to_string())
}

/// Update learner-facing fields when an existing term is re-added.
pub fn update_vocab_meta(conn: &Connection, item: &VocabItem) -> Result<(), String> {
    let collocations_json =
        serde_json::to_string(&item.collocations).map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE vocab SET definition_zh=?1, word_type=?2, collocations_json=?3, context_sentence=?4, article_id=?5 WHERE id=?6",
        params![
            item.definition_zh,
            item.word_type,
            collocations_json,
            item.context_sentence,
            item.article_id,
            item.id
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn update_vocab_review(conn: &Connection, item: &VocabItem) -> Result<(), String> {
    conn.execute(
        "UPDATE vocab SET status=?1, interval_days=?2, reps=?3, consecutive_know=?4, next_review_at=?5 WHERE id=?6",
        params![
            item.status,
            item.interval_days,
            item.reps,
            item.consecutive_know,
            item.next_review_at,
            item.id
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn due_vocab(conn: &Connection) -> Result<Vec<VocabItem>, String> {
    let now = Utc::now().to_rfc3339();
    let sql = format!(
        "{VOCAB_SELECT} WHERE status='learning' AND next_review_at<=?1 ORDER BY next_review_at ASC LIMIT 50"
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![now], map_vocab)
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

pub fn set_vocab_status(conn: &Connection, id: &str, status: &str) -> Result<(), String> {
    conn.execute(
        "UPDATE vocab SET status=?1 WHERE id=?2",
        params![status, id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn delete_vocab(conn: &Connection, id: &str) -> Result<(), String> {
    conn.execute("DELETE FROM vocab WHERE id=?1", params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}