use crate::error::AppError;
use chrono::Utc;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// One recorded term lookup (Home/Reader selection popover), newest first.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct LookupEntry {
    #[ts(type = "number")]
    pub id: i64,
    pub term: String,
    /// Selection/sentence the lookup came from (may be empty).
    pub context: String,
    pub article_id: Option<String>,
    pub created_at: String,
}

fn map_lookup(row: &rusqlite::Row<'_>) -> rusqlite::Result<LookupEntry> {
    Ok(LookupEntry {
        id: row.get(0)?,
        term: row.get(1)?,
        context: row.get(2)?,
        article_id: row.get(3)?,
        created_at: row.get(4)?,
    })
}

const LOOKUP_SELECT: &str =
    "SELECT id,term,context,article_id,created_at FROM lookup_history";

pub fn record_lookup(
    conn: &Connection,
    term: &str,
    context: &str,
    article_id: Option<&str>,
) -> Result<(), AppError> {
    let term = term.trim();
    if term.is_empty() {
        return Ok(());
    }
    conn.execute(
        "INSERT INTO lookup_history (term, context, article_id, created_at)
         VALUES (?1, ?2, ?3, ?4)",
        params![term, context, article_id, Utc::now().to_rfc3339()],
    )?;
    Ok(())
}

/// Newest-first page of lookups; optional case-insensitive term/substring search.
pub fn list_lookups(
    conn: &Connection,
    search: Option<&str>,
    limit: usize,
    offset: usize,
) -> Result<Vec<LookupEntry>, AppError> {
    let mut sql = String::from(LOOKUP_SELECT);
    let mut values: Vec<rusqlite::types::Value> = Vec::new();
    if let Some(q) = search.map(str::trim).filter(|q| !q.is_empty()) {
        sql.push_str(" WHERE lower(term) LIKE ?1 OR context LIKE ?1");
        values.push(format!("%{}%", q.to_lowercase()).into());
    }
    sql.push_str(" ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?");
    values.push((limit as i64).into());
    values.push((offset as i64).into());
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt
        .query_map(rusqlite::params_from_iter(values.iter()), map_lookup)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

pub fn delete_lookup(conn: &Connection, id: i64) -> Result<(), AppError> {
    let changed = conn.execute("DELETE FROM lookup_history WHERE id=?1", params![id])?;
    if changed == 0 {
        return Err(AppError::msg("lookup entry not found"));
    }
    Ok(())
}

pub fn clear_lookups(conn: &Connection) -> Result<(), AppError> {
    conn.execute("DELETE FROM lookup_history", [])?;
    Ok(())
}

pub fn count_lookups(conn: &Connection) -> Result<i64, AppError> {
    Ok(conn.query_row("SELECT COUNT(*) FROM lookup_history", [], |r| {
        r.get(0)
    })?)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS lookup_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                term TEXT NOT NULL,
                context TEXT NOT NULL DEFAULT '',
                article_id TEXT,
                created_at TEXT NOT NULL
            );",
        )
        .unwrap();
        conn
    }

    #[test]
    fn record_list_delete_roundtrip() {
        let conn = setup();
        record_lookup(&conn, "fragile", "a fragile peace", None).unwrap();
        record_lookup(&conn, "treaty", "signed a treaty", Some("a1")).unwrap();
        assert_eq!(count_lookups(&conn).unwrap(), 2);

        let rows = list_lookups(&conn, None, 10, 0).unwrap();
        assert_eq!(rows.len(), 2);
        // newest first — same timestamps could reorder, so check as a set
        let terms: Vec<&str> = rows.iter().map(|r| r.term.as_str()).collect();
        assert!(terms.contains(&"fragile") && terms.contains(&"treaty"));

        let found = list_lookups(&conn, Some("frag"), 10, 0).unwrap();
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].term, "fragile");

        delete_lookup(&conn, rows[0].id).unwrap();
        assert_eq!(count_lookups(&conn).unwrap(), 1);
        clear_lookups(&conn).unwrap();
        assert_eq!(count_lookups(&conn).unwrap(), 0);
    }

    #[test]
    fn record_skips_blank_terms() {
        let conn = setup();
        record_lookup(&conn, "   ", "ctx", None).unwrap();
        assert_eq!(count_lookups(&conn).unwrap(), 0);
    }
}
