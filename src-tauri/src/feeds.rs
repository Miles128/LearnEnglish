use crate::config::AppConfig;
use crate::error::AppError;
use crate::db::{self, Article, DbState, FeedSource};
use crate::vocab;
use chrono::Utc;
use feed_rs::parser;
use regex::Regex;
use reqwest::blocking::Client;
use rusqlite::{params, Connection};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;
use ts_rs::TS;
use uuid::Uuid;

pub(crate) const MIN_FULLTEXT_CHARS: usize = 400;
/// Articles whose body is shorter than this many words are dropped for RSS
/// sources: a real learning session needs substance, not a blurb.
/// User imports (url/file) are never deleted.
pub(crate) const MIN_ARTICLE_WORDS: usize = 400;
/// RSS bodies at or above this length are treated as full-text feeds (no page required).
/// Shorter bodies are teasers/summaries — page fetch must succeed or the entry is skipped.
const TRUST_RSS_FULLTEXT_CHARS: usize = 2000;

const HTTP_USER_AGENT: &str = "Shiyan/0.1 (+local; educational)";

/// Shared blocking client so connections pool across feeds/pages instead of
/// being rebuilt per request.
static HTTP: LazyLock<Client> = LazyLock::new(|| {
    Client::builder()
        .user_agent(HTTP_USER_AGENT)
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .expect("build reqwest client")
});

static RE_TAG_STRIP: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"<[^>]+>").unwrap());
static RE_TRAILING_WS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[ \t]+\n").unwrap());
static RE_BLANK_RUN: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\n{3,}").unwrap());
static RE_HTML_TITLE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?is)<title[^>]*>(.*?)</title>").unwrap());
static RE_FOOTNOTE_DEF: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?m)^\[\d+\]:\s+\S+\s*$").unwrap());
static RE_LIST_LINK_LINE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?m)^\s*(?:[-*]|\d+\.)\s+\[").unwrap());
static RE_KEYWORD_TAIL: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?is)(?:Keywords for this article|Filed under:|^\s*Tags:).*$").unwrap()
});

#[derive(Debug, Default, Serialize, TS)]
#[ts(export)]
pub struct RefreshResult {
    pub fetched_feeds: usize,
    pub added_or_updated: usize,
    pub updated: usize,
    pub skipped_existing: usize,
    pub skipped_short: usize,
    pub skipped_non_english: usize,
    pub skipped_duplicate: usize,
    /// One-time backfill removals of synopsis-only / truncated bodies.
    pub purged_teasers: usize,
    /// Retention removals (articles older than the configured window).
    pub purged_old: usize,
    pub feeds_unchanged: usize,
    pub titles_translated: usize,
    pub errors: Vec<String>,
}

struct DownloadStats {
    skipped_existing: usize,
    skipped_short: usize,
    skipped_non_english: usize,
    skipped_duplicate: usize,
    /// Entries older than the retention window — never ingested.
    skipped_old: usize,
    /// Entries whose RSS body was trusted full-text without a page fetch.
    rss_fulltext_hits: usize,
    /// Entries considered for new content (denominator of fulltext_ratio).
    evaluated: usize,
}

impl Default for DownloadStats {
    fn default() -> Self {
        Self {
            skipped_existing: 0,
            skipped_short: 0,
            skipped_non_english: 0,
            skipped_duplicate: 0,
            skipped_old: 0,
            rss_fulltext_hits: 0,
            evaluated: 0,
        }
    }
}

struct FeedDownload {
    articles: Vec<Article>,
    updates: Vec<Article>,
    stats: DownloadStats,
    /// ETag from this response; None leaves the stored value untouched.
    etag: Option<String>,
    /// Server answered 304 Not-Modified — nothing to parse or insert.
    unchanged: bool,
}

#[derive(Debug, Clone, Serialize, TS)]
#[ts(export)]
pub struct RefreshProgress {
    /// download | translate | done
    pub phase: String,
    pub current: usize,
    pub total: usize,
    pub label: String,
    /// 0–100 overall progress across download + translate
    pub percent: u8,
}

#[derive(Debug, Clone, Serialize, TS)]
#[ts(export)]
pub struct FeedValidation {
    pub ok: bool,
    pub title: Option<String>,
    pub entry_count: usize,
    pub error: Option<String>,
}

/// Probe a URL: fetch + parse as RSS/Atom. Does not write to DB.
pub fn validate_feed_url(url: &str) -> FeedValidation {
    let url = url.trim();
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return FeedValidation {
            ok: false,
            title: None,
            entry_count: 0,
            error: Some("URL 必须以 http(s) 开头".into()),
        };
    }
    match HTTP.get(url).send().and_then(|r| r.error_for_status()) {
        Ok(resp) => match resp.bytes() {
            Ok(bytes) => match parser::parse(&bytes[..]) {
                Ok(parsed) => FeedValidation {
                    ok: true,
                    title: parsed.title.map(|t| t.content),
                    entry_count: parsed.entries.len(),
                    error: None,
                },
                Err(e) => FeedValidation {
                    ok: false,
                    title: None,
                    entry_count: 0,
                    error: Some(format!("不是有效的 RSS/Atom：{e}")),
                },
            },
            Err(e) => FeedValidation {
                ok: false,
                title: None,
                entry_count: 0,
                error: Some(e.to_string()),
            },
        },
        Err(e) => FeedValidation {
            ok: false,
            title: None,
            entry_count: 0,
            error: Some(e.to_string()),
        },
    }
}

/// Split candidate URLs into new vs already-known. Returns (new_urls, skipped_count).
#[cfg(test)]
pub fn partition_new_urls(candidates: &[String], known: &HashSet<String>) -> (Vec<String>, usize) {
    let mut new_urls = Vec::new();
    let mut skipped = 0usize;
    for url in candidates {
        if known.contains(url) {
            skipped += 1;
        } else {
            new_urls.push(url.clone());
        }
    }
    (new_urls, skipped)
}

pub(crate) fn select_enabled_feeds(feeds: Vec<FeedSource>) -> Vec<FeedSource> {
    feeds.into_iter().filter(|f| f.enabled).collect()
}

/// Tracking parameters stripped by [`canonical_article_url`].
const TRACKING_PARAMS: &[&str] = &[
    "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "utm_id",
    "fbclid", "gclid", "gclsrc", "dclid", "msclkid", "twclid", "igshid",
    "ref", "ref_src", "ref_url", "mc_cid", "mc_eid", "yclid",
    "_hsenc", "_hsmi", "vero_id", "pk_campaign", "pk_kwd", "si",
];

