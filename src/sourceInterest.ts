/** Group articles into per-source sections, preserving first appearance
 * order — the backend hands the list over already interest-ranked. */
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
