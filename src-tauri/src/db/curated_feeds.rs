//! Curated feed seed data, embedded from `resources/curated_feeds.json` at
//! compile time. Edit the JSON (not this file) to change the built-in list.

use super::FeedSource;

const CURATED_FEEDS_JSON: &str = include_str!("../../resources/curated_feeds.json");

#[derive(serde::Deserialize)]
struct CuratedFeed {
    id: String,
    name: String,
    category: String,
    url: String,
}

/// Classic news + well-known blogs/newsletters + AI-oriented tech.
/// Prefer free/full-text article feeds; no podcasts (show notes only).
pub fn curated_feeds() -> Vec<FeedSource> {
    let feeds: Vec<CuratedFeed> =
        serde_json::from_str(CURATED_FEEDS_JSON).expect("valid resources/curated_feeds.json");
    feeds
        .into_iter()
        .map(|f| FeedSource {
            id: f.id,
            name: f.name,
            category: f.category,
            url: f.url,
            enabled: true,
            origin: "curated".into(),
            description: String::new(),
        })
        .collect()
}