/// Canonical form of an article URL for dedup: drops fragment + tracking
/// params and a trailing slash. Only http(s); other schemes pass through.
pub(crate) fn canonical_article_url(raw: &str) -> String {
    let Ok(mut u) = url::Url::parse(raw) else {
        return raw.to_string();
    };
    if u.scheme() != "http" && u.scheme() != "https" {
        return raw.to_string();
    }
    u.set_fragment(None);
    if u.query().is_some() {
        let kept: Vec<(String, String)> = u
            .query_pairs()
            .filter(|(k, _)| !TRACKING_PARAMS.contains(&k.as_ref()))
            .map(|(k, v)| (k.into_owned(), v.into_owned()))
            .collect();
        u.set_query(None);
        if !kept.is_empty() {
            u.query_pairs_mut().extend_pairs(kept);
        }
    }
    if u.path().len() > 1 && u.path().ends_with('/') {
        let trimmed = u.path().trim_end_matches('/').to_string();
        u.set_path(&trimmed);
    }
    u.to_string()
}

/// Lowercase alphanumeric tokens of a title — the fuzzy-dedup key.
pub(crate) fn title_tokens(title: &str) -> Vec<String> {
    title
        .to_lowercase()
        .split(|c: char| !c.is_alphanumeric())
        .filter(|t| !t.is_empty())
        .map(str::to_owned)
        .collect()
}

/// Near-duplicate headline test across sources:
/// - exact match after normalization always counts;
/// - otherwise Jaccard ≥ 0.85 on token sets, but only for headline-sized
///   titles (≥8 tokens) so short unrelated headlines can't collide.
pub(crate) fn is_near_duplicate_title(a: &str, b: &str) -> bool {
    let ta = title_tokens(a);
    let tb = title_tokens(b);
    if ta.is_empty() || tb.is_empty() {
        return false;
    }
    if ta == tb {
        return true;
    }
    if ta.len() < 8 || tb.len() < 8 {
        return false;
    }
    let sa: std::collections::HashSet<&String> = ta.iter().collect();
    let sb: std::collections::HashSet<&String> = tb.iter().collect();
    let inter = sa.intersection(&sb).count();
    let union = sa.union(&sb).count();
    union > 0 && (inter as f64) / (union as f64) >= 0.85
}

/// In-memory title index for cross-source dedup during one refresh.
struct TitleIndex {
    exact: std::collections::HashSet<String>,
    fuzzy: Vec<(String, Vec<String>)>,
}

impl TitleIndex {
    fn new(rows: Vec<(String, String)>) -> Self {
        let mut index = Self {
            exact: std::collections::HashSet::new(),
            fuzzy: Vec::new(),
        };
        for (title, _url) in rows {
            index.insert(&title);
        }
        index
    }

    fn insert(&mut self, title: &str) {
        let tokens = title_tokens(title);
        if tokens.is_empty() {
            return;
        }
        self.exact.insert(tokens.join(" "));
        self.fuzzy.push((title.to_string(), tokens));
    }

    fn is_dup(&self, title: &str) -> bool {
        let tokens = title_tokens(title);
        if tokens.is_empty() {
            return false;
        }
        if self.exact.contains(&tokens.join(" ")) {
            return true;
        }
        self.fuzzy
            .iter()
            .any(|(existing, _)| is_near_duplicate_title(title, existing))
    }
}

/// Bodies ending in these markers were cut off — a teaser or a truncated
/// extract, never the whole story.
const TRUNCATION_TAIL_MARKERS: &[&str] = &[
    "continue reading",
    "read more",
    "read the rest",
    "read the full",
    "view the full",
    "full story at",
    "[…]",
    "…]",
];

/// True when the tail of a body looks cut off (feed teasers / truncated extracts).
pub(crate) fn looks_truncated(text: &str) -> bool {
    let char_count = text.chars().count();
    let skip = char_count.saturating_sub(100);
    let tail: String = text.chars().skip(skip).collect();
    let lower = tail.to_ascii_lowercase();
    TRUNCATION_TAIL_MARKERS.iter().any(|m| lower.contains(m))
}

/// Per-feed trust bar for RSS bodies, adapted by the feed's observed
/// full-text ratio from previous refreshes.
/// - `>= 0.7` (mostly full-text feeds): lower the bar, page fetches rarely pay off.
/// - `<= 0.2` (teaser-only feeds): raise the bar; short RSS bodies are junk.
/// - otherwise (or unknown, -1): the default bar.
pub(crate) fn rss_trust_chars(fulltext_ratio: f64) -> usize {
    if fulltext_ratio >= 0.7 {
        1200
    } else if fulltext_ratio >= 0.0 && fulltext_ratio <= 0.2 {
        3200
    } else {
        TRUST_RSS_FULLTEXT_CHARS
    }
}

/// One-time backfill: re-audit every stored RSS body with the current
/// readability rules and delete anything that is only a synopsis, a
/// truncated extract, or below the word threshold. Runs once (guarded by
/// `app_meta`), refreshing word counts on the survivors.
const CONTENT_AUDIT_KEY: &str = "content_audit_v1";

pub(crate) fn audit_rss_bodies_once(conn: &Connection) -> Result<usize, AppError> {
    if db::get_meta(conn, CONTENT_AUDIT_KEY)?.is_some() {
        return Ok(0);
    }
    let articles = db::list_all_rss_articles(conn)?;
    let mut removed = 0usize;
    for article in &articles {
        let word_count = article.content_text.split_whitespace().count() as i64;
        let bad = word_count < MIN_ARTICLE_WORDS as i64
            || !is_readable_article_body(&article.content_text)
            || looks_truncated(&article.content_text);
        if bad {
            db::delete_article(conn, &article.id)?;
            removed += 1;
        } else if article.word_count != word_count {
            db::set_article_quality(conn, &article.id, "fulltext", "rss", word_count)?;
        }
    }
    db::set_meta(conn, CONTENT_AUDIT_KEY, "done")?;
    Ok(removed)
}

/// Retention: drop auto-ingested articles older than `retention_days`
/// (0 = keep forever). Liked articles and user imports are never touched.
pub(crate) fn purge_expired_articles(
    conn: &Connection,
    retention_days: u32,
) -> Result<usize, AppError> {
    if retention_days == 0 {
        return Ok(0);
    }
    let cutoff = (Utc::now() - chrono::Duration::days(retention_days as i64)).to_rfc3339();
    db::purge_old_rss_articles(conn, &cutoff)
}

