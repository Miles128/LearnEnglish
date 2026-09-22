import { normalizeKey } from "./wordLevels";

/** Filter known words by a case-insensitive substring query. */
export function filterKnownWords(words: string[], q: string): string[] {
  const s = normalizeKey(q);
  if (!s) return words;
  return words.filter((w) => w.toLowerCase().includes(s));
}

export type KnownToggleDeps = {
  knownTerms: string[];
  markKnown: (term: string) => Promise<void>;
  unmarkKnown: (term: string) => Promise<void>;
  onError: (message: string) => void;
};

/**
 * Mark/unmark-known toggle behind the lookup popover, shared by Home and
 * Reader. Pure factory (no store import) so it stays unit-testable.
 */
export function createKnownToggle(deps: KnownToggleDeps) {
  return async function toggleKnown(term: string): Promise<void> {
    const key = normalizeKey(term);
    try {
      if (deps.knownTerms.includes(key)) await deps.unmarkKnown(key);
      else await deps.markKnown(key);
    } catch (e) {
      deps.onError(String(e));
    }
  };
}
