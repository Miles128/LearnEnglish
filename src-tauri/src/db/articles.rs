use crate::error::AppError;
use super::{Article, ArticleListItem};
use rusqlite::{params, Connection, OptionalExtension};

const ARTICLE_COLS: &str =
    "id,url,title,title_zh,source,category,published_at,content_text,fetched_at,origin,summary_zh,last_opened_at,open_count,word_count,quality,extraction_source,dwell_ms,read_completed,liked,tags_json";

/// Home list only needs an excerpt (known% + blurb). Full body stays on get_article.
pub const LIST_EXCERPT_CHARS: i32 = 6000;

pub fn list_articles(
    conn: &Connection,
    category: Option<&str>,
    limit: Option<i64>,
    offset: Option<i64>,
) -> Result<Vec<ArticleListItem>, AppError> {
    query_articles(
        conn,
        &ArticleQuery {
            category,
            ..Default::default()
        },
        limit,
        offset,
    )
}

/// Read-state filter for the library view.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ReadState {
    #[default]
    All,
    Unread,
    Read,
}

/// Library / list filters. Empty fields are ignored.
#[derive(Debug, Clone, Default)]
pub struct ArticleQuery<'a> {
    pub category: Option<&'a str>,
    /// OR across tags.
    pub tags: &'a [String],
    /// Exact source (publication) name.
    pub source: Option<&'a str>,
    pub read_state: ReadState,
    pub liked_only: bool,
    /// Newest first (library) instead of source-grouped (default).
    pub recent_first: bool,
}

/// Filtered article list. Tags are OR; everything else is AND.
pub fn query_articles(
    conn: &Connection,
    query: &ArticleQuery<'_>,
    limit: Option<i64>,
    offset: Option<i64>,
) -> Result<Vec<ArticleListItem>, AppError> {
    let mut sql = format!(
        "SELECT id,url,title,title_zh,source,category,published_at,SUBSTR(content_text,1,{LIST_EXCERPT_CHARS}),fetched_at,origin,summary_zh,last_opened_at,open_count,word_count,quality,extraction_source,dwell_ms,read_completed,liked,tags_json FROM articles"
    );
    let mut params: Vec<rusqlite::types::Value> = vec![];
    let mut clauses: Vec<String> = vec![];
    if let Some(cat) = query.category.filter(|c| *c != "all") {
        clauses.push("category=?".into());
        params.push(rusqlite::types::Value::Text(cat.to_string()));
    }
    if !query.tags.is_empty() {
        // json_each() errors on an empty string — articles without tags can
        // never match a tag filter, so exclude them up front.
        clauses.push("tags_json <> ''".into());
        let ors: Vec<String> = query
            .tags
            .iter()
            .map(|_| "EXISTS (SELECT 1 FROM json_each(tags_json) WHERE value=?)".to_string())
            .collect();
        clauses.push(format!("({})", ors.join(" OR ")));
        for tag in query.tags {
            params.push(rusqlite::types::Value::Text(tag.clone()));
        }
    }
    if let Some(source) = query.source.filter(|s| !s.is_empty()) {
        clauses.push("source=?".into());
        params.push(rusqlite::types::Value::Text(source.to_string()));
    }
    match query.read_state {
        ReadState::All => {}
        ReadState::Unread => clauses.push("last_opened_at IS NULL".into()),
        ReadState::Read => clauses.push("last_opened_at IS NOT NULL".into()),
    }
    if query.liked_only {
        clauses.push("liked=1".into());
    }
    if !clauses.is_empty() {
        sql.push_str(" WHERE ");
        sql.push_str(&clauses.join(" AND "));
    }
    if query.recent_first {
        sql.push_str(" ORDER BY fetched_at DESC, published_at DESC, id ASC");
    } else {
        sql.push_str(" ORDER BY source ASC, fetched_at DESC, published_at DESC, id ASC");
    }
    sql.push_str(" LIMIT ? OFFSET ?");
    params.push(rusqlite::types::Value::Integer(limit.unwrap_or(60)));
    params.push(rusqlite::types::Value::Integer(offset.unwrap_or(0)));

    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt
        .query_map(rusqlite::params_from_iter(params.iter()), map_article_list_item)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// Distinct sources with article counts, busiest first (library filter).
pub fn list_article_sources(conn: &Connection) -> Result<Vec<(String, i64)>, AppError> {
    let mut stmt = conn
        .prepare("SELECT source, COUNT(*) FROM articles GROUP BY source ORDER BY COUNT(*) DESC, source ASC")
        .map_err(AppError::from)?;
    let rows = stmt
        .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)))
        .map_err(AppError::from)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(AppError::from)?;
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
        tags: parse_tags_json(&row.get::<_, String>(19)?),
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
        tags: parse_tags_json(&row.get::<_, String>(19)?),
    })
}

