use crate::db::VocabItem;
use chrono::{Duration, Utc};

#[derive(Debug, Clone, Copy)]
pub enum Rating {
    Again,
    Hard,
    Easy,
}

impl Rating {
    pub fn from_str(s: &str) -> Result<Self, String> {
        match s {
            "again" | "不认识" => Ok(Self::Again),
            "hard" | "模糊" => Ok(Self::Hard),
            "easy" | "认识" => Ok(Self::Easy),
            _ => Err(format!("unknown rating: {s}")),
        }
    }
}

/// Simplified SRS: again ~10m, hard 1d, easy 1→3→7→14 days.
/// Mastered when consecutive_know >= 3 and interval is at 14-day step.
pub fn apply_rating(item: &mut VocabItem, rating: Rating) {
    item.reps += 1;
    let now = Utc::now();
    match rating {
        Rating::Again => {
            item.consecutive_know = 0;
            item.interval_days = 0.0;
            item.next_review_at = (now + Duration::minutes(10)).to_rfc3339();
        }
        Rating::Hard => {
            // Gentle reminder: schedule tomorrow, but don't wipe the easy streak.
            item.interval_days = 1.0;
            item.next_review_at = (now + Duration::days(1)).to_rfc3339();
        }
        Rating::Easy => {
            item.consecutive_know += 1;
            let next = match item.interval_days {
                x if x < 1.0 => 1.0,
                x if x < 3.0 => 3.0,
                x if x < 7.0 => 7.0,
                _ => 14.0,
            };
            item.interval_days = next;
            item.next_review_at = (now + Duration::days(next as i64)).to_rfc3339();
            if item.consecutive_know >= 3 && (next - 14.0).abs() < f64::EPSILON {
                item.status = "mastered".into();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> VocabItem {
        VocabItem {
            id: "1".into(),
            term: "t".into(),
            definition_zh: "测".into(),
            word_type: "noun".into(),
            collocations: vec![],
            context_sentence: "".into(),
            article_id: None,
            status: "learning".into(),
            interval_days: 0.0,
            reps: 0,
            consecutive_know: 0,
            next_review_at: Utc::now().to_rfc3339(),
            created_at: Utc::now().to_rfc3339(),
        }
    }

    #[test]
    fn easy_progresses_and_masters() {
        let mut item = sample();
        apply_rating(&mut item, Rating::Easy);
        assert_eq!(item.interval_days, 1.0);
        assert_eq!(item.status, "learning");
        apply_rating(&mut item, Rating::Easy);
        assert_eq!(item.interval_days, 3.0);
        apply_rating(&mut item, Rating::Easy);
        assert_eq!(item.interval_days, 7.0);
        assert_eq!(item.status, "learning");
        apply_rating(&mut item, Rating::Easy);
        assert_eq!(item.interval_days, 14.0);
        assert!(item.consecutive_know >= 3);
        assert_eq!(item.status, "mastered");
    }

    #[test]
    fn hard_schedules_tomorrow_without_wiping_streak() {
        let mut item = sample();
        apply_rating(&mut item, Rating::Easy);
        apply_rating(&mut item, Rating::Easy);
        assert_eq!(item.consecutive_know, 2);
        apply_rating(&mut item, Rating::Hard);
        assert_eq!(item.interval_days, 1.0);
        assert_eq!(item.consecutive_know, 2, "hard keeps the easy streak");
        assert_eq!(item.status, "learning");
    }

    #[test]
    fn again_resets_streak() {
        let mut item = sample();
        apply_rating(&mut item, Rating::Easy);
        apply_rating(&mut item, Rating::Again);
        assert_eq!(item.consecutive_know, 0);
        assert_eq!(item.interval_days, 0.0);
    }
}
