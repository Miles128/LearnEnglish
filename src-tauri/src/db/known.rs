use crate::error::AppError;
use rusqlite::{params, Connection};

/// Words the learner marked as already known (lowercased, deduped).
pub fn list_known_words(conn: &Connection) -> Result<Vec<String>, AppError> {
    let mut stmt = conn.prepare("SELECT term FROM known_words ORDER BY term")?;
    let rows = stmt
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

pub fn add_known_word(conn: &Connection, term: &str) -> Result<(), AppError> {
    let key = term.trim().to_lowercase();
    if key.is_empty() {
        return Ok(());
    }
    conn.execute(
        "INSERT OR IGNORE INTO known_words (term, created_at) VALUES (?1, ?2)",
        params![key, chrono::Utc::now().to_rfc3339()],
    )?;
    Ok(())
}

pub fn remove_known_word(conn: &Connection, term: &str) -> Result<(), AppError> {
    conn.execute(
        "DELETE FROM known_words WHERE term=?1",
        params![term.trim().to_lowercase()],
    )?;
    Ok(())
}
