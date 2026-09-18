use crate::error::AppError;
use crate::config::AppConfig;
use crate::db::{self, DbState, VocabItem};
use chrono::Utc;
use reqwest::blocking::Client;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::sync::LazyLock;
use ts_rs::TS;
use uuid::Uuid;

/// Shared LLM HTTP client — one connection pool instead of a new client per call.
static CHAT_CLIENT: LazyLock<Client> = LazyLock::new(|| {
    Client::builder()
        .timeout(std::time::Duration::from_secs(90))
        .build()
        .expect("build reqwest client")
});

#[derive(Debug, Serialize, Deserialize)]
pub struct VocabEnrichment {
    pub definition_zh: String,
    pub word_type: String,
    pub collocations: Vec<String>,
}

#[derive(Deserialize)]
struct ChatResponse {
    choices: Vec<Choice>,
}

#[derive(Deserialize)]
struct Choice {
    message: Message,
}

#[derive(Deserialize)]
struct Message {
    content: Option<String>,
}

pub fn translate_text(cfg: &AppConfig, text: &str) -> Result<String, AppError> {
    ensure_configured(cfg)?;
    let system = "You are a precise English-to-Simplified-Chinese translator for language learners. Translate faithfully. Output ONLY the Chinese translation, no quotes or commentary.";
    let user = format!("Translate to Simplified Chinese:\n\n{text}");
    chat(cfg, system, &user)
}

fn strip_fences(raw: &str) -> &str {
    raw.trim()
        .trim_start_matches("```json")
        .trim_start_matches("```")
        .trim_end_matches("```")
        .trim()
}

const JSON_REMINDER: &str =
    "\n\nREMINDER: Reply with ONLY valid JSON in the exact shape requested. No markdown fences, no commentary.";

/// Chat → parse JSON. Uses the provider's JSON output mode so responses are
/// parseable in one shot; the stricter-instruction retry remains as a
/// fallback for providers without it.
fn chat_json<T: for<'de> Deserialize<'de>>(
    cfg: &AppConfig,
    system: &str,
    user: &str,
    label: &str,
) -> Result<T, AppError> {
    let raw = chat_json_mode(cfg, system, user)?;
    match serde_json::from_str(strip_fences(&raw)) {
        Ok(v) => Ok(v),
        Err(first_err) => {
            let raw2 =
                chat_json_mode(cfg, system, &format!("{user}{JSON_REMINDER}")).map_err(|e| {
                    AppError::msg(format!(
                        "{label}: first attempt failed to parse ({first_err}); retry request failed: {e}"
                    ))
                })?;
            serde_json::from_str(strip_fences(&raw2))
                .map_err(|e| {
                    AppError::msg(format!(
                        "parse {label}: {first_err}; retry also failed: {e}; raw={raw2}"
                    ))
                })
        }
    }
}

/// Translate article paragraphs in batch. Input order must match output order.
pub fn translate_texts(cfg: &AppConfig, texts: &[String]) -> Result<Vec<String>, AppError> {
    if texts.is_empty() {
        return Ok(vec![]);
    }
    ensure_configured(cfg)?;
    let system = r#"You translate English passages to Simplified Chinese for language learners.
Given a JSON array of English passages, return ONLY a JSON array of Chinese translations in the same order and length.
Translate faithfully. No markdown fences, no commentary."#;
    let payload = serde_json::to_string(texts)?;
    let out: Vec<String> = chat_json(cfg, system, &payload, "paragraph translations")?;
    if out.len() != texts.len() {
        return Err(AppError::msg(format!(
            "paragraph translation count mismatch: got {} expected {}",
            out.len(),
            texts.len()
        )));
    }
    Ok(out)
}

pub const CARD_SUMMARY_MAX_CHARS: usize = 60;
const CARD_EXCERPT_CHARS: usize = 200;

/// Truncate to at most `max_chars` Unicode scalars, then trim.
pub fn clip_zh(s: &str, max_chars: usize) -> String {
    s.chars().take(max_chars).collect::<String>().trim().to_string()
}

#[derive(Serialize)]
pub struct ArticleCardIn {
    pub title: String,
    pub excerpt: String,
}

#[derive(Deserialize, Default)]
pub struct ArticleCardOut {
    #[serde(default)]
    pub title_zh: String,
    #[serde(default)]
    pub summary_zh: String,
    /// 2–3 lowercase English topic tags for interest profiling.
    #[serde(default)]
    pub tags: Vec<String>,
}

pub fn card_from_article(title: &str, content_text: &str) -> ArticleCardIn {
    ArticleCardIn {
        title: title.to_string(),
        excerpt: clip_zh(content_text, CARD_EXCERPT_CHARS),
    }
}

