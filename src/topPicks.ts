import type { ArticleListItem } from "./api/types";

/**
 * "今日精选": the first `max` ranked articles the learner has not opened yet.
 * The backend already ranks by interest, so picks = unread prefix.
 */
export function pickTopArticles(
  articles: ArticleListItem[],
  max: number = 5,
): ArticleListItem[] {
  return articles.filter((a) => !a.last_opened_at).slice(0, max);
}

/** Ids of top picks, used to keep source boards duplicate-free. */
export function topPickIds(picks: ArticleListItem[]): Set<string> {
  return new Set(picks.map((a) => a.id));
}