/// Assess rows whose quality was never stamped (legacy rows and anything
/// that predates the quality column). Deletes non-English / junk bodies and
/// stamps the rest as 'fulltext'. Assessed rows are never re-derived later,
/// so refresh cost stays proportional to new data.
pub(crate) fn assess_unassessed_articles(conn: &Connection) -> Result<(usize, usize), AppError> {
    let unassessed = db::list_unassessed_rss_articles(conn)?;
    let mut del_non_english = 0usize;
    let mut del_short = 0usize;
    for article in &unassessed {
        if !is_english_article(None, &article.title, &article.content_text) {
            db::delete_article(conn, &article.id)?;
            del_non_english += 1;
        } else if !is_readable_article_body(&article.content_text) {
            db::delete_article(conn, &article.id)?;
            del_short += 1;
        } else {
            let word_count = article.content_text.split_whitespace().count() as i64;
            db::set_article_quality(conn, &article.id, "fulltext", "rss", word_count)?;
        }
    }
    Ok((del_non_english, del_short))
}

/// Enforce [`MIN_ARTICLE_WORDS`] on stored RSS bodies (idempotent, cheap).
/// Runs every refresh so a raised threshold backfills against stamped rows.
pub(crate) fn purge_rss_below_word_threshold(conn: &Connection) -> Result<usize, AppError> {
    let changed = conn
        .execute(
            "DELETE FROM articles WHERE origin='rss' AND word_count > 0 AND word_count < ?1",
            params![MIN_ARTICLE_WORDS as i64],
        )
        ?;
    Ok(changed)
}

/// How many feeds download concurrently. Bounded to keep polite to servers
/// and to preserve per-feed progress ordering in the UI.
const PARALLEL_FEEDS: usize = 4;

pub fn refresh_feeds(
    db: &DbState,
    cfg: &AppConfig,
    mut on_progress: impl FnMut(RefreshProgress) + Send + 'static,
) -> Result<RefreshResult, AppError> {
    let feeds = {
        let conn = db.lock_read()?;
        db::list_feeds(&conn)?
    };

    let enabled: Vec<FeedSource> = select_enabled_feeds(feeds);

    let download_total = enabled.len();
    // Reserve ~80% of the bar for downloads, ~20% for title translation.
    let translate_weight = 20u8;
    let download_weight = 80u8;

    let mut result = RefreshResult::default();

    if download_total == 0 {
        on_progress(RefreshProgress {
            phase: "done".into(),
            current: 0,
            total: 0,
            label: "没有启用的订阅源".into(),
            percent: 100,
        });
        return Ok(result);
    }

    // Progress flows through a channel: workers (and this thread) send
    // events, one pump thread owns the `FnMut` callback.
    let (progress_tx, progress_rx) = std::sync::mpsc::channel::<RefreshProgress>();
    let pump = std::thread::spawn(move || {
        for event in progress_rx {
            on_progress(event);
        }
    });
    let report = |phase: &str, current: usize, total: usize, label: String, percent: u8| {
        let _ = progress_tx.send(RefreshProgress {
            phase: phase.into(),
            current,
            total,
            label,
            percent,
        });
    };

    // One-time assessment of rows that never got a quality stamp.
    {
        let conn = db.lock_write()?;
        let (del_non_english, del_short) = assess_unassessed_articles(&conn)?;
        result.skipped_non_english += del_non_english;
        result.skipped_short += del_short;
        result.skipped_short += purge_rss_below_word_threshold(&conn)?;
        // One-time body audit: synopsis-only / truncated bodies out.
        result.purged_teasers += audit_rss_bodies_once(&conn)?;
        // Retention window from settings.
        result.purged_old += purge_expired_articles(&conn, cfg.article_retention_days)?;
    }
    let known_urls = std::sync::Mutex::new({
        let conn = db.lock_write()?;
        db::list_article_urls(&conn)?
            .into_iter()
            .map(|u| canonical_article_url(&u))
            .collect::<HashSet<String>>()
    });
    // Dedup window: only recent titles, so recurring same-name features
    // (daily briefings, link roundups) are never swallowed forever.
    let dedup_since = (Utc::now() - chrono::Duration::days(14)).to_rfc3339();
    let title_index = std::sync::Mutex::new(TitleIndex::new({
        let conn = db.lock_read()?;
        db::list_article_titles(&conn, Some(&dedup_since))?
    }));
    let known_lengths = {
        let conn = db.lock_read()?;
        db::list_article_content_lengths(&conn)?
    };
    let upgraded = std::sync::Mutex::<HashSet<String>>::new(HashSet::new());

    let next_index = std::sync::atomic::AtomicUsize::new(0);
    let done_feeds = std::sync::atomic::AtomicUsize::new(0);
    let shared = std::sync::Mutex::new(&mut result);
    let now = Utc::now().to_rfc3339();

    std::thread::scope(|scope| {
        let workers = PARALLEL_FEEDS.min(download_total);
        for _ in 0..workers {
            scope.spawn(|| loop {
                let index = next_index.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                if index >= download_total {
                    break;
                }
                let feed = &enabled[index];
                let done = done_feeds.load(std::sync::atomic::Ordering::SeqCst);
                report(
                    "download",
                    done + 1,
                    download_total,
                    format!("增量下载 {}/{}：{}", done + 1, download_total, feed.name),
                    ((done as u16 * download_weight as u16) / download_total.max(1) as u16) as u8,
                );

                let trust_chars = rss_trust_chars(feed.fulltext_ratio);
                let outcome =
                    download_feed_articles(
                        &HTTP,
                        feed,
                        trust_chars,
                        &known_urls,
                        &known_lengths,
                        &upgraded,
                        cfg.article_retention_days,
                    );
                done_feeds.fetch_add(1, std::sync::atomic::Ordering::SeqCst);

                let mut ok = true;
                let mut ratio: Option<f64> = None;
                match outcome {
                    Ok(download) => {
                        if download.unchanged {
                            (shared.lock().expect("refresh lock")).feeds_unchanged += 1;
                        }
                        {
                            let stats = download.stats;
                            let conn = db.lock_write();
                            match conn {
                                Err(e) => {
                                    ok = false;
                                    (shared.lock().expect("refresh lock"))
                                        .errors
                                        .push(format!("{}: {e}", feed.name));
                                }
                                Ok(conn) => {
                                    let mut stats = stats;
                                    for article in &download.articles {
                                        if title_index
                                            .lock()
                                            .expect("title index lock")
                                            .is_dup(&article.title)
                                        {
                                            stats.skipped_duplicate += 1;
                                            continue;
                                        }
                                        match db::insert_article_if_new(&conn, article) {
                                            Ok(true) => {
                                                known_urls
                                                    .lock()
                                                    .expect("known urls lock")
                                                    .insert(article.url.clone());
                                                title_index
                                                    .lock()
                                                    .expect("title index lock")
                                                    .insert(&article.title);
                                                (shared.lock().expect("refresh lock"))
                                                    .added_or_updated += 1;
                                            }
                                            Ok(false) => {
                                                stats.skipped_existing += 1;
                                            }
                                            Err(e) => {
                                                ok = false;
                                                (shared.lock().expect("refresh lock"))
                                                    .errors
                                                    .push(format!("{}: {e}", feed.name));
                                                break;
                                            }
                                        }
                                    }
                                    for update in &download.updates {
                                        if let Ok(true) = db::refresh_article_content(&conn, update) {
                                            (shared.lock().expect("refresh lock")).updated += 1;
                                        }
                                    }
                                    if stats.evaluated > 0 {
                                        ratio = Some(
                                            stats.rss_fulltext_hits as f64
                                                / stats.evaluated as f64,
                                        );
                                    }
                                    let mut result = shared.lock().expect("refresh lock");
                                    result.skipped_existing +=
                                        stats.skipped_existing + stats.skipped_old;
                                    result.skipped_short += stats.skipped_short;
                                    result.skipped_non_english += stats.skipped_non_english;
                                    result.skipped_duplicate += stats.skipped_duplicate;
                                }
                            }
                        }
                        match db.lock_write() {
                            Ok(conn) => {
                                if let Err(e) = db::set_feed_refresh_meta(
                                    &conn,
                                    &feed.id,
                                    download.etag.as_deref(),
                                    &now,
                                    ratio,
                                ) {
                                    ok = false;
                                    (shared.lock().expect("refresh lock"))
                                        .errors
                                        .push(format!("{}: {e}", feed.name));
                                }
                            }
                            Err(e) => {
                                ok = false;
                                (shared.lock().expect("refresh lock"))
                                    .errors
                                    .push(format!("{}: {e}", feed.name));
                            }
                        }
                    }
                    Err(e) => {
                        ok = false;
                        (shared.lock().expect("refresh lock"))
                            .errors
                            .push(format!("{}: {e}", feed.name));
                    }
                }
                if ok {
                    (shared.lock().expect("refresh lock")).fetched_feeds += 1;
                }
                let done = done_feeds.load(std::sync::atomic::Ordering::SeqCst);
                report(
                    "download",
                    done,
                    download_total,
                    format!("已完成 {done}/{download_total}：{}", feed.name),
                    ((done as u16 * download_weight as u16) / download_total.max(1) as u16) as u8,
                );
            });
        }
    });

    report(
        "translate",
        0,
        0,
        "正在翻译标题与简介…".into(),
        download_weight,
    );

    match fill_missing_card_zh(db, cfg, 80, |done, total| {
        let translate_pct = if total == 0 {
            translate_weight
        } else {
            ((done as u16 * translate_weight as u16) / total.max(1) as u16) as u8
        };
        report(
            "translate",
            done,
            total,
            if total == 0 {
                "标题与简介完成".into()
            } else {
                format!("正在翻译标题与简介 {done}/{total}")
            },
            download_weight.saturating_add(translate_pct).min(99),
        );
    }) {
        Ok(n) => result.titles_translated = n,
        Err(e) => result.errors.push(format!("标题/简介: {e}")),
    }

    report(
        "done",
        download_total,
        download_total,
        "刷新完成".into(),
        100,
    );
    drop(progress_tx);
    let _ = pump.join();

    Ok(result)
}

