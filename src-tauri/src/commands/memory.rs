use crate::config;
use crate::db::{self, DbState, MemoryItem};
use crate::error::AppError;
use crate::srs::{apply_rating, Rating};
use crate::vocab::{self, AddMemoryInput};
use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;

#[tauri::command]
pub async fn add_memory(app: AppHandle, input: AddMemoryInput) -> Result<MemoryItem, AppError> {
    let cfg = config::load_config()?;
    crate::commands::spawn_db(app, move |state| {
        Ok(vocab::add_or_merge_memory(state, &cfg, input)?)
    })
    .await
}

#[tauri::command]
pub fn list_memory(
    state: tauri::State<'_, DbState>,
    kind: Option<String>,
    status: Option<String>,
) -> Result<Vec<MemoryItem>, AppError> {
    let conn = state.lock_read()?;
    Ok(db::list_memory(&conn, kind.as_deref(), status.as_deref())?)
}

#[tauri::command]
pub fn due_memory(
    state: tauri::State<'_, DbState>,
    kind: Option<String>,
) -> Result<Vec<MemoryItem>, AppError> {
    let conn = state.lock_read()?;
    Ok(db::due_memory(&conn, kind.as_deref())?)
}

#[tauri::command]
pub fn review_memory(
    state: tauri::State<'_, DbState>,
    id: String,
    rating: String,
) -> Result<MemoryItem, AppError> {
    let r = Rating::from_str(&rating)?;
    let conn = state.lock_write()?;
    let mut item =
        db::get_memory(&conn, &id)?.ok_or_else(|| "memory item not found".to_string())?;
    apply_rating(&mut item, r);
    db::update_memory_review(&conn, &item)?;
    Ok(item)
}

#[tauri::command]
pub fn set_memory_status(
    state: tauri::State<'_, DbState>,
    id: String,
    status: String,
) -> Result<(), AppError> {
    let conn = state.lock_write()?;
    Ok(db::set_memory_status(&conn, &id, &status)?)
}

#[tauri::command]
pub fn delete_memory(state: tauri::State<'_, DbState>, id: String) -> Result<(), AppError> {
    let conn = state.lock_write()?;
    Ok(db::delete_memory(&conn, &id)?)
}

/// Export the whole vocab library (words + phrases, all statuses) as a CSV
/// file chosen via the system save dialog. Returns the written path, or
/// `None` when the user cancels the dialog.
#[tauri::command]
pub async fn export_memory_csv(
    app: tauri::AppHandle,
    state: tauri::State<'_, DbState>,
) -> Result<Option<String>, AppError> {
    // Build the payload under a short-lived read lock, then release before
    // showing the modal dialog.
    let csv = {
        let conn = state.lock_read()?;
        db::export_memory_csv(&conn)?
    };
    let file_name = format!(
        "shiyan-vocab-{}.csv",
        chrono::Local::now().format("%Y%m%d-%H%M")
    );
    let picked = tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .add_filter("CSV", &["csv"])
            .set_file_name(file_name)
            .blocking_save_file()
    })
    .await
    .map_err(|e| AppError::msg(e.to_string()))?;
    let Some(picked) = picked else {
        return Ok(None);
    };
    let path = picked
        .into_path()
        .map_err(|e| AppError::msg(e.to_string()))?;
    std::fs::write(&path, csv)?;
    Ok(Some(path.to_string_lossy().into_owned()))
}
