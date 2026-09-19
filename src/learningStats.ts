import type { LearningStats } from "./api/types";

export type { LearningStats };

/** Compact Home insight: today's opens over the all-time total. */
export function formatLearningInsight(stats: LearningStats): string {
  return `今日 ${stats.opened_today} / 总 ${stats.opened_total}`;
}

/** "Read" = finished (bottom + dwell threshold), not merely opened. */
export function articleIsRead(article: { read_completed?: boolean }): boolean {
  return Boolean(article.read_completed);
}

/** Record once per article id in a hook lifetime; skip missing loads. */
export function shouldRecordOpen(
  alreadyId: string | undefined,
  article: { id: string } | null,
): string | null {
  if (!article) return null;
  if (alreadyId === article.id) return null;
  return article.id;
}