pub fn fill_missing_card_zh(
    db: &DbState,
    cfg: &AppConfig,
    limit: usize,
    mut on_progress: impl FnMut(usize, usize),
) -> Result<usize, AppError> {
    let missing = {
        let conn = db.lock_read()?;
        db::articles_missing_card_zh(&conn, limit)?
    };
    if missing.is_empty() {
        on_progress(0, 0);
        return Ok(0);
    }

    let total = missing.len();
    let mut done = 0usize;
    let mut last_err: Option<String> = None;
    on_progress(done, total);

    for chunk in missing.chunks(16) {
        let cards: Vec<vocab::ArticleCardIn> = chunk
            .iter()
            .map(|a| vocab::card_from_article(&a.title, &a.content_text))
            .collect();
        let translated = match vocab::translate_article_cards(cfg, &cards) {
            Ok(rows) => rows,
            Err(e) => {
                last_err = Some(format!(
                    "标题/简介（第 {}–{} 条）：{e}",
                    done + 1,
                    done + cards.len()
                ));
                continue;
            }
        };
        {
            let conn = db.lock_write()?;
            for (article, card) in chunk.iter().zip(translated.into_iter()) {
                let mut wrote = false;
                if article.title_zh.is_empty() && !card.title_zh.is_empty() {
                    db::set_article_title_zh(&conn, &article.id, &card.title_zh)?;
                    wrote = true;
                }
                if article.summary_zh.is_empty() && !card.summary_zh.is_empty() {
                    db::set_article_summary_zh(&conn, &article.id, &card.summary_zh)?;
                    wrote = true;
                }
                if !card.tags.is_empty() {
                    db::set_article_tags(&conn, &article.id, &card.tags)?;
                }
                if wrote {
                    done += 1;
                }
            }
        }
        on_progress(done, total);
    }
    if done == 0 {
        if let Some(e) = last_err {
            return Err(AppError::msg(e));
        }
    }
    Ok(done)
}

