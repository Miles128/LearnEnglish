use crate::config;
use crate::db::{self, DbState, PhraseItem};
use crate::error::AppError;
use crate::srs::{apply_rating_phrase, Rating};
use crate::vocab::{self, AddPhraseInput};
use tauri::AppHandle;

#[tauri::command]
pub async fn add_phrase(app: AppHandle, input: AddPhraseInput) -> Result<PhraseItem, AppError> {
    let cfg = config::load_config()?;
    crate::commands::spawn_db(app, move |state| {
        Ok(vocab::add_or_merge_phrase(state, &cfg, input)?)
    })
    .await
}

#[tauri::command]
pub fn list_phrases(
    state: tauri::State<'_, DbState>,
    status: Option<String>,
) -> Result<Vec<PhraseItem>, AppError> {
    let conn = state.lock_read()?;
    Ok(db::list_phrases(&conn, status.as_deref())?)
}

#[tauri::command]
pub fn due_phrases(state: tauri::State<'_, DbState>) -> Result<Vec<PhraseItem>, AppError> {
    let conn = state.lock_read()?;
    Ok(db::due_phrases(&conn)?)
}

#[tauri::command]
pub fn review_phrase(
    state: tauri::State<'_, DbState>,
    id: String,
    rating: String,
) -> Result<PhraseItem, AppError> {
    let r = Rating::from_str(&rating)?;
    let conn = state.lock_write()?;
    let mut item = db::get_phrase(&conn, &id)?.ok_or_else(|| "phrase not found".to_string())?;
    apply_rating_phrase(&mut item, r);
    db::update_phrase_review(&conn, &item)?;
    Ok(item)
}

#[tauri::command]
pub fn set_phrase_status(
    state: tauri::State<'_, DbState>,
    id: String,
    status: String,
) -> Result<(), AppError> {
    let conn = state.lock_write()?;
    Ok(db::set_phrase_status(&conn, &id, &status)?)
}

#[tauri::command]
pub fn delete_phrase(state: tauri::State<'_, DbState>, id: String) -> Result<(), AppError> {
    let conn = state.lock_write()?;
    Ok(db::delete_phrase(&conn, &id)?)
}
