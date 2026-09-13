use crate::config::AppConfig;
use crate::db::{self, Article, DbState, FeedSource};
use crate::vocab;
use chrono::Utc;
use feed_rs::parser;
use regex::Regex;
use reqwest::blocking::Client;
use rusqlite::Connection;
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;
use ts_rs::TS;
use uuid::Uuid;

pub(crate) const MIN_FULLTEXT_CHARS: usize = 400;
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

#[derive(Debug, Serialize, TS)]
#[ts(export)]
pub struct RefreshResult {
    pub fetched_feeds: usize,
    pub added_or_updated: usize,
    pub updated: usize,
    pub skipped_existing: usize,
    pub skipped_short: usize,
    pub skipped_non_english: usize,
    pub titles_translated: usize,
    pub errors: Vec<String>,
}

struct DownloadStats {
    skipped_existing: usize,
    skipped_short: usize,
    skipped_non_english: usize,
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

pub fn refresh_feeds(
    db: &DbState,
    cfg: &AppConfig,
    mut on_progress: impl FnMut(RefreshProgress),
) -> Result<RefreshResult, String> {
    let feeds = {
        let conn = db.lock_read()?;
        db::list_feeds(&conn)?
    };

    let enabled: Vec<FeedSource> = select_enabled_feeds(feeds);

    let download_total = enabled.len();
    // Reserve ~80% of the bar for downloads, ~20% for title translation.
    let translate_weight = 20u8;
    let download_weight = 80u8;

    let mut result = RefreshResult {
        fetched_feeds: 0,
        added_or_updated: 0,
        updated: 0,
        skipped_existing: 0,
        skipped_short: 0,
        skipped_non_english: 0,
        titles_translated: 0,
        errors: vec![],
    };

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

    let (non_english_ids, teaser_ids) = {
        let conn = db.lock_read()?;
        (
            collect_non_english_rss_ids(&conn)?,
            collect_summary_only_rss_ids(&conn)?,
        )
    };
    let mut known_urls = {
        let conn = db.lock_write()?;
        result.skipped_non_english += delete_articles(&conn, &non_english_ids)?;
        result.skipped_short += delete_articles(&conn, &teaser_ids)?;
        db::list_article_urls(&conn)?
    };
    let known_lengths = {
        let conn = db.lock_read()?;
        db::list_article_content_lengths(&conn)?
    };

    for (idx, feed) in enabled.iter().enumerate() {
        let current = idx + 1;
        let percent = ((current.saturating_sub(1) as u16 * download_weight as u16)
            / download_total.max(1) as u16) as u8;
        on_progress(RefreshProgress {
            phase: "download".into(),
            current,
            total: download_total,
            label: format!("增量下载 {current}/{download_total}：{}", feed.name),
            percent,
        });

        result.fetched_feeds += 1;
        match download_feed_articles(&HTTP, feed, &known_urls, &known_lengths) {
            Ok((articles, updates, stats)) => {
                result.skipped_existing += stats.skipped_existing;
                result.skipped_short += stats.skipped_short;
                result.skipped_non_english += stats.skipped_non_english;
                let conn = db.lock_write()?;
                for article in &articles {
                    if db::insert_article_if_new(&conn, article)? {
                        known_urls.insert(article.url.clone());
                        result.added_or_updated += 1;
                    } else {
                        result.skipped_existing += 1;
                    }
                }
                for update in &updates {
                    if db::refresh_article_content(&conn, update)? {
                        result.updated += 1;
                    }
                }
            }
            Err(e) => result.errors.push(format!("{}: {}", feed.name, e)),
        }

        let percent_done = ((current as u16 * download_weight as u16)
            / download_total.max(1) as u16) as u8;
        on_progress(RefreshProgress {
            phase: "download".into(),
            current,
            total: download_total,
            label: format!("已完成 {current}/{download_total}：{}", feed.name),
            percent: percent_done,
        });
    }

    on_progress(RefreshProgress {
        phase: "translate".into(),
        current: 0,
        total: 0,
        label: "正在翻译标题与简介…".into(),
        percent: download_weight,
    });

    match fill_missing_card_zh(db, cfg, 80, |done, total| {
        let translate_pct = if total == 0 {
            translate_weight
        } else {
            ((done as u16 * translate_weight as u16) / total.max(1) as u16) as u8
        };
        on_progress(RefreshProgress {
            phase: "translate".into(),
            current: done,
            total,
            label: if total == 0 {
                "标题与简介完成".into()
            } else {
                format!("正在翻译标题与简介 {done}/{total}")
            },
            percent: download_weight.saturating_add(translate_pct).min(99),
        });
    }) {
        Ok(n) => result.titles_translated = n,
        Err(e) => result.errors.push(format!("标题/简介: {e}")),
    }

    on_progress(RefreshProgress {
        phase: "done".into(),
        current: download_total,
        total: download_total,
        label: "刷新完成".into(),
        percent: 100,
    });

    Ok(result)
}

pub fn fill_missing_card_zh(
    db: &DbState,
    cfg: &AppConfig,
    limit: usize,
    mut on_progress: impl FnMut(usize, usize),
) -> Result<usize, String> {
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

    for chunk in missing.chunks(8) {
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
                if wrote {
                    done += 1;
                }
            }
        }
        on_progress(done, total);
    }
    if done == 0 {
        if let Some(e) = last_err {
            return Err(e);
        }
    }
    Ok(done)
}

