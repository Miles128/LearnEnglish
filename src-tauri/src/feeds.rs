use crate::config::AppConfig;
use crate::db::{self, Article, FeedSource};
use crate::vocab;
use chrono::Utc;
use feed_rs::parser;
use regex::Regex;
use reqwest::blocking::Client;
use rusqlite::Connection;
use serde::Serialize;
use uuid::Uuid;

const MIN_FULLTEXT_CHARS: usize = 400;

#[derive(Debug, Serialize)]
pub struct RefreshResult {
    pub fetched_feeds: usize,
    pub added_or_updated: usize,
    pub skipped_short: usize,
    pub titles_translated: usize,
    pub errors: Vec<String>,
}

pub fn refresh_feeds(conn: &Connection, cfg: &AppConfig) -> Result<RefreshResult, String> {
    let client = Client::builder()
        .user_agent("LearnEnglish/0.1 (+local; educational)")
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;

    let feeds = db::list_feeds(conn)?;
    let mut result = RefreshResult {
        fetched_feeds: 0,
        added_or_updated: 0,
        skipped_short: 0,
        titles_translated: 0,
        errors: vec![],
    };

    for feed in feeds {
        if !feed.enabled || cfg.disabled_feeds.contains(&feed.id) {
            continue;
        }
        result.fetched_feeds += 1;
        match fetch_one(&client, conn, &feed) {
            Ok((ok, skip)) => {
                result.added_or_updated += ok;
                result.skipped_short += skip;
            }
            Err(e) => result.errors.push(format!("{}: {}", feed.name, e)),
        }
    }

    match fill_missing_title_translations(conn, cfg, 40) {
        Ok(n) => result.titles_translated = n,
        Err(e) => result.errors.push(format!("标题翻译: {e}")),
    }

    Ok(result)
}

pub fn fill_missing_title_translations(
    conn: &Connection,
    cfg: &AppConfig,
    limit: usize,
) -> Result<usize, String> {
    let missing = db::articles_missing_title_zh(conn, limit)?;
    if missing.is_empty() {
        return Ok(0);
    }

    let mut done = 0usize;
    for chunk in missing.chunks(8) {
        let titles: Vec<String> = chunk.iter().map(|a| a.title.clone()).collect();
        let translated = vocab::translate_titles(cfg, &titles)?;
        for (article, zh) in chunk.iter().zip(translated.into_iter()) {
            let zh = zh.trim().to_string();
            if zh.is_empty() {
                continue;
            }
            db::set_article_title_zh(conn, &article.id, &zh)?;
            done += 1;
        }
    }
    Ok(done)
}

fn fetch_one(
    client: &Client,
    conn: &Connection,
    feed: &FeedSource,
) -> Result<(usize, usize), String> {
    let bytes = client
        .get(&feed.url)
        .send()
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?
        .bytes()
        .map_err(|e| e.to_string())?;

    let parsed = parser::parse(&bytes[..]).map_err(|e| e.to_string())?;
    let mut ok = 0usize;
    let mut skip = 0usize;
    let now = Utc::now().to_rfc3339();

    for entry in parsed.entries.into_iter().take(25) {
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

        let content_text = html_to_text(&raw_html);
        if content_text.chars().count() < MIN_FULLTEXT_CHARS {
            skip += 1;
            continue;
        }

        let published_at = entry
            .published
            .or(entry.updated)
            .map(|d| d.to_rfc3339());

        let article = Article {
            id: Uuid::new_v4().to_string(),
            url,
            title,
            title_zh: String::new(),
            source: feed.name.clone(),
            category: feed.category.clone(),
            published_at,
            content_text,
            fetched_at: now.clone(),
        };
        db::upsert_article(conn, &article)?;
        ok += 1;
    }
    Ok((ok, skip))
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
