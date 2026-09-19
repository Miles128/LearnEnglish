//! Importing a single article by URL (the "add by link" path).

use super::dedup::canonical_article_url;
use super::enrich::fill_article_card_zh;
use super::extract::extract_article_page;
use super::filters::{is_english_article, looks_like_paywall, looks_truncated};
use super::net::HTTP;
use crate::db::{self, Article, DbState};
use crate::error::AppError;
use chrono::Utc;
use uuid::Uuid;

pub fn source_from_url(url: &str) -> String {
    url::Url::parse(url)
        .ok()
        .and_then(|u| u.host_str().map(|h| h.trim_start_matches("www.").to_string()))
        .filter(|h| !h.is_empty())
        .unwrap_or_else(|| "导入".into())
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
        tags: vec![],
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
