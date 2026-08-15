mod commands;
mod config;
mod db;
mod error;
mod feeds;
mod import_file;
mod srs;
mod vocab;

#[cfg(test)]
mod db_tests;

use std::sync::Mutex;
use tauri::Manager;

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
            app.manage(db::DbState(Mutex::new(conn)));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::config::get_config,
            commands::config::save_config_cmd,
            commands::articles::list_articles,
            commands::articles::get_article,
            commands::feeds::list_feeds,
            commands::feeds::set_feed_enabled,
            commands::feeds::list_feed_categories,
            commands::feeds::add_feed_category,
            commands::feeds::subscribe_feed,
            commands::feeds::validate_feed,
            commands::feeds::discover_feeds,
            commands::feeds::refresh_feeds,
            commands::articles::translate_missing_titles,
            commands::articles::import_article_url,
            commands::articles::import_article_file,
            commands::articles::get_paragraphs,
            commands::articles::list_paragraph_translations,
            commands::articles::translate_paragraph,
            commands::articles::translate_selection,
            commands::articles::translate_full_article,
            commands::vocab::add_vocab,
            commands::vocab::list_vocab,
            commands::vocab::due_vocab,
            commands::vocab::review_vocab,
            commands::vocab::set_vocab_status,
            commands::vocab::delete_vocab
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}