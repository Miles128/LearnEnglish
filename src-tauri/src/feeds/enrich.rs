//! LLM enrichment: backfill translated cards (summary_zh) and topic tags.

use crate::config::AppConfig;
use crate::db::{self, DbState};
use crate::error::AppError;
use crate::vocab;

pub fn fill_missing_card_zh(
    db: &DbState,
    cfg: &AppConfig,
    limit: usize,
    mut on_progress: impl FnMut(usize, usize),
) -> Result<usize, AppError> {
    let missing = {
        let conn = db.lock_read()?;
        db::articles_missing_card_zh(&conn, limit)?
    };
    if missing.is_empty() {
        on_progress(0, 0);
        return Ok(0);
    }

    let total = missing.len();
    let mut done = 0usize;
    let mut last_err: Option<String> = None;
    on_progress(done, total);

    for chunk in missing.chunks(16) {
        let cards: Vec<vocab::ArticleCardIn> = chunk
            .iter()
            .map(|a| vocab::card_from_article(&a.title, &a.content_text))
            .collect();
        let translated = match vocab::translate_article_cards(cfg, &cards) {
            Ok(rows) => rows,
            Err(e) => {
                last_err = Some(format!(
                    "简介（第 {}–{} 条）：{e}",
                    done + 1,
                    done + cards.len()
                ));
                continue;
            }
        };
        {
            let conn = db.lock_write()?;
            for (article, card) in chunk.iter().zip(translated.into_iter()) {
                let mut wrote = false;
                if article.summary_zh.is_empty() && !card.summary_zh.is_empty() {
                    db::set_article_summary_zh(&conn, &article.id, &card.summary_zh)?;
                    wrote = true;
                }
                if !card.tags.is_empty() {
                    db::set_article_tags(&conn, &article.id, &card.tags)?;
                }
                if wrote {
                    done += 1;
                }
            }
        }
        on_progress(done, total);
    }
    if done == 0 {
        if let Some(e) = last_err {
            return Err(AppError::msg(e));
        }
    }
    Ok(done)
}

/// Backfill topic tags for articles that lack them (existing library +
/// anything whose card was translated before tags existed).
pub fn fill_missing_tags(
    db: &DbState,
    cfg: &AppConfig,
    limit: usize,
    mut on_progress: impl FnMut(usize, usize),
) -> Result<usize, AppError> {
    let missing = {
        let conn = db.lock_read()?;
        db::articles_missing_tags(&conn, limit)?
    };
    if missing.is_empty() {
        on_progress(0, 0);
        return Ok(0);
    }

    let total = missing.len();
    let mut done = 0usize;
    let mut last_err: Option<String> = None;
    on_progress(done, total);

    for chunk in missing.chunks(16) {
        let cards: Vec<vocab::ArticleCardIn> = chunk
            .iter()
            .map(|a| vocab::card_from_article(&a.title, &a.content_text))
            .collect();
        let tagged = match vocab::assign_article_tags(cfg, &cards) {
            Ok(rows) => rows,
            Err(e) => {
                last_err = Some(format!("主题标签（第 {}–{} 条）：{e}", done + 1, done + cards.len()));
                continue;
            }
        };
        {
            let conn = db.lock_write()?;
            for (article, tags) in chunk.iter().zip(tagged.into_iter()) {
                if tags.is_empty() {
                    continue;
                }
                db::set_article_tags(&conn, &article.id, &tags)?;
                done += 1;
            }
        }
        on_progress(done, total);
    }
    if done == 0 {
        if let Some(e) = last_err {
            return Err(AppError::msg(e));
        }
    }
    Ok(done)
}

/// Translate + persist the summary card for a single article (used right
/// after a URL import).
pub fn fill_article_card_zh(
    db: &DbState,
    cfg: &AppConfig,
    article: &mut crate::db::Article,
) -> Result<(), AppError> {
    if !article.summary_zh.is_empty() {
        return Ok(());
    }
    if cfg.api_key.trim().is_empty() {
        return Ok(());
    }
    let cards = [vocab::card_from_article(&article.title, &article.content_text)];
    let translated = vocab::translate_article_cards(cfg, &cards)?;
    let Some(card) = translated.into_iter().next() else {
        return Ok(());
    };
    let conn = db.lock_write()?;
    if article.summary_zh.is_empty() && !card.summary_zh.is_empty() {
        db::set_article_summary_zh(&conn, &article.id, &card.summary_zh)?;
        article.summary_zh = card.summary_zh;
    }
    Ok(())
}
