use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Mutex;

pub struct DbState(pub Mutex<Connection>);

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Article {
    pub id: String,
    pub url: String,
    pub title: String,
    #[serde(default)]
    pub title_zh: String,
    pub source: String,
    pub category: String,
    pub published_at: Option<String>,
    pub content_text: String,
    pub fetched_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FeedSource {
    pub id: String,
    pub name: String,
    pub category: String,
    pub url: String,
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TranslationRow {
    pub id: i64,
    pub article_id: String,
    pub scope: String,
    pub scope_key: String,
    pub source_text: String,
    pub translated_text: String,
    pub model: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VocabItem {
    pub id: String,
    pub term: String,
    pub definition_zh: String,
    pub word_type: String,
    pub collocations: Vec<String>,
    pub context_sentence: String,
    pub article_id: Option<String>,
    pub status: String,
    pub interval_days: f64,
    pub reps: i64,
    pub consecutive_know: i64,
    pub next_review_at: String,
    pub created_at: String,
}

pub fn db_path(app_data: PathBuf) -> PathBuf {
    std::fs::create_dir_all(&app_data).ok();
    app_data.join("learnenglish.db")
}

pub fn open_db(path: PathBuf) -> Result<Connection, String> {
    let conn = Connection::open(path).map_err(|e| e.to_string())?;
    conn.execute_batch(
        r#"
        PRAGMA foreign_keys = ON;
        CREATE TABLE IF NOT EXISTS articles (
            id TEXT PRIMARY KEY,
            url TEXT NOT NULL UNIQUE,
            title TEXT NOT NULL,
            title_zh TEXT NOT NULL DEFAULT '',
            source TEXT NOT NULL,
            category TEXT NOT NULL,
            published_at TEXT,
            content_text TEXT NOT NULL,
            fetched_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS feed_sources (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            category TEXT NOT NULL,
            url TEXT NOT NULL UNIQUE,
            enabled INTEGER NOT NULL DEFAULT 1
        );
        CREATE TABLE IF NOT EXISTS translations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            article_id TEXT NOT NULL,
            scope TEXT NOT NULL,
            scope_key TEXT NOT NULL,
            source_text TEXT NOT NULL,
            translated_text TEXT NOT NULL,
            model TEXT NOT NULL,
            created_at TEXT NOT NULL,
            UNIQUE(article_id, scope, scope_key)
        );
        CREATE TABLE IF NOT EXISTS vocab (
            id TEXT PRIMARY KEY,
            term TEXT NOT NULL,
            definition_zh TEXT NOT NULL,
            word_type TEXT NOT NULL,
            collocations_json TEXT NOT NULL DEFAULT '[]',
            context_sentence TEXT NOT NULL DEFAULT '',
            article_id TEXT,
            status TEXT NOT NULL DEFAULT 'learning',
            interval_days REAL NOT NULL DEFAULT 0,
            reps INTEGER NOT NULL DEFAULT 0,
            consecutive_know INTEGER NOT NULL DEFAULT 0,
            next_review_at TEXT NOT NULL,
            created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_articles_category ON articles(category);
        CREATE INDEX IF NOT EXISTS idx_vocab_status ON vocab(status);
        CREATE INDEX IF NOT EXISTS idx_vocab_next ON vocab(next_review_at);
        "#,
    )
    .map_err(|e| e.to_string())?;
    // migrate older DBs
    let _ = conn.execute(
        "ALTER TABLE articles ADD COLUMN title_zh TEXT NOT NULL DEFAULT ''",
        [],
    );
    seed_feeds(&conn)?;
    Ok(conn)
}

fn seed_feeds(conn: &Connection) -> Result<(), String> {
    let seeds = curated_feeds();
    // Insert newly curated feeds; IGNORE keeps existing enable/disable.
    for f in &seeds {
        conn.execute(
            "INSERT OR IGNORE INTO feed_sources (id, name, category, url, enabled) VALUES (?1,?2,?3,?4,1)",
            params![f.id, f.name, f.category, f.url],
        )
        .map_err(|e| e.to_string())?;
        // Keep name/category/url in sync if we retarget a curated id.
        conn.execute(
            "UPDATE feed_sources SET name=?1, category=?2, url=?3 WHERE id=?4",
            params![f.name, f.category, f.url, f.id],
        )
        .map_err(|e| e.to_string())?;
    }
    // Drop obsolete curated sources (e.g. old programming blogs).
    let keep: std::collections::HashSet<&str> = seeds.iter().map(|f| f.id.as_str()).collect();
    for existing in list_feeds(conn)? {
        if !keep.contains(existing.id.as_str()) {
            conn.execute("DELETE FROM feed_sources WHERE id=?1", params![existing.id])
                .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

fn feed(id: &str, name: &str, category: &str, url: &str) -> FeedSource {
    FeedSource {
        id: id.into(),
        name: name.into(),
        category: category.into(),
        url: url.into(),
        enabled: true,
    }
}

/// Classic news + well-known blogs/newsletters + AI-oriented tech.
/// Prefer free/full-text article feeds; no podcasts (show notes only).
pub fn curated_feeds() -> Vec<FeedSource> {
    vec![
        // tech — AI / general tech news & commentary
        feed(
            "mit-technology-review",
            "MIT Technology Review",
            "tech",
            "https://www.technologyreview.com/feed/",
        ),
        feed(
            "mit-tr-ai",
            "MIT TR · Artificial Intelligence",
            "tech",
            "https://www.technologyreview.com/topic/artificial-intelligence/feed",
        ),
        feed(
            "the-verge",
            "The Verge",
            "tech",
            "https://www.theverge.com/rss/index.xml",
        ),
        feed(
            "arstechnica",
            "Ars Technica",
            "tech",
            "https://feeds.arstechnica.com/arstechnica/index",
        ),
        feed(
            "conversation-ai",
            "The Conversation · AI",
            "tech",
            "https://theconversation.com/us/topics/artificial-intelligence-ai-90/articles.atom",
        ),
        feed(
            "platformer",
            "Platformer",
            "tech",
            "https://www.platformer.news/feed",
        ),
        feed(
            "last-week-in-ai",
            "Last Week in AI",
            "tech",
            "https://lastweekin.ai/feed",
        ),
        feed(
            "one-useful-thing",
            "One Useful Thing",
            "tech",
            "https://www.oneusefulthing.org/feed",
        ),
        feed(
            "benedict-evans",
            "Benedict Evans",
            "tech",
            "https://www.ben-evans.com/benedictevans?format=rss",
        ),
        feed(
            "stratechery",
            "Stratechery",
            "tech",
            "https://stratechery.com/feed/",
        ),
        feed(
            "daring-fireball",
            "Daring Fireball",
            "tech",
            "https://daringfireball.net/feeds/main",
        ),
        // finance — business explainers & newsletters
        feed(
            "conversation-business",
            "The Conversation · Business",
            "finance",
            "https://theconversation.com/us/business/articles.atom",
        ),
        feed(
            "lennys-newsletter",
            "Lenny's Newsletter",
            "finance",
            "https://www.lennysnewsletter.com/feed",
        ),
        feed(
            "not-boring",
            "Not Boring",
            "finance",
            "https://www.notboring.co/feed",
        ),
        // world — classic free / open newsrooms (RSS + page fetch for full text)
        feed(
            "guardian-world",
            "The Guardian · World",
            "world",
            "https://www.theguardian.com/world/rss",
        ),
        feed(
            "guardian-international",
            "The Guardian · International",
            "world",
            "https://www.theguardian.com/international/rss",
        ),
        feed(
            "bbc-world",
            "BBC News · World",
            "world",
            "https://feeds.bbci.co.uk/news/world/rss.xml",
        ),
        feed(
            "aljazeera",
            "Al Jazeera English",
            "world",
            "https://www.aljazeera.com/xml/rss/all.xml",
        ),
        feed(
            "dw-english",
            "Deutsche Welle",
            "world",
            "https://rss.dw.com/rdf/rss-en-all",
        ),
        feed(
            "npr-news",
            "NPR News",
            "world",
            "https://feeds.npr.org/1001/rss.xml",
        ),
        feed(
            "france24",
            "France 24 English",
            "world",
            "https://www.france24.com/en/rss",
        ),
        feed(
            "un-news",
            "UN News",
            "world",
            "https://news.un.org/feed/subscribe/en/news/all/rss.xml",
        ),
        feed(
            "conversation-us",
            "The Conversation US",
            "world",
            "https://theconversation.com/us/articles.atom",
        ),
        feed(
            "conversation-world",
            "The Conversation · World",
            "world",
            "https://theconversation.com/us/world/articles.atom",
        ),
        feed(
            "propublica",
            "ProPublica",
            "world",
            "https://www.propublica.org/feeds/propublica/main",
        ),
        feed(
            "who-news",
            "WHO News",
            "world",
            "https://www.who.int/rss-feeds/news-english.xml",
        ),
        // other — classic blogs, science / space
        feed(
            "nasa",
            "NASA Breaking News",
            "other",
            "https://www.nasa.gov/rss/dyn/breaking_news.rss",
        ),
        feed(
            "space-com",
            "Space.com",
            "other",
            "https://www.space.com/feeds/all",
        ),
        feed(
            "quanta",
            "Quanta Magazine",
            "other",
            "https://www.quantamagazine.org/feed/",
        ),
        feed(
            "conversation-science",
            "The Conversation · Science",
            "other",
            "https://theconversation.com/us/science/articles.atom",
        ),
        feed(
            "wait-but-why",
            "Wait But Why",
            "other",
            "https://waitbutwhy.com/feed",
        ),
        feed(
            "the-marginalian",
            "The Marginalian",
            "other",
            "https://www.themarginalian.org/feed/",
        ),
        feed(
            "farnam-street",
            "Farnam Street",
            "other",
            "https://fs.blog/feed/",
        ),
        feed(
            "seth-godin",
            "Seth's Blog",
            "other",
            "https://seths.blog/feed/",
        ),
        feed(
            "james-clear",
            "James Clear",
            "other",
            "https://jamesclear.com/feed",
        ),
        feed(
            "cal-newport",
            "Cal Newport",
            "other",
            "https://www.calnewport.com/blog/feed/",
        ),
        feed(
            "ted-ideas",
            "TED Ideas",
            "other",
            "https://ideas.ted.com/feed/",
        ),
        feed(
            "open-culture",
            "Open Culture",
            "other",
            "https://www.openculture.com/feed",
        ),
    ]
}

pub fn list_articles(
    conn: &Connection,
    category: Option<&str>,
) -> Result<Vec<Article>, String> {
    let mut sql = String::from(
        "SELECT id,url,title,title_zh,source,category,published_at,content_text,fetched_at FROM articles",
    );
    let mut params_vec: Vec<String> = vec![];
    if let Some(cat) = category {
        if cat != "all" {
            sql.push_str(" WHERE category=?1");
            params_vec.push(cat.to_string());
        }
    }
    sql.push_str(" ORDER BY source ASC, fetched_at DESC, published_at DESC LIMIT 400");

    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = if params_vec.is_empty() {
        stmt.query_map([], map_article)
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?
    } else {
        stmt.query_map(params![params_vec[0]], map_article)
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?
    };
    Ok(rows)
}

fn map_article(row: &rusqlite::Row<'_>) -> rusqlite::Result<Article> {
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
    })
}

pub fn get_article(conn: &Connection, id: &str) -> Result<Option<Article>, String> {
    conn.query_row(
        "SELECT id,url,title,title_zh,source,category,published_at,content_text,fetched_at FROM articles WHERE id=?1",
        params![id],
        map_article,
    )
    .optional()
    .map_err(|e| e.to_string())
}

pub fn get_article_by_url(conn: &Connection, url: &str) -> Result<Option<Article>, String> {
    conn.query_row(
        "SELECT id,url,title,title_zh,source,category,published_at,content_text,fetched_at FROM articles WHERE url=?1",
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

/// Insert only when `url` is new. Returns `true` if inserted, `false` if already present.
/// Idempotent: never overwrites existing content / translations.
pub fn insert_article_if_new(conn: &Connection, a: &Article) -> Result<bool, String> {
    let changed = conn
        .execute(
            "INSERT INTO articles (id,url,title,title_zh,source,category,published_at,content_text,fetched_at)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)
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
                a.fetched_at
            ],
        )
        .map_err(|e| e.to_string())?;
    Ok(changed > 0)
}

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
    conn.execute("DELETE FROM articles WHERE id=?1", params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn articles_missing_title_zh(conn: &Connection, limit: usize) -> Result<Vec<Article>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id,url,title,title_zh,source,category,published_at,content_text,fetched_at
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

pub fn list_feeds(conn: &Connection) -> Result<Vec<FeedSource>, String> {
    let mut stmt = conn
        .prepare("SELECT id,name,category,url,enabled FROM feed_sources ORDER BY category,name")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok(FeedSource {
                id: row.get(0)?,
                name: row.get(1)?,
                category: row.get(2)?,
                url: row.get(3)?,
                enabled: row.get::<_, i64>(4)? == 1,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

pub fn set_feed_enabled(conn: &Connection, id: &str, enabled: bool) -> Result<(), String> {
    conn.execute(
        "UPDATE feed_sources SET enabled=?1 WHERE id=?2",
        params![if enabled { 1 } else { 0 }, id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

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
        |row| {
            Ok(TranslationRow {
                id: row.get(0)?,
                article_id: row.get(1)?,
                scope: row.get(2)?,
                scope_key: row.get(3)?,
                source_text: row.get(4)?,
                translated_text: row.get(5)?,
                model: row.get(6)?,
            })
        },
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
        .query_map(params![article_id], |row| {
            Ok(TranslationRow {
                id: row.get(0)?,
                article_id: row.get(1)?,
                scope: row.get(2)?,
                scope_key: row.get(3)?,
                source_text: row.get(4)?,
                translated_text: row.get(5)?,
                model: row.get(6)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

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
