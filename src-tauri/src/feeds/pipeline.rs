//! The RSS refresh pipeline: parallel feed download, entry filtering,
//! DB insertion, and progress reporting.

use super::cleanup::{
    assess_unassessed_articles, audit_rss_bodies_once, purge_expired_articles,
    purge_rss_below_word_threshold,
};
use super::dedup::{canonical_article_url, TitleIndex};
use super::enrich::{fill_missing_card_zh, fill_missing_tags};
use super::extract::{fetch_article_page, html_to_text};
use super::filters::{
    choose_article_body, is_blocked_content, is_english_article, is_readable_article_body,
    looks_like_paywall, looks_truncated, rss_trust_chars,
};
use super::net::{ensure_public_http_url, HTTP};
use super::{MIN_ARTICLE_WORDS};
use crate::config::AppConfig;
use crate::db::{self, Article, DbState, FeedSource};
use crate::error::AppError;
use chrono::Utc;
use feed_rs::parser;
use reqwest::blocking::Client;
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use ts_rs::TS;
use uuid::Uuid;

/// How many feeds download concurrently. Bounded to keep polite to servers
/// and to preserve per-feed progress ordering in the UI.
const PARALLEL_FEEDS: usize = 4;

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

pub(crate) struct DownloadStats {
    skipped_existing: usize,
    skipped_short: usize,
    skipped_non_english: usize,
    skipped_duplicate: usize,
    /// Link roundups / podcast transcripts — never ingested.
    skipped_blocked: usize,
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
            skipped_blocked: 0,
            skipped_old: 0,
            rss_fulltext_hits: 0,
            evaluated: 0,
        }
    }
}

pub(crate) struct FeedDownload {
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

pub(crate) fn select_enabled_feeds(feeds: Vec<FeedSource>) -> Vec<FeedSource> {
    feeds.into_iter().filter(|f| f.enabled).collect()
}

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

    // Tags drive filtering + the interest profile; backfill a bounded batch
    // per refresh so the whole library catches up over a few runs.
    match fill_missing_tags(db, cfg, 200, |done, total| {
        if total > 0 {
            report(
                "translate",
                done,
                total,
                format!("正在生成主题标签 {done}/{total}"),
                download_weight,
            );
        }
    }) {
        Ok(_) => {}
        Err(e) => result.errors.push(format!("主题标签: {e}")),
    }

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
    ensure_public_http_url(&feed.url)?;
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

        // Link roundups and podcast transcripts are not reading material.
        if is_blocked_content(&title, &content_text) {
            stats.skipped_blocked += 1;
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
        tags: vec![],
    }
}
