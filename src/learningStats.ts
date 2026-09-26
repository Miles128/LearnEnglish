import type { LearningStats } from "./api/types";

export type { LearningStats };

/** Compact Home insight: today's opens, 7-day opens, and this week's new vocab. */
export function formatLearningInsight(stats: LearningStats): string {
  const parts = [`今日 ${stats.opened_today}`, `本周 ${stats.opened_7d}`, `总 ${stats.opened_total}`];
  if (stats.vocab_created_7d > 0) parts.push(`本周新词 ${stats.vocab_created_7d}`);
  return parts.join(" · ");
}

/** Whether an article counts as read for learning stats. */
export function articleIsRead(article: { read_completed?: number | boolean }): boolean {
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
