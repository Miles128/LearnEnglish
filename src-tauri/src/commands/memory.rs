use crate::config;
use crate::db::{self, DbState, MemoryItem};
use crate::error::AppError;
use crate::srs::{apply_rating, Rating};
use crate::vocab::{self, AddMemoryInput};
use tauri::AppHandle;

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
