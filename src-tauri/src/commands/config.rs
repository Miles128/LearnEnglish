use crate::config::{self, AppConfig};
use crate::error::AppError;

#[tauri::command]
pub fn get_config() -> Result<AppConfig, AppError> {
    config::load_config()
}

#[tauri::command]
pub fn save_config_cmd(cfg: AppConfig) -> Result<(), AppError> {
    config::save_config(&cfg)
}
