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

pub fn translate_text(cfg: &AppConfig, text: &str) -> Result<String, String> {
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

/// Chat → parse JSON, with one stricter-instruction retry on parse failure.
/// Models occasionally wrap JSON in prose/fences despite instructions; the
/// single retry recovers most of those without burning extra calls up front.
fn chat_json<T: for<'de> Deserialize<'de>>(
    cfg: &AppConfig,
    system: &str,
    user: &str,
    label: &str,
) -> Result<T, String> {
    let raw = chat(cfg, system, user)?;
    match serde_json::from_str(strip_fences(&raw)) {
        Ok(v) => Ok(v),
        Err(first_err) => {
            let raw2 = chat(cfg, system, &format!("{user}{JSON_REMINDER}"))
                .map_err(|e| format!("{label}: first attempt failed to parse ({first_err}); retry request failed: {e}"))?;
            serde_json::from_str(strip_fences(&raw2))
                .map_err(|e| format!("parse {label}: {first_err}; retry also failed: {e}; raw={raw2}"))
        }
    }
}

/// Translate article paragraphs in batch. Input order must match output order.
pub fn translate_texts(cfg: &AppConfig, texts: &[String]) -> Result<Vec<String>, String> {
    if texts.is_empty() {
        return Ok(vec![]);
    }
    ensure_configured(cfg)?;
    let system = r#"You translate English passages to Simplified Chinese for language learners.
Given a JSON array of English passages, return ONLY a JSON array of Chinese translations in the same order and length.
Translate faithfully. No markdown fences, no commentary."#;
    let payload = serde_json::to_string(texts).map_err(|e| e.to_string())?;
    let out: Vec<String> = chat_json(cfg, system, &payload, "paragraph translations")?;
    if out.len() != texts.len() {
        return Err(format!(
            "paragraph translation count mismatch: got {} expected {}",
            out.len(),
            texts.len()
        ));
    }
    Ok(out)
}

pub const CARD_SUMMARY_MAX_CHARS: usize = 50;
const CARD_EXCERPT_CHARS: usize = 400;

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
}

pub fn card_from_article(title: &str, content_text: &str) -> ArticleCardIn {
    ArticleCardIn {
        title: title.to_string(),
        excerpt: clip_zh(content_text, CARD_EXCERPT_CHARS),
    }
}

/// Batch: Chinese title + ≤50-char Chinese summary. Input order = output order.
pub fn translate_article_cards(
    cfg: &AppConfig,
    cards: &[ArticleCardIn],
) -> Result<Vec<ArticleCardOut>, String> {
    if cards.is_empty() {
        return Ok(vec![]);
    }
    ensure_configured(cfg)?;
    let system = r#"You write Simplified Chinese metadata for English articles for language learners.
Given a JSON array of objects {title, excerpt}, return ONLY a JSON array of the same length.
Each item must be {"title_zh":"<Chinese title>","summary_zh":"<Chinese synopsis>"}.
summary_zh must be a faithful one-sentence synopsis of the excerpt, at most 50 Chinese characters (no ellipsis padding, no quotes).
No markdown fences, no commentary."#;
    let payload = serde_json::to_string(cards).map_err(|e| e.to_string())?;
    let out: Vec<ArticleCardOut> = chat_json(cfg, system, &payload, "article cards")?;
    if out.len() != cards.len() {
        return Err(format!(
            "article card count mismatch: got {} expected {}",
            out.len(),
            cards.len()
        ));
    }
    Ok(out
        .into_iter()
        .map(|mut c| {
            c.title_zh = c.title_zh.trim().to_string();
            c.summary_zh = clip_zh(&c.summary_zh, CARD_SUMMARY_MAX_CHARS);
            c
        })
        .collect())
}

pub fn enrich_vocab(cfg: &AppConfig, term: &str, context: &str) -> Result<VocabEnrichment, String> {
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
) -> Result<VocabItem, String> {
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
    let conn = db.lock_write().map_err(|e| e.to_string())?;

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
) -> Result<Vec<FeedDiscoverCandidate>, String> {
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

fn ensure_configured(cfg: &AppConfig) -> Result<(), String> {
    if cfg.api_key.trim().is_empty() || cfg.api_key.contains("YOUR_API_KEY") {
        return Err("请先在设置中配置 API Key（config.local.json）".into());
    }
    if cfg.base_url.trim().is_empty() || cfg.model.trim().is_empty() {
        return Err("请配置 base_url 与 model".into());
    }
    Ok(())
}

fn chat(cfg: &AppConfig, system: &str, user: &str) -> Result<String, String> {
    let base = cfg.base_url.trim_end_matches('/');
    let url = format!("{base}/chat/completions");
    let body = json!({
        "model": cfg.model,
        "temperature": 0.2,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user}
        ]
    });

    let resp = CHAT_CLIENT
        .post(&url)
        .bearer_auth(&cfg.api_key)
        .json(&body)
        .send()
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?;

    let parsed: ChatResponse = resp.json().map_err(|e| e.to_string())?;
    parsed
        .choices
        .first()
        .and_then(|c| c.message.content.clone())
        .ok_or_else(|| "LLM returned empty content".into())
}

#[cfg(test)]
mod clip_tests {
    use super::clip_zh;

    #[test]
    fn clip_zh_counts_unicode_scalars() {
        assert_eq!(clip_zh("abcdefghij", 5), "abcde");
        assert_eq!(clip_zh("一二三四五六七八九十", 5), "一二三四五");
        assert_eq!(clip_zh("  短简介  ", 50), "短简介");
        let long: String = "字".repeat(80);
        assert_eq!(clip_zh(&long, 50).chars().count(), 50);
    }
}
