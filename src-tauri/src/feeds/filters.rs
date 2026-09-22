//! Content gates: readability, English-only, blocked content, paywall,
//! and the RSS-vs-page body decision.

use super::MIN_FULLTEXT_CHARS;
use std::sync::LazyLock;

/// RSS bodies at or above this length are treated as full-text feeds (no page required).
/// Shorter bodies are teasers/summaries — page fetch must succeed or the entry is skipped.
pub(crate) const TRUST_RSS_FULLTEXT_CHARS: usize = 2000;

static RE_TAG_STRIP: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"<[^>]+>").unwrap());
static RE_FOOTNOTE_DEF: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"(?m)^\[\d+\]:\s+\S+\s*$").unwrap());
static RE_LIST_LINK_LINE: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"(?m)^\s*(?:[-*]|\d+\.)\s+\[").unwrap());
static RE_KEYWORD_TAIL: LazyLock<regex::Regex> = LazyLock::new(|| {
    regex::Regex::new(r"(?is)(?:Keywords for this article|Filed under:|^\s*Tags:).*$").unwrap()
});
/// Titles that mark a link roundup / daily digest rather than an article.
/// Only fires on multi-word roundup patterns (never a bare "daily"/"links"),
/// so articles *about* those words are never falsely blocked.
static RE_ROUNDUP_TITLE: LazyLock<regex::Regex> = LazyLock::new(|| {
    regex::Regex::new(r"(?i)\b(roundup|weekly review|weekly links|daily digest|daily briefing|link roundup|link dump)\b").unwrap()
});
/// Titles that mark a podcast / interview transcript.
static RE_TRANSCRIPT_TITLE: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"(?i)\b(transcript|podcast|episode)\b").unwrap());
/// Timestamps like 12:34 or 1:02:03 — transcripts are dense with them.
static RE_TIMESTAMP: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"\b\d{1,2}:\d{2}(?::\d{2})?\b").unwrap());
static RE_BARE_URL: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"https?://").unwrap());

/// Bodies ending in these markers were cut off — a teaser or a truncated
/// extract, never the whole story.
const TRUNCATION_TAIL_MARKERS: &[&str] = &[
    "continue reading",
    "read more",
    "read the rest",
    "read the full",
    "view the full",
    "full story at",
    "[…]",
    "…]",
];

/// True when the tail of a body looks cut off (feed teasers / truncated extracts).
pub(crate) fn looks_truncated(text: &str) -> bool {
    let char_count = text.chars().count();
    let skip = char_count.saturating_sub(100);
    let tail: String = text.chars().skip(skip).collect();
    let lower = tail.to_ascii_lowercase();
    TRUNCATION_TAIL_MARKERS.iter().any(|m| lower.contains(m))
}

/// Per-feed trust bar for RSS bodies, adapted by the feed's observed
/// full-text ratio from previous refreshes.
/// - `>= 0.7` (mostly full-text feeds): lower the bar, page fetches rarely pay off.
/// - `<= 0.2` (teaser-only feeds): raise the bar; short RSS bodies are junk.
/// - otherwise (or unknown, -1): the default bar.
pub(crate) fn rss_trust_chars(fulltext_ratio: f64) -> usize {
    if fulltext_ratio >= 0.7 {
        1200
    } else if (0.0..=0.2).contains(&fulltext_ratio) {
        3200
    } else {
        TRUST_RSS_FULLTEXT_CHARS
    }
}

/// Nav chrome, keyword teasers, or link lists — not a readable article.
pub(crate) fn is_readable_article_body(text: &str) -> bool {
    if looks_like_page_chrome(text) || is_link_or_nav_dump(text) {
        return false;
    }
    prose_char_count(text) >= MIN_FULLTEXT_CHARS
}

fn looks_like_page_chrome(text: &str) -> bool {
    let head: String = text.chars().take(480).collect();
    let lower = head.to_ascii_lowercase();
    lower.contains("skip to main content")
        || lower.contains("skip to content")
        || lower.contains("open navigation menu")
        || lower.contains("googletagmanager.com")
}

fn is_link_or_nav_dump(text: &str) -> bool {
    let without_notes = RE_FOOTNOTE_DEF.replace_all(text, "");
    let lines: Vec<&str> = without_notes
        .lines()
        .filter(|line| !line.trim().is_empty())
        .collect();
    if lines.len() < 8 {
        return false;
    }
    let link_lines = lines
        .iter()
        .filter(|line| RE_LIST_LINK_LINE.is_match(line))
        .count();
    (link_lines as f64) / (lines.len() as f64) >= 0.5
}

