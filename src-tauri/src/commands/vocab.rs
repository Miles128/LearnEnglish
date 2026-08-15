use crate::config;
use crate::error::{lock_db, AppError};
use crate::db::{self, DbState, VocabItem};
use crate::srs::{apply_rating, Rating};
use crate::vocab::{self, VocabEnrichment};
use chrono::Utc;
use uuid::Uuid;

#[derive(serde::Deserialize)]
pub struct AddVocabInput {
    pub term: String,
    pub context_sentence: String,
    pub article_id: Option<String>,
    pub definition_zh: Option<String>,
    pub word_type: Option<String>,
    pub collocations: Option<Vec<String>>,
}

#[tauri::command]
pub fn add_vocab(state: tauri::State<'_, DbState>, input: AddVocabInput) -> Result<VocabItem, AppError> {
    let cfg = config::load_config()?;
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
        match vocab::enrich_vocab(&cfg, &term, &input.context_sentence) {
            Ok(e) => e,
            // LLM unavailable (no key / network): degrade to whatever we already know
            // so adding a word never hard-fails on enrichment.
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
    let conn = lock_db(&state)?;

    // Dedup by term: merge new info into the existing entry instead of duplicating.
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

#[tauri::command]
pub fn list_vocab(
    state: tauri::State<'_, DbState>,
    status: Option<String>,
) -> Result<Vec<VocabItem>, AppError> {
    let conn = lock_db(&state)?;
    Ok(db::list_vocab(&conn, status.as_deref())?)
}

#[tauri::command]
pub fn due_vocab(state: tauri::State<'_, DbState>) -> Result<Vec<VocabItem>, AppError> {
    let conn = lock_db(&state)?;
    Ok(db::due_vocab(&conn)?)
}

#[tauri::command]
pub fn review_vocab(
    state: tauri::State<'_, DbState>,
    id: String,
    rating: String,
) -> Result<VocabItem, AppError> {
    let r = Rating::from_str(&rating)?;
    let conn = lock_db(&state)?;
    let mut item = db::get_vocab(&conn, &id)?.ok_or_else(|| "vocab not found".to_string())?;
    apply_rating(&mut item, r);
    db::update_vocab_review(&conn, &item)?;
    Ok(item)
}

#[tauri::command]
pub fn set_vocab_status(
    state: tauri::State<'_, DbState>,
    id: String,
    status: String,
) -> Result<(), AppError> {
    let conn = lock_db(&state)?;
    Ok(db::set_vocab_status(&conn, &id, &status)?)
}

#[tauri::command]
pub fn delete_vocab(state: tauri::State<'_, DbState>, id: String) -> Result<(), AppError> {
    let conn = lock_db(&state)?;
    Ok(db::delete_vocab(&conn, &id)?)
}