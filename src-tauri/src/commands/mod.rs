//! Tauri command handlers, grouped by domain.
//!
//! Each module owns the `#[tauri::command]` functions for one domain and stays
//! free of business logic — it serializes the request, drives the domain module,
//! and maps errors out. `lib.rs` registers the full handler list.

pub mod articles;
pub mod config;
pub mod feeds;
pub mod vocab;