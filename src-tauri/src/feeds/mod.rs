//! RSS ingest pipeline for the reading library.
//!
//! Module layout (each concern gets one file):
//! - [`net`] — shared HTTP client, SSRF guard, feed-URL validation
//! - [`filters`] — readability / English-only / blocked-content / paywall gates
//! - [`extract`] — article-page fetch + HTML→text extraction
//! - [`dedup`] — URL canonicalization + cross-source title dedup
//! - [`pipeline`] — the parallel refresh flow (`refresh_feeds`)
//! - [`cleanup`] — one-time audits, retention purges, body repair
//! - [`enrich`] — LLM backfill of summaries and topic tags
//! - [`import`] — import-a-single-article-by-URL path
//!
//! All public items are re-exported here so call sites keep using
//! `crate::feeds::…` unchanged.

pub mod cleanup;
pub mod dedup;
pub mod enrich;
pub mod extract;
pub mod filters;
pub mod import;
pub mod net;
pub mod pipeline;

// The re-exports below form the module's outward facade (`crate::feeds::X`).
// Some are consumed only by tests or sibling submodules, so unused-import
// warnings are expected in non-test builds and silenced.
#[allow(unused_imports)]
pub(crate) use cleanup::{
    audit_rss_bodies_once, clear_stale_paragraph_translations_once, purge_blocked_articles,
    purge_expired_articles, purge_rss_below_word_threshold, repair_missing_paragraphs,
};
#[cfg(test)]
pub(crate) use cleanup::{
    collect_non_english_rss_ids, delete_articles, purge_non_english_articles,
    purge_summary_only_articles,
};
#[allow(unused_imports)]
pub(crate) use dedup::{canonical_article_url, is_near_duplicate_title, title_tokens, TitleIndex};
#[cfg(test)]
pub(crate) use dedup::partition_new_urls;
#[allow(unused_imports)]
pub(crate) use enrich::{
    fill_article_card_zh, fill_missing_card_zh, fill_missing_tags, CARDS_PER_REFRESH,
    TAGS_PER_REFRESH,
};
#[allow(unused_imports)]
pub(crate) use extract::{extract_article_page, fetch_article_page, html_to_text, title_from_html};
#[allow(unused_imports)]
pub(crate) use filters::{
    choose_article_body, is_blocked_content, is_english_article, is_readable_article_body,
    looks_like_link_roundup, looks_like_paywall, looks_like_transcript, looks_truncated,
    rss_trust_chars, TRUST_RSS_FULLTEXT_CHARS,
};
#[cfg(test)]
pub(crate) use filters::is_summary_only_body;
#[allow(unused_imports)]
pub use import::{import_article_from_url, source_from_url};
#[allow(unused_imports)]
pub use net::{ensure_public_http_url, validate_feed_url, FeedValidation};
pub use pipeline::{refresh_feeds, RefreshProgress, RefreshResult};
#[allow(unused_imports)]
pub(crate) use pipeline::select_enabled_feeds;

/// Articles whose body is shorter than this many characters are rejected as
/// RSS-only teasers unless a trusted page fulltext is available.
pub(crate) const MIN_FULLTEXT_CHARS: usize = 400;
/// Articles whose body is shorter than this many words are dropped for RSS
/// sources: a real learning session needs substance, not a blurb.
/// User imports (url/file) are never deleted.
pub(crate) const MIN_ARTICLE_WORDS: usize = 400;

pub fn split_paragraphs(text: &str) -> Vec<String> {
    crate::reflow::reflow(text)
}

#[cfg(test)]
mod tests;
