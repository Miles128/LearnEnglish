/** CEFR ordered from easiest to hardest. */
export const CEFR_LEVELS = ["A1", "A2", "B1", "B2", "C1", "C2"] as const;
export type CefrLevel = (typeof CEFR_LEVELS)[number];

export const FREQ_BANDS = [1000, 3000, 5000, 10000, 20000] as const;
export type FreqBand = (typeof FREQ_BANDS)[number];

export type WordLevelEntry = {
  cefr: CefrLevel;
  rank: number;
  /** Optional bundled Chinese gloss (may be empty). */
  zh?: string;
};

export type DifficultyPrefs = {
  cefrLevel: CefrLevel;
  freqBand: FreqBand;
};

const CEFR_RANK: Record<CefrLevel, number> = {
  A1: 1,
  A2: 2,
  B1: 3,
  B2: 4,
  C1: 5,
  C2: 6,
};

type RawRow = [string, string, number] | [string, string, number, string];

const lexicon = new Map<string, WordLevelEntry>();
const phraseList: string[] = [];
let loadPromise: Promise<void> | null = null;
let loaded = false;

function ingestRows(rawLevels: RawRow[]) {
  lexicon.clear();
  phraseList.length = 0;
  for (const row of rawLevels) {
    const [term, cefr, rank, zh] = row;
    if (!CEFR_RANK[cefr as CefrLevel]) continue;
    const key = normalizeKey(term);
    if (!key) continue;
    lexicon.set(key, {
      cefr: cefr as CefrLevel,
      rank,
      zh: zh?.trim() || undefined,
    });
    if (key.includes(" ")) phraseList.push(key);
  }
  phraseList.sort((a, b) => b.length - a.length);
  loaded = true;
}

/** Lazy-load bundled CEFR + frequency lexicon (large JSON). */
export function ensureLexiconLoaded(): Promise<void> {
  if (loaded) return Promise.resolve();
  if (loadPromise) return loadPromise;
  loadPromise = import("./data/word-levels.json").then((mod) => {
    ingestRows(mod.default as RawRow[]);
  });
  return loadPromise;
}

export function isLexiconLoaded(): boolean {
  return loaded;
}

