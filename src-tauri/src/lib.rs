mod config;
mod db;
mod feeds;
mod import_file;
mod srs;
mod vocab;

#[cfg(test)]
mod db_tests;

use chrono::Utc;
use config::AppConfig;
use db::{Article, DbState, FeedCategory, FeedSource, TranslationRow, VocabItem};
use feeds::{FeedValidation, RefreshProgress, RefreshResult};
use srs::{apply_rating, Rating};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};
use uuid::Uuid;
use vocab::{FeedDiscoverCandidate, VocabEnrichment};

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
fn list_feed_categories(
    state: tauri::State<'_, DbState>,
) -> Result<Vec<FeedCategory>, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    db::list_feed_categories(&conn)
}

#[tauri::command]
fn add_feed_category(
    state: tauri::State<'_, DbState>,
    label: String,
) -> Result<FeedCategory, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    db::add_feed_category(&conn, &label)
}

#[derive(serde::Deserialize)]
struct SubscribeFeedInput {
    name: String,
    category: String,
    url: String,
    description: Option<String>,
}

#[tauri::command]
fn subscribe_feed(
    state: tauri::State<'_, DbState>,
    input: SubscribeFeedInput,
) -> Result<FeedSource, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    db::subscribe_feed(
        &conn,
        &input.name,
        &input.category,
        &input.url,
        input.description.as_deref().unwrap_or(""),
    )
}

#[tauri::command]
async fn validate_feed(url: String) -> Result<FeedValidation, String> {
    tauri::async_runtime::spawn_blocking(move || feeds::validate_feed_url(&url))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn discover_feeds(
    app: AppHandle,
    category_id: String,
) -> Result<Vec<FeedDiscoverCandidate>, String> {
    let cfg = config::load_config()?;
    let app_handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let state = app_handle
            .try_state::<DbState>()
            .ok_or_else(|| "数据库未就绪".to_string())?;
        let conn = state.0.lock().map_err(|e| e.to_string())?;
        let cat = db::get_feed_category(&conn, &category_id)?
            .ok_or_else(|| format!("未知分类：{category_id}"))?;
        drop(conn);
        vocab::discover_rss_feeds(&cfg, &cat.id, &cat.label)
    })
    .await
    .map_err(|e| e.to_string())?
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
async fn import_article_file(app: AppHandle, path: String) -> Result<Article, String> {
    let app_handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let state = app_handle
            .try_state::<DbState>()
            .ok_or_else(|| "数据库未就绪".to_string())?;
        import_file::import_article_from_file(&state.0, &path)
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

#[derive(Clone, serde::Serialize)]
struct TranslateProgress {
    article_id: String,
    current: usize,
    total: usize,
    scope_key: String,
    translated_text: String,
    done: bool,
}

#[tauri::command]
async fn translate_paragraph(
    app: AppHandle,
    article_id: String,
    paragraph_index: usize,
    text: String,
) -> Result<TranslationRow, String> {
    // Blocking LLM HTTP must not run on the UI/main command thread.
    let cfg = config::load_config()?;
    let app_handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let state = app_handle
            .try_state::<DbState>()
            .ok_or_else(|| "数据库未就绪".to_string())?;
        let scope_key = paragraph_index.to_string();
        {
            let conn = state.0.lock().map_err(|e| e.to_string())?;
            if let Some(existing) =
                db::get_translation(&conn, &article_id, "paragraph", &scope_key)?
            {
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
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn translate_selection(
    app: AppHandle,
    article_id: String,
    text: String,
) -> Result<TranslationRow, String> {
    let cfg = config::load_config()?;
    let app_handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
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
            let conn = state.0.lock().map_err(|e| e.to_string())?;
            if let Some(existing) =
                db::get_translation(&conn, &article_id, "selection", &scope_key)?
            {
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
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn translate_full_article(
    app: AppHandle,
    article_id: String,
) -> Result<Vec<TranslationRow>, String> {
    let cfg = config::load_config()?;
    let app_handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let state = app_handle
            .try_state::<DbState>()
            .ok_or_else(|| "数据库未就绪".to_string())?;
        let paragraphs = {
            let conn = state.0.lock().map_err(|e| e.to_string())?;
            let article = db::get_article(&conn, &article_id)?
                .ok_or_else(|| "article not found".to_string())?;
            feeds::split_paragraphs(&article.content_text)
        };

        let total = paragraphs.len();
        let mut out = Vec::new();
        for (i, p) in paragraphs.iter().enumerate() {
            let scope_key = i.to_string();
            let existing = {
                let conn = state.0.lock().map_err(|e| e.to_string())?;
                db::get_translation(&conn, &article_id, "paragraph", &scope_key)?
            };
            let row = if let Some(row) = existing {
                row
            } else {
                let translated = vocab::translate_text(&cfg, p)?;
                let conn = state.0.lock().map_err(|e| e.to_string())?;
                db::save_translation(
                    &conn,
                    &article_id,
                    "paragraph",
                    &scope_key,
                    p,
                    &translated,
                    &cfg.model,
                )?
            };
            let _ = app_handle.emit(
                "translate-progress",
                TranslateProgress {
                    article_id: article_id.clone(),
                    current: i + 1,
                    total,
                    scope_key: row.scope_key.clone(),
                    translated_text: row.translated_text.clone(),
                    done: false,
                },
            );
            out.push(row);
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
        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())?
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
        .plugin(tauri_plugin_dialog::init())
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
            list_feed_categories,
            add_feed_category,
            subscribe_feed,
            validate_feed,
            discover_feeds,
            refresh_feeds,
            translate_missing_titles,
            import_article_url,
            import_article_file,
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
