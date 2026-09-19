//! HTTP transport + SSRF guard for feed pages and article pages.

use crate::error::AppError;
use reqwest::blocking::Client;
use std::net::ToSocketAddrs;
use std::sync::LazyLock;

pub(crate) const HTTP_USER_AGENT: &str = "Shiyan/0.1 (+local; educational)";

/// Shared blocking client so connections pool across feeds/pages instead of
/// being rebuilt per request.
pub(crate) static HTTP: LazyLock<Client> = LazyLock::new(|| {
    Client::builder()
        .user_agent(HTTP_USER_AGENT)
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .expect("build reqwest client")
});

/// True for loopback / private / link-local / CGNAT addresses — the ranges an
/// SSRF-style request should never reach.
fn is_blocked_ip(ip: std::net::IpAddr) -> bool {
    match ip {
        std::net::IpAddr::V4(v4) => {
            let o = v4.octets();
            v4.is_loopback()
                || v4.is_private()
                || v4.is_link_local()
                || v4.is_unspecified()
                || v4.is_broadcast()
                || o[0] == 0
                || (o[0] == 100 && (o[1] & 0xc0) == 64) // 100.64.0.0/10 CGNAT
        }
        std::net::IpAddr::V6(v6) => {
            v6.is_loopback()
                || v6.is_unspecified()
                || (v6.segments()[0] & 0xffc0) == 0xfe80 // fe80::/10 link-local
                || (v6.segments()[0] & 0xfe00) == 0xfc00 // fc00::/7 unique-local
                || v6
                    .to_ipv4_mapped()
                    .map(|v4| is_blocked_ip(std::net::IpAddr::V4(v4)))
                    .unwrap_or(false)
        }
    }
}

/// Parse `url` and refuse anything that is not a plain public http(s) target.
/// Feed subscriptions, discovered feeds and imported article pages all pass
/// through here so a malicious source cannot make the app probe `localhost`,
/// the LAN, or the cloud metadata endpoint.
pub fn ensure_public_http_url(url: &str) -> Result<url::Url, AppError> {
    let parsed = url::Url::parse(url).map_err(|_| AppError::msg("链接格式不正确"))?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err(AppError::msg("仅支持 http/https 链接"));
    }
    let host = parsed
        .host_str()
        .ok_or_else(|| AppError::msg("链接缺少主机名"))?;
    let bare = host.trim_start_matches('[').trim_end_matches(']');
    let lower = bare.to_ascii_lowercase();
    if lower == "localhost" || lower.ends_with(".localhost") || lower.ends_with(".local") {
        return Err(AppError::msg("不支持访问本机或内网地址"));
    }
    if let Ok(ip) = bare.parse::<std::net::IpAddr>() {
        if is_blocked_ip(ip) {
            return Err(AppError::msg("不支持访问本机或内网地址"));
        }
    } else if let Ok(addrs) = (bare, 0).to_socket_addrs() {
        // Hostname resolved to a blocked address (DNS-rebinding best effort).
        if addrs.into_iter().any(|a| is_blocked_ip(a.ip())) {
            return Err(AppError::msg("不支持访问本机或内网地址"));
        }
    }
    Ok(parsed)
}

/// Probe a URL: fetch + parse as RSS/Atom. Does not write to DB.
pub fn validate_feed_url(url: &str) -> FeedValidation {
    let url = url.trim();
    let url = match ensure_public_http_url(url) {
        Ok(_) => url,
        Err(e) => {
            return FeedValidation {
                ok: false,
                title: None,
                entry_count: 0,
                error: Some(e.to_string()),
            }
        }
    };
    match HTTP.get(url).send().and_then(|r| r.error_for_status()) {
        Ok(resp) => match resp.bytes() {
            Ok(bytes) => match feed_rs::parser::parse(&bytes[..]) {
                Ok(parsed) => FeedValidation {
                    ok: true,
                    title: parsed.title.map(|t| t.content),
                    entry_count: parsed.entries.len(),
                    error: None,
                },
                Err(e) => FeedValidation {
                    ok: false,
                    title: None,
                    entry_count: 0,
                    error: Some(format!("不是有效的 RSS/Atom：{e}")),
                },
            },
            Err(e) => FeedValidation {
                ok: false,
                title: None,
                entry_count: 0,
                error: Some(e.to_string()),
            },
        },
        Err(e) => FeedValidation {
            ok: false,
            title: None,
            entry_count: 0,
            error: Some(e.to_string()),
        },
    }
}

#[derive(Debug, Clone, serde::Serialize, ts_rs::TS)]
#[ts(export)]
pub struct FeedValidation {
    pub ok: bool,
    pub title: Option<String>,
    pub entry_count: usize,
    pub error: Option<String>,
}
