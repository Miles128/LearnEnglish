use crate::error::{lock_db, AppError};
use crate::db::{self, DbState, FeedCategory, FeedSource};
use crate::feeds::{self, FeedValidation, RefreshProgress, RefreshResult};
use crate::vocab::{self, FeedDiscoverCandidate};
use tauri::{AppHandle, Emitter, Manager};

#[tauri::command]
pub fn list_feeds(state: tauri::State<'_, DbState>) -> Result<Vec<FeedSource>, AppError> {
    let conn = lock_db(&state)?;
    Ok(db::list_feeds(&conn)?)
}

#[tauri::command]
pub fn set_feed_enabled(
    state: tauri::State<'_, DbState>,
    id: String,
    enabled: bool,
) -> Result<(), AppError> {
    let conn = lock_db(&state)?;
    Ok(db::set_feed_enabled(&conn, &id, enabled)?)
}

#[tauri::command]
pub fn list_feed_categories(
    state: tauri::State<'_, DbState>,
) -> Result<Vec<FeedCategory>, AppError> {
    let conn = lock_db(&state)?;
    Ok(db::list_feed_categories(&conn)?)
}

#[tauri::command]
pub fn add_feed_category(
    state: tauri::State<'_, DbState>,
    label: String,
) -> Result<FeedCategory, AppError> {
    let conn = lock_db(&state)?;
    Ok(db::add_feed_category(&conn, &label)?)
}

#[derive(serde::Deserialize)]
pub struct SubscribeFeedInput {
    pub name: String,
    pub category: String,
    pub url: String,
    pub description: Option<String>,
}

#[tauri::command]
pub fn subscribe_feed(
    state: tauri::State<'_, DbState>,
    input: SubscribeFeedInput,
) -> Result<FeedSource, AppError> {
    let conn = lock_db(&state)?;
    Ok(db::subscribe_feed(
        &conn,
        &input.name,
        &input.category,
        &input.url,
        input.description.as_deref().unwrap_or(""),
    )?)
}

#[tauri::command]
pub async fn validate_feed(url: String) -> Result<FeedValidation, AppError> {
    tauri::async_runtime::spawn_blocking(move || -> Result<FeedValidation, AppError> {
        Ok(feeds::validate_feed_url(&url))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn discover_feeds(
    app: AppHandle,
    category_id: String,
) -> Result<Vec<FeedDiscoverCandidate>, AppError> {
    let cfg = crate::config::load_config()?;
    let app_handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<Vec<FeedDiscoverCandidate>, AppError> {
        let state = app_handle
            .try_state::<DbState>()
            .ok_or_else(|| "数据库未就绪".to_string())?;
        let conn = lock_db(&state)?;
        let cat = db::get_feed_category(&conn, &category_id)?
            .ok_or_else(|| format!("未知分类：{category_id}"))?;
        drop(conn);
        Ok(vocab::discover_rss_feeds(&cfg, &cat.id, &cat.label)?)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn refresh_feeds(app: AppHandle) -> Result<RefreshResult, AppError> {
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

    let cfg = crate::config::load_config()?;
    let app_handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<RefreshResult, AppError> {
        let state = app_handle
            .try_state::<DbState>()
            .ok_or_else(|| "数据库未就绪".to_string())?;
        Ok(feeds::refresh_feeds(&state.0, &cfg, |progress: RefreshProgress| {
            let _ = app_handle.emit("refresh-progress", &progress);
        })?)
    })
    .await
    .map_err(|e| e.to_string())?
}