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
 * Normalize a selection: single words reduce to their base form so `cities`,
 * `running`, `went` all look up as `city` / `run` / `go`; phrases pass through.
 */
export function prepareLookup(raw: string): LookupTarget {
  const source = raw.trim().replace(/\s+/g, " ");
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
