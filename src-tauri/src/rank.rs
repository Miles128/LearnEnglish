//! Interest-based article ranking for the home list.
//!
//! Deterministic, explainable scoring — no ML runtime required:
//! freshness × affinity + explicit signals (liked / read / dwell) + a
//! bounded exploration jitter so unseen articles still surface.

use crate::db::ArticleListItem;
use chrono::{DateTime, Utc};
use std::collections::HashMap;
use std::hash::{Hash, Hasher};

/// Aggregated open counts by source / category.
#[derive(Debug, Default, Clone)]
pub struct Affinity {
    pub source_opens: HashMap<String, i64>,
    pub category_opens: HashMap<String, i64>,
}

impl Affinity {
    pub fn from_maps(
        source_opens: HashMap<String, i64>,
        category_opens: HashMap<String, i64>,
    ) -> Self {
        Self {
            source_opens,
            category_opens,
        }
    }
}

/// Log-scaled affinity in [0, 1]; 10 opens saturate.
pub fn affinity_score(opens: i64) -> f64 {
    if opens <= 0 {
        0.0
    } else {
        ((opens + 1) as f64).ln() / 10f64.ln()
    }
}

/// Exponential freshness decay: 1.0 today, ~0.24 at 30 days, floor 0.05.
pub fn freshness(age_days: f64) -> f64 {
    (-age_days.max(0.0) / 21.0).exp().max(0.05)
}

/// Body-length fit: very short and very long articles are worse reads;
/// ~300–3000 words is the sweet spot.
pub fn word_fit(word_count: i64) -> f64 {
    match word_count {
        0 => 0.0,                    // unknown, no opinion
        wc if wc < 150 => -0.6,      // likely stub/teaser that slipped through
        wc if wc <= 3000 => 0.4,     // comfortable single-sitting read
        wc if wc <= 6000 => 0.1,
        _ => -0.3,                   // heavy commitment
    }
}

/// Deterministic pseudo-random jitter in [-0.3, 0.3], re-seeded daily, so
/// unseen articles get exploration slots without shuffling on every render.
pub fn exploration_jitter(article_id: &str, day_key: i64) -> f64 {
    use std::collections::hash_map::DefaultHasher;
    let mut hasher = DefaultHasher::new();
    article_id.hash(&mut hasher);
    day_key.hash(&mut hasher);
    let hash = hasher.finish();
    (hash % 1000) as f64 / 999.0 * 0.6 - 0.3
}

/// Age in days, preferring `published_at` then `fetched_at`; unparseable/missing → 0 (now).
pub fn article_age_days(published_at: Option<&str>, fetched_at: &str, now: DateTime<Utc>) -> f64 {
    let parsed = published_at
        .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
        .or_else(|| DateTime::parse_from_rfc3339(fetched_at).ok());
    match parsed {
        Some(t) => (now - t.with_timezone(&Utc)).num_seconds() as f64 / 86_400.0,
        None => 0.0,
    }
}

/// Dwell-time signals (ms of visible, focused reading).
/// Long dwell = real engagement even if not finished; a sub-30s bounce on an
/// opened article is a weak negative.
pub fn dwell_adjustment(dwell_ms: i64, read_completed: bool) -> f64 {
    if dwell_ms >= 300_000 {
        if read_completed {
            0.8 // deep engaged read to the end
        } else {
            0.6 // long dwell, unfinished
        }
    } else if dwell_ms >= 30_000 {
        0.2
    } else if dwell_ms > 0 && !read_completed {
        -0.15 // bounced quickly
    } else {
        0.0
    }
}

pub fn article_rank_score(
    article: &ArticleListItem,
    affinity: &Affinity,
    now: DateTime<Utc>,
    day_key: i64,
) -> f64 {
    let age = article_age_days(article.published_at.as_deref(), &article.fetched_at, now);
    let fresh = freshness(age);
    let mut score = fresh;
    score += 0.6 * affinity_score(*affinity.source_opens.get(&article.source).unwrap_or(&0)) * fresh;
    score += 0.4
        * affinity_score(
            *affinity
                .category_opens
                .get(&article.category)
                .unwrap_or(&0),
        )
        * fresh;
    if article.liked {
        score += 2.5;
    }
    score += word_fit(article.word_count);
    if article.open_count == 0 {
        score += exploration_jitter(&article.id, day_key);
    } else {
        if article.read_completed {
            score -= 0.6;
        } else {
            score -= 0.25;
        }
        score += dwell_adjustment(article.dwell_ms, article.read_completed);
    }
    score
}

