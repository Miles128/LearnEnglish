use crate::config::AppConfig;
use crate::db::{self, Article, FeedSource};
use crate::vocab;
use chrono::Utc;
use feed_rs::parser;
use regex::Regex;
use reqwest::blocking::Client;
use rusqlite::Connection;
use serde::Serialize;
use std::collections::HashSet;
use std::sync::Mutex;
use uuid::Uuid;

const MIN_FULLTEXT_CHARS: usize = 400;

#[derive(Debug, Serialize)]
pub struct RefreshResult {
    pub fetched_feeds: usize,
    pub added_or_updated: usize,
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

#[derive(Debug, Clone, Serialize)]
pub struct RefreshProgress {
    /// download | translate | done
    pub phase: String,
    pub current: usize,
    pub total: usize,
    pub label: String,
    /// 0–100 overall progress across download + translate
    pub percent: u8,
}

/// Split candidate URLs into new vs already-known. Returns (new_urls, skipped_count).
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

pub fn refresh_feeds(
    db: &Mutex<Connection>,
    cfg: &AppConfig,
    mut on_progress: impl FnMut(RefreshProgress),
) -> Result<RefreshResult, String> {
    let client = Client::builder()
        .user_agent("LearnEnglish/0.1 (+local; educational)")
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;

    let feeds = {
        let conn = db.lock().map_err(|e| e.to_string())?;
        db::list_feeds(&conn)?
    };

    let enabled: Vec<FeedSource> = feeds
        .into_iter()
        .filter(|f| f.enabled && !cfg.disabled_feeds.contains(&f.id))
        .collect();

    let download_total = enabled.len();
    // Reserve ~80% of the bar for downloads, ~20% for title translation.
    let translate_weight = 20u8;
    let download_weight = 80u8;

    let mut result = RefreshResult {
        fetched_feeds: 0,
        added_or_updated: 0,
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

    let mut known_urls = {
        let conn = db.lock().map_err(|e| e.to_string())?;
        result.skipped_non_english += purge_non_english_articles(&conn)?;
        db::list_article_urls(&conn)?
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
        match download_feed_articles(&client, feed, &known_urls) {
            Ok((articles, stats)) => {
                result.skipped_existing += stats.skipped_existing;
                result.skipped_short += stats.skipped_short;
                result.skipped_non_english += stats.skipped_non_english;
                let conn = db.lock().map_err(|e| e.to_string())?;
                for article in &articles {
                    if db::insert_article_if_new(&conn, article)? {
                        known_urls.insert(article.url.clone());
                        result.added_or_updated += 1;
                    } else {
                        result.skipped_existing += 1;
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
        label: "正在翻译标题…".into(),
        percent: download_weight,
    });

    match fill_missing_title_translations_with_progress(db, cfg, 40, |done, total| {
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
                "标题翻译完成".into()
            } else {
                format!("正在翻译标题 {done}/{total}")
            },
            percent: download_weight.saturating_add(translate_pct).min(99),
        });
    }) {
        Ok(n) => result.titles_translated = n,
        Err(e) => result.errors.push(format!("标题翻译: {e}")),
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

pub fn fill_missing_title_translations(
    db: &Mutex<Connection>,
    cfg: &AppConfig,
    limit: usize,
) -> Result<usize, String> {
    fill_missing_title_translations_with_progress(db, cfg, limit, |_, _| {})
}

fn fill_missing_title_translations_with_progress(
    db: &Mutex<Connection>,
    cfg: &AppConfig,
    limit: usize,
    mut on_progress: impl FnMut(usize, usize),
) -> Result<usize, String> {
    let missing = {
        let conn = db.lock().map_err(|e| e.to_string())?;
        db::articles_missing_title_zh(&conn, limit)?
    };
    if missing.is_empty() {
        on_progress(0, 0);
        return Ok(0);
    }

    let total = missing.len();
    let mut done = 0usize;
    on_progress(done, total);

    for chunk in missing.chunks(8) {
        let titles: Vec<String> = chunk.iter().map(|a| a.title.clone()).collect();
        let translated = vocab::translate_titles(cfg, &titles)?;
        {
            let conn = db.lock().map_err(|e| e.to_string())?;
            for (article, zh) in chunk.iter().zip(translated.into_iter()) {
                let zh = zh.trim().to_string();
                if zh.is_empty() {
                    continue;
                }
                db::set_article_title_zh(&conn, &article.id, &zh)?;
                done += 1;
            }
        }
        on_progress(done, total);
    }
    Ok(done)
}

/// Download + parse one feed without holding the DB lock.
/// Skips entries whose URL is already in `known_urls` (incremental / idempotent).
fn download_feed_articles(
    client: &Client,
    feed: &FeedSource,
    known_urls: &HashSet<String>,
) -> Result<(Vec<Article>, DownloadStats), String> {
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
    let mut stats = DownloadStats {
        skipped_existing: 0,
        skipped_short: 0,
        skipped_non_english: 0,
    };
    let now = Utc::now().to_rfc3339();

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

        // Already downloaded — skip HTML parse / re-insert.
        if known_urls.contains(&url) {
            stats.skipped_existing += 1;
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

        let content_text = html_to_text(&raw_html);
        if content_text.chars().count() < MIN_FULLTEXT_CHARS {
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
        });
    }
    Ok((articles, stats))
}

/// Keep English-only articles for learning. Prefer feed/entry language tags;
/// fall back to a Latin-vs-other-script heuristic when tags are missing.
fn is_english_article(language: Option<&str>, title: &str, content: &str) -> bool {
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

fn purge_non_english_articles(conn: &Connection) -> Result<usize, String> {
    let existing = db::list_articles(conn, None)?;
    let mut removed = 0usize;
    for article in existing {
        if !is_english_article(None, &article.title, &article.content_text) {
            db::delete_article(conn, &article.id)?;
            removed += 1;
        }
    }
    Ok(removed)
}

fn html_to_text(html: &str) -> String {
    let stripped = html2text::from_read(html.as_bytes(), 100).unwrap_or_else(|_| {
        let re = Regex::new(r"<[^>]+>").unwrap();
        re.replace_all(html, " ").to_string()
    });
    let re_ws = Regex::new(r"[ \t]+\n").unwrap();
    let re_blank = Regex::new(r"\n{3,}").unwrap();
    let s = re_ws.replace_all(&stripped, "\n");
    let s = re_blank.replace_all(&s, "\n\n");
    s.trim().to_string()
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
}
