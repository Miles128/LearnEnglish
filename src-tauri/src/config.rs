use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppConfig {
    pub base_url: String,
    pub api_key: String,
    pub model: String,
    #[serde(default)]
    pub disabled_feeds: Vec<String>,
    /// User CEFR level (A1–C2). Words above this are underlined when reading.
    #[serde(default = "default_cefr_level")]
    pub cefr_level: String,
    /// Known vocabulary band (1000 / 3000 / 5000 / 10000 / 20000).
    /// Words with frequency rank above this are underlined.
    #[serde(default = "default_freq_band")]
    pub freq_band: u32,
    /// Whether the adaptive vocab placement test has been completed.
    #[serde(default)]
    pub vocab_placement_done: bool,
    /// Final continuous ability L from the last placement test.
    #[serde(default)]
    pub vocab_placement_l: Option<f64>,
    /// ISO timestamp of the last placement test.
    #[serde(default)]
    pub vocab_placement_at: Option<String>,
    /// Reader body font preset (serif / palatino / georgia / newyork / songti / sans).
    #[serde(default = "default_reader_font")]
    pub reader_font: String,
    /// Reader body font size in px (16 / 18 / 20 / 22 / 24).
    #[serde(default = "default_reader_font_size")]
    pub reader_font_size: u32,
    /// Reader body line-height (1.5 / 1.65 / 1.75 / 1.9 / 2.1).
    #[serde(default = "default_reader_line_height")]
    pub reader_line_height: f64,
    /// Reader measure preset (narrow / medium / wide / full).
    #[serde(default = "default_reader_line_width")]
    pub reader_line_width: String,
}

fn default_cefr_level() -> String {
    "B1".into()
}

fn default_freq_band() -> u32 {
    3000
}

fn default_reader_font() -> String {
    "serif".into()
}

fn default_reader_font_size() -> u32 {
    18
}

fn default_reader_line_height() -> f64 {
    1.75
}

fn default_reader_line_width() -> String {
    "medium".into()
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            base_url: "https://api.openai.com/v1".into(),
            api_key: String::new(),
            model: "gpt-4o-mini".into(),
            disabled_feeds: vec![],
            cefr_level: default_cefr_level(),
            freq_band: default_freq_band(),
            vocab_placement_done: false,
            vocab_placement_l: None,
            vocab_placement_at: None,
            reader_font: default_reader_font(),
            reader_font_size: default_reader_font_size(),
            reader_line_height: default_reader_line_height(),
            reader_line_width: default_reader_line_width(),
        }
    }
}

pub fn config_path() -> PathBuf {
    if let Ok(p) = std::env::var("LEARNENGLISH_CONFIG") {
        return PathBuf::from(p);
    }
    // Prefer project root when running via `pnpm tauri dev`
    let candidates = [
        PathBuf::from("config.local.json"),
        PathBuf::from("../config.local.json"),
        PathBuf::from("../../config.local.json"),
    ];
    for c in candidates {
        if c.exists() {
            return c;
        }
    }
    // Packaged app fallback: ~/Library/Application Support/com.sihai.learnenglish/
    if let Some(home) = std::env::var_os("HOME") {
        let dir = PathBuf::from(home)
            .join("Library/Application Support/com.sihai.learnenglish");
        let _ = fs::create_dir_all(&dir);
        return dir.join("config.local.json");
    }
    PathBuf::from("config.local.json")
}

pub fn load_config() -> Result<AppConfig, String> {
    let path = config_path();
    if !path.exists() {
        return Ok(AppConfig::default());
    }
    let raw = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    serde_json::from_str(&raw).map_err(|e| e.to_string())
}

pub fn save_config(cfg: &AppConfig) -> Result<(), String> {
    let path = config_path();
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
    }
    let raw = serde_json::to_string_pretty(cfg).map_err(|e| e.to_string())?;
    fs::write(&path, raw).map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn old_config_gets_reader_defaults() {
        let raw = r#"{
            "base_url": "https://api.openai.com/v1",
            "api_key": "x",
            "model": "gpt-4o-mini"
        }"#;
        let cfg: AppConfig = serde_json::from_str(raw).unwrap();
        assert_eq!(cfg.reader_font, "serif");
        assert_eq!(cfg.reader_font_size, 18);
        assert_eq!(cfg.reader_line_height, 1.75);
        assert_eq!(cfg.reader_line_width, "medium");
        assert_eq!(cfg.cefr_level, "B1");
        assert_eq!(cfg.freq_band, 3000);
    }
}
