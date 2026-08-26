use crate::config;
use crate::db::{self, DbState, VocabItem};
use crate::error::AppError;
use crate::srs::{apply_rating, Rating};
use crate::vocab::{self, AddVocabInput};
use tauri::AppHandle;

#[tauri::command]
pub async fn add_vocab(app: AppHandle, input: AddVocabInput) -> Result<VocabItem, AppError> {
    let cfg = config::load_config()?;
    crate::commands::spawn_db(app, move |state| {
        Ok(vocab::add_or_merge_vocab(state, &cfg, input)?)
    })
    .await
}

#[tauri::command]
pub fn list_vocab(
    state: tauri::State<'_, DbState>,
    status: Option<String>,
) -> Result<Vec<VocabItem>, AppError> {
    let conn = state.lock_read()?;
    Ok(db::list_vocab(&conn, status.as_deref())?)
}

#[tauri::command]
pub fn due_vocab(state: tauri::State<'_, DbState>) -> Result<Vec<VocabItem>, AppError> {
    let conn = state.lock_read()?;
    Ok(db::due_vocab(&conn)?)
}

#[tauri::command]
pub fn review_vocab(
    state: tauri::State<'_, DbState>,
    id: String,
    rating: String,
) -> Result<VocabItem, AppError> {
    let r = Rating::from_str(&rating)?;
    let conn = state.lock_write()?;
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
    let conn = state.lock_write()?;
    Ok(db::set_vocab_status(&conn, &id, &status)?)
}

#[tauri::command]
pub fn delete_vocab(state: tauri::State<'_, DbState>, id: String) -> Result<(), AppError> {
    let conn = state.lock_write()?;
    Ok(db::delete_vocab(&conn, &id)?)
}
