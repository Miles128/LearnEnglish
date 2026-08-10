mod config;
mod db;
mod feeds;
mod srs;
mod vocab;

#[cfg(test)]
mod db_tests;

use chrono::Utc;
use config::AppConfig;
use db::{Article, DbState, FeedSource, TranslationRow, VocabItem};
use feeds::{RefreshProgress, RefreshResult};
use srs::{apply_rating, Rating};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};
use uuid::Uuid;
use vocab::VocabEnrichment;

#[tauri::command]
fn get_config() -> Result<AppConfig, String> {
    config::load_config()
}

#[tauri::command]
fn save_config_cmd(cfg: AppConfig) -> Result<(), String> {
    config::save_config(&cfg)
}

#[tauri::command]
fn list_articles(state: tauri::State<'_, DbState>, category: Option<String>) -> Result<Vec<Article>, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    db::list_articles(&conn, category.as_deref())
}

#[tauri::command]
fn get_article(state: tauri::State<'_, DbState>, id: String) -> Result<Option<Article>, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    db::get_article(&conn, &id)
}

#[tauri::command]
fn list_feeds(state: tauri::State<'_, DbState>) -> Result<Vec<FeedSource>, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    db::list_feeds(&conn)
}

#[tauri::command]
fn set_feed_enabled(
    state: tauri::State<'_, DbState>,
    id: String,
    enabled: bool,
) -> Result<(), String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    db::set_feed_enabled(&conn, &id, enabled)
}

