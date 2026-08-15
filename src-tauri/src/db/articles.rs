use super::Article;
use rusqlite::{params, Connection, OptionalExtension};

const ARTICLE_COLS: &str =
    "id,url,title,title_zh,source,category,published_at,content_text,fetched_at,origin";

pub fn list_articles(
    conn: &Connection,
    category: Option<&str>,
    limit: Option<i64>,
    offset: Option<i64>,
) -> Result<Vec<Article>, String> {
    let mut sql = format!("SELECT {ARTICLE_COLS} FROM articles");
    let mut params: Vec<rusqlite::types::Value> = vec![];
    if let Some(cat) = category {
        if cat != "all" {
            sql.push_str(" WHERE category=?");
            params.push(rusqlite::types::Value::Text(cat.to_string()));
        }
    }
    sql.push_str(" ORDER BY source ASC, fetched_at DESC, published_at DESC");
    sql.push_str(" LIMIT ? OFFSET ?");
    params.push(rusqlite::types::Value::Integer(limit.unwrap_or(400)));
    params.push(rusqlite::types::Value::Integer(offset.unwrap_or(0)));

    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(rusqlite::params_from_iter(params.iter()), map_article)
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

/// All articles with no LIMIT — used for maintenance purges on refresh.
pub fn list_all_articles(conn: &Connection) -> Result<Vec<Article>, String> {
    let mut stmt = conn
        .prepare(&format!("SELECT {ARTICLE_COLS} FROM articles"))
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], map_article)
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

pub fn map_article(row: &rusqlite::Row<'_>) -> rusqlite::Result<Article> {
    Ok(Article {
        id: row.get(0)?,
        url: row.get(1)?,
        title: row.get(2)?,
        title_zh: row.get(3)?,
        source: row.get(4)?,
        category: row.get(5)?,
        published_at: row.get(6)?,
        content_text: row.get(7)?,
        fetched_at: row.get(8)?,
        origin: row.get(9)?,
    })
}

pub fn get_article(conn: &Connection, id: &str) -> Result<Option<Article>, String> {
    conn.query_row(
        &format!("SELECT {ARTICLE_COLS} FROM articles WHERE id=?1"),
        params![id],
        map_article,
    )
    .optional()
    .map_err(|e| e.to_string())
}

pub fn get_article_by_url(conn: &Connection, url: &str) -> Result<Option<Article>, String> {
    conn.query_row(
        &format!("SELECT {ARTICLE_COLS} FROM articles WHERE url=?1"),
        params![url],
        map_article,
    )
    .optional()
    .map_err(|e| e.to_string())
}

pub fn list_article_urls(conn: &Connection) -> Result<std::collections::HashSet<String>, String> {
    let mut stmt = conn
        .prepare("SELECT url FROM articles")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|e| e.to_string())?
        .collect::<Result<std::collections::HashSet<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

/// url → stored body length in bytes (used to refresh stale RSS bodies).
pub fn list_article_content_lengths(
    conn: &Connection,
) -> Result<std::collections::HashMap<String, usize>, String> {
    let mut stmt = conn
        .prepare("SELECT url, LENGTH(content_text) FROM articles")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)? as usize)))
        .map_err(|e| e.to_string())?
        .collect::<Result<std::collections::HashMap<_, _>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

/// Insert only when `url` is new. Returns `true` if inserted, `false` if already present.
/// Idempotent: never overwrites existing content / translations.
pub fn insert_article_if_new(conn: &Connection, a: &Article) -> Result<bool, String> {
    let changed = conn
        .execute(
            "INSERT INTO articles (id,url,title,title_zh,source,category,published_at,content_text,fetched_at,origin)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)
             ON CONFLICT(url) DO NOTHING",
            params![
                a.id,
                a.url,
                a.title,
                a.title_zh,
                a.source,
                a.category,
                a.published_at,
                a.content_text,
                a.fetched_at,
                a.origin
            ],
        )
        .map_err(|e| e.to_string())?;
    Ok(changed > 0)
}

/// Refresh an existing RSS article when a longer full-text body is available.
/// Keeps id / url / title_zh / source / category / published_at / origin intact.
pub fn refresh_article_content(conn: &Connection, a: &Article) -> Result<bool, String> {
    let changed = conn
        .execute(
            "UPDATE articles SET title=?1, content_text=?2, fetched_at=?3
             WHERE id=?4 AND content_text <> ?2",
            params![a.title, a.content_text, a.fetched_at, a.id],
        )
        .map_err(|e| e.to_string())?;
    Ok(changed > 0)
}

#[cfg(test)]
pub fn upsert_article(conn: &Connection, a: &Article) -> Result<(), String> {
    // Legacy alias used by older tests; refresh path uses insert_article_if_new.
    let _ = insert_article_if_new(conn, a)?;
    Ok(())
}

pub fn delete_article(conn: &Connection, id: &str) -> Result<(), String> {
    conn.execute(
        "DELETE FROM translations WHERE article_id=?1",
        params![id],
    )
    .map_err(|e| e.to_string())?;
    // Keep learned words, just detach them from the removed article.
    conn.execute(
        "UPDATE vocab SET article_id=NULL WHERE article_id=?1",
        params![id],
    )
    .map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM articles WHERE id=?1", params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn articles_missing_title_zh(conn: &Connection, limit: usize) -> Result<Vec<Article>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id,url,title,title_zh,source,category,published_at,content_text,fetched_at,origin
             FROM articles
             WHERE IFNULL(title_zh,'') = ''
             ORDER BY fetched_at DESC
             LIMIT ?1",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![limit as i64], map_article)
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

pub fn set_article_title_zh(conn: &Connection, id: &str, title_zh: &str) -> Result<(), String> {
    conn.execute(
        "UPDATE articles SET title_zh=?1 WHERE id=?2",
        params![title_zh, id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}