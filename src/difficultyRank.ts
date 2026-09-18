import type { ArticleListItem } from "./api/types";
import type { DifficultyLevel } from "./difficulty";

/**
 * Difficulty fit on top of the backend interest rank. The sweet spot is
 * "普通/较难": readable with a few new words. Trivially easy pieces teach
 * nothing; word walls are demoted hard.
 */
export function difficultyAdjustment(level: DifficultyLevel | null): number {
  switch (level) {
    case "easy":
      return -0.3;
    case "normal":
      return 0.3;
    case "hard":
      return 0.2;
    case "harder":
      return -0.2;
    case "hardest":
      return -0.5;
    default:
      return 0;
  }
}

export function adjustedScore(
  article: ArticleListItem,
  level: DifficultyLevel | null,
): number {
  return article.rank_score + difficultyAdjustment(level);
}

/** Re-order a ranked list by difficulty-adjusted score (stable, non-mutating). */
export function applyDifficultyOrder(
  articles: ArticleListItem[],
  difficultyById: Map<string, DifficultyLevel | null>,
): ArticleListItem[] {
  return articles
    .map((a) => ({
      a,
      score: adjustedScore(a, difficultyById.get(a.id) ?? null),
    }))
    .sort((x, y) => y.score - x.score)
    .map((row) => row.a);
}
