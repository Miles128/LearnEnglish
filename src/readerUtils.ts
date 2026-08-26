import type { TranslateProgress } from "./api";

export type CategoryRef = { id: string; label: string };

/** Prefer the live feed-category list; fall back to the raw id. */
export function categoryLabel(
  id: string,
  categories: readonly CategoryRef[],
): string {
  return categories.find((c) => c.id === id)?.label ?? id;
}

/** Sentence (paragraph) containing `term`, or the term itself. */
export function findContext(paragraphs: string[], term: string): string {
  const lower = term.toLowerCase();
  const hit = paragraphs.find((p) => p.toLowerCase().includes(lower));
  return hit ?? term;
}

/** Merge one streamed paragraph; ignore the terminal `done` event. */
export function applyTranslateProgress(
  map: Record<string, string>,
  progress: TranslateProgress,
): Record<string, string> {
  if (progress.done || !progress.scope_key) return map;
  return { ...map, [progress.scope_key]: progress.translated_text };
}

export function translateProgressLabel(
  progress: TranslateProgress | null,
): string | null {
  if (!progress || progress.done) return null;
  return `翻译中 ${progress.current}/${progress.total}`;
}