/// Batch: Chinese title + one-sentence Chinese synopsis + topic tags,
/// in one request. Input order = output order.
pub fn translate_article_cards(
    cfg: &AppConfig,
    cards: &[ArticleCardIn],
) -> Result<Vec<ArticleCardOut>, AppError> {
    if cards.is_empty() {
        return Ok(vec![]);
    }
    ensure_configured(cfg)?;
    let system = r#"You write Simplified Chinese metadata for English articles for language learners.
Given a JSON array of objects {title, excerpt}, return ONLY a JSON array of the same length.
Each item must be {"title_zh":"<Chinese title>","summary_zh":"<Chinese synopsis>","tags":["<tag1>","<tag2>"]}.
title_zh is a natural Chinese rendering of the title (not pinyin).
summary_zh is ONE complete Simplified Chinese sentence (about 30–60 characters) that says what the article is about. No ellipsis padding, no quotes, no English.
tags is 2–3 short lowercase English topic tags (e.g. ["economy","central-bank"]). No markdown fences, no commentary."#;
    let payload = serde_json::to_string(cards)?;
    let out: Vec<ArticleCardOut> = chat_json(cfg, system, &payload, "article cards")?;
    if out.len() != cards.len() {
        return Err(AppError::msg(format!(
            "article card count mismatch: got {} expected {}",
            out.len(),
            cards.len()
        )));
    }
    Ok(out
        .into_iter()
        .map(|mut c| {
            c.title_zh = c.title_zh.trim().to_string();
            c.summary_zh = clip_zh(&c.summary_zh, CARD_SUMMARY_MAX_CHARS);
            c.tags = c
                .tags
                .iter()
                .map(|t| t.trim().to_lowercase())
                .filter(|t| !t.is_empty())
                .take(3)
                .collect();
            c
        })
        .collect())
}

pub fn enrich_vocab(cfg: &AppConfig, term: &str, context: &str) -> Result<VocabEnrichment, AppError> {
    ensure_configured(cfg)?;
    let system = r#"You help English learners. Given a word/phrase and its context sentence, return ONLY valid JSON with keys:
definition_zh (string, concise Chinese meaning),
word_type (string, e.g. noun / verb / adjective / phrase / idiom / usage),
collocations (array of 2-5 short common collocations or usage patterns in English).
No markdown fences."#;
    let user = format!("Term: {term}\nContext: {context}");
    chat_json(cfg, system, &user, "vocab JSON")
}

#[derive(serde::Deserialize)]
pub struct AddVocabInput {
    pub term: String,
    pub context_sentence: String,
    pub article_id: Option<String>,
    pub definition_zh: Option<String>,
    pub word_type: Option<String>,
    pub collocations: Option<Vec<String>>,
}