#[tauri::command]
async fn refresh_feeds(app: AppHandle) -> Result<RefreshResult, String> {
    // Sync commands run on the UI main thread — blocking HTTP there freezes the window.
    // Offload to a blocking pool so the UI can paint progress events.
    let _ = app.emit(
        "refresh-progress",
        RefreshProgress {
            phase: "download".into(),
            current: 0,
            total: 0,
            label: "开始刷新…".into(),
            percent: 0,
        },
    );

    let cfg = config::load_config()?;
    let app_handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let state = app_handle
            .try_state::<DbState>()
            .ok_or_else(|| "数据库未就绪".to_string())?;
        feeds::refresh_feeds(&state.0, &cfg, |progress: RefreshProgress| {
            let _ = app_handle.emit("refresh-progress", &progress);
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn translate_missing_titles(app: AppHandle) -> Result<usize, String> {
    let cfg = config::load_config()?;
    let app_handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let state = app_handle
            .try_state::<DbState>()
            .ok_or_else(|| "数据库未就绪".to_string())?;
        feeds::fill_missing_title_translations(&state.0, &cfg, 40)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn import_article_url(app: AppHandle, url: String) -> Result<Article, String> {
    let app_handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let state = app_handle
            .try_state::<DbState>()
            .ok_or_else(|| "数据库未就绪".to_string())?;
        feeds::import_article_from_url(&state.0, &url)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn get_paragraphs(state: tauri::State<'_, DbState>, id: String) -> Result<Vec<String>, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let article = db::get_article(&conn, &id)?.ok_or_else(|| "article not found".to_string())?;
    Ok(feeds::split_paragraphs(&article.content_text))
}

#[tauri::command]
fn list_paragraph_translations(
    state: tauri::State<'_, DbState>,
    article_id: String,
) -> Result<Vec<TranslationRow>, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    db::list_paragraph_translations(&conn, &article_id)
}

#[tauri::command]
fn translate_paragraph(
    state: tauri::State<'_, DbState>,
    article_id: String,
    paragraph_index: usize,
    text: String,
) -> Result<TranslationRow, String> {
    let cfg = config::load_config()?;
    let scope_key = paragraph_index.to_string();
    {
        let conn = state.0.lock().map_err(|e| e.to_string())?;
        if let Some(existing) = db::get_translation(&conn, &article_id, "paragraph", &scope_key)? {
            return Ok(existing);
        }
    }
    let translated = vocab::translate_text(&cfg, &text)?;
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    db::save_translation(
        &conn,
        &article_id,
        "paragraph",
        &scope_key,
        &text,
        &translated,
        &cfg.model,
    )
}

#[tauri::command]
fn translate_selection(
    state: tauri::State<'_, DbState>,
    article_id: String,
    text: String,
) -> Result<TranslationRow, String> {
    let cfg = config::load_config()?;
    let scope_key = {
        use std::collections::hash_map::DefaultHasher;
        use std::hash::{Hash, Hasher};
        let mut h = DefaultHasher::new();
        text.hash(&mut h);
        format!("{:x}", h.finish())
    };
    {
        let conn = state.0.lock().map_err(|e| e.to_string())?;
        if let Some(existing) = db::get_translation(&conn, &article_id, "selection", &scope_key)? {
            return Ok(existing);
        }
    }
    let translated = vocab::translate_text(&cfg, &text)?;
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    db::save_translation(
        &conn,
        &article_id,
        "selection",
        &scope_key,
        &text,
        &translated,
        &cfg.model,
    )
}

#[tauri::command]
fn translate_full_article(
    state: tauri::State<'_, DbState>,
    article_id: String,
) -> Result<Vec<TranslationRow>, String> {
    let cfg = config::load_config()?;
    let paragraphs = {
        let conn = state.0.lock().map_err(|e| e.to_string())?;
        let article = db::get_article(&conn, &article_id)?
            .ok_or_else(|| "article not found".to_string())?;
        feeds::split_paragraphs(&article.content_text)
    };

    let mut out = Vec::new();
    for (i, p) in paragraphs.iter().enumerate() {
        let scope_key = i.to_string();
        let existing = {
            let conn = state.0.lock().map_err(|e| e.to_string())?;
            db::get_translation(&conn, &article_id, "paragraph", &scope_key)?
        };
        if let Some(row) = existing {
            out.push(row);
            continue;
        }
        let translated = vocab::translate_text(&cfg, p)?;
        let conn = state.0.lock().map_err(|e| e.to_string())?;
        let row = db::save_translation(
            &conn,
            &article_id,
            "paragraph",
            &scope_key,
            p,
            &translated,
            &cfg.model,
        )?;
        out.push(row);
    }
    Ok(out)
}

#[derive(serde::Deserialize)]
struct AddVocabInput {
    term: String,
    context_sentence: String,
    article_id: Option<String>,
    definition_zh: Option<String>,
    word_type: Option<String>,
    collocations: Option<Vec<String>>,
}

#[tauri::command]
fn add_vocab(state: tauri::State<'_, DbState>, input: AddVocabInput) -> Result<VocabItem, String> {
    let cfg = config::load_config()?;
    let enrichment: VocabEnrichment = if input.definition_zh.is_some()
        && input.word_type.is_some()
        && input.collocations.is_some()
    {
        VocabEnrichment {
            definition_zh: input.definition_zh.unwrap_or_default(),
            word_type: input.word_type.unwrap_or_else(|| "phrase".into()),
            collocations: input.collocations.unwrap_or_default(),
        }
    } else {
        vocab::enrich_vocab(&cfg, &input.term, &input.context_sentence)?
    };

    let now = Utc::now().to_rfc3339();
    let item = VocabItem {
        id: Uuid::new_v4().to_string(),
        term: input.term.trim().to_string(),
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
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    db::insert_vocab(&conn, &item)?;
    Ok(item)
}

#[tauri::command]
fn list_vocab(
    state: tauri::State<'_, DbState>,
    status: Option<String>,
) -> Result<Vec<VocabItem>, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    db::list_vocab(&conn, status.as_deref())
}

#[tauri::command]
fn due_vocab(state: tauri::State<'_, DbState>) -> Result<Vec<VocabItem>, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    db::due_vocab(&conn)
}

#[tauri::command]
fn review_vocab(
    state: tauri::State<'_, DbState>,
    id: String,
    rating: String,
) -> Result<VocabItem, String> {
    let r = Rating::from_str(&rating)?;
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let mut item = db::get_vocab(&conn, &id)?.ok_or_else(|| "vocab not found".to_string())?;
    apply_rating(&mut item, r);
    db::update_vocab_review(&conn, &item)?;
    Ok(item)
}

#[tauri::command]
fn set_vocab_status(
    state: tauri::State<'_, DbState>,
    id: String,
    status: String,
) -> Result<(), String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    db::set_vocab_status(&conn, &id, &status)
}

#[tauri::command]
fn delete_vocab(state: tauri::State<'_, DbState>, id: String) -> Result<(), String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    db::delete_vocab(&conn, &id)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let dir = app
                .path()
                .app_data_dir()
                .map_err(|e| e.to_string())?;
            let path = db::db_path(dir);
            let conn = db::open_db(path)?;
            app.manage(DbState(Mutex::new(conn)));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_config,
            save_config_cmd,
            list_articles,
            get_article,
            list_feeds,
            set_feed_enabled,
            refresh_feeds,
            translate_missing_titles,
            import_article_url,
            get_paragraphs,
            list_paragraph_translations,
            translate_paragraph,
            translate_selection,
            translate_full_article,
            add_vocab,
            list_vocab,
            due_vocab,
            review_vocab,
            set_vocab_status,
            delete_vocab
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
