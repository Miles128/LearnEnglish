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
        if (detail) details.set(detail.word.toLowerCase(), detail);
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
  const key = term.trim().toLowerCase();
  if (!key) return null;
  return details.get(key) ?? null;
}

/** Base form from the dictionary if present (falls back to the term). */
export function detailLemma(term: string): string | null {
  return lookupDetail(term)?.lemma || null;
}