/// Enrich (optional) and insert-or-merge a vocab row. LLM failure degrades to given fields.
pub fn add_or_merge_vocab(
    db: &DbState,
    cfg: &AppConfig,
    input: AddVocabInput,
) -> Result<VocabItem, AppError> {
    let term = input.term.trim().to_string();
    if term.is_empty() {
        return Err("词条不能为空".into());
    }
    let definition_zh = input.definition_zh.clone().unwrap_or_default();
    let word_type = input.word_type.clone().unwrap_or_default();
    let collocations = input.collocations.clone().unwrap_or_default();
    let explicit = input.definition_zh.is_some()
        && input.word_type.is_some()
        && input.collocations.is_some();
    let mut enrichment = if explicit {
        VocabEnrichment {
            definition_zh: definition_zh.clone(),
            word_type: if word_type.is_empty() {
                "phrase".into()
            } else {
                word_type.clone()
            },
            collocations,
        }
    } else {
        match enrich_vocab(cfg, &term, &input.context_sentence) {
            Ok(e) => e,
            Err(_) => VocabEnrichment {
                definition_zh: definition_zh.clone(),
                word_type: if word_type.is_empty() {
                    "phrase".into()
                } else {
                    word_type.clone()
                },
                collocations: collocations.clone(),
            },
        }
    };
    if enrichment.definition_zh.is_empty() {
        enrichment.definition_zh = definition_zh.clone();
    }
    if enrichment.word_type.is_empty() {
        enrichment.word_type = "phrase".into();
    }

    let now = Utc::now().to_rfc3339();
    let conn = db.lock_write()?;

    if let Some(mut existing) = db::get_vocab_by_term(&conn, &term)? {
        if existing.definition_zh.is_empty() {
            existing.definition_zh = enrichment.definition_zh.clone();
        }
        if existing.word_type.is_empty() {
            existing.word_type = enrichment.word_type.clone();
        }
        for c in &enrichment.collocations {
            let c = c.trim();
            if !c.is_empty() && !existing.collocations.contains(&c.to_string()) {
                existing.collocations.push(c.to_string());
            }
        }
        if existing.context_sentence.is_empty() {
            existing.context_sentence = input.context_sentence.clone();
        }
        if existing.article_id.is_none() {
            existing.article_id = input.article_id.clone();
        }
        db::update_vocab_meta(&conn, &existing)?;
        return Ok(existing);
    }

    let item = VocabItem {
        id: Uuid::new_v4().to_string(),
        term,
        definition_zh: enrichment.definition_zh,
        word_type: enrichment.word_type,
        collocations: enrichment.collocations,
        context_sentence: input.context_sentence,
        article_id: input.article_id,
        status: "learning".into(),
        interval_days: 0.0,
        reps: 0,
        consecutive_know: 0,
        next_review_at: now.clone(),
        created_at: now,
    };
    db::insert_vocab(&conn, &item)?;
    Ok(item)
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct FeedDiscoverCandidate {
    pub name: String,
    pub url: String,
    #[serde(default)]
    pub description: String,
}

/// Ask the configured LLM for free full-text English RSS feeds in a category.
pub fn discover_rss_feeds(
    cfg: &AppConfig,
    category_id: &str,
    category_label: &str,
) -> Result<Vec<FeedDiscoverCandidate>, AppError> {
    ensure_configured(cfg)?;
    let system = r#"You help curate free, publicly available English news RSS/Atom feeds for language learners.
Return ONLY a JSON array (no markdown fences) of 6–10 objects with keys:
name (string, publication name),
url (string, direct RSS or Atom feed URL, https preferred),
description (string, one short English sentence).
Prefer classic reputable outlets and blogs with free full-text or long excerpts.
Do NOT suggest podcasts, paywalled-only feeds, or non-English sources.
URLs must look like real feed endpoints (often ending in /feed, /rss, .xml)."#;
    let user = format!(
        "Category id: {category_id}\nCategory label: {category_label}\nRecommend English RSS feeds for this category."
    );
    let mut out: Vec<FeedDiscoverCandidate> =
        chat_json(cfg, system, &user, "discover JSON")?;
    out.retain(|c| {
        let u = c.url.trim();
        (u.starts_with("https://") || u.starts_with("http://")) && !c.name.trim().is_empty()
    });
    if out.is_empty() {
        return Err("模型未返回可用的 RSS 候选".into());
    }
    Ok(out)
}

fn ensure_configured(cfg: &AppConfig) -> Result<(), AppError> {
    if cfg.api_key.trim().is_empty() || cfg.api_key.contains("YOUR_API_KEY") {
        return Err("请先在设置中配置 API Key（config.local.json）".into());
    }
    if cfg.base_url.trim().is_empty() || cfg.model.trim().is_empty() {
        return Err("请配置 base_url 与 model".into());
    }
    Ok(())
}

/// OpenAI-compatible chat URL. Official DeepSeek / OpenAI roots need `/v1`.
pub fn chat_completions_url(base_url: &str) -> String {
    let base = base_url.trim().trim_end_matches('/');
    if base.ends_with("/chat/completions") {
        return base.to_string();
    }
    let known_root = base.ends_with("api.deepseek.com") || base.ends_with("api.openai.com");
    if known_root && !base.ends_with("/v1") {
        return format!("{base}/v1/chat/completions");
    }
    format!("{base}/chat/completions")
}

fn chat(cfg: &AppConfig, system: &str, user: &str) -> Result<String, AppError> {
    chat_body(cfg, system, user, false)
}

/// Chat with the provider's JSON output mode — one-shot parseable responses,
/// no parse-failure retry round-trips (the retry stays as a fallback).
fn chat_json_mode(cfg: &AppConfig, system: &str, user: &str) -> Result<String, AppError> {
    chat_body(cfg, system, user, true)
}

fn chat_body(cfg: &AppConfig, system: &str, user: &str, json_mode: bool) -> Result<String, AppError> {
    let url = chat_completions_url(&cfg.base_url);
    let mut body = json!({
        "model": cfg.model,
        "temperature": 0.2,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user}
        ]
    });
    if json_mode {
        body["response_format"] = json!({"type": "json_object"});
    }

    let send = || -> Result<String, AppError> {
        let resp = CHAT_CLIENT
            .post(&url)
            .bearer_auth(&cfg.api_key)
            .json(&body)
            .send()?
            .error_for_status()
            .map_err(|e| AppError::msg(format!("LLM {e}")))?;
        let parsed: ChatResponse = resp.json()?;
        parsed
            .choices
            .first()
            .and_then(|c| c.message.content.clone())
            .ok_or_else(|| AppError::msg("LLM returned empty content"))
    };
    with_retry(send, CHAT_ATTEMPTS)
}

