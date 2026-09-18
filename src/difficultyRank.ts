import type { ArticleListItem } from "./api/types";

/**
 * Difficulty fit on top of the backend interest rank. The backend doesn't
 * know the learner's vocabulary, so the frontend nudges the order with the
 * "约认识 N%" estimate:
 * - ~85–98% known = the sweet spot: readable with a few new words.
 * - <80% = word wall, demote.
 * - >99% = nothing to learn, demote slightly.
 */
export function difficultyAdjustment(knownPct: number | null): number {
  if (knownPct === null) return 0;
  if (knownPct < 80) return -0.4;
  if (knownPct > 99) return -0.3;
  if (knownPct >= 85) return 0.3;
  return 0;
}

export function adjustedScore(
  article: ArticleListItem,
  knownPct: number | null,
): number {
  return article.rank_score + difficultyAdjustment(knownPct);
}

/** Re-order a ranked list by difficulty-adjusted score (stable, non-mutating). */
export function applyDifficultyOrder(
  articles: ArticleListItem[],
  knownPctById: Map<string, number | null>,
): ArticleListItem[] {
  return articles
    .map((a) => ({ a, score: adjustedScore(a, knownPctById.get(a.id) ?? null) }))
    .sort((x, y) => y.score - x.score)
    .map((row) => row.a);
}