/// Download + parse one feed without holding the DB lock.
/// Skips entries whose URL is already in `known_urls` (incremental / idempotent).
/// `trust_chars` is the per-feed RSS full-text trust bar (see [`rss_trust_chars`]).
fn download_feed_articles(
    client: &Client,
    feed: &FeedSource,
    trust_chars: usize,
    known_urls: &std::sync::Mutex<HashSet<String>>,
    known_lengths: &HashMap<String, usize>,
    upgraded: &std::sync::Mutex<HashSet<String>>,
    retention_days: u32,
) -> Result<FeedDownload, AppError> {
    let mut stats = DownloadStats::default();
    let request = client.get(&feed.url);
    let request = if feed.etag.is_empty() {
        request
    } else {
        request.header(reqwest::header::IF_NONE_MATCH, feed.etag.as_str())
    };
    let resp = request.send()?;
    if resp.status() == reqwest::StatusCode::NOT_MODIFIED {
        return Ok(FeedDownload {
            articles: vec![],
            updates: vec![],
            stats,
            etag: None,
            unchanged: true,
        });
    }
    let etag = resp
        .headers()
        .get(reqwest::header::ETAG)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());
    let bytes = resp
        .error_for_status()
        ?
        .bytes()
        ?;

    let parsed = parser::parse(&bytes[..]).map_err(|e| AppError::msg(e.to_string()))?;
    let feed_language = parsed.language.clone();
    let mut articles = Vec::new();
    let mut updates = Vec::new();
    let now = Utc::now().to_rfc3339();

    let mut page_fetches = 0usize;
    const MAX_PAGE_FETCHES: usize = 12;

    let known_guard = known_urls.lock().map_err(|_| "known urls poisoned")?;

    for entry in parsed.entries.into_iter().take(40) {
        let url = entry
            .links
            .iter()
            .find(|l| {
                l.rel.as_deref() == Some("alternate")
                    || l.media_type.as_deref() == Some("text/html")
            })
            .or_else(|| entry.links.first())
            .map(|l| l.href.clone())
            .unwrap_or_else(|| entry.id.clone());
        if url.is_empty() {
            continue;
        }
        let url = canonical_article_url(&url);

        let title = entry
            .title
            .map(|t| t.content)
            .unwrap_or_else(|| "Untitled".into());

        // Retention: never ingest entries older than the configured window
        // (otherwise the purge/reseed loop re-adds them every refresh).
        let published = entry.published.or(entry.updated);
        if retention_days > 0 {
            if let Some(published_at) = published {
                let cutoff =
                    Utc::now() - chrono::Duration::days(retention_days as i64);
                if published_at < cutoff {
                    stats.skipped_old += 1;
                    continue;
                }
            }
        }

        let raw_html = entry
            .content
            .and_then(|c| c.body)
            .or_else(|| entry.summary.map(|s| s.content))
            .unwrap_or_default();

        let rss_text = html_to_text(&raw_html);

        // Already downloaded — only upgrade when the RSS body itself is now
        // trusted full-text AND meaningfully longer than what we stored.
        // Never page-fetch known URLs again (budget preserved for new ones).
        if known_guard.contains(&url) {
            let stored_len = known_lengths.get(&url).copied().unwrap_or(0);
            stats.evaluated += 1;
            if rss_text.chars().count() >= trust_chars
                && is_readable_article_body(&rss_text)
                && !looks_truncated(&rss_text)
                && rss_text.split_whitespace().count() >= MIN_ARTICLE_WORDS
                && rss_text.chars().count() > stored_len
            {
                // Two parallel workers can see the same URL from different
                // feeds; only the first upgrade wins.
                let mut upgraded = upgraded.lock().map_err(|_| "upgraded set poisoned")?;
                if !upgraded.insert(url.clone()) {
                    stats.skipped_existing += 1;
                    continue;
                }
                drop(upgraded);
                stats.rss_fulltext_hits += 1;
                updates.push(fulltext_article(
                    String::new(), // not used by refresh_article_content
                    url.clone(),
                    title,
                    feed.name.clone(),
                    feed.category.clone(),
                    entry
                        .published
                        .or(entry.updated)
                        .map(|d| d.to_rfc3339()),
                    rss_text,
                    now.clone(),
                    "rss",
                ));
            } else {
                stats.skipped_existing += 1;
            }
            continue;
        }

        // Full-text RSS can be trusted; teaser / chrome / tag-wall / truncated
        // bodies must fetch the article page. If the page is also junk, skip.
        let content_text = if rss_text.chars().count() >= trust_chars
            && is_readable_article_body(&rss_text)
            && !looks_truncated(&rss_text)
        {
            stats.evaluated += 1;
            stats.rss_fulltext_hits += 1;
            rss_text
        } else {
            stats.evaluated += 1;
            if page_fetches >= MAX_PAGE_FETCHES {
                stats.skipped_short += 1;
                continue;
            }
            page_fetches += 1;
            let page_text = fetch_article_page(client, &url).ok();
            match choose_article_body(&rss_text, page_text.as_deref()) {
                Some(body) => body,
                None => {
                    stats.skipped_short += 1;
                    continue;
                }
            }
        };

        if looks_like_paywall(&content_text) {
            stats.skipped_short += 1;
            continue;
        }

        if content_text.split_whitespace().count() < MIN_ARTICLE_WORDS {
            stats.skipped_short += 1;
            continue;
        }

        let language = entry.language.as_deref().or(feed_language.as_deref());
        if !is_english_article(language, &title, &content_text) {
            stats.skipped_non_english += 1;
            continue;
        }

        articles.push(fulltext_article(
            Uuid::new_v4().to_string(),
            url,
            title,
            feed.name.clone(),
            feed.category.clone(),
            entry
                .published
                .or(entry.updated)
                .map(|d| d.to_rfc3339()),
            content_text,
            now.clone(),
            "page",
        ));
    }
    Ok(FeedDownload {
        articles,
        updates,
        stats,
        etag,
        unchanged: false,
    })
}

/// Build an article whose body already passed the readability gate.
/// Stamps word count + quality so refresh never re-derives them.
fn fulltext_article(
    id: String,
    url: String,
    title: String,
    source: String,
    category: String,
    published_at: Option<String>,
    content_text: String,
    fetched_at: String,
    extraction_source: &str,
) -> Article {
    let word_count = content_text.split_whitespace().count() as i64;
    Article {
        id,
        url,
        title,
        title_zh: String::new(),
        source,
        category,
        published_at,
        content_text,
        fetched_at,
        origin: "rss".into(),
        summary_zh: String::new(),
        last_opened_at: None,
        open_count: 0,
        word_count,
        quality: "fulltext".into(),
        extraction_source: extraction_source.into(),
        dwell_ms: 0,
        read_completed: false,
        liked: false,
    }
}

/// Keep English-only articles for learning. Prefer feed/entry language tags;
/// fall back to a Latin-vs-other-script heuristic when tags are missing.
pub(crate) fn is_english_article(language: Option<&str>, title: &str, content: &str) -> bool {
    if let Some(tag) = language {
        if !is_english_lang_tag(tag) {
            return false;
        }
    }
    looks_like_english(title, content)
}

fn is_english_lang_tag(tag: &str) -> bool {
    let t = tag.trim().to_ascii_lowercase();
    t == "en" || t.starts_with("en-") || t.starts_with("en_")
}

fn looks_like_english(title: &str, content: &str) -> bool {
    let sample: String = title
        .chars()
        .chain(std::iter::once(' '))
        .chain(content.chars().take(1200))
        .collect();

    let mut letters = 0usize;
    let mut latin = 0usize;
    let mut non_latin = 0usize;

    for ch in sample.chars() {
        if !ch.is_alphabetic() {
            continue;
        }
        letters += 1;
        if ch.is_ascii_alphabetic() {
            latin += 1;
        } else {
            non_latin += 1;
        }
    }

    // Too little signal — keep (length filter already applied).
    if letters < 40 {
        return true;
    }

    // Obvious non-English scripts (CJK, Cyrillic, Arabic, etc.).
    if (non_latin as f64) / (letters as f64) > 0.12 {
        return false;
    }

    (latin as f64) / (letters as f64) >= 0.85
}

#[cfg(test)]
pub(crate) fn collect_non_english_rss_ids(conn: &Connection) -> Result<Vec<String>, AppError> {
    Ok(db::list_unassessed_rss_articles(conn)?
        .into_iter()
        .filter(|article| !is_english_article(None, &article.title, &article.content_text))
        .map(|article| article.id)
        .collect())
}

