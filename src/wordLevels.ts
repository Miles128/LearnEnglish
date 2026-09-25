/**
 * Attribution for `src/data/word-levels.json`:
 * CEFR-J Vocabulary Profile 1.5, FrequencyWords (OpenSubtitles 2018),
 * ECDICT first sense. Format: [term, cefr, rank] or [term, cefr, rank, zh]
 *
 * CEFR ordered from easiest to hardest.
 */
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
  loadPromise = import("./data/word-levels.json")
    .then((mod) => {
      ingestRows(mod.default as RawRow[]);
    })
    .catch((err) => {
      loadPromise = null;
      throw err;
    });
  return loadPromise;
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

  for (const c of lemmaCandidates(key)) {
    const hit = lexicon.get(c);
    if (hit) return hit;
  }
  return null;
}

/**
 * Rule-based base-form candidates for a surface form, most likely first.
 * Single implementation shared by lexicon lookup (`lookupWord`,
 * `findLemmaKey`) and the lookup lemma policy (`lemma.ts`): fix rules here
 * once instead of in two places. Kept small and conservative — only
 * structures unambiguous enough to be worth a base form.
 */
export function lemmaCandidates(word: string): string[] {
  const w = word.toLowerCase();
  if (w.length < 3 || w.includes(" ")) return [];
  const out: string[] = [];
  const push = (c: string) => {
    if (c && c !== w && c.length >= 2 && !out.includes(c)) out.push(c);
  };

  // possessives / contractions
  if (w.endsWith("'s")) push(w.slice(0, -2));
  if (w.endsWith("'")) push(w.slice(0, -1));

  // plurals
  if (w.endsWith("ies") && w.length > 3) push(`${w.slice(0, -3)}y`);
  if (w.endsWith("ves")) {
    push(`${w.slice(0, -3)}f`);
    push(`${w.slice(0, -3)}fe`);
  }
  if (w.endsWith("es")) {
    push(w.slice(0, -2));
    if (/(ch|sh|ss|x|z)es$/.test(w)) push(w.slice(0, -2));
  }
  if (w.endsWith("s") && !w.endsWith("ss") && !w.endsWith("us") && !w.endsWith("is")) {
    push(w.slice(0, -1));
  }
  if (w.endsWith("men")) push(`${w.slice(0, -3)}man`);

  // -ing (running → run, making → make)
  if (w.endsWith("ing") && w.length > 4) {
    const stem = w.slice(0, -3);
    if (stem.length >= 2 && stem[stem.length - 1] === stem[stem.length - 2]) {
      push(stem.slice(0, -1)); // doubled consonant
    }
    push(stem);
    push(`${stem}e`);
  }

  // -ed (walked → walk, studied → study, stopped → stop, liked → like)
  if (w.endsWith("ed") && w.length > 3) {
    const stem = w.slice(0, -2);
    if (w.endsWith("ied")) push(`${w.slice(0, -3)}y`);
    if (stem.length >= 2 && stem[stem.length - 1] === stem[stem.length - 2]) {
      push(stem.slice(0, -1));
    }
    push(stem);
    push(`${stem}e`);
  }

  // comparative / superlative (bigger → big, nicer → nice)
  if (w.endsWith("est") && w.length > 4) {
    const stem = w.slice(0, -3);
    if (stem.length >= 2 && stem[stem.length - 1] === stem[stem.length - 2]) {
      push(stem.slice(0, -1));
    }
    push(stem);
    push(`${stem}e`);
  }
  if (w.endsWith("er") && w.length > 3) {
    const stem = w.slice(0, -2);
    if (stem.length >= 2 && stem[stem.length - 1] === stem[stem.length - 2]) {
      push(stem.slice(0, -1));
    }
    push(stem);
    push(`${stem}e`);
  }

  // adverbs
  if (w.endsWith("ly") && w.length > 4) {
    push(w.slice(0, -2));
    if (w.endsWith("ily")) push(`${w.slice(0, -3)}y`);
    push(w.slice(0, -2) + "e");
  }

  return out;
}

/** CEFR steps above the learner's level; 0 when within reach. */
export function cefrStepsAbove(
  entry: WordLevelEntry,
  level: CefrLevel,
): number {
  return Math.max(0, CEFR_RANK[entry.cefr] - CEFR_RANK[level]);
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

/**
 * Super-hard = a tier above `isHardWord`, used to gate the automatic Chinese
 * gloss so only words genuinely out of reach get the extra annotation. A word
 * qualifies when either:
 *   • it is ≥2 CEFR steps above the learner's level (B1 user → C1 or higher), or
 *   • its frequency rank is past 2× the learner's known band (3000 → >6000).
 * Every super-hard word is also a hard word; the reverse does not hold.
 */
export function isSuperHardWord(
  entry: WordLevelEntry,
  prefs: DifficultyPrefs,
): boolean {
  return (
    cefrStepsAbove(entry, prefs.cefrLevel) >= 2 ||
    entry.rank > prefs.freqBand * 2
  );
}

export type AnnotatedSpan =
  | { type: "text"; text: string }
  | {
      type: "token";
      text: string;
      term: string;
      hard: boolean;
      /** A tier above `hard`; drives the automatic Chinese gloss. */
      superHard: boolean;
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
  knownTerms: string[] = [],
): AnnotatedSpan[] {
  const learning = new Set(
    learningTerms.map(normalizeKey).filter((t) => t.length >= 2),
  );
  const known = new Set(
    knownTerms.map(normalizeKey).filter((t) => t.length >= 2),
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
      const knownHit = known.has(phraseHit.key);
      const hard = !knownHit && (entry ? isHardWord(entry, prefs) : false);
      const superHard =
        !knownHit && (entry ? isSuperHardWord(entry, prefs) : false);
      const learningHit = !knownHit && learning.has(phraseHit.key);
      spans.push({
        type: "token",
        text: phraseHit.raw,
        term: phraseHit.key,
        hard,
        superHard,
        learning: learningHit,
        zh: entry?.zh,
      });
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
    const lemmaKey = findLemmaKey(key);
    const knownHit = known.has(key) || known.has(lemmaKey);
    const hard = !knownHit && (entry ? isHardWord(entry, prefs) : false);
    const superHard =
      !knownHit && (entry ? isSuperHardWord(entry, prefs) : false);
    const inLearning =
      !knownHit && (learning.has(key) || learning.has(lemmaKey));

    spans.push({
      type: "token",
      text: raw,
      term: lemmaKey || key,
      hard,
      superHard,
      learning: inLearning,
      zh: entry?.zh,
    });
    i = m.index + raw.length;
  }

  return coalesceText(spans);
}

function findLemmaKey(surface: string): string {
  if (lexicon.has(surface)) return surface;
  for (const c of lemmaCandidates(surface)) {
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