/// Bare links per 1000 words — pure link dumps score very high.
fn bare_link_density(text: &str) -> f64 {
    let words = text.split_whitespace().count().max(1);
    RE_BARE_URL.find_iter(text).count() as f64 / words as f64 * 1000.0
}

/// Link roundups / dailies: a title that says so, or a pure link dump.
pub(crate) fn looks_like_link_roundup(title: &str, text: &str) -> bool {
    RE_ROUNDUP_TITLE.is_match(title) || bare_link_density(text) > 80.0
}

/// Podcast / interview transcripts: titled as such, or timestamp-dense.
pub(crate) fn looks_like_transcript(title: &str, text: &str) -> bool {
    RE_TRANSCRIPT_TITLE.is_match(title) || RE_TIMESTAMP.find_iter(text).count() >= 20
}

/// Content we do not ingest: link roundups and podcast transcripts.
pub(crate) fn is_blocked_content(title: &str, text: &str) -> bool {
    looks_like_link_roundup(title, text) || looks_like_transcript(title, text)
}

fn prose_char_count(text: &str) -> usize {
    let mut s = RE_KEYWORD_TAIL.replace_all(text, "").into_owned();
    s = RE_FOOTNOTE_DEF.replace_all(&s, "").into_owned();
    s = RE_TAG_STRIP.replace_all(&s, " ").into_owned();
    s.split_whitespace().map(|w| w.chars().count()).sum()
}

pub(crate) fn looks_like_paywall(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    const MARKERS: &[&str] = &[
        "subscribe to continue",
        "subscription required",
        "create a free account to read",
        "sign in to read",
        "already a subscriber",
        "metered paywall",
        "for subscribers only",
    ];
    MARKERS.iter().any(|m| lower.contains(m))
}

/// Keep English-only articles for learning. Prefer feed/entry language tags;
/// fall back to a Latin-vs-other-script heuristic when tags are missing.
pub(crate) fn is_english_article(language: Option<&str>, title: &str, content: &str) -> bool {
    if let Some(tag) = language {
        if !is_english_lang_tag(tag) {
            return false;
        }
    }
    looks_like_english(title, content)
}

pub(crate) fn is_english_lang_tag(tag: &str) -> bool {
    let t = tag.trim().to_ascii_lowercase();
    t == "en" || t.starts_with("en-") || t.starts_with("en_")
}

fn looks_like_english(title: &str, content: &str) -> bool {
    let sample: String = title
        .chars()
        .chain(std::iter::once(' '))
        .chain(content.chars().take(1200))
        .collect();

    let mut letters = 0usize;
    let mut latin = 0usize;
    let mut non_latin = 0usize;

    for ch in sample.chars() {
        if !ch.is_alphabetic() {
            continue;
        }
        letters += 1;
        if ch.is_ascii_alphabetic() {
            latin += 1;
        } else {
            non_latin += 1;
        }
    }

    // Too little signal — keep (length filter already applied).
    if letters < 40 {
        return true;
    }

    // Obvious non-English scripts (CJK, Cyrillic, Arabic, etc.).
    if (non_latin as f64) / (letters as f64) > 0.12 {
        return false;
    }

    (latin as f64) / (letters as f64) >= 0.85
}

/// Decide final article body from RSS text and an optional page extract.
///
/// - Long, readable RSS (≥ [`TRUST_RSS_FULLTEXT_CHARS`]): trust as full-text.
/// - Otherwise only accept a page extract that is real prose (not a teaser,
///   nav/tag wall, or link dump). Never keep chrome just because it is long.
pub(crate) fn choose_article_body(rss_text: &str, page_text: Option<&str>) -> Option<String> {
    if rss_text.chars().count() >= TRUST_RSS_FULLTEXT_CHARS
        && is_readable_article_body(rss_text)
        && !looks_truncated(rss_text)
    {
        return Some(rss_text.to_string());
    }
    match page_text {
        Some(page) if is_readable_article_body(page) && !looks_truncated(page) => {
            Some(page.to_string())
        }
        _ => None,
    }
}

/// True when stored body would be rejected as RSS-only teaser (no trusted page fulltext).
#[cfg(test)]
pub(crate) fn is_summary_only_body(content: &str) -> bool {
    choose_article_body(content, None).is_none()
}
