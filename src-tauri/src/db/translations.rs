use super::TranslationRow;
use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension};

pub fn get_translation(
    conn: &Connection,
    article_id: &str,
    scope: &str,
    scope_key: &str,
) -> Result<Option<TranslationRow>, String> {
    conn.query_row(
        "SELECT id,article_id,scope,scope_key,source_text,translated_text,model FROM translations
         WHERE article_id=?1 AND scope=?2 AND scope_key=?3",
        params![article_id, scope, scope_key],
        map_translation,
    )
    .optional()
    .map_err(|e| e.to_string())
}

pub fn save_translation(
    conn: &Connection,
    article_id: &str,
    scope: &str,
    scope_key: &str,
    source_text: &str,
    translated_text: &str,
    model: &str,
) -> Result<TranslationRow, String> {
    let now = Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO translations (article_id,scope,scope_key,source_text,translated_text,model,created_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7)
         ON CONFLICT(article_id,scope,scope_key) DO UPDATE SET
           source_text=excluded.source_text,
           translated_text=excluded.translated_text,
           model=excluded.model,
           created_at=excluded.created_at",
        params![
            article_id,
            scope,
            scope_key,
            source_text,
            translated_text,
            model,
            now
        ],
    )
    .map_err(|e| e.to_string())?;
    get_translation(conn, article_id, scope, scope_key)?
        .ok_or_else(|| "failed to read saved translation".into())
}

pub fn list_paragraph_translations(
    conn: &Connection,
    article_id: &str,
) -> Result<Vec<TranslationRow>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id,article_id,scope,scope_key,source_text,translated_text,model FROM translations
             WHERE article_id=?1 AND scope='paragraph'",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![article_id], map_translation)
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

fn map_translation(row: &rusqlite::Row<'_>) -> rusqlite::Result<TranslationRow> {
    Ok(TranslationRow {
        id: row.get(0)?,
        article_id: row.get(1)?,
        scope: row.get(2)?,
        scope_key: row.get(3)?,
        source_text: row.get(4)?,
        translated_text: row.get(5)?,
        model: row.get(6)?,
    })
}