#[cfg(test)]
pub(crate) fn delete_articles(conn: &Connection, ids: &[String]) -> Result<usize, AppError> {
    let mut removed = 0usize;
    for id in ids {
        db::delete_article(conn, id)?;
        removed += 1;
    }
    Ok(removed)
}

#[cfg(test)]
pub(crate) fn purge_non_english_articles(conn: &Connection) -> Result<usize, AppError> {
    let (non_english, _) = assess_unassessed_articles(conn)?;
    Ok(non_english)
}

/// True when stored body would be rejected as RSS-only teaser (no trusted page fulltext).
#[cfg(test)]
fn is_summary_only_body(content: &str) -> bool {
    choose_article_body(content, None).is_none()
}

/// Nav chrome, keyword teasers, or link lists — not a readable article.
fn is_readable_article_body(text: &str) -> bool {
    if looks_like_page_chrome(text) || is_link_or_nav_dump(text) {
        return false;
    }
    prose_char_count(text) >= MIN_FULLTEXT_CHARS
}

fn looks_like_page_chrome(text: &str) -> bool {
    let head: String = text.chars().take(480).collect();
    let lower = head.to_ascii_lowercase();
    lower.contains("skip to main content")
        || lower.contains("skip to content")
        || lower.contains("open navigation menu")
        || lower.contains("googletagmanager.com")
}

fn is_link_or_nav_dump(text: &str) -> bool {
    let without_notes = RE_FOOTNOTE_DEF.replace_all(text, "");
    let lines: Vec<&str> = without_notes
        .lines()
        .filter(|line| !line.trim().is_empty())
        .collect();
    if lines.len() < 8 {
        return false;
    }
    let link_lines = lines
        .iter()
        .filter(|line| RE_LIST_LINK_LINE.is_match(line))
        .count();
    (link_lines as f64) / (lines.len() as f64) >= 0.5
}

fn prose_char_count(text: &str) -> usize {
    let mut s = RE_KEYWORD_TAIL.replace_all(text, "").into_owned();
    s = RE_FOOTNOTE_DEF.replace_all(&s, "").into_owned();
    s = RE_TAG_STRIP.replace_all(&s, " ").into_owned();
    s.split_whitespace().map(|w| w.chars().count()).sum()
}

#[cfg(test)]
pub(crate) fn purge_summary_only_articles(conn: &Connection) -> Result<usize, AppError> {
    let (_, short) = assess_unassessed_articles(conn)?;
    Ok(short)
}

fn html_to_text(html: &str) -> String {
    let stripped = html2text::from_read(html.as_bytes(), 100)
        .unwrap_or_else(|_| RE_TAG_STRIP.replace_all(html, " ").to_string());
    let s = RE_TRAILING_WS.replace_all(&stripped, "\n");
    let s = RE_BLANK_RUN.replace_all(&s, "\n\n");
    s.trim().to_string()
}

fn title_from_html(html: &str) -> Option<String> {
    let caps = RE_HTML_TITLE.captures(html)?;
    let raw = caps.get(1)?.as_str();
    let decoded = html_to_text(raw);
    let mut title = decoded.lines().next().unwrap_or("").trim().to_string();
    for sep in [" | ", " — ", " – ", " - "] {
        if let Some((left, _)) = title.split_once(sep) {
            let left = left.trim();
            if left.chars().count() >= 8 {
                title = left.to_string();
                break;
            }
        }
    }
    if title.is_empty() {
        None
    } else {
        Some(title)
    }
}

pub fn source_from_url(url: &str) -> String {
    url::Url::parse(url)
        .ok()
        .and_then(|u| u.host_str().map(|h| h.trim_start_matches("www.").to_string()))
        .filter(|h| !h.is_empty())
        .unwrap_or_else(|| "导入".into())
}

struct ExtractedPage {
    title: String,
    text: String,
}

/// Fetch a public article URL and extract title + main text (no paywall bypass).
fn extract_article_page(client: &Client, url: &str) -> Result<ExtractedPage, AppError> {
    let parsed = url::Url::parse(url).map_err(|e| AppError::msg(e.to_string()))?;
    let html = client
        .get(url)
        .header(
            "Accept",
            "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
        )
        .send()
        ?
        .error_for_status()
        ?
        .text()
        ?;

    if looks_like_paywall(&html) {
        return Err("疑似付费墙，已跳过".into());
    }

    let mut title = title_from_html(&html).unwrap_or_default();

    // Prefer readability extraction; fall back to html2text.
    let from_readability = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let mut cursor = std::io::Cursor::new(html.as_bytes());
        readability::extractor::extract(&mut cursor, &parsed).ok().map(|p| {
            let text = p.text.trim().to_string();
            let text = if text.is_empty() {
                html_to_text(&p.content)
            } else {
                text
            };
            let page_title = p.title.trim().to_string();
            (page_title, text)
        })
    }))
    .ok()
    .flatten();

    let text = if let Some((page_title, text)) = from_readability {
        if title.is_empty() && !page_title.is_empty() {
            title = page_title;
        }
        if is_readable_article_body(&text) {
            text
        } else {
            html_to_text(&html)
        }
    } else {
        html_to_text(&html)
    };

    if !is_readable_article_body(&text) {
        return Err("正文太短，未能抽到可读全文".into());
    }

    if title.is_empty() {
        title = "Untitled".into();
    }

    Ok(ExtractedPage { title, text })
}

/// Fetch a public article URL and extract main text (no paywall bypass).
fn fetch_article_page(client: &Client, url: &str) -> Result<String, AppError> {
    Ok(extract_article_page(client, url)?.text)
}

/// Import one public article URL into the local library.
pub fn import_article_from_url(db: &DbState, url: &str) -> Result<Article, AppError> {
    let url = url.trim();
    if url.is_empty() {
        return Err("请输入文章链接".into());
    }
    let parsed = url::Url::parse(url).map_err(|_| "链接格式不正确".to_string())?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err("仅支持 http/https 链接".into());
    }

    {
        let conn = db.lock_read()?;
        if let Some(existing) = db::get_article_by_url(&conn, url)? {
            return Ok(existing);
        }
    }

    let url: String = canonical_article_url(url);

    let extracted = extract_article_page(&HTTP, &url)?;
    if looks_like_paywall(&extracted.text) {
        return Err("疑似付费墙，已跳过".into());
    }
    if !is_english_article(None, &extracted.title, &extracted.text) {
        return Err("看起来不是英文文章".into());
    }
    if looks_truncated(&extracted.text) {
        return Err("正文疑似被截断，已跳过".into());
    }

    let article = Article {
        id: Uuid::new_v4().to_string(),
        url: url.to_string(),
        title: extracted.title,
        title_zh: String::new(),
        source: source_from_url(&url),
        category: "other".into(),
        published_at: None,
        word_count: extracted.text.split_whitespace().count() as i64,
        quality: "fulltext".into(),
        extraction_source: "url".into(),
        content_text: extracted.text,
        fetched_at: Utc::now().to_rfc3339(),
        origin: "url".into(),
        summary_zh: String::new(),
        last_opened_at: None,
        open_count: 0,
        dwell_ms: 0,
        read_completed: false,
        liked: false,
    };

    {
        let conn = db.lock_write()?;
        if !db::insert_article_if_new(&conn, &article)? {
            return db::get_article_by_url(&conn, &url)?
                .ok_or_else(|| "导入失败：文章未写入".into());
        }
    }
    let mut article = article;
    if let Ok(cfg) = crate::config::load_config() {
        let _ = fill_article_card_zh(db, &cfg, &mut article);
    }
    Ok(article)
}