pub fn mark_article_opened(conn: &Connection, id: &str) -> Result<(), AppError> {
    let now = chrono::Utc::now().to_rfc3339();
    let changed = conn
        .execute(
            "UPDATE articles SET last_opened_at=?1, open_count=open_count+1 WHERE id=?2",
            params![now, id],
        )
        ?;
    if changed == 0 {
        return Err(AppError::msg("article not found"));
    }
    Ok(())
}

pub fn learning_stats(conn: &Connection) -> Result<super::LearningStats, AppError> {
    let since = (chrono::Utc::now() - chrono::Duration::days(7)).to_rfc3339();
    let opened_total: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM articles WHERE last_opened_at IS NOT NULL",
            [],
            |row| row.get(0),
        )
        ?;
    let opened_7d: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM articles WHERE last_opened_at >= ?1",
            params![since],
            |row| row.get(0),
        )
        ?;
    let top_source = conn
        .query_row(
            "SELECT source FROM articles WHERE last_opened_at IS NOT NULL
             GROUP BY source ORDER BY SUM(open_count) DESC, source ASC LIMIT 1",
            [],
            |row| row.get(0),
        )
        .optional()
    .map_err(AppError::from)
        ?;
    let top_category = conn
        .query_row(
            "SELECT category FROM articles WHERE last_opened_at IS NOT NULL
             GROUP BY category ORDER BY SUM(open_count) DESC, category ASC LIMIT 1",
            [],
            |row| row.get(0),
        )
        .optional()
    .map_err(AppError::from)
        ?;
    let vocab_created_7d: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM vocab WHERE created_at >= ?1",
            params![since],
            |row| row.get(0),
        )
        ?;
    let vocab_learning: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM vocab WHERE status='learning'",
            [],
            |row| row.get(0),
        )
        ?;
    Ok(super::LearningStats {
        opened_total,
        opened_7d,
        top_source,
        top_category,
        vocab_created_7d,
        vocab_learning,
    })
}

/// Reading statistics for the stats page (last 14 days + totals).
pub fn reading_stats(conn: &Connection) -> Result<super::ReadingStats, AppError> {
    const DAILY_DAYS: i64 = 14;

    // `last_opened_at` is RFC3339 UTC, so the first 10 chars are the date.
    let mut days: Vec<super::ReadingDay> = Vec::new();
    {
        let mut stmt = conn
            .prepare(
                "SELECT date(substr(last_opened_at,1,10)) AS d,
                        COUNT(*),
                        CAST(IFNULL(SUM(dwell_ms),0)/60000 AS INTEGER),
                        IFNULL(SUM(word_count),0)
                 FROM articles
                 WHERE last_opened_at IS NOT NULL
                 GROUP BY d",
            )
            .map_err(AppError::from)?;
        let by_date: std::collections::HashMap<String, super::ReadingDay> = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    super::ReadingDay {
                        date: String::new(),
                        articles: row.get(1)?,
                        minutes: row.get(2)?,
                        words: row.get(3)?,
                    },
                ))
            })
            .map_err(AppError::from)?
            .collect::<Result<std::collections::HashMap<_, _>, _>>()
            .map_err(AppError::from)?;

        let today = chrono::Utc::now().date_naive();
        for offset in (0..DAILY_DAYS).rev() {
            let date = (today - chrono::Duration::days(offset))
                .format("%Y-%m-%d")
                .to_string();
            days.push(
                by_date
                    .get(&date)
                    .map(|d| super::ReadingDay { date: date.clone(), ..d.clone() })
                    .unwrap_or(super::ReadingDay {
                        date,
                        articles: 0,
                        minutes: 0,
                        words: 0,
                    }),
            );
        }
    }

    // Streak: consecutive days with activity, starting today or yesterday.
    let streak_days: i64 = {
        let mut stmt = conn
            .prepare(
                "SELECT DISTINCT date(substr(last_opened_at,1,10)) AS d
                 FROM articles WHERE last_opened_at IS NOT NULL ORDER BY d DESC",
            )
            .map_err(AppError::from)?;
        let dates: Vec<String> = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(AppError::from)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(AppError::from)?;
        let present: std::collections::HashSet<&str> = dates.iter().map(|s| s.as_str()).collect();
        let today = chrono::Utc::now().date_naive();
        let start = if present.contains(today.format("%Y-%m-%d").to_string().as_str()) {
            today
        } else if present
            .contains((today - chrono::Duration::days(1)).format("%Y-%m-%d").to_string().as_str())
        {
            today - chrono::Duration::days(1)
        } else {
            return Ok(build_stats(conn, days, 0)?);
        };
        let mut streak = 0i64;
        let mut cursor = start;
        while present.contains(cursor.format("%Y-%m-%d").to_string().as_str()) {
            streak += 1;
            cursor -= chrono::Duration::days(1);
        }
        streak
    };

    build_stats(conn, days, streak_days)
}

