import type { TranslateProgress } from "./api";

export type CategoryRef = { id: string; label: string };

/** Prefer the live feed-category list; fall back to the raw id. */
export function categoryLabel(
  id: string,
  categories: readonly CategoryRef[],
): string {
  return categories.find((c) => c.id === id)?.label ?? id;
}

/** A short reading-window around `term`: sentence-bounded when possible,
 * hard-clipped to ~`max` chars otherwise. Examples stay scannable. */
export function clipContext(sentence: string, max: number = 140): string {
  const s = sentence.replace(/\s+/g, " ").trim();
  if (s.length <= max) return s;
  const slice = s.slice(0, max);
  // Cut at the last sentence end inside the window instead of mid-word.
  const cut = Math.max(
    slice.lastIndexOf(". "),
    slice.lastIndexOf("! "),
    slice.lastIndexOf("? "),
  );
  return (cut > max * 0.5 ? slice.slice(0, cut + 1) : slice.trimEnd()) + "…";
}

/** Short context window containing `term`, or the term itself. */
export function findContext(paragraphs: string[], term: string): string {
  const lower = term.toLowerCase();
  const hit = paragraphs.find((p) => p.toLowerCase().includes(lower));
  if (!hit) return term;
  const at = hit.toLowerCase().indexOf(lower);
  if (at < 0) return clipContext(hit);
  const start = Math.max(0, at - 60);
  const end = Math.min(hit.length, at + term.length + 60);
  const window = hit.slice(start, end);
  return (
    (start > 0 ? "…" : "") +
    clipContext(window, 140) +
    (end < hit.length ? "" : "")
  );
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
