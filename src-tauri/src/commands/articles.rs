use crate::db::{self, Article, DbState, TranslationRow};
use crate::error::AppError;
use crate::feeds;
use crate::import_file;
use crate::vocab;
use rusqlite::Connection;
use tauri::{AppHandle, Emitter};

#[derive(Clone, serde::Serialize, ts_rs::TS)]
#[ts(export)]
pub struct ArticleView {
    pub article: Article,
    pub paragraphs: Vec<String>,
    pub translations: Vec<TranslationRow>,
}

pub fn load_article_view(conn: &Connection, id: &str) -> Result<Option<ArticleView>, String> {
    let Some(article) = db::get_article(conn, id)? else {
        return Ok(None);
    };
    let paragraphs = feeds::split_paragraphs(&article.content_text);
    let translations = db::list_paragraph_translations(conn, id)?;
    Ok(Some(ArticleView {
        article,
        paragraphs,
        translations,
    }))
}

#[tauri::command]
pub fn list_articles(
    state: tauri::State<'_, DbState>,
    category: Option<String>,
    limit: Option<i64>,
    offset: Option<i64>,
) -> Result<Vec<Article>, AppError> {
    let conn = state.lock_read()?;
    Ok(db::list_articles(&conn, category.as_deref(), limit, offset)?)
}

#[tauri::command]
pub fn get_article_view(
    state: tauri::State<'_, DbState>,
    id: String,
) -> Result<Option<ArticleView>, AppError> {
    let conn = state.lock_read()?;
    Ok(load_article_view(&conn, &id)?)
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

/// Stable across process restarts and compiler versions (unlike DefaultHasher),
/// so cached selection translations survive app updates.
fn stable_scope_key(text: &str) -> String {
    // FNV-1a 64-bit
    let mut hash: u64 = 0xcbf29ce484222325;
    for byte in text.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:x}")
}

fn translate_and_cache(
    state: &DbState,
    cfg: &crate::config::AppConfig,
    article_id: &str,
    scope: &str,
    scope_key: &str,
    text: &str,
) -> Result<TranslationRow, AppError> {
    {
        let conn = state.lock_read()?;
        if let Some(existing) = db::get_translation(&conn, article_id, scope, scope_key)? {
            return Ok(existing);
        }
    }
    let translated = vocab::translate_text(cfg, text)?;
    let conn = state.lock_write()?;
    Ok(db::save_translation(
        &conn,
        article_id,
        scope,
        scope_key,
        text,
        &translated,
        &cfg.model,
    )?)
}

#[tauri::command]
pub async fn translate_paragraph(
    app: AppHandle,
    article_id: String,
    paragraph_index: usize,
    text: String,
) -> Result<TranslationRow, AppError> {
    let cfg = crate::config::load_config()?;
    crate::commands::spawn_db(app, move |state| {
        translate_and_cache(
            state,
            &cfg,
            &article_id,
            "paragraph",
            &paragraph_index.to_string(),
            &text,
        )
    })
    .await
}

#[tauri::command]
pub async fn translate_selection(
    app: AppHandle,
    article_id: String,
    text: String,
) -> Result<TranslationRow, AppError> {
    let cfg = crate::config::load_config()?;
    crate::commands::spawn_db(app, move |state| {
        let scope_key = stable_scope_key(&text);
        translate_and_cache(state, &cfg, &article_id, "selection", &scope_key, &text)
    })
    .await
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
    let emit_app = app.clone();
    crate::commands::spawn_db(app, move |state| {
        let paragraphs = {
            let conn = state.lock_read()?;
            let article = db::get_article(&conn, &article_id)?
                .ok_or_else(|| "article not found".to_string())?;
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
                    let conn = state.lock_read()?;
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
                            let conn = state.lock_write()?;
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
                        let _ = emit_app.emit(
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
                Err(e) => {
                    let first = missing.first().map(|i| i + 1).unwrap_or(0);
                    let last = missing.last().map(|i| i + 1).unwrap_or(0);
                    errors.push(format!("段落 {first}–{last} 翻译失败：{e}"));
                }
            }
        }
        let _ = emit_app.emit(
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
}

#[tauri::command]
pub async fn translate_missing_titles(app: AppHandle) -> Result<usize, AppError> {
    let cfg = crate::config::load_config()?;
    crate::commands::spawn_db(app, move |state| {
        Ok(feeds::fill_missing_title_translations(state, &cfg, 40)?)
    })
    .await
}

#[tauri::command]
pub async fn import_article_url(app: AppHandle, url: String) -> Result<Article, AppError> {
    crate::commands::spawn_db(app, move |state| {
        Ok(feeds::import_article_from_url(state, &url)?)
    })
    .await
}

#[tauri::command]
pub async fn import_article_file(app: AppHandle, path: String) -> Result<Article, AppError> {
    crate::commands::spawn_db(app, move |state| {
        Ok(import_file::import_article_from_file(state, &path)?)
    })
    .await
}
