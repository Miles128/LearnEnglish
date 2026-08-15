use crate::error::{lock_db, AppError};
use crate::db::{self, Article, DbState, TranslationRow};
use crate::feeds;
use crate::import_file;
use crate::vocab;
use tauri::{AppHandle, Emitter, Manager};

#[tauri::command]
pub fn list_articles(
    state: tauri::State<'_, DbState>,
    category: Option<String>,
    limit: Option<i64>,
    offset: Option<i64>,
) -> Result<Vec<Article>, AppError> {
    let conn = lock_db(&state)?;
    Ok(db::list_articles(&conn, category.as_deref(), limit, offset)?)
}

#[tauri::command]
pub fn get_article(state: tauri::State<'_, DbState>, id: String) -> Result<Option<Article>, AppError> {
    let conn = lock_db(&state)?;
    Ok(db::get_article(&conn, &id)?)
}

#[tauri::command]
pub fn get_paragraphs(state: tauri::State<'_, DbState>, id: String) -> Result<Vec<String>, AppError> {
    let conn = lock_db(&state)?;
    let article = db::get_article(&conn, &id)?.ok_or_else(|| "article not found".to_string())?;
    Ok(feeds::split_paragraphs(&article.content_text))
}

#[tauri::command]
pub fn list_paragraph_translations(
    state: tauri::State<'_, DbState>,
    article_id: String,
) -> Result<Vec<TranslationRow>, AppError> {
    let conn = lock_db(&state)?;
    Ok(db::list_paragraph_translations(&conn, &article_id)?)
}

#[derive(Clone, serde::Serialize, ts_rs::TS)]
#[ts(export)]
pub struct TranslateProgress {
    pub article_id: String,
    pub current: usize,
    pub total: usize,
    pub scope_key: String,
    pub translated_text: String,
    pub done: bool,
}

#[tauri::command]
pub async fn translate_paragraph(
    app: AppHandle,
    article_id: String,
    paragraph_index: usize,
    text: String,
) -> Result<TranslationRow, AppError> {
    // Blocking LLM HTTP must not run on the UI/main command thread.
    let cfg = crate::config::load_config()?;
    let app_handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<TranslationRow, AppError> {
        let state = app_handle
            .try_state::<DbState>()
            .ok_or_else(|| "数据库未就绪".to_string())?;
        let scope_key = paragraph_index.to_string();
        {
            let conn = lock_db(&state)?;
            if let Some(existing) =
                db::get_translation(&conn, &article_id, "paragraph", &scope_key)?
            {
                return Ok(existing);
            }
        }
        let translated = vocab::translate_text(&cfg, &text)?;
        let conn = lock_db(&state)?;
        Ok(db::save_translation(
            &conn,
            &article_id,
            "paragraph",
            &scope_key,
            &text,
            &translated,
            &cfg.model,
        )?)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn translate_selection(
    app: AppHandle,
    article_id: String,
    text: String,
) -> Result<TranslationRow, AppError> {
    let cfg = crate::config::load_config()?;
    let app_handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<TranslationRow, AppError> {
        let state = app_handle
            .try_state::<DbState>()
            .ok_or_else(|| "数据库未就绪".to_string())?;
        let scope_key = {
            use std::collections::hash_map::DefaultHasher;
            use std::hash::{Hash, Hasher};
            let mut h = DefaultHasher::new();
            text.hash(&mut h);
            format!("{:x}", h.finish())
        };
        {
            let conn = lock_db(&state)?;
            if let Some(existing) =
                db::get_translation(&conn, &article_id, "selection", &scope_key)?
            {
                return Ok(existing);
            }
        }
        let translated = vocab::translate_text(&cfg, &text)?;
        let conn = lock_db(&state)?;
        Ok(db::save_translation(
            &conn,
            &article_id,
            "selection",
            &scope_key,
            &text,
            &translated,
            &cfg.model,
        )?)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Clone, serde::Serialize, ts_rs::TS)]
#[ts(export)]
pub struct FullTranslateResult {
    pub rows: Vec<TranslationRow>,
    pub errors: Vec<String>,
}

#[tauri::command]
pub async fn translate_full_article(
    app: AppHandle,
    article_id: String,
) -> Result<FullTranslateResult, AppError> {
    let cfg = crate::config::load_config()?;
    let app_handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<FullTranslateResult, AppError> {
        let state = app_handle
            .try_state::<DbState>()
            .ok_or_else(|| "数据库未就绪".to_string())?;
        let paragraphs = {
            let conn = lock_db(&state)?;
            let article = db::get_article(&conn, &article_id)?
                .ok_or_else(|| "article not found".to_string())?;
            feeds::split_paragraphs(&article.content_text)
        };

        let total = paragraphs.len();
        let mut out = Vec::new();
        let mut errors = Vec::new();

        for chunk_start in (0..total).step_by(8) {
            let indices: Vec<usize> =
                (chunk_start..(chunk_start + 8).min(total)).collect();
            let mut missing: Vec<usize> = Vec::new();
            let mut missing_texts: Vec<String> = Vec::new();
            for &i in &indices {
                let scope_key = i.to_string();
                let existing = {
                    let conn = lock_db(&state)?;
                    db::get_translation(&conn, &article_id, "paragraph", &scope_key)?
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
            match vocab::translate_texts(&cfg, &missing_texts) {
                Ok(translated) => {
                    for (i, text) in missing.iter().zip(translated.iter()) {
                        let scope_key = i.to_string();
                        let row = {
                            let conn = lock_db(&state)?;
                            db::save_translation(
                                &conn,
                                &article_id,
                                "paragraph",
                                &scope_key,
                                &paragraphs[*i],
                                text,
                                &cfg.model,
                            )?
                        };
                        let _ = app_handle.emit(
                            "translate-progress",
                            TranslateProgress {
                                article_id: article_id.clone(),
                                current: *i + 1,
                                total,
                                scope_key: row.scope_key.clone(),
                                translated_text: row.translated_text.clone(),
                                done: false,
                            },
                        );
                        out.push(row);
                    }
                }
                Err(e) => errors.push(e),
            }
        }
        let _ = app_handle.emit(
            "translate-progress",
            TranslateProgress {
                article_id: article_id.clone(),
                current: total,
                total,
                scope_key: String::new(),
                translated_text: String::new(),
                done: true,
            },
        );
        Ok(FullTranslateResult { rows: out, errors })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn translate_missing_titles(app: AppHandle) -> Result<usize, AppError> {
    let cfg = crate::config::load_config()?;
    let app_handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<usize, AppError> {
        let state = app_handle
            .try_state::<DbState>()
            .ok_or_else(|| "数据库未就绪".to_string())?;
        Ok(feeds::fill_missing_title_translations(&state.0, &cfg, 40)?)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn import_article_url(app: AppHandle, url: String) -> Result<Article, AppError> {
    let app_handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<Article, AppError> {
        let state = app_handle
            .try_state::<DbState>()
            .ok_or_else(|| "数据库未就绪".to_string())?;
        Ok(feeds::import_article_from_url(&state.0, &url)?)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn import_article_file(app: AppHandle, path: String) -> Result<Article, AppError> {
    let app_handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<Article, AppError> {
        let state = app_handle
            .try_state::<DbState>()
            .ok_or_else(|| "数据库未就绪".to_string())?;
        Ok(import_file::import_article_from_file(&state.0, &path)?)
    })
    .await
    .map_err(|e| e.to_string())?
}