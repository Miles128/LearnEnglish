export type LearningStats = {
  opened_total: number;
  opened_7d: number;
  top_source: string | null;
  top_category: string | null;
  vocab_created_7d: number;
  vocab_learning: number;
};

export function formatLearningInsight(stats: LearningStats): string {
  if (stats.opened_total === 0) {
    return "读过的文章会记在这里，用来看你常读什么。";
  }
  const parts = [
    `本周读 ${stats.opened_7d} 篇`,
    `累计 ${stats.opened_total} 篇`,
  ];
  if (stats.top_source) {
    parts.push(`常读 ${stats.top_source}`);
  }
  if (stats.vocab_created_7d > 0) {
    parts.push(`本周新词 ${stats.vocab_created_7d}`);
  }
  return parts.join(" · ");
}

export function articleIsRead(article: { last_opened_at?: string | null }): boolean {
  return Boolean(article.last_opened_at);
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
