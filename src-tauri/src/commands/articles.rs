use crate::db::{self, Article, ArticleListItem, DbState, LearningStats, TranslationRow};
use crate::error::AppError;
use crate::feeds;
use crate::import_file;
use crate::translate;
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
pub async fn list_articles(
    app: AppHandle,
    category: Option<String>,
    limit: Option<i64>,
    offset: Option<i64>,
) -> Result<Vec<ArticleListItem>, AppError> {
    crate::commands::spawn_db(app, move |state| {
        let conn = state.lock_read()?;
        Ok(db::list_articles(&conn, category.as_deref(), limit, offset)?)
    })
    .await
}

#[tauri::command]
pub fn get_article_view(
    state: tauri::State<'_, DbState>,
    id: String,
) -> Result<Option<ArticleView>, AppError> {
    let conn = state.lock_read()?;
    Ok(load_article_view(&conn, &id)?)
}

#[tauri::command]
pub fn mark_article_opened(
    state: tauri::State<'_, DbState>,
    id: String,
) -> Result<(), AppError> {
    let conn = state.lock_write()?;
    Ok(db::mark_article_opened(&conn, &id)?)
}

#[tauri::command]
pub fn get_learning_stats(
    state: tauri::State<'_, DbState>,
) -> Result<LearningStats, AppError> {
    let conn = state.lock_read()?;
    Ok(db::learning_stats(&conn)?)
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
        Ok(translate::translate_and_cache(
            state,
            &cfg,
            &article_id,
            "paragraph",
            &paragraph_index.to_string(),
            &text,
        )?)
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
        let scope_key = translate::stable_scope_key(&text);
        Ok(translate::translate_and_cache(
            state,
            &cfg,
            &article_id,
            "selection",
            &scope_key,
            &text,
        )?)
    })
    .await
}

#[tauri::command]
pub async fn translate_full_article(
    app: AppHandle,
    article_id: String,
) -> Result<translate::FullTranslateResult, AppError> {
    let cfg = crate::config::load_config()?;
    let emit_app = app.clone();
    crate::commands::spawn_db(app, move |state| {
        Ok(translate::translate_full_article(
            state,
            &cfg,
            &article_id,
            |p| {
                let _ = emit_app.emit("translate-progress", p);
            },
        )?)
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