/// Download + parse one feed without holding the DB lock.
/// Skips entries whose URL is already in `known_urls` (incremental / idempotent).
fn download_feed_articles(
    client: &Client,
    feed: &FeedSource,
    known_urls: &HashSet<String>,
    known_lengths: &HashMap<String, usize>,
) -> Result<(Vec<Article>, Vec<Article>, DownloadStats), String> {
    let bytes = client
        .get(&feed.url)
        .send()
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?
        .bytes()
        .map_err(|e| e.to_string())?;

    let parsed = parser::parse(&bytes[..]).map_err(|e| e.to_string())?;
    let feed_language = parsed.language.clone();
    let mut articles = Vec::new();
    let mut updates = Vec::new();
    let mut stats = DownloadStats {
        skipped_existing: 0,
        skipped_short: 0,
        skipped_non_english: 0,
    };
    let now = Utc::now().to_rfc3339();

    let mut page_fetches = 0usize;
    const MAX_PAGE_FETCHES: usize = 12;

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

        let title = entry
            .title
            .map(|t| t.content)
            .unwrap_or_else(|| "Untitled".into());

        let raw_html = entry
            .content
            .and_then(|c| c.body)
            .or_else(|| entry.summary.map(|s| s.content))
            .unwrap_or_default();

        let rss_text = html_to_text(&raw_html);

        // Already downloaded — only upgrade when the RSS body itself is now
        // trusted full-text AND meaningfully longer than what we stored.
        // Never page-fetch known URLs again (budget preserved for new ones).
        if known_urls.contains(&url) {
            let stored_len = known_lengths.get(&url).copied().unwrap_or(0);
            if rss_text.chars().count() >= TRUST_RSS_FULLTEXT_CHARS
                && is_readable_article_body(&rss_text)
                && rss_text.chars().count() > stored_len
            {
                updates.push(Article {
                    id: String::new(), // not used by refresh_article_content
                    url: url.clone(),
                    title,
                    title_zh: String::new(),
                    source: feed.name.clone(),
                    category: feed.category.clone(),
                    published_at: entry
                        .published
                        .or(entry.updated)
                        .map(|d| d.to_rfc3339()),
                    content_text: rss_text,
                    fetched_at: now.clone(),
                    origin: "rss".into(),
                    summary_zh: String::new(),
                    last_opened_at: None,
                    open_count: 0,
                });
            } else {
                stats.skipped_existing += 1;
            }
            continue;
        }

        // Full-text RSS can be trusted; teaser / chrome / tag-wall bodies must
        // fetch the article page. If the page is also junk, skip.
        let content_text = if rss_text.chars().count() >= TRUST_RSS_FULLTEXT_CHARS
            && is_readable_article_body(&rss_text)
        {
            rss_text
        } else {
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

        let language = entry.language.as_deref().or(feed_language.as_deref());
        if !is_english_article(language, &title, &content_text) {
            stats.skipped_non_english += 1;
            continue;
        }

        let published_at = entry
            .published
            .or(entry.updated)
            .map(|d| d.to_rfc3339());

        articles.push(Article {
            id: Uuid::new_v4().to_string(),
            url,
            title,
            title_zh: String::new(),
            source: feed.name.clone(),
            category: feed.category.clone(),
            published_at,
            content_text,
            fetched_at: now.clone(),
            origin: "rss".into(),
            summary_zh: String::new(),
            last_opened_at: None,
            open_count: 0,
        });
    }
    Ok((articles, updates, stats))
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

pub(crate) fn collect_non_english_rss_ids(conn: &Connection) -> Result<Vec<String>, String> {
    let existing = db::list_rss_language_samples(conn, 1200)?;
    Ok(existing
        .into_iter()
        .filter(|(_, title, sample)| !is_english_article(None, title, sample))
        .map(|(id, _, _)| id)
        .collect())
}

pub(crate) fn delete_articles(conn: &Connection, ids: &[String]) -> Result<usize, String> {
    let mut removed = 0usize;
    for id in ids {
        db::delete_article(conn, id)?;
        removed += 1;
    }
    Ok(removed)
}

#[cfg(test)]
pub(crate) fn purge_non_english_articles(conn: &Connection) -> Result<usize, String> {
    let ids = collect_non_english_rss_ids(conn)?;
    delete_articles(conn, &ids)
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

pub(crate) fn collect_summary_only_rss_ids(conn: &Connection) -> Result<Vec<String>, String> {
    // Chrome/tag-wall dumps are often longer than a teaser, so scan every RSS body.
    let candidates = db::list_rss_teaser_candidates(conn, i64::MAX)?;
    Ok(candidates
        .into_iter()
        .filter(|article| !is_readable_article_body(&article.content_text))
        .map(|article| article.id)
        .collect())
}

#[cfg(test)]
pub(crate) fn purge_summary_only_articles(conn: &Connection) -> Result<usize, String> {
    let ids = collect_summary_only_rss_ids(conn)?;
    delete_articles(conn, &ids)
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
fn extract_article_page(client: &Client, url: &str) -> Result<ExtractedPage, String> {
    let parsed = url::Url::parse(url).map_err(|e| e.to_string())?;
    let html = client
        .get(url)
        .header(
            "Accept",
            "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
        )
        .send()
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?
        .text()
        .map_err(|e| e.to_string())?;

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
fn fetch_article_page(client: &Client, url: &str) -> Result<String, String> {
    Ok(extract_article_page(client, url)?.text)
}

/// Import one public article URL into the local library.
pub fn import_article_from_url(db: &DbState, url: &str) -> Result<Article, String> {
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

    let extracted = extract_article_page(&HTTP, url)?;
    if looks_like_paywall(&extracted.text) {
        return Err("疑似付费墙，已跳过".into());
    }
    if !is_english_article(None, &extracted.title, &extracted.text) {
        return Err("看起来不是英文文章".into());
    }

    let article = Article {
        id: Uuid::new_v4().to_string(),
        url: url.to_string(),
        title: extracted.title,
        title_zh: String::new(),
        source: source_from_url(url),
        category: "other".into(),
        published_at: None,
        content_text: extracted.text,
        fetched_at: Utc::now().to_rfc3339(),
        origin: "url".into(),
        summary_zh: String::new(),
        last_opened_at: None,
        open_count: 0,
    };

    {
        let conn = db.lock_write()?;
        if !db::insert_article_if_new(&conn, &article)? {
            return db::get_article_by_url(&conn, url)?
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
) -> Result<(), String> {
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
    if rss_text.chars().count() >= TRUST_RSS_FULLTEXT_CHARS && is_readable_article_body(rss_text)
    {
        return Some(rss_text.to_string());
    }
    match page_text {
        Some(page) if is_readable_article_body(page) => Some(page.to_string()),
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
