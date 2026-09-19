use crate::db::{self, DbState};
use crate::error::AppError;

#[tauri::command]
pub fn list_known_words(state: tauri::State<'_, DbState>) -> Result<Vec<String>, AppError> {
    let conn = state.lock_read()?;
    Ok(db::list_known_words(&conn)?)
}

#[tauri::command]
pub fn add_known_word(state: tauri::State<'_, DbState>, term: String) -> Result<(), AppError> {
    let conn = state.lock_write()?;
    Ok(db::add_known_word(&conn, &term)?)
}

#[tauri::command]
pub fn remove_known_word(state: tauri::State<'_, DbState>, term: String) -> Result<(), AppError> {
    let conn = state.lock_write()?;
    Ok(db::remove_known_word(&conn, &term)?)
}