fn build_stats(
    conn: &Connection,
    days: Vec<super::ReadingDay>,
    streak_days: i64,
) -> Result<super::ReadingStats, AppError> {
    let since = (chrono::Utc::now() - chrono::Duration::days(7)).to_rfc3339();
    let scalar = |sql: &str, params: &[&dyn rusqlite::ToSql]| -> Result<i64, AppError> {
        conn.query_row(sql, params, |row| row.get::<_, i64>(0))
            .map_err(AppError::from)
    };

    let read_filter = "last_opened_at IS NOT NULL";
    let articles_total = scalar(
        &format!("SELECT COUNT(*) FROM articles WHERE {read_filter}"),
        &[],
    )?;
    let articles_7d = scalar(
        &format!("SELECT COUNT(*) FROM articles WHERE {read_filter} AND last_opened_at >= ?1"),
        &[&since],
    )?;
    let completed_total = scalar(
        "SELECT COUNT(*) FROM articles WHERE read_completed = 1",
        &[],
    )?;
    let liked_total = scalar("SELECT COUNT(*) FROM articles WHERE liked = 1", &[])?;
    let minutes_total = scalar(
        &format!("SELECT IFNULL(SUM(dwell_ms),0)/60000 FROM articles WHERE {read_filter}"),
        &[],
    )?;
    let minutes_7d = scalar(
        &format!(
            "SELECT IFNULL(SUM(dwell_ms),0)/60000 FROM articles WHERE {read_filter} AND last_opened_at >= ?1"
        ),
        &[&since],
    )?;
    let words_total = scalar(
        &format!("SELECT IFNULL(SUM(word_count),0) FROM articles WHERE {read_filter}"),
        &[],
    )?;

    let by_status = |table: &str, status: &str| -> Result<i64, AppError> {
        conn.query_row(
            &format!("SELECT COUNT(*) FROM {table} WHERE status=?1"),
            rusqlite::params![status],
            |row| row.get::<_, i64>(0),
        )
        .map_err(AppError::from)
    };
    let vocab_learning = by_status("vocab", "learning")?;
    let vocab_mastered = by_status("vocab", "mastered")?;
    let phrases_learning = by_status("phrases", "learning")?;
    let phrases_mastered = by_status("phrases", "mastered")?;

    let due_since = chrono::Utc::now().to_rfc3339();
    let due_today = scalar(
        "SELECT (SELECT COUNT(*) FROM vocab WHERE status='learning' AND next_review_at <= ?1)
              + (SELECT COUNT(*) FROM phrases WHERE status='learning' AND next_review_at <= ?1)",
        &[&due_since],
    )?;

    let top_sources = {
        let mut stmt = conn
            .prepare(&format!(
                "SELECT source, COUNT(*), CAST(IFNULL(SUM(dwell_ms),0)/60000 AS INTEGER)
                 FROM articles WHERE {read_filter}
                 GROUP BY source ORDER BY SUM(dwell_ms) DESC, COUNT(*) DESC LIMIT 6"
            ))
            .map_err(AppError::from)?;
        let rows = stmt
            .query_map([], |row| {
                Ok(super::SourceStat {
                    name: row.get(0)?,
                    articles: row.get(1)?,
                    minutes: row.get(2)?,
                })
            })
            .map_err(AppError::from)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(AppError::from)?;
        rows
    };

    Ok(super::ReadingStats {
        days,
        streak_days,
        articles_total,
        articles_7d,
        completed_total,
        liked_total,
        minutes_total,
        minutes_7d,
        words_total,
        vocab_learning,
        vocab_mastered,
        phrases_learning,
        phrases_mastered,
        due_today,
        top_sources,
    })
}

