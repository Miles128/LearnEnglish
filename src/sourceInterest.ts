export const RECENT_OPEN_MS = 7 * 24 * 60 * 60 * 1000;

export function sourceInterestScore(
  articles: { open_count?: number; last_opened_at?: string | null }[],
  nowMs: number,
  recentMs: number = RECENT_OPEN_MS,
): number {
  let score = 0;
  for (const a of articles) {
    const n = a.open_count ?? 0;
    if (n <= 0) continue;
    score += n;
    const t = a.last_opened_at ? Date.parse(a.last_opened_at) : Number.NaN;
    if (!Number.isNaN(t) && nowMs - t <= recentMs) score += n;
  }
  return score;
}

export function sortSectionsByInterest<
  T extends {
    articles: { open_count?: number; last_opened_at?: string | null }[];
  },
>(sections: T[], nowMs: number): T[] {
  return sections
    .map((section, index) => ({
      section,
      index,
      score: sourceInterestScore(section.articles, nowMs),
    }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((row) => row.section);
}

export function groupBySource<
  T extends { source: string; category: string },
>(articles: T[]): { source: string; category: string; articles: T[] }[] {
  const map = new Map<string, { source: string; category: string; articles: T[] }>();
  for (const a of articles) {
    const key = a.source || "其他";
    let sec = map.get(key);
    if (!sec) {
      sec = { source: key, category: a.category, articles: [] };
      map.set(key, sec);
    }
    sec.articles.push(a);
  }
  return Array.from(map.values());
}
