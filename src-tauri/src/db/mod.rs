//! SQLite storage: schema + migrations + per-domain repositories.
//!
//! Sub-modules own their tables and re-export the repository functions at the
//! `db::` root so callers (`feeds`, `import_file`, `commands`, tests) keep a
//! single facade entry point.

mod articles;
mod curated_feeds;
mod feeds;
mod translations;
mod vocab;

pub use articles::*;
pub use curated_feeds::*;
pub use feeds::*;
pub use translations::*;
pub use vocab::*;

use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard};
use ts_rs::TS;

use crate::error::AppError;

/// Two pooled connections to the same WAL database. Writes serialize on the
/// write connection; reads run concurrently on the read connection instead of
/// queueing behind every writer.
pub struct DbState {
    write: Mutex<Connection>,
    read: Mutex<Connection>,
}

impl DbState {
    /// Open both connections. Migrations are idempotent, so opening twice is safe.
    pub fn open(app_data: PathBuf) -> Result<Self, AppError> {
        let write = open_db(app_data.clone())?;
        let read = open_db(app_data)?;
        Ok(Self {
            write: Mutex::new(write),
            read: Mutex::new(read),
        })
    }

    pub fn lock_write(&self) -> Result<MutexGuard<'_, Connection>, AppError> {
        self.write.lock().map_err(|_| AppError::Locked)
    }

    pub fn lock_read(&self) -> Result<MutexGuard<'_, Connection>, AppError> {
        self.read.lock().map_err(|_| AppError::Locked)
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, TS)]
#[ts(export)]
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
    /// rss = auto-ingested; url / file = user-imported (never purged by refresh).
    #[serde(default = "default_article_origin")]
    pub origin: String,
    /// LLM-generated Simplified Chinese blurb, at most 50 characters.
    #[serde(default)]
    pub summary_zh: String,
    /// Set when the reader is opened. Implicit; never asked.
    #[serde(default)]
    pub last_opened_at: Option<String>,
    #[serde(default)]
    #[ts(type = "number")]
    pub open_count: i64,
    /// Whitespace-delimited word count of the body, stamped at ingest/refresh.
    #[serde(default)]
    #[ts(type = "number")]
    pub word_count: i64,
    /// '' = not yet assessed; 'fulltext' once the body passed the readability gate.
    #[serde(default)]
    pub quality: String,
    /// Where the final body came from: rss | page | url | file.
    #[serde(default)]
    pub extraction_source: String,
    /// Accumulated visible reading time in milliseconds.
    #[serde(default)]
    #[ts(type = "number")]
    pub dwell_ms: i64,
    #[serde(default)]
    pub read_completed: bool,
    #[serde(default)]
    pub liked: bool,
    /// Lowercase English topic tags from card translation (semantic profile input).
    #[serde(default)]
    pub tags: Vec<String>,
}

/// Home-list row: excerpt only. Full body stays on `Article` / get_article.
#[derive(Debug, Clone, Default, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ArticleListItem {
    pub id: String,
    pub url: String,
    pub title: String,
    #[serde(default)]
    pub title_zh: String,
    pub source: String,
    pub category: String,
    pub published_at: Option<String>,
    pub excerpt: String,
    pub fetched_at: String,
    #[serde(default = "default_article_origin")]
    pub origin: String,
    #[serde(default)]
    pub summary_zh: String,
    #[serde(default)]
    pub last_opened_at: Option<String>,
    #[serde(default)]
    #[ts(type = "number")]
    pub open_count: i64,
    #[serde(default)]
    #[ts(type = "number")]
    pub word_count: i64,
    /// Interest rank from the ranked list; 0 when unranked.
    #[serde(default)]
    #[ts(type = "number")]
    pub rank_score: f64,
    #[serde(default)]
    #[ts(type = "number")]
    pub dwell_ms: i64,
    #[serde(default)]
    pub read_completed: bool,
    #[serde(default)]
    pub liked: bool,
    /// Lowercase English topic tags (for filtering + interest profile).
    #[serde(default)]
    pub tags: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct LearningStats {
    #[ts(type = "number")]
    pub opened_total: i64,
    #[ts(type = "number")]
    pub opened_7d: i64,
    pub top_source: Option<String>,
    pub top_category: Option<String>,
    #[ts(type = "number")]
    pub vocab_created_7d: i64,
    #[ts(type = "number")]
    pub vocab_learning: i64,
}

