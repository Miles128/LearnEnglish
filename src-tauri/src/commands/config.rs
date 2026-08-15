use crate::error::AppError;
use crate::config::{self, AppConfig};

#[tauri::command]
pub fn get_config() -> Result<AppConfig, AppError> {
    Ok(config::load_config()?)
}

#[tauri::command]
pub fn save_config_cmd(cfg: AppConfig) -> Result<(), AppError> {
    Ok(config::save_config(&cfg)?)
}