pub fn fill_article_card_zh(
    db: &DbState,
    cfg: &AppConfig,
    article: &mut Article,
) -> Result<(), AppError> {
    if !article.title_zh.is_empty() && !article.summary_zh.is_empty() {
        return Ok(());
    }
    if cfg.api_key.trim().is_empty() {
        return Ok(());
    }
    let cards = [vocab::card_from_article(&article.title, &article.content_text)];
    let translated = vocab::translate_article_cards(cfg, &cards)?;
    let Some(card) = translated.into_iter().next() else {
        return Ok(());
    };
    let conn = db.lock_write()?;
    if article.title_zh.is_empty() && !card.title_zh.is_empty() {
        db::set_article_title_zh(&conn, &article.id, &card.title_zh)?;
        article.title_zh = card.title_zh;
    }
    if article.summary_zh.is_empty() && !card.summary_zh.is_empty() {
        db::set_article_summary_zh(&conn, &article.id, &card.summary_zh)?;
        article.summary_zh = card.summary_zh;
    }
    Ok(())
}

fn looks_like_paywall(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    const MARKERS: &[&str] = &[
        "subscribe to continue",
        "subscription required",
        "create a free account to read",
        "sign in to read",
        "already a subscriber",
        "metered paywall",
        "for subscribers only",
    ];
    MARKERS.iter().any(|m| lower.contains(m))
}

/// Decide final article body from RSS text and an optional page extract.
///
/// - Long, readable RSS (≥ [`TRUST_RSS_FULLTEXT_CHARS`]): trust as full-text.
/// - Otherwise only accept a page extract that is real prose (not a teaser,
///   nav/tag wall, or link dump). Never keep chrome just because it is long.
fn choose_article_body(rss_text: &str, page_text: Option<&str>) -> Option<String> {
    if rss_text.chars().count() >= TRUST_RSS_FULLTEXT_CHARS
        && is_readable_article_body(rss_text)
        && !looks_truncated(rss_text)
    {
        return Some(rss_text.to_string());
    }
    match page_text {
        Some(page) if is_readable_article_body(page) && !looks_truncated(page) => {
            Some(page.to_string())
        }
        _ => None,
    }
}

