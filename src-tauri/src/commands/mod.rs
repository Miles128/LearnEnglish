//! Tauri command handlers, grouped by domain.
//!
//! Each module owns the `#[tauri::command]` functions for one domain and stays
//! free of business logic — it serializes the request, drives the domain module,
//! and maps errors out. `lib.rs` registers the full handler list.

pub mod articles;
pub mod config;
pub mod feeds;
pub mod phrases;
pub mod vocab;

use crate::db::DbState;
use crate::error::AppError;
use tauri::{AppHandle, Manager};

/// Run blocking DB/network work off the UI thread, with `DbState` already resolved.
pub async fn spawn_db<T, F>(app: AppHandle, f: F) -> Result<T, AppError>
where
    T: Send + 'static,
    F: FnOnce(&DbState) -> Result<T, AppError> + Send + 'static,
{
    crate::error::flatten_blocking(
        tauri::async_runtime::spawn_blocking(move || {
            let state = app
                .try_state::<DbState>()
                .ok_or_else(|| AppError::from("数据库未就绪"))?;
            f(&state)
        })
        .await,
    )
}

/// Same pool, no database.
pub async fn spawn_blocking_err<T, F>(f: F) -> Result<T, AppError>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, AppError> + Send + 'static,
{
    crate::error::flatten_blocking(tauri::async_runtime::spawn_blocking(f).await)
}
