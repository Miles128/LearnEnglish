/** Filter known words by a case-insensitive substring query. */
export function filterKnownWords(words: string[], q: string): string[] {
  const s = q.trim().toLowerCase();
  if (!s) return words;
  return words.filter((w) => w.toLowerCase().includes(s));
}