pub fn get_article(conn: &Connection, id: &str) -> Result<Option<Article>, AppError> {
    conn.query_row(
        &format!("SELECT {ARTICLE_COLS} FROM articles WHERE id=?1"),
        params![id],
        map_article,
    )
    .optional()
    .map_err(AppError::from)
    
}

pub fn get_article_by_url(conn: &Connection, url: &str) -> Result<Option<Article>, AppError> {
    conn.query_row(
        &format!("SELECT {ARTICLE_COLS} FROM articles WHERE url=?1"),
        params![url],
        map_article,
    )
    .optional()
    .map_err(AppError::from)
    
}

pub fn list_article_urls(conn: &Connection) -> Result<std::collections::HashSet<String>, AppError> {
    let mut stmt = conn
        .prepare("SELECT url FROM articles")
        ?;
    let rows = stmt
        .query_map([], |row| row.get::<_, String>(0))
        ?
        .collect::<Result<std::collections::HashSet<_>, _>>()
        ?;
    Ok(rows)
}

/// url → stored body length in bytes (used to refresh stale RSS bodies).
pub fn list_article_content_lengths(
    conn: &Connection,
) -> Result<std::collections::HashMap<String, usize>, AppError> {
    let mut stmt = conn
        .prepare("SELECT url, LENGTH(content_text) FROM articles")
        ?;
    let rows = stmt
        .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)? as usize)))
        ?
        .collect::<Result<std::collections::HashMap<_, _>, _>>()
        ?;
    Ok(rows)
}

/// Insert only when `url` is new. Returns `true` if inserted, `false` if already present.
/// Idempotent: never overwrites existing content / translations.
pub fn insert_article_if_new(conn: &Connection, a: &Article) -> Result<bool, AppError> {
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
        ?;
    Ok(changed > 0)
}

/// Refresh an existing RSS article when a longer full-text body is available.
/// Matches by URL: callers may build the update struct with an empty/fresh id
/// (the RSS refresh path does exactly that).
/// Keeps id / url / title_zh / source / category / published_at / origin intact.
/// Clears `summary_zh` so the refresh pipeline regenerates it for the new body.
pub fn refresh_article_content(conn: &Connection, a: &Article) -> Result<bool, AppError> {
    let changed = conn
        .execute(
            "UPDATE articles SET title=?1, content_text=?2, fetched_at=?3, summary_zh='',
                    word_count=?4, quality='fulltext', extraction_source=?5
             WHERE url=?6 AND origin='rss' AND content_text <> ?2",
            params![a.title, a.content_text, a.fetched_at, a.word_count, a.extraction_source, a.url],
        )
        ?;
    Ok(changed > 0)
}

/// RSS articles whose body quality has not been assessed yet (`quality=''`).
/// Legacy rows get assessed once during refresh; new rows are stamped on insert.
pub fn list_unassessed_rss_articles(conn: &Connection) -> Result<Vec<Article>, AppError> {
    let mut stmt = conn
        .prepare(&format!(
            "SELECT {ARTICLE_COLS} FROM articles WHERE origin='rss' AND quality=''"
        ))
        ?;
    let rows = stmt
        .query_map([], map_article)
        ?
        .collect::<Result<Vec<_>, _>>()
        ?;
    Ok(rows)
}

/// Store topic tags (lowercase English) produced by card translation.
/// Empty string = no tags yet; overwritten wholesale on refresh.
pub fn set_article_tags(conn: &Connection, id: &str, tags: &[String]) -> Result<(), AppError> {
    let json = if tags.is_empty() {
        String::new()
    } else {
        serde_json::to_string(tags)?
    };
    conn.execute(
        "UPDATE articles SET tags_json=?1 WHERE id=?2",
        params![json, id],
    )
    .map_err(AppError::from)?;
    Ok(())
}

/// Stamp the body-quality verdict on an article (once; never re-derived later).
pub fn set_article_quality(
    conn: &Connection,
    id: &str,
    quality: &str,
    extraction_source: &str,
    word_count: i64,
) -> Result<(), AppError> {
    conn.execute(
        "UPDATE articles SET quality=?1, extraction_source=?2, word_count=?3 WHERE id=?4",
        params![quality, extraction_source, word_count, id],
    )
    ?;
    Ok(())
}

