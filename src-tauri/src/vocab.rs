use crate::config::AppConfig;
use reqwest::blocking::Client;
use serde::{Deserialize, Serialize};
use serde_json::json;

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

/// Translate article titles in batch. Input order must match output order.
pub fn translate_titles(cfg: &AppConfig, titles: &[String]) -> Result<Vec<String>, String> {
    if titles.is_empty() {
        return Ok(vec![]);
    }
    ensure_configured(cfg)?;
    let system = r#"You translate English article titles to Simplified Chinese for learners.
Given a JSON array of English titles, return ONLY a JSON array of Chinese titles in the same order and length.
No markdown fences, no commentary."#;
    let payload = serde_json::to_string(titles).map_err(|e| e.to_string())?;
    let raw = chat(cfg, system, &payload)?;
    let cleaned = raw
        .trim()
        .trim_start_matches("```json")
        .trim_start_matches("```")
        .trim_end_matches("```")
        .trim();
    let out: Vec<String> = serde_json::from_str(cleaned)
        .map_err(|e| format!("parse title translations: {e}; raw={raw}"))?;
    if out.len() != titles.len() {
        return Err(format!(
            "title translation count mismatch: got {} expected {}",
            out.len(),
            titles.len()
        ));
    }
    Ok(out)
}

pub fn enrich_vocab(cfg: &AppConfig, term: &str, context: &str) -> Result<VocabEnrichment, String> {
    ensure_configured(cfg)?;
    let system = r#"You help English learners. Given a word/phrase and its context sentence, return ONLY valid JSON with keys:
definition_zh (string, concise Chinese meaning),
word_type (string, e.g. noun / verb / adjective / phrase / idiom / usage),
collocations (array of 2-5 short common collocations or usage patterns in English).
No markdown fences."#;
    let user = format!("Term: {term}\nContext: {context}");
    let raw = chat(cfg, system, &user)?;
    let cleaned = raw
        .trim()
        .trim_start_matches("```json")
        .trim_start_matches("```")
        .trim_end_matches("```")
        .trim();
    serde_json::from_str(cleaned).map_err(|e| format!("parse vocab JSON: {e}; raw={raw}"))
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
    let client = Client::builder()
        .timeout(std::time::Duration::from_secs(90))
        .build()
        .map_err(|e| e.to_string())?;

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

    let resp = client
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
