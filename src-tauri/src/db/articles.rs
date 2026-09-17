use super::{Article, ArticleListItem};
use rusqlite::{params, Connection, OptionalExtension};

const ARTICLE_COLS: &str =
    "id,url,title,title_zh,source,category,published_at,content_text,fetched_at,origin,summary_zh,last_opened_at,open_count,word_count,quality,extraction_source,dwell_ms,read_completed,liked";

/// Home list only needs an excerpt (known% + blurb). Full body stays on get_article.
pub const LIST_EXCERPT_CHARS: i32 = 6000;

pub fn list_articles(
    conn: &Connection,
    category: Option<&str>,
    limit: Option<i64>,
    offset: Option<i64>,
) -> Result<Vec<ArticleListItem>, String> {
    let mut sql = format!(
        "SELECT id,url,title,title_zh,source,category,published_at,SUBSTR(content_text,1,{LIST_EXCERPT_CHARS}),fetched_at,origin,summary_zh,last_opened_at,open_count,word_count,quality,extraction_source,dwell_ms,read_completed,liked FROM articles"
    );
    let mut params: Vec<rusqlite::types::Value> = vec![];
    if let Some(cat) = category {
        if cat != "all" {
            sql.push_str(" WHERE category=?");
            params.push(rusqlite::types::Value::Text(cat.to_string()));
        }
    }
    sql.push_str(" ORDER BY source ASC, fetched_at DESC, published_at DESC");
    sql.push_str(" LIMIT ? OFFSET ?");
    params.push(rusqlite::types::Value::Integer(limit.unwrap_or(60)));
    params.push(rusqlite::types::Value::Integer(offset.unwrap_or(0)));

    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(rusqlite::params_from_iter(params.iter()), map_article_list_item)
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

pub fn map_article_list_item(row: &rusqlite::Row<'_>) -> rusqlite::Result<ArticleListItem> {
    Ok(ArticleListItem {
        id: row.get(0)?,
        url: row.get(1)?,
        title: row.get(2)?,
        title_zh: row.get(3)?,
        source: row.get(4)?,
        category: row.get(5)?,
        published_at: row.get(6)?,
        excerpt: row.get(7)?,
        fetched_at: row.get(8)?,
        origin: row.get(9)?,
        summary_zh: row.get(10)?,
        last_opened_at: row.get(11)?,
        open_count: row.get(12)?,
        word_count: row.get(13)?,
        rank_score: 0.0,
        dwell_ms: row.get(16)?,
        read_completed: row.get::<_, i64>(17)? != 0,
        liked: row.get::<_, i64>(18)? != 0,
    })
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
        summary_zh: row.get(10)?,
        last_opened_at: row.get(11)?,
        open_count: row.get(12)?,
        word_count: row.get(13)?,
        quality: row.get(14)?,
        extraction_source: row.get(15)?,
        dwell_ms: row.get(16)?,
        read_completed: row.get::<_, i64>(17)? != 0,
        liked: row.get::<_, i64>(18)? != 0,
    })
}

pub fn mark_article_opened(conn: &Connection, id: &str) -> Result<(), String> {
    let now = chrono::Utc::now().to_rfc3339();
    let changed = conn
        .execute(
            "UPDATE articles SET last_opened_at=?1, open_count=open_count+1 WHERE id=?2",
            params![now, id],
        )
        .map_err(|e| e.to_string())?;
    if changed == 0 {
        return Err("article not found".into());
    }
    Ok(())
}