/// Score + sort a window of list items in place (descending score),
/// stamping `rank_score` for the frontend to pass through.
pub fn rank_articles(
    mut items: Vec<ArticleListItem>,
    affinity: &Affinity,
    now: DateTime<Utc>,
    day_key: i64,
) -> Vec<ArticleListItem> {
    for item in items.iter_mut() {
        item.rank_score = article_rank_score(item, affinity, now, day_key);
    }
    items.sort_by(|a, b| {
        b.rank_score
            .partial_cmp(&a.rank_score)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    items
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::ArticleListItem;

    fn item(id: &str) -> ArticleListItem {
        ArticleListItem {
            id: id.into(),
            url: format!("https://example.com/{id}"),
            title: id.into(),
            title_zh: String::new(),
            source: "Test".into(),
            category: "tech".into(),
            published_at: None,
            excerpt: String::new(),
            fetched_at: "2020-01-01T00:00:00Z".into(),
            origin: "rss".into(),
            summary_zh: String::new(),
            last_opened_at: None,
            open_count: 0,
            word_count: 800,
            rank_score: 0.0,
            dwell_ms: 0,
            read_completed: false,
            liked: false,
        }
    }

    #[test]
    fn freshness_decays_with_age() {
        assert!((freshness(0.0) - 1.0).abs() < 1e-9);
        assert!(freshness(7.0) < freshness(1.0));
        assert!(freshness(400.0) >= 0.05, "never decays to zero");
    }

    #[test]
    fn affinity_saturates_and_handles_zero() {
        assert_eq!(affinity_score(0), 0.0);
        assert!(affinity_score(3) > affinity_score(1));
        assert!(affinity_score(9) >= 1.0);
        assert!(affinity_score(100) >= 1.0);
    }

    #[test]
    fn liked_and_completed_dominate() {
        let now = Utc::now();
        let affinity = Affinity::default();
        let base = item("a");
        let liked = {
            let mut i = item("b");
            i.liked = true;
            i
        };
        let completed = {
            let mut i = item("c");
            i.open_count = 1;
            i.read_completed = true;
            i
        };
        assert!(
            article_rank_score(&liked, &affinity, now, 0)
                > article_rank_score(&base, &affinity, now, 0),
            "liked beats a plain article"
        );
        assert!(
            article_rank_score(&completed, &affinity, now, 0)
                < article_rank_score(&base, &affinity, now, 0),
            "already finished articles sink"
        );
    }

    #[test]
    fn word_fit_penalizes_stubs_and_marathons() {
        assert!(word_fit(80) < 0.0);
        assert!(word_fit(1200) > word_fit(9000));
        assert!(word_fit(800) > word_fit(100));
        assert_eq!(word_fit(0), 0.0);
    }

    #[test]
    fn jitter_bounded_and_day_seeded() {
        let j1 = exploration_jitter("abc", 20_000);
        let j1_again = exploration_jitter("abc", 20_000);
        assert!((j1 - j1_again).abs() < f64::EPSILON, "same day is stable");
        assert!((-0.3..=0.3).contains(&j1));
        // Varies across days for at least a sample of ids.
        let differs = (0..20)
            .any(|d| exploration_jitter("abc", d) != exploration_jitter("abc", d + 1));
        assert!(differs, "jitter should re-seed across days");
    }

    #[test]
    fn dwell_signals_engagement() {
        assert!((dwell_adjustment(0, false)).abs() < f64::EPSILON);
        assert_eq!(dwell_adjustment(10_000, false), -0.15, "quick bounce");
        assert_eq!(dwell_adjustment(60_000, false), 0.2, "read a minute");
        assert_eq!(dwell_adjustment(400_000, false), 0.6, "long dwell");
        assert_eq!(
            dwell_adjustment(400_000, true),
            0.8,
            "long dwell read to the end"
        );
    }

    #[test]
    fn ranking_is_descending_and_stamps_scores() {
        let now = Utc::now();
        let affinity = Affinity::default();
        let mut fresh = item("fresh");
        fresh.fetched_at = now.to_rfc3339();
        let mut old = item("old");
        old.fetched_at = (now - chrono::Duration::days(120)).to_rfc3339();
        old.open_count = 2;
        old.read_completed = true;

        let ranked = rank_articles(vec![old, fresh], &affinity, now, 1);
        assert_eq!(ranked[0].id, "fresh");
        assert!(ranked[0].rank_score > ranked[1].rank_score);
        assert!(ranked[0].rank_score != 0.0, "score is stamped for the UI");
    }

    #[test]
    fn affinity_boosts_familiar_sources() {
        let now = Utc::now();
        let mut affinity = Affinity::default();
        affinity.source_opens.insert("Test".into(), 50);
        let mut a = item("fam");
        a.fetched_at = now.to_rfc3339();
        let mut b = item("other");
        b.fetched_at = now.to_rfc3339();
        b.source = "Other".into();
        let score_fam = article_rank_score(&a, &affinity, now, 1);
        let score_other = article_rank_score(&b, &affinity, now, 1);
        assert!(score_fam > score_other);
        // Identical except source → gap comes purely from affinity × freshness.
        assert!((score_fam - score_other) > 0.5);
    }
}