fn default_article_origin() -> String {
    "rss".into()
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct FeedSource {
    pub id: String,
    pub name: String,
    pub category: String,
    pub url: String,
    pub enabled: bool,
    /// curated = built-in seed; user = subscribed via manage UI
    #[serde(default = "default_feed_origin")]
    pub origin: String,
    #[serde(default)]
    pub description: String,
    /// HTTP ETag from the last successful fetch; sent back as If-None-Match.
    #[serde(default)]
    pub etag: String,
    #[serde(default)]
    pub last_fetched_at: Option<String>,
    /// Fraction of entries in the last refresh whose RSS body was trusted
    /// full-text. -1 = unknown (no data yet). Drives the per-feed trust bar.
    #[serde(default)]
    #[ts(type = "number")]
    pub fulltext_ratio: f64,
}

fn default_feed_origin() -> String {
    "curated".into()
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct FeedCategory {
    pub id: String,
    pub label: String,
    pub builtin: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct TranslationRow {
    #[ts(type = "number")]
    pub id: i64,
    pub article_id: String,
    pub scope: String,
    pub scope_key: String,
    pub source_text: String,
    pub translated_text: String,
    pub model: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
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
    #[ts(type = "number")]
    pub reps: i64,
    #[ts(type = "number")]
    pub consecutive_know: i64,
    pub next_review_at: String,
    pub created_at: String,
}

pub fn db_path(app_data: PathBuf) -> PathBuf {
    std::fs::create_dir_all(&app_data).ok();
    app_data.join("learnenglish.db")
}

pub fn open_db(path: PathBuf) -> Result<Connection, AppError> {
    let conn = Connection::open(path)?;
    let _ = conn.pragma_update(None, "journal_mode", "WAL");
    conn.execute_batch("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;")
        ?;
    migrate(&conn)?;
    feeds::seed_feed_categories(&conn)?;
    feeds::seed_feeds(&conn)?;
    Ok(conn)
}

const BASELINE_SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS articles (
    id TEXT PRIMARY KEY,
    url TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    title_zh TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL,
    category TEXT NOT NULL,
    published_at TEXT,
    content_text TEXT NOT NULL,
    fetched_at TEXT NOT NULL,
    origin TEXT NOT NULL DEFAULT 'rss'
);
CREATE TABLE IF NOT EXISTS feed_sources (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    category TEXT NOT NULL,
    url TEXT NOT NULL UNIQUE,
    enabled INTEGER NOT NULL DEFAULT 1,
    origin TEXT NOT NULL DEFAULT 'curated',
    description TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS feed_categories (
    id TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    builtin INTEGER NOT NULL DEFAULT 0
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
CREATE INDEX IF NOT EXISTS idx_translations_article ON translations(article_id);
CREATE INDEX IF NOT EXISTS idx_vocab_article ON vocab(article_id);
"#;

/// Column additions for databases created before these fields existed.
/// Only runs once (while stamping version 1); "duplicate column name" is the
/// expected no-op case.
const LEGACY_COLUMN_ADDITIONS: &[&str] = &[
    "ALTER TABLE articles ADD COLUMN title_zh TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE feed_sources ADD COLUMN origin TEXT NOT NULL DEFAULT 'curated'",
    "ALTER TABLE feed_sources ADD COLUMN description TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE articles ADD COLUMN origin TEXT NOT NULL DEFAULT 'rss'",
];

/// Version-gated migrations. To add one: raise `LATEST_VERSION` and apply its
/// DDL inside `migrate` when `stored < N`. Stamp each version with its own
/// number (never `LATEST_VERSION`) so later steps are not skipped.
const LATEST_VERSION: i64 = 8;

fn migrate(conn: &Connection) -> Result<(), AppError> {
    let mut stored: i64 = conn
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        ?;

    if stored < 1 {
        // v0 → v1: baseline schema. Idempotent DDL makes this safe both for fresh
        // databases and legacy ones that predate user_version stamping.
        conn.execute_batch(BASELINE_SCHEMA)
            ?;
        for sql in LEGACY_COLUMN_ADDITIONS {
            if let Err(e) = conn.execute(sql, []) {
                let msg = e.to_string();
                if !msg.contains("duplicate column name") {
                    return Err(AppError::msg(msg));
                }
            }
        }
        conn.pragma_update(None, "user_version", 1)
            ?;
        stored = 1;
    }

    if stored < 2 {
        vocab::collapse_duplicate_vocab_terms(conn)?;
        conn.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_vocab_term_lower ON vocab(lower(term))",
            [],
        )
        ?;
        conn.pragma_update(None, "user_version", 2)
            ?;
        stored = 2;
    }

    if stored < 3 {
        apply_v3_foreign_keys(conn)?;
        conn.pragma_update(None, "user_version", 3)
            ?;
        stored = 3;
    }

    if stored < 4 {
        if let Err(e) = conn.execute(
            "ALTER TABLE articles ADD COLUMN summary_zh TEXT NOT NULL DEFAULT ''",
            [],
        ) {
            let msg = e.to_string();
            if !msg.contains("duplicate column name") {
                return Err(AppError::msg(msg));
            }
        }
        conn.pragma_update(None, "user_version", 4)
            ?;
        stored = 4;
    }

    if stored < 5 {
        for sql in [
            "ALTER TABLE articles ADD COLUMN last_opened_at TEXT",
            "ALTER TABLE articles ADD COLUMN open_count INTEGER NOT NULL DEFAULT 0",
        ] {
            if let Err(e) = conn.execute(sql, []) {
                let msg = e.to_string();
                if !msg.contains("duplicate column name") {
                    return Err(AppError::msg(msg));
                }
            }
        }
        conn.pragma_update(None, "user_version", 5)
            ?;
        stored = 5;
    }

    if stored < 6 {
        // Quality metadata (stamped at ingest) + implicit reading signals
        // (dwell / completion / like) + per-feed HTTP/1.1 cache metadata.
        for sql in [
            "ALTER TABLE articles ADD COLUMN word_count INTEGER NOT NULL DEFAULT 0",
            "ALTER TABLE articles ADD COLUMN quality TEXT NOT NULL DEFAULT ''",
            "ALTER TABLE articles ADD COLUMN extraction_source TEXT NOT NULL DEFAULT ''",
            "ALTER TABLE articles ADD COLUMN dwell_ms INTEGER NOT NULL DEFAULT 0",
            "ALTER TABLE articles ADD COLUMN read_completed INTEGER NOT NULL DEFAULT 0",
            "ALTER TABLE articles ADD COLUMN liked INTEGER NOT NULL DEFAULT 0",
            "ALTER TABLE feed_sources ADD COLUMN etag TEXT NOT NULL DEFAULT ''",
            "ALTER TABLE feed_sources ADD COLUMN last_fetched_at TEXT",
            "ALTER TABLE feed_sources ADD COLUMN fulltext_ratio REAL NOT NULL DEFAULT -1",
        ] {
            if let Err(e) = conn.execute(sql, []) {
                let msg = e.to_string();
                if !msg.contains("duplicate column name") {
                    return Err(AppError::msg(msg));
                }
            }
        }
        conn.execute_batch(
            "CREATE INDEX IF NOT EXISTS idx_articles_fetched ON articles(fetched_at DESC);
             CREATE INDEX IF NOT EXISTS idx_articles_origin_quality ON articles(origin, quality);",
        )
        ?;
        conn.pragma_update(None, "user_version", 6)
            ?;
        stored = 6;
    }

    if stored < 7 {
        // Topic tags from card translation — input for semantic interest profiling.
        if let Err(e) = conn.execute(
            "ALTER TABLE articles ADD COLUMN tags_json TEXT NOT NULL DEFAULT ''",
            [],
        ) {
            let msg = e.to_string();
            if !msg.contains("duplicate column name") {
                return Err(AppError::msg(msg));
            }
        }
        conn.pragma_update(None, "user_version", 7)
            .map_err(AppError::from)?;
        stored = 7;
    }

    if stored < 8 {
        // Key/value app metadata: one-time backfill markers and similar
        // bookkeeping that must not be re-derived every refresh.
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS app_meta (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );",
        )
        .map_err(AppError::from)?;
        conn.pragma_update(None, "user_version", 8)
            .map_err(AppError::from)?;
        stored = 8;
    }

    if stored < LATEST_VERSION {
        return Err(AppError::msg(format!(
            "incomplete schema migration: user_version={stored}, expected {LATEST_VERSION}"
        )));
    }
    Ok(())
}

/// Rebuild translations/vocab with article FKs. SQLite cannot ADD CONSTRAINT.
fn apply_v3_foreign_keys(conn: &Connection) -> Result<(), AppError> {
    conn.execute_batch("PRAGMA foreign_keys = OFF;")
        ?;
    conn.execute_batch(
        r#"
        BEGIN;
        DELETE FROM translations WHERE article_id NOT IN (SELECT id FROM articles);
        UPDATE vocab SET article_id = NULL
          WHERE article_id IS NOT NULL
            AND article_id NOT IN (SELECT id FROM articles);

        CREATE TABLE translations_new (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            article_id TEXT NOT NULL,
            scope TEXT NOT NULL,
            scope_key TEXT NOT NULL,
            source_text TEXT NOT NULL,
            translated_text TEXT NOT NULL,
            model TEXT NOT NULL,
            created_at TEXT NOT NULL,
            UNIQUE(article_id, scope, scope_key),
            FOREIGN KEY (article_id) REFERENCES articles(id) ON DELETE CASCADE
        );
        INSERT INTO translations_new
            (id, article_id, scope, scope_key, source_text, translated_text, model, created_at)
        SELECT id, article_id, scope, scope_key, source_text, translated_text, model, created_at
          FROM translations;
        DROP TABLE translations;
        ALTER TABLE translations_new RENAME TO translations;
        CREATE INDEX IF NOT EXISTS idx_translations_article ON translations(article_id);

        CREATE TABLE vocab_new (
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
            created_at TEXT NOT NULL,
            FOREIGN KEY (article_id) REFERENCES articles(id) ON DELETE SET NULL
        );
        INSERT INTO vocab_new
            (id, term, definition_zh, word_type, collocations_json, context_sentence,
             article_id, status, interval_days, reps, consecutive_know, next_review_at, created_at)
        SELECT id, term, definition_zh, word_type, collocations_json, context_sentence,
               article_id, status, interval_days, reps, consecutive_know, next_review_at, created_at
          FROM vocab;
        DROP TABLE vocab;
        ALTER TABLE vocab_new RENAME TO vocab;
        CREATE INDEX IF NOT EXISTS idx_vocab_status ON vocab(status);
        CREATE INDEX IF NOT EXISTS idx_vocab_next ON vocab(next_review_at);
        CREATE INDEX IF NOT EXISTS idx_vocab_article ON vocab(article_id);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_vocab_term_lower ON vocab(lower(term));
        COMMIT;
        "#,
    )
    ?;
    conn.execute_batch("PRAGMA foreign_keys = ON;")
        ?;
    Ok(())
}