pub fn learning_stats(conn: &Connection) -> Result<super::LearningStats, String> {
    let since = (chrono::Utc::now() - chrono::Duration::days(7)).to_rfc3339();
    let opened_total: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM articles WHERE last_opened_at IS NOT NULL",
            [],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    let opened_7d: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM articles WHERE last_opened_at >= ?1",
            params![since],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    let top_source = conn
        .query_row(
            "SELECT source FROM articles WHERE last_opened_at IS NOT NULL
             GROUP BY source ORDER BY SUM(open_count) DESC, source ASC LIMIT 1",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let top_category = conn
        .query_row(
            "SELECT category FROM articles WHERE last_opened_at IS NOT NULL
             GROUP BY category ORDER BY SUM(open_count) DESC, category ASC LIMIT 1",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let vocab_created_7d: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM vocab WHERE created_at >= ?1",
            params![since],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    let vocab_learning: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM vocab WHERE status='learning'",
            [],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    Ok(super::LearningStats {
        opened_total,
        opened_7d,
        top_source,
        top_category,
        vocab_created_7d,
        vocab_learning,
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
            "INSERT INTO articles (id,url,title,title_zh,source,category,published_at,content_text,fetched_at,origin,summary_zh,word_count,quality,extraction_source)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)
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
                a.origin,
                a.summary_zh,
                a.word_count,
                a.quality,
                a.extraction_source,
            ],
        )
        .map_err(|e| e.to_string())?;
    Ok(changed > 0)
}

/// Refresh an existing RSS article when a longer full-text body is available.
/// Matches by URL: callers may build the update struct with an empty/fresh id
/// (the RSS refresh path does exactly that).
/// Keeps id / url / title_zh / source / category / published_at / origin intact.
/// Clears `summary_zh` so the refresh pipeline regenerates it for the new body.
pub fn refresh_article_content(conn: &Connection, a: &Article) -> Result<bool, String> {
    let changed = conn
        .execute(
            "UPDATE articles SET title=?1, content_text=?2, fetched_at=?3, summary_zh='',
                    word_count=?4, quality='fulltext', extraction_source=?5
             WHERE url=?6 AND origin='rss' AND content_text <> ?2",
            params![a.title, a.content_text, a.fetched_at, a.word_count, a.extraction_source, a.url],
        )
        .map_err(|e| e.to_string())?;
    Ok(changed > 0)
}

/// RSS articles whose body quality has not been assessed yet (`quality=''`).
/// Legacy rows get assessed once during refresh; new rows are stamped on insert.
pub fn list_unassessed_rss_articles(conn: &Connection) -> Result<Vec<Article>, String> {
    let mut stmt = conn
        .prepare(&format!(
            "SELECT {ARTICLE_COLS} FROM articles WHERE origin='rss' AND quality=''"
        ))
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], map_article)
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

/// Stamp the body-quality verdict on an article (once; never re-derived later).
pub fn set_article_quality(
    conn: &Connection,
    id: &str,
    quality: &str,
    extraction_source: &str,
    word_count: i64,
) -> Result<(), String> {
    conn.execute(
        "UPDATE articles SET quality=?1, extraction_source=?2, word_count=?3 WHERE id=?4",
        params![quality, extraction_source, word_count, id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Accumulate visible reading time and optionally mark the article as read to the end.
pub fn add_article_reading_progress(
    conn: &Connection,
    id: &str,
    dwell_ms_delta: i64,
    read_completed: bool,
) -> Result<(), String> {
    let changed = conn
        .execute(
            "UPDATE articles
             SET dwell_ms = MAX(0, dwell_ms + ?1),
                 read_completed = CASE WHEN ?2 THEN 1 ELSE read_completed END
             WHERE id=?3",
            params![dwell_ms_delta, read_completed, id],
        )
        .map_err(|e| e.to_string())?;
    if changed == 0 {
        return Err("article not found".into());
    }
    Ok(())
}

pub fn set_article_liked(conn: &Connection, id: &str, liked: bool) -> Result<(), String> {
    let changed = conn
        .execute(
            "UPDATE articles SET liked=?1 WHERE id=?2",
            params![liked, id],
        )
        .map_err(|e| e.to_string())?;
    if changed == 0 {
        return Err("article not found".into());
    }
    Ok(())
}

/// All-time open counts grouped by source and by category — the affinity
/// signal for article ranking.
pub fn affinity_open_counts(
    conn: &Connection,
) -> Result<(std::collections::HashMap<String, i64>, std::collections::HashMap<String, i64>), String>
{
    let read = |sql: &str| -> Result<std::collections::HashMap<String, i64>, String> {
        let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)))
            .map_err(|e| e.to_string())?
            .collect::<Result<std::collections::HashMap<_, _>, _>>()
            .map_err(|e| e.to_string())?;
        Ok(rows)
    };
    let by_source = read(
        "SELECT source, SUM(open_count) FROM articles WHERE open_count > 0 GROUP BY source",
    )?;
    let by_category = read(
        "SELECT category, SUM(open_count) FROM articles WHERE open_count > 0 GROUP BY category",
    )?;
    Ok((by_source, by_category))
}

#[cfg(test)]
pub fn upsert_article(conn: &Connection, a: &Article) -> Result<(), String> {
    // Legacy alias used by older tests; refresh path uses insert_article_if_new.
    let _ = insert_article_if_new(conn, a)?;
    Ok(())
}

pub fn delete_article(conn: &Connection, id: &str) -> Result<(), String> {
    // translations CASCADE; vocab.article_id SET NULL (schema v3).
    conn.execute("DELETE FROM articles WHERE id=?1", params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn articles_missing_card_zh(conn: &Connection, limit: usize) -> Result<Vec<Article>, String> {
    let mut stmt = conn
        .prepare(&format!(
            "SELECT {ARTICLE_COLS} FROM articles
             WHERE IFNULL(title_zh,'') = '' OR IFNULL(summary_zh,'') = ''
             ORDER BY fetched_at DESC
             LIMIT ?1"
        ))
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

pub fn set_article_summary_zh(conn: &Connection, id: &str, summary_zh: &str) -> Result<(), String> {
    conn.execute(
        "UPDATE articles SET summary_zh=?1 WHERE id=?2",
        params![summary_zh, id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}