/// Accumulate visible reading time and optionally mark the article as read to the end.
/// Delta is clamped so a buggy client can't inflate a session in one call.
pub fn add_article_reading_progress(
    conn: &Connection,
    id: &str,
    dwell_ms_delta: i64,
    read_completed: bool,
) -> Result<(), AppError> {
    const MAX_DWELL_DELTA_MS: i64 = 120_000;
    let delta = dwell_ms_delta.clamp(-MAX_DWELL_DELTA_MS, MAX_DWELL_DELTA_MS);
    let changed = conn
        .execute(
            "UPDATE articles
             SET dwell_ms = MAX(0, dwell_ms + ?1),
                 read_completed = CASE WHEN ?2 THEN 1 ELSE read_completed END
             WHERE id=?3",
            params![delta, read_completed, id],
        )
        .map_err(AppError::from)?;
    if changed == 0 {
        return Err(AppError::msg("article not found"));
    }
    Ok(())
}

pub fn set_article_liked(conn: &Connection, id: &str, liked: bool) -> Result<(), AppError> {
    let changed = conn
        .execute(
            "UPDATE articles SET liked=?1 WHERE id=?2",
            params![liked, id],
        )
        ?;
    if changed == 0 {
        return Err(AppError::msg("article not found"));
    }
    Ok(())
}

/// `(title, url)` of articles ingested within the dedup window — the seed for
/// the refresh-time title-dedup index. Windowed so recurring same-name
/// features (daily briefings, link roundups) are never swallowed forever.
pub fn list_article_titles(
    conn: &Connection,
    since: Option<&str>,
) -> Result<Vec<(String, String)>, AppError> {
    let (sql, args): (&str, Vec<&str>) = match since {
        Some(s) => ("SELECT title, url FROM articles WHERE fetched_at >= ?1", vec![s]),
        None => ("SELECT title, url FROM articles", vec![]),
    };
    let mut stmt = conn.prepare(sql).map_err(AppError::from)?;
    let rows = stmt
        .query_map(rusqlite::params_from_iter(args.iter()), |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(AppError::from)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(AppError::from)?;
    Ok(rows)
}

/// Every stored RSS article (full body) — used by one-time content audits.
pub fn list_all_rss_articles(conn: &Connection) -> Result<Vec<Article>, AppError> {
    let mut stmt = conn
        .prepare(&format!(
            "SELECT {ARTICLE_COLS} FROM articles WHERE origin='rss'"
        ))
        .map_err(AppError::from)?;
    let rows = stmt
        .query_map([], map_article)
        .map_err(AppError::from)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(AppError::from)?;
    Ok(rows)
}

/// Retention purge: drop auto-ingested articles whose publication (falling
/// back to fetch) time is older than `cutoff`. Liked articles and user
/// imports are kept.
pub fn purge_old_rss_articles(conn: &Connection, cutoff_rfc3339: &str) -> Result<usize, AppError> {
    let changed = conn
        .execute(
            "DELETE FROM articles
             WHERE origin='rss' AND liked=0
               AND julianday(COALESCE(published_at, fetched_at)) < julianday(?1)",
            params![cutoff_rfc3339],
        )
        .map_err(AppError::from)?;
    Ok(changed)
}

pub fn get_meta(conn: &Connection, key: &str) -> Result<Option<String>, AppError> {
    conn.query_row(
        "SELECT value FROM app_meta WHERE key=?1",
        params![key],
        |row| row.get(0),
    )
    .optional()
    .map_err(AppError::from)
}

pub fn set_meta(conn: &Connection, key: &str, value: &str) -> Result<(), AppError> {
    conn.execute(
        "INSERT INTO app_meta (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        params![key, value],
    )
    .map_err(AppError::from)?;
    Ok(())
}

/// Parse the stored tags JSON; malformed/empty → no tags.
pub fn parse_tags_json(raw: &str) -> Vec<String> {
    if raw.trim().is_empty() {
        return vec![];
    }
    serde_json::from_str::<Vec<String>>(raw).unwrap_or_default()
}

/// Articles that still lack topic tags (for the one-time / rolling backfill).
pub fn articles_missing_tags(conn: &Connection, limit: usize) -> Result<Vec<Article>, AppError> {
    let mut stmt = conn
        .prepare(&format!(
            "SELECT {ARTICLE_COLS} FROM articles
             WHERE IFNULL(tags_json,'') = '' AND quality='fulltext'
             ORDER BY fetched_at DESC
             LIMIT ?1"
        ))
        .map_err(AppError::from)?;
    let rows = stmt
        .query_map(params![limit as i64], map_article)
        .map_err(AppError::from)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(AppError::from)?;
    Ok(rows)
}

/// Interest profile inputs for tag-based ranking:
/// - `user_weights`: tag → engagement weight (liked 2.0, read-to-end 1.0)
/// - `doc_counts`: tag → number of articles carrying it
/// - `docs`: number of tagged articles (IDF denominator)
pub fn tag_profile(
    conn: &Connection,
) -> Result<
    (
        std::collections::HashMap<String, f64>,
        std::collections::HashMap<String, i64>,
        i64,
    ),
    AppError,
> {
    let mut stmt = conn
        .prepare("SELECT tags_json, liked, read_completed FROM articles")
        .map_err(AppError::from)?;
    let mut rows = stmt.query([]).map_err(AppError::from)?;

    let mut user_weights: std::collections::HashMap<String, f64> =
        std::collections::HashMap::new();
    let mut doc_counts: std::collections::HashMap<String, i64> =
        std::collections::HashMap::new();
    let mut docs = 0i64;

    while let Some(row) = rows.next().map_err(AppError::from)? {
        let tags = parse_tags_json(&row.get::<_, String>(0).map_err(AppError::from)?);
        if tags.is_empty() {
            continue;
        }
        docs += 1;
        let liked: i64 = row.get(1).map_err(AppError::from)?;
        let completed: i64 = row.get(2).map_err(AppError::from)?;
        let weight = if liked != 0 {
            2.0
        } else if completed != 0 {
            1.0
        } else {
            0.0
        };
        for tag in tags {
            *doc_counts.entry(tag.clone()).or_insert(0) += 1;
            if weight > 0.0 {
                *user_weights.entry(tag).or_insert(0.0) += weight;
            }
        }
    }
    Ok((user_weights, doc_counts, docs))
}

/// All-time open counts grouped by source and by category — the affinity
/// signal for article ranking.
pub fn affinity_open_counts(
    conn: &Connection,
) -> Result<(std::collections::HashMap<String, i64>, std::collections::HashMap<String, i64>), AppError>
{
    let read = |sql: &str| -> Result<std::collections::HashMap<String, i64>, AppError> {
        let mut stmt = conn.prepare(sql)?;
        let rows = stmt
            .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)))
            ?
            .collect::<Result<std::collections::HashMap<_, _>, _>>()
            ?;
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
pub fn upsert_article(conn: &Connection, a: &Article) -> Result<(), AppError> {
    // Legacy alias used by older tests; refresh path uses insert_article_if_new.
    let _ = insert_article_if_new(conn, a)?;
    Ok(())
}

