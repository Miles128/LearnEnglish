//! Fetching a public article page and extracting title + main text.

use super::filters::{is_readable_article_body, looks_like_paywall};
use super::net::ensure_public_http_url;
use crate::error::AppError;
use reqwest::blocking::Client;
use std::sync::LazyLock;

static RE_TAG_STRIP: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"<[^>]+>").unwrap());
static RE_TRAILING_WS: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"[ \t]+\n").unwrap());
static RE_BLANK_RUN: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"\n{3,}").unwrap());
static RE_HTML_TITLE: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"(?is)<title[^>]*>(.*?)</title>").unwrap());

pub(crate) fn html_to_text(html: &str) -> String {
    let stripped = html2text::from_read(html.as_bytes(), 100)
        .unwrap_or_else(|_| RE_TAG_STRIP.replace_all(html, " ").to_string());
    let s = RE_TRAILING_WS.replace_all(&stripped, "\n");
    let s = RE_BLANK_RUN.replace_all(&s, "\n\n");
    s.trim().to_string()
}

pub(crate) fn title_from_html(html: &str) -> Option<String> {
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

pub(crate) struct ExtractedPage {
    pub title: String,
    pub text: String,
}

/// Fetch a public article URL and extract title + main text (no paywall bypass).
pub(crate) fn extract_article_page(client: &Client, url: &str) -> Result<ExtractedPage, AppError> {
    let parsed = ensure_public_http_url(url)?;
    let html = client
        .get(url)
        .header(
            "Accept",
            "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
        )
        .send()?
        .error_for_status()?
        .text()?;

    if looks_like_paywall(&html) {
        return Err("疑似付费墙，已跳过".into());
    }

    let mut title = title_from_html(&html).unwrap_or_default();

    // Prefer readability extraction; fall back to html2text.
    let from_readability = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let mut cursor = std::io::Cursor::new(html.as_bytes());
        readability::extractor::extract(&mut cursor, &parsed).ok().map(|p| {
            // readability's `text` is a single blob that loses paragraph
            // breaks; the cleaned HTML keeps them, so prefer it.
            let from_html = html_to_text(&p.content);
            let text = if from_html.is_empty() {
                p.text.trim().to_string()
            } else {
                from_html
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
pub(crate) fn fetch_article_page(client: &Client, url: &str) -> Result<String, AppError> {
    Ok(extract_article_page(client, url)?.text)
}