pub fn split_paragraphs(text: &str) -> Vec<String> {
    text.split("\n\n")
        .map(|p| p.trim().to_string())
        .filter(|p| !p.is_empty())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dummy_feed(id: &str, enabled: bool) -> FeedSource {
        FeedSource {
            id: id.into(),
            name: id.into(),
            category: "world".into(),
            url: format!("https://example.com/{id}"),
            enabled,
            origin: "curated".into(),
            description: String::new(),
            ..Default::default()
        }
    }

    #[test]
    fn select_enabled_uses_db_flag_only() {
        let enabled = select_enabled_feeds(vec![
            dummy_feed("on", true),
            dummy_feed("off", false),
        ]);
        assert_eq!(enabled.len(), 1);
        assert_eq!(enabled[0].id, "on");
    }

    #[test]
    fn trust_bar_adapts_to_feed_fulltext_ratio() {
        assert_eq!(rss_trust_chars(0.9), 1200, "full-text feeds lower the bar");
        assert_eq!(rss_trust_chars(0.7), 1200);
        assert_eq!(
            rss_trust_chars(0.1),
            3200,
            "teaser-only feeds raise the bar"
        );
        assert_eq!(rss_trust_chars(0.0), 3200);
        assert_eq!(
            rss_trust_chars(-1.0),
            TRUST_RSS_FULLTEXT_CHARS,
            "unknown ratio keeps the default"
        );
        assert_eq!(rss_trust_chars(0.5), TRUST_RSS_FULLTEXT_CHARS);
    }

    #[test]
    fn canonical_url_strips_tracking_and_noise() {
        assert_eq!(
            canonical_article_url(
                "https://example.com/story?utm_source=rss&utm_medium=feed&id=7#more"
            ),
            "https://example.com/story?id=7"
        );
        assert_eq!(
            canonical_article_url("https://Example.com/story/?fbclid=abc"),
            "https://example.com/story"
        );
        assert_eq!(
            canonical_article_url("https://example.com/a?gclid=x&fbclid=y"),
            "https://example.com/a"
        );
        // Non-http schemes and unparseable input pass through untouched.
        assert_eq!(canonical_article_url("mailto:a@b.c"), "mailto:a@b.c");
        assert_eq!(canonical_article_url("not a url"), "not a url");
    }

    #[test]
    fn near_duplicate_title_rules() {
        assert!(is_near_duplicate_title(
            "Fed Signals Open Door to Rate Cuts",
            "fed signals open door to rate cuts"
        ));
        assert!(is_near_duplicate_title(
            "Fed Signals Open Door to Rate Cuts in September Meeting Minutes",
            "Fed Signals Open Door to Rate Cuts in September Meeting Minutes"
        ));
        // Long headlines differing by a couple of words.
        let a = "The Federal Reserve Signaled It Could Cut Interest Rates at Its September Policy Meeting";
        let b = "The Federal Reserve Signaled It Might Cut Interest Rates at Its September Policy Meeting";
        assert!(is_near_duplicate_title(a, b));
        // Short headlines need exact matches.
        assert!(!is_near_duplicate_title(
            "Markets slide again",
            "Markets slide today"
        ));
        // Unrelated long headlines stay apart.
        assert!(!is_near_duplicate_title(
            "How remote work reshaped suburban housing markets across America",
            "A deep dive into the history of jazz piano in New Orleans"
        ));
        assert!(!is_near_duplicate_title("", "anything"));
    }

    #[test]
    fn title_index_dedups_across_sources() {
        let mut index = TitleIndex::new(vec![]);
        index.insert("Fed Signals Open Door to Rate Cuts in September Meeting Minutes");
        assert!(index.is_dup("fed signals open door to rate cuts in september meeting minutes"));
        assert!(!index.is_dup("Earnings Season Begins With a Whimper"));
        index.insert("Earnings Season Begins With a Whimper Amid Rate Anxiety This Quarter");
        assert!(index.is_dup("Earnings Season Begins With a Whimper Amid Rate Anxiety This Quarter"));
    }

    #[test]
    fn truncated_tails_force_page_fetch() {
        let body = "word ".repeat(500) + "Continue reading…";
        assert!(looks_truncated(&body));
        // Long readable body ending with a read-more marker is NOT trusted.
        assert!(choose_article_body(&body, None).is_none());
        // A clean page extract is still accepted.
        let full = "word ".repeat(500);
        assert!(choose_article_body(&body, Some(&full)).is_some());
        // Clean fulltext is unaffected.
        let clean = "word ".repeat(500);
        assert!(!looks_truncated(&clean));
        assert!(choose_article_body(&clean, None).is_some());
        assert!(!looks_truncated("short"));
    }

    #[test]
    fn english_lang_tags() {
        assert!(is_english_lang_tag("en"));
        assert!(is_english_lang_tag("en-US"));
        assert!(is_english_lang_tag("EN_GB"));
        assert!(!is_english_lang_tag("zh-CN"));
        assert!(!is_english_lang_tag("ja"));
        assert!(!is_english_lang_tag("pt-BR"));
    }

    #[test]
    fn rejects_chinese_content() {
        let title = "如何学习 Rust 编程语言入门指南";
        let content = "今天我们来讨论如何高效学习一门新的编程语言。首先需要理解基本概念，然后通过大量练习巩固知识。".repeat(5);
        assert!(!is_english_article(None, title, &content));
        assert!(!is_english_article(Some("zh-CN"), "Anything", &content));
    }

    #[test]
    fn accepts_english_content() {
        let title = "How to learn Rust effectively";
        let content = "Today we discuss how to learn a new programming language effectively. First understand the fundamentals, then practice with real projects until the ideas stick.".repeat(3);
        assert!(is_english_article(None, title, &content));
        assert!(is_english_article(Some("en-US"), title, &content));
        assert!(!is_english_article(Some("fr"), title, &content));
    }

    #[test]
    fn partition_skips_known() {
        let known = HashSet::from(["https://a".into()]);
        let (new_urls, skipped) =
            partition_new_urls(&["https://a".into(), "https://b".into()], &known);
        assert_eq!(skipped, 1);
        assert_eq!(new_urls, vec!["https://b".to_string()]);
    }

    #[test]
    fn source_strips_www() {
        assert_eq!(
            source_from_url("https://www.theguardian.com/world/example"),
            "theguardian.com"
        );
        assert_eq!(source_from_url("not-a-url"), "导入");
    }

    #[test]
    fn title_parses_html_title() {
        let html = "<html><head><title>  Hello World  | Site </title></head></html>";
        assert_eq!(title_from_html(html).as_deref(), Some("Hello World"));
    }

    #[test]
    fn skips_rss_summary_when_page_fetch_fails() {
        // Mid-length teaser (≥ old 400 threshold) must not be kept if page is unavailable
        // (anti-crawl / paywall / short extract).
        let teaser = "a".repeat(500);
        assert!(teaser.chars().count() >= MIN_FULLTEXT_CHARS);
        assert!(teaser.chars().count() < TRUST_RSS_FULLTEXT_CHARS);
        assert!(choose_article_body(&teaser, None).is_none());
        assert!(choose_article_body(&teaser, Some("too short")).is_none());
    }

    #[test]
    fn accepts_page_fulltext_over_rss_teaser() {
        let teaser = "teaser ".repeat(80); // ~560 chars
        let full = "full article body ".repeat(40); // ~720 chars
        assert!(full.chars().count() >= MIN_FULLTEXT_CHARS);
        let chosen = choose_article_body(&teaser, Some(&full)).expect("page body");
        assert_eq!(chosen, full);
    }

    #[test]
    fn trusts_long_rss_fulltext_without_page() {
        let full_rss = "word ".repeat(500); // 2500 chars
        assert!(full_rss.chars().count() >= TRUST_RSS_FULLTEXT_CHARS);
        let chosen = choose_article_body(&full_rss, None).expect("rss full text");
        assert_eq!(chosen, full_rss);
    }

    #[test]
    fn summary_only_body_matches_choose_without_page() {
        let teaser = "a".repeat(500);
        assert!(is_summary_only_body(&teaser));
        assert!(!is_summary_only_body(&"word ".repeat(500)));
        assert!(is_summary_only_body("short"));
    }

    fn chrome_nav_soup() -> String {
        let mut s = String::from("Skip to main content\n\n");
        for i in 1..40 {
            s.push_str(&format!("* [ Home topic {i} ][{i}]\n"));
        }
        s.push_str("\nA one-line dek about the story.\n");
        for i in 1..40 {
            s.push_str(&format!("[{i}]: https://example.com/{i}\n"));
        }
        s
    }

    fn link_dump_body() -> String {
        let mut s = String::from("#### Markets\n\n");
        for i in 1..20 {
            s.push_str(&format!("* [A market headline number {i} for readers][{i}]\n"));
        }
        s
    }

    fn short_real_post() -> String {
        "Culture provides scaffolding, and learning happens over time. \
The result is that we are each capable of extraordinary feats. \
People can fly planes, ski down mountains, or solve a crossword. \
Most people only exhibit this skill when there are months of exposure.\n\n\
That is the whole post."
            .repeat(2)
    }

    #[test]
    fn rejects_page_chrome_and_keyword_teasers() {
        let chrome = chrome_nav_soup();
        assert!(chrome.chars().count() > TRUST_RSS_FULLTEXT_CHARS);
        assert!(!is_readable_article_body(&chrome));
        assert!(choose_article_body(&chrome, None).is_none());

        let teaser = format!(
            "In Chad, the Chari River has been badly affected by years of intensive sand \
extraction along its banks, particularly around the capital. The ministry banned \
the practice to protect wildlife.                            Keywords for this article"
        );
        assert!(!is_readable_article_body(&teaser));
    }

    #[test]
    fn rejects_link_dump_even_when_long() {
        let dump = link_dump_body();
        assert!(dump.chars().count() > 400);
        assert!(!is_readable_article_body(&dump));
        assert!(choose_article_body(&dump, Some(&dump)).is_none());
    }

    #[test]
    fn keeps_short_real_prose() {
        let post = short_real_post();
        assert!(post.chars().count() >= MIN_FULLTEXT_CHARS);
        assert!(post.chars().count() < TRUST_RSS_FULLTEXT_CHARS);
        assert!(is_readable_article_body(&post));
        assert_eq!(
            choose_article_body("teaser", Some(&post)).as_deref(),
            Some(post.as_str())
        );
    }
}
