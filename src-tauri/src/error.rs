use serde::{Serialize, Serializer};

/// Unified application error, surfaced to the frontend as its display string.
#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("{0}")]
    Msg(String),
    #[error("数据库错误：{0}")]
    Db(#[from] rusqlite::Error),
    #[error("网络请求失败：{0}")]
    Reqwest(#[from] reqwest::Error),
    #[error("链接格式不正确：{0}")]
    Url(#[from] url::ParseError),
    #[error("IO 错误：{0}")]
    Io(#[from] std::io::Error),
    #[error("数据源状态被占用，请稍后重试")]
    Locked,
}

impl Serialize for AppError {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

impl From<String> for AppError {
    fn from(s: String) -> Self {
        AppError::Msg(s)
    }
}

impl From<&str> for AppError {
    fn from(s: &str) -> Self {
        AppError::Msg(s.to_string())
    }
}

/// Acquire the shared DB connection, mapping a poisoned lock to `AppError::Locked`.
pub fn lock_db(
    state: &crate::db::DbState,
) -> Result<std::sync::MutexGuard<'_, rusqlite::Connection>, AppError> {
    state.0.lock().map_err(|_| AppError::Locked)
}