export function normalizeKey(term: string): string {
  return term
    .trim()
    .toLowerCase()
    .replace(/[’']/g, "'")
    .replace(/\s+/g, " ");
}

export function isCefrLevel(v: string): v is CefrLevel {
  return (CEFR_LEVELS as readonly string[]).includes(v);
}

export function isFreqBand(v: number): v is FreqBand {
  return (FREQ_BANDS as readonly number[]).includes(v);
}

/** Light inflection fallbacks for lookup. */
export function lookupWord(term: string): WordLevelEntry | null {
  const key = normalizeKey(term);
  if (!key) return null;
  const direct = lexicon.get(key);
  if (direct) return direct;

  const candidates = inflectionCandidates(key);
  for (const c of candidates) {
    const hit = lexicon.get(c);
    if (hit) return hit;
  }
  return null;
}

function inflectionCandidates(key: string): string[] {
  if (key.includes(" ")) return [];
  const out: string[] = [];
  const push = (s: string) => {
    if (s && s !== key && s.length >= 2) out.push(s);
  };

  if (key.endsWith("'s")) push(key.slice(0, -2));
  if (key.endsWith("s") && !key.endsWith("ss")) push(key.slice(0, -1));
  if (key.endsWith("es")) push(key.slice(0, -2));
  if (key.endsWith("ies")) push(`${key.slice(0, -3)}y`);
  if (key.endsWith("ing")) {
    push(key.slice(0, -3));
    push(`${key.slice(0, -3)}e`);
    if (key.length > 5 && key[key.length - 4] === key[key.length - 5]) {
      push(key.slice(0, -4));
    }
  }
  if (key.endsWith("ed")) {
    push(key.slice(0, -2));
    push(`${key.slice(0, -1)}`); // e.g. liked -> like via -d? handled by -e
    push(`${key.slice(0, -2)}e`);
    if (key.length > 4 && key[key.length - 3] === key[key.length - 4]) {
      push(key.slice(0, -3));
    }
  }
  if (key.endsWith("er")) push(key.slice(0, -2));
  if (key.endsWith("est")) push(key.slice(0, -3));
  if (key.endsWith("ly")) push(key.slice(0, -2));
  return out;
}

/**
 * Hard if CEFR above user level OR frequency rank above user's known-band.
 * Words absent from the lexicon are not auto-underlined.
 */
export function isHardWord(
  entry: WordLevelEntry,
  prefs: DifficultyPrefs,
): boolean {
  const cefrHard = CEFR_RANK[entry.cefr] > CEFR_RANK[prefs.cefrLevel];
  const freqHard = entry.rank > prefs.freqBand;
  return cefrHard || freqHard;
}

export type AnnotatedSpan =
  | { type: "text"; text: string }
  | {
      type: "token";
      text: string;
      term: string;
      hard: boolean;
      learning: boolean;
      zh?: string;
    };

const TOKEN_RE = /[A-Za-z][A-Za-z'-]*|[^\sA-Za-z]+|\s+/g;

/**
 * Annotate plain text: longest-phrase match from lexicon, then single tokens.
 * Learning vocab terms also marked (even if not hard).
 */
export function annotateText(
  text: string,
  prefs: DifficultyPrefs,
  learningTerms: string[],
): AnnotatedSpan[] {
  const learning = new Set(
    learningTerms.map(normalizeKey).filter((t) => t.length >= 2),
  );
  // Prefer longer learning phrases too
  const learningPhrases = [...learning]
    .filter((t) => t.includes(" "))
    .sort((a, b) => b.length - a.length);

  const spans: AnnotatedSpan[] = [];
  let i = 0;
  const lower = text.toLowerCase();

  while (i < text.length) {
    const phraseHit =
      matchPhraseAt(text, lower, i, phraseList) ??
      matchPhraseAt(text, lower, i, learningPhrases);

    if (phraseHit) {
      const entry = lookupWord(phraseHit.key);
      const hard = entry ? isHardWord(entry, prefs) : false;
      const learningHit = learning.has(phraseHit.key);
      if (hard || learningHit) {
        spans.push({
          type: "token",
          text: phraseHit.raw,
          term: phraseHit.key,
          hard,
          learning: learningHit,
          zh: entry?.zh,
        });
      } else {
        spans.push({ type: "text", text: phraseHit.raw });
      }
      i = phraseHit.end;
      continue;
    }

    TOKEN_RE.lastIndex = i;
    const m = TOKEN_RE.exec(text);
    if (!m || m.index !== i) {
      spans.push({ type: "text", text: text[i]! });
      i += 1;
      continue;
    }

    const raw = m[0];
    const isWord = /^[A-Za-z]/.test(raw);
    if (!isWord) {
      spans.push({ type: "text", text: raw });
      i = m.index + raw.length;
      continue;
    }

    const key = normalizeKey(raw);
    const entry = lookupWord(key);
    const hard = entry ? isHardWord(entry, prefs) : false;
    const lemmaKey = findLemmaKey(key);
    const inLearning = learning.has(key) || learning.has(lemmaKey);

    if (hard || inLearning) {
      spans.push({
        type: "token",
        text: raw,
        term: lemmaKey || key,
        hard,
        learning: inLearning,
        zh: entry?.zh,
      });
    } else {
      spans.push({ type: "text", text: raw });
    }
    i = m.index + raw.length;
  }

  return coalesceText(spans);
}

function findLemmaKey(surface: string): string {
  if (lexicon.has(surface)) return surface;
  for (const c of inflectionCandidates(surface)) {
    if (lexicon.has(c)) return c;
  }
  return surface;
}

function matchPhraseAt(
  text: string,
  lower: string,
  start: number,
  phrases: string[],
): { key: string; raw: string; end: number } | null {
  for (const phrase of phrases) {
    const n = phrase.length;
    if (start + n > text.length) continue;
    const slice = lower.slice(start, start + n);
    if (slice !== phrase) continue;
    // boundary: start ok; end should not continue a word char
    const before = start === 0 ? " " : text[start - 1]!;
    const after = start + n >= text.length ? " " : text[start + n]!;
    if (/[A-Za-z]/.test(before) || /[A-Za-z]/.test(after)) continue;
    return { key: phrase, raw: text.slice(start, start + n), end: start + n };
  }
  return null;
}

function coalesceText(spans: AnnotatedSpan[]): AnnotatedSpan[] {
  const out: AnnotatedSpan[] = [];
  for (const s of spans) {
    const last = out[out.length - 1];
    if (s.type === "text" && last?.type === "text") {
      last.text += s.text;
    } else {
      out.push(s);
    }
  }
  return out;
}

export function defaultDifficultyPrefs(): DifficultyPrefs {
  return { cefrLevel: "B1", freqBand: 3000 };
}

export type LexiconTerm = {
  term: string;
  cefr: CefrLevel;
  rank: number;
  zh?: string;
};

/** Snapshot of loaded lexicon (empty if not yet loaded). */
export function listLexiconTerms(): LexiconTerm[] {
  const out: LexiconTerm[] = [];
  for (const [term, e] of lexicon) {
    out.push({ term, cefr: e.cefr, rank: e.rank, zh: e.zh });
  }
  return out;
}