pub fn delete_article(conn: &Connection, id: &str) -> Result<(), AppError> {
    // translations CASCADE; vocab.article_id SET NULL (schema v3).
    conn.execute("DELETE FROM articles WHERE id=?1", params![id])
        ?;
    Ok(())
}

pub fn articles_missing_card_zh(conn: &Connection, limit: usize) -> Result<Vec<Article>, AppError> {
    let mut stmt = conn
        .prepare(&format!(
            "SELECT {ARTICLE_COLS} FROM articles
             WHERE IFNULL(title_zh,'') = '' OR IFNULL(summary_zh,'') = ''
             ORDER BY fetched_at DESC
             LIMIT ?1"
        ))
        ?;
    let rows = stmt
        .query_map(params![limit as i64], map_article)
        ?
        .collect::<Result<Vec<_>, _>>()
        ?;
    Ok(rows)
}

pub fn set_article_title_zh(conn: &Connection, id: &str, title_zh: &str) -> Result<(), AppError> {
    conn.execute(
        "UPDATE articles SET title_zh=?1 WHERE id=?2",
        params![title_zh, id],
    )
    ?;
    Ok(())
}

pub fn set_article_summary_zh(conn: &Connection, id: &str, summary_zh: &str) -> Result<(), AppError> {
    conn.execute(
        "UPDATE articles SET summary_zh=?1 WHERE id=?2",
        params![summary_zh, id],
    )
    ?;
    Ok(())
}