/// Transient failures worth retrying: timeouts, connection issues, server
/// hiccups (429 / 5xx), and undecodable responses. Client mistakes (401/404…)
/// and our own messages are not.
pub(crate) fn is_retryable(err: &AppError) -> bool {
    match err {
        AppError::Json(_) => true,
        AppError::Http(e) => {
            e.is_timeout()
                || e.is_connect()
                || e.is_request()
                || e.status().is_some_and(|s| {
                    s.as_u16() == 429 || s.as_u16() >= 500
                })
        }
        _ => false,
    }
}

/// Exponential backoff between attempts: 0.6s, 1.2s, …
pub(crate) fn backoff_ms(attempt: u32) -> u64 {
    600u64 << attempt.min(4)
}

const CHAT_ATTEMPTS: u32 = 3;

/// Retry loop for transient LLM failures. A retryable error re-arms the
/// closure after a backoff sleep; anything else surfaces immediately.
pub(crate) fn with_retry<T, F>(mut attempt: F, max_attempts: u32) -> Result<T, AppError>
where
    F: FnMut() -> Result<T, AppError>,
{
    let mut last: Option<AppError> = None;
    for i in 0..max_attempts {
        match attempt() {
            Ok(value) => return Ok(value),
            Err(e) => {
                if i + 1 < max_attempts && is_retryable(&e) {
                    last = Some(e);
                    std::thread::sleep(std::time::Duration::from_millis(backoff_ms(i)));
                } else {
                    return Err(e);
                }
            }
        }
    }
    Err(last.unwrap_or_else(|| AppError::msg("retry loop ended without an error")))
}

#[cfg(test)]
mod clip_tests {
    use super::{backoff_ms, chat_completions_url, clip_zh, is_retryable, with_retry};
    use crate::error::AppError;

    fn json_err() -> AppError {
        AppError::Json(serde_json::from_str::<serde_json::Value>("not json").unwrap_err())
    }

    #[test]
    fn deepseek_root_gets_v1() {
        assert_eq!(
            chat_completions_url("https://api.deepseek.com"),
            "https://api.deepseek.com/v1/chat/completions"
        );
        assert_eq!(
            chat_completions_url("https://api.deepseek.com/v1"),
            "https://api.deepseek.com/v1/chat/completions"
        );
    }

    #[test]
    fn retryable_matrix() {
        assert!(is_retryable(&json_err()));
        assert!(!is_retryable(&AppError::msg("请先配置 API Key")));
        assert!(!is_retryable(&AppError::Locked));
    }

    #[test]
    fn with_retry_recovers_after_transient_failure() {
        let mut calls = 0;
        let out: Result<i32, AppError> = with_retry(
            || {
                calls += 1;
                if calls == 1 {
                    Err(json_err())
                } else {
                    Ok(7)
                }
            },
            3,
        );
        assert_eq!(out.unwrap(), 7);
        assert_eq!(calls, 2);
    }

    #[test]
    fn with_retry_surfaces_permanent_errors_immediately() {
        let mut calls = 0;
        let out: Result<i32, AppError> = with_retry(
            || {
                calls += 1;
                Err(AppError::msg("no key"))
            },
            3,
        );
        assert!(out.unwrap_err().to_string().contains("no key"));
        assert_eq!(calls, 1);
    }

    #[test]
    fn with_retry_gives_up_after_max_attempts() {
        let mut calls = 0;
        let out: Result<i32, AppError> = with_retry(
            || {
                calls += 1;
                Err(json_err())
            },
            2,
        );
        assert!(out.is_err());
        assert_eq!(calls, 2);
    }

    #[test]
    fn backoff_is_exponential() {
        assert_eq!(backoff_ms(0), 600);
        assert_eq!(backoff_ms(1), 1200);
        assert_eq!(backoff_ms(2), 2400);
        assert_eq!(backoff_ms(20), 600 << 4, "capped");
    }


    #[test]
    fn clip_zh_counts_unicode_scalars() {
        assert_eq!(clip_zh("abcdefghij", 5), "abcde");
        assert_eq!(clip_zh("一二三四五六七八九十", 5), "一二三四五");
        assert_eq!(clip_zh("  短简介  ", 50), "短简介");
        let long: String = "字".repeat(80);
        assert_eq!(clip_zh(&long, 50).chars().count(), 50);
        let two_sentences: String = "字".repeat(160);
        assert_eq!(
            clip_zh(&two_sentences, super::CARD_SUMMARY_MAX_CHARS)
                .chars()
                .count(),
            super::CARD_SUMMARY_MAX_CHARS
        );
    }
}
