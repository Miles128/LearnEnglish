/**
 * Local article difficulty index.
 *
 * Difficulty = density of words outside the learner's comfort zone, weighted
 * by how far outside they are, plus a light sentence-length correction.
 * Everything runs on the bundled lexicon — no network, no LLM.
 */

import {
  CEFR_LEVELS,
  FREQ_BANDS,
  isHardWord,
  lookupWord,
  type CefrLevel,
  type DifficultyPrefs,
  type FreqBand,
} from "./wordLevels";

export const DIFFICULTY_LEVELS = [
  "easy",
  "normal",
  "hard",
  "harder",
  "hardest",
] as const;
export type DifficultyLevel = (typeof DIFFICULTY_LEVELS)[number];

export const DIFFICULTY_LABELS: Record<DifficultyLevel, string> = {
  easy: "简单",
  normal: "普通",
  hard: "较难",
  harder: "困难",
  hardest: "极难",
};

const CEFR_INDEX: Record<CefrLevel, number> = {
  A1: 0,
  A2: 1,
  B1: 2,
  B2: 3,
  C1: 4,
  C2: 5,
};

const BAND_INDEX: Record<FreqBand, number> = {
  1000: 0,
  3000: 1,
  5000: 2,
  10000: 3,
  20000: 4,
};

/** Bucket edges on the difficulty score (density × sentence factor). */
const LEVEL_EDGES: [number, DifficultyLevel][] = [
  [0.02, "easy"],
  [0.05, "normal"],
  [0.1, "hard"],
  [0.18, "harder"],
];

const WORD_RE = /[A-Za-z][A-Za-z'-]*/g;
const SENTENCE_RE = /[^.!?]+[.!?]*/g;

/** Sample cap: the list computes this for every visible article. */
const MAX_SAMPLE_CHARS = 6000;

export function tokenizeWords(text: string): string[] {
  const out: string[] = [];
  const re = new RegExp(WORD_RE.source, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const w = m[0].toLowerCase();
    if (w.length >= 2) out.push(w);
  }
  return out;
}

/** Smallest band that covers `rank`. */
function bandOf(rank: number): FreqBand {
  for (const band of FREQ_BANDS) {
    if (rank <= band) return band;
  }
  return FREQ_BANDS[FREQ_BANDS.length - 1]!;
}

/**
 * Weight of a word outside the comfort zone:
 * `1 + 0.5·(bands above) + 0.5·(CEFR steps above)`; 0 inside; 0.5 for OOV
 * (names / unlisted words are not evidence of difficulty).
 */
export function wordDifficultyWeight(
  term: string,
  prefs: DifficultyPrefs,
  learning: boolean,
): number {
  if (learning) return 1.5;
  const entry = lookupWord(term);
  if (!entry) return 0.5;
  if (!isHardWord(entry, prefs)) return 0;
  const bandSteps = Math.max(
    0,
    BAND_INDEX[bandOf(entry.rank)] - BAND_INDEX[prefs.freqBand],
  );
  const cefrSteps = Math.max(
    0,
    CEFR_INDEX[entry.cefr] - CEFR_INDEX[prefs.cefrLevel],
  );
  return 1 + 0.5 * bandSteps + 0.5 * cefrSteps;
}

/** Long sentences add a little difficulty — deliberately a low weight. */
export function sentenceFactor(avgSentenceWords: number): number {
  if (avgSentenceWords <= 0) return 1;
  const raw = 1 + 0.15 * ((avgSentenceWords - 18) / 18);
  return Math.max(0.9, Math.min(1.25, raw));
}

export function difficultyFromScore(score: number): DifficultyLevel {
  for (const [edge, level] of LEVEL_EDGES) {
    if (score < edge) return level;
  }
  return "hardest";
}

export type DifficultyResult = {
  level: DifficultyLevel;
  score: number;
  avgSentenceWords: number;
};

/**
 * Difficulty of an article body for this learner. Null when the sample is too
 * small to judge (should be rare — bodies below 400 words are never stored).
 */
export function articleDifficulty(
  rawContent: string,
  learningTerms: string[],
  prefs: DifficultyPrefs,
): DifficultyResult | null {
  const content =
    rawContent.length > MAX_SAMPLE_CHARS
      ? rawContent.slice(0, MAX_SAMPLE_CHARS)
      : rawContent;
  const tokens = tokenizeWords(content);
  if (tokens.length < 40) return null;

  const learning = new Set(
    learningTerms.map((t) => t.trim().toLowerCase()).filter((t) => t.length >= 2),
  );

  let total = 0;
  for (const tok of tokens) {
    total += wordDifficultyWeight(tok, prefs, learning.has(tok));
  }
  const density = total / tokens.length;

  const sentences = content.match(SENTENCE_RE) ?? [];
  const avgSentenceWords =
    sentences.length > 0 ? tokens.length / sentences.length : tokens.length;

  const score = density * sentenceFactor(avgSentenceWords);
  return { level: difficultyFromScore(score), score, avgSentenceWords };
}

export function difficultyLabel(level: DifficultyLevel): string {
  return DIFFICULTY_LABELS[level];
}

/** CSS modifier for the badge color ramp (green → red). */
export function difficultyClassName(level: DifficultyLevel): string {
  return `difficulty-badge d-${level}`;
}

export { CEFR_LEVELS };
