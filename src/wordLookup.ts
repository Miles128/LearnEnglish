import { toLemma } from "./lemma";
import { lookupWord } from "./wordLevels";

/** What a click/selection resolves to for lookup and translation. */
export type LookupTarget = {
  /** Base form shown in the popover (lemma for single words). */
  term: string;
  /** The raw selection, used for context sentences. */
  source: string;
};

/**
 * ALL-CAPS selections are acronyms / initialisms (NATO, AI, GDP): they keep
 * their case instead of being lowercased and lemma-reduced.
 */
export function isAllCaps(raw: string, minLength = 2): boolean {
  const text = raw.trim().replace(/['’]s$/, "");
  if (text.length < minLength) return false;
  return /^[A-Z][A-Z0-9.\-&/]*$/.test(text);
}

/**
 * Normalize a selection: single words reduce to their base form so `cities`,
 * `running`, `went` all look up as `city` / `run` / `go`; phrases pass through.
 * ALL-CAPS terms are kept verbatim so they translate as acronyms.
 */
export function prepareLookup(raw: string): LookupTarget {
  const source = raw.trim().replace(/\s+/g, " ");
  if (isAllCaps(source)) return { term: source, source };
  const isSingleWord = /^[A-Za-z][A-Za-z'-]*$/.test(source);
  return {
    term: isSingleWord ? toLemma(source) : source,
    source,
  };
}

/** Bundled dictionary gloss for a base form, if present. */
export function bundledGloss(term: string): string | undefined {
  return lookupWord(term)?.zh;
}

/** Session cache for list-page translations (re-selecting a word is free). */
const translationCache = new Map<string, string>();

export function cachedTranslation(term: string): string | undefined {
  return translationCache.get(term.toLowerCase());
}

export function rememberTranslation(term: string, translation: string) {
  if (term && translation) translationCache.set(term.toLowerCase(), translation);
}

/**
 * True when a selection is a short phrase rather than a single word or a
 * whole sentence — the cue for offering "add to phrase library".
 */
export function isPhraseSelection(raw: string, maxWords = 6): boolean {
  const text = raw.trim().replace(/\s+/g, " ");
  if (!text) return false;
  if (/[.!?]$/.test(text)) return false;
  const words = text.split(" ");
  if (words.length < 2 || words.length > maxWords) return false;
  return words.every((w) => /^[A-Za-z][A-Za-z'’-]*$/.test(w));
}
