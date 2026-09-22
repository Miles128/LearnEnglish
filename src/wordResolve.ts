import { toLemma } from "./lemma";
import { lookupWord, normalizeKey } from "./wordLevels";

// 划词解析域：选区归一（lookup）+ 内置词典详情（details）。
// 由 useWordPopover / SelectionPopover / Home / Reader 消费。

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

/**
 * Session cache for list-page translations (re-selecting a word is free).
 * Bounded LRU: re-selecting refreshes recency, the oldest entry is evicted
 * past the cap so a long session cannot grow it without bound.
 */
const translationCache = new Map<string, string>();
export const TRANSLATION_CACHE_CAP = 200;

export function cachedTranslation(term: string): string | undefined {
  const key = normalizeKey(term);
  const hit = translationCache.get(key);
  if (hit !== undefined) {
    // Refresh recency: Map iterates in insertion order.
    translationCache.delete(key);
    translationCache.set(key, hit);
  }
  return hit;
}

export function rememberTranslation(term: string, translation: string) {
  if (!term || !translation) return;
  const key = normalizeKey(term);
  if (!key) return;
  if (translationCache.has(key)) translationCache.delete(key);
  translationCache.set(key, translation);
  while (translationCache.size > TRANSLATION_CACHE_CAP) {
    const oldest = translationCache.keys().next();
    if (oldest.done) break;
    translationCache.delete(oldest.value);
  }
}

/** Visible for tests. */
export function translationCacheSize(): number {
  return translationCache.size;
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

/**
 * Lazy access to the bundled rich word details (multi-sense Chinese,
 * phonetics, frequency ranks, word forms, Tatoeba examples).
 *
 * Built by `node scripts/build-dict.mjs`; see src/data/word-details.SOURCES.md
 * for ECDICT (MIT) / Tatoeba (CC BY) attribution.
 */

export type WordExample = { en: string; zh: string };

export type WordDetail = {
  word: string;
  /** Chinese senses, most common first. */
  senses: string[];
  phonetic: string;
  pos: string;
  collins: number;
  oxford: number;
  rank: number;
  /** Base form from the dictionary, when known. */
  lemma: string;
  examples: WordExample[];
};

type RawRow = [
  string, // word
  string, // senses joined by \n
  string, // phonetic
  string, // pos
  number, // collins
  number, // oxford
  number, // rank
  string, // lemma
  ...string[],
];

/** Decode one compact row; null when the row carries nothing useful. */
export function decodeDetail(row: unknown): WordDetail | null {
  if (!Array.isArray(row) || row.length < 8) return null;
  const [
    word,
    senses,
    phonetic,
    pos,
    collins,
    oxford,
    rank,
    lemma,
    ...examples
  ] = row as RawRow;
  if (typeof word !== "string" || word.length === 0) return null;

  const parsedSenses = String(senses ?? "")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);

  const parsedExamples: WordExample[] = [];
  for (let i = 0; i + 1 < examples.length; i += 2) {
    const en = String(examples[i] ?? "").trim();
    const zh = String(examples[i + 1] ?? "").trim();
    if (en) parsedExamples.push({ en, zh });
  }

  if (parsedSenses.length === 0 && parsedExamples.length === 0) return null;

  return {
    word,
    senses: parsedSenses,
    phonetic: String(phonetic ?? ""),
    pos: String(pos ?? ""),
    collins: Number(collins) || 0,
    oxford: Number(oxford) || 0,
    rank: Number(rank) || 0,
    lemma: String(lemma ?? ""),
    examples: parsedExamples,
  };
}

const details = new Map<string, WordDetail>();
let loading: Promise<void> | null = null;

export function detailsLoaded(): boolean {
  return details.size > 0;
}

/** Load the details chunk once (lazy — only paid on the first word lookup). */
export function ensureDetailsLoaded(): Promise<void> {
  if (loading) return loading;
  loading = import("./data/word-details.json")
    .then((mod) => {
      for (const row of mod.default as unknown[]) {
        const detail = decodeDetail(row);
        if (detail) details.set(normalizeKey(detail.word), detail);
      }
    })
    .catch((err) => {
      loading = null;
      throw err;
    });
  return loading;
}

/** Best detail for a term; accepts inflected forms via the raw key. */
export function lookupDetail(term: string): WordDetail | null {
  const key = normalizeKey(term);
  if (!key) return null;
  return details.get(key) ?? null;
}
