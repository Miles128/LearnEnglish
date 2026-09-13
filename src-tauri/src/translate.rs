//! Paragraph / selection / full-article translation orchestration.
//! Commands only spawn work and emit progress.

use crate::config::AppConfig;
use crate::db::{self, DbState, TranslationRow};
use crate::feeds;
use crate::vocab;
use serde::Serialize;
use ts_rs::TS;

#[derive(Clone, Serialize, TS)]
#[ts(export)]
pub struct TranslateProgress {
    pub article_id: String,
    pub current: usize,
    pub total: usize,
    pub scope_key: String,
    pub translated_text: String,
    pub done: bool,
}

#[derive(Clone, Serialize, TS)]
#[ts(export)]
pub struct FullTranslateResult {
    pub rows: Vec<TranslationRow>,
    pub errors: Vec<String>,
}

/// Stable across process restarts and compiler versions (unlike DefaultHasher).
pub fn stable_scope_key(text: &str) -> String {
    let mut hash: u64 = 0xcbf29ce484222325;
    for byte in text.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:x}")
}

pub fn translate_and_cache(
    state: &DbState,
    cfg: &AppConfig,
    article_id: &str,
    scope: &str,
    scope_key: &str,
    text: &str,
) -> Result<TranslationRow, String> {
    {
        let conn = state.lock_read().map_err(|e| e.to_string())?;
        if let Some(existing) = db::get_translation(&conn, article_id, scope, scope_key)? {
            return Ok(existing);
        }
    }
    let translated = vocab::translate_text(cfg, text)?;
    let conn = state.lock_write().map_err(|e| e.to_string())?;
    db::save_translation(
        &conn,
        article_id,
        scope,
        scope_key,
        text,
        &translated,
        &cfg.model,
    )
}

pub fn translate_full_article(
    state: &DbState,
    cfg: &AppConfig,
    article_id: &str,
    mut on_progress: impl FnMut(&TranslateProgress),
) -> Result<FullTranslateResult, String> {
    let paragraphs = {
        let conn = state.lock_read().map_err(|e| e.to_string())?;
        let article = db::get_article(&conn, article_id)?.ok_or_else(|| "article not found".to_string())?;
        feeds::split_paragraphs(&article.content_text)
    };

    let total = paragraphs.len();
    let mut out = Vec::new();
    let mut errors = Vec::new();

    for chunk_start in (0..total).step_by(8) {
        let indices: Vec<usize> = (chunk_start..(chunk_start + 8).min(total)).collect();
        let mut missing: Vec<usize> = Vec::new();
        let mut missing_texts: Vec<String> = Vec::new();
        for &i in &indices {
            let scope_key = i.to_string();
            let existing = {
                let conn = state.lock_read().map_err(|e| e.to_string())?;
                db::get_translation(&conn, article_id, "paragraph", &scope_key)?
            };
            match existing {
                Some(row) => out.push(row),
                None => {
                    missing.push(i);
                    missing_texts.push(paragraphs[i].clone());
                }
            }
        }
        if missing_texts.is_empty() {
            continue;
        }
        match vocab::translate_texts(cfg, &missing_texts) {
            Ok(translated) => {
                for (i, text) in missing.iter().zip(translated.iter()) {
                    let scope_key = i.to_string();
                    let row = {
                        let conn = state.lock_write().map_err(|e| e.to_string())?;
                        db::save_translation(
                            &conn,
                            article_id,
                            "paragraph",
                            &scope_key,
                            &paragraphs[*i],
                            text,
                            &cfg.model,
                        )?
                    };
                    on_progress(&TranslateProgress {
                        article_id: article_id.to_string(),
                        current: *i + 1,
                        total,
                        scope_key: row.scope_key.clone(),
                        translated_text: row.translated_text.clone(),
                        done: false,
                    });
                    out.push(row);
                }
            }
            Err(e) => {
                let first = missing.first().map(|i| i + 1).unwrap_or(0);
                let last = missing.last().map(|i| i + 1).unwrap_or(0);
                errors.push(format!("段落 {first}–{last} 翻译失败：{e}"));
            }
        }
    }
    on_progress(&TranslateProgress {
        article_id: article_id.to_string(),
        current: total,
        total,
        scope_key: String::new(),
        translated_text: String::new(),
        done: true,
    });
    Ok(FullTranslateResult { rows: out, errors })
}

#[cfg(test)]
mod tests {
    use super::stable_scope_key;

    #[test]
    fn scope_key_is_stable_and_distinct() {
        assert_eq!(stable_scope_key("hello"), stable_scope_key("hello"));
        assert_ne!(stable_scope_key("hello"), stable_scope_key("world"));
    }
}
