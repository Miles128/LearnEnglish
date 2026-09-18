mod commands;
mod config;
mod db;
mod error;
mod feeds;
mod import_file;
mod rank;
mod srs;
mod translate;
mod vocab;

#[cfg(test)]
mod db_tests;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            let state = db::DbState::open(db::db_path(dir))?;
            {
                let mut cfg = config::load_config()?;
                if !cfg.disabled_feeds.is_empty() {
                    let conn = state.lock_write()?;
                    db::apply_legacy_disabled_feeds(&conn, &cfg.disabled_feeds)?;
                    drop(conn);
                    cfg.disabled_feeds.clear();
                    config::save_config(&cfg)?;
                }
            }
            app.manage(state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::config::get_config,
            commands::config::save_config_cmd,
            commands::articles::list_articles,
            commands::articles::list_articles_ranked,
            commands::articles::list_library,
            commands::articles::list_article_sources,
            commands::articles::get_article_view,
            commands::articles::mark_article_opened,
            commands::articles::mark_article_progress,
            commands::articles::set_article_liked,
            commands::articles::get_learning_stats,
            commands::feeds::list_feeds,
            commands::feeds::set_feed_enabled,
            commands::feeds::list_feed_categories,
            commands::feeds::add_feed_category,
            commands::feeds::subscribe_feed,
            commands::feeds::validate_feed,
            commands::feeds::discover_feeds,
            commands::feeds::refresh_feeds,
            commands::articles::fill_missing_card_zh,
            commands::articles::fill_missing_tags,
            commands::articles::import_article_url,
            commands::articles::import_article_file,
            commands::articles::translate_paragraph,
            commands::articles::translate_selection,
            commands::articles::translate_plain_text,
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