/**
 * Local article difficulty index.
 *
 * Difficulty = density of words outside the learner's comfort zone, weighted
 * by how far outside they are, plus a light sentence-length correction.
 * Everything runs on the bundled lexicon — no network, no LLM.
 */

import {
  FREQ_BANDS,
  lookupWord,
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

const BAND_INDEX: Record<FreqBand, number> = {
  1000: 0,
  3000: 1,
  5000: 2,
  10000: 3,
  20000: 4,
};

/** Default bucket edges on the difficulty score (density × sentence factor). */
export const DEFAULT_EDGES: readonly [number, number, number, number] = [
  0.02, 0.05, 0.1, 0.18,
];
export type DifficultyEdges = readonly [number, number, number, number];

/** Minimum sample before calibration is trusted at all. */
const MIN_CALIBRATION_SAMPLES = 40;
/** How much weight the observed distribution gets vs the default edges. */
const CALIBRATION_BLEND = 0.5;
/** Bucket targets: 15% easy, 25% normal, 30% hard, 20% harder, rest hardest. */
const CALIBRATION_QUANTILES = [0.15, 0.4, 0.7, 0.9] as const;

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo]!;
  const t = pos - lo;
  return sorted[lo]! * (1 - t) + sorted[hi]! * t;
}

/**
 * Calibrate the five bucket edges against the learner's own library so
 * 简单/普通/较难 mean "relative to what you actually read". Blends the
 * observed quantiles with the defaults to stay stable on small samples.
 */
export function calibrateEdges(scores: number[]): DifficultyEdges {
  const sorted = scores.filter((s) => Number.isFinite(s)).sort((a, b) => a - b);
  if (sorted.length < MIN_CALIBRATION_SAMPLES) {
    return DEFAULT_EDGES;
  }
  const observed = CALIBRATION_QUANTILES.map((q) =>
    quantile(sorted, q),
  ) as unknown as DifficultyEdges;
  const blended = observed.map(
    (v, i) => v * CALIBRATION_BLEND + DEFAULT_EDGES[i]! * (1 - CALIBRATION_BLEND),
  ) as unknown as DifficultyEdges;
  // Keep the edges strictly increasing and above zero.
  const out: number[] = [];
  let floor = 0.001;
  for (const edge of blended) {
    const next = Math.max(edge, floor);
    out.push(next);
    floor = next + 0.001;
  }
  return out as unknown as DifficultyEdges;
}

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

/** Learner profile for the local difficulty index: word-frequency size only. */
export type DifficultyPrefs = {
  freqBand: FreqBand;
};

/**
 * Weight of a word outside the comfort zone, by frequency alone:
 * `1 + 0.5·(bands above)`; 0 inside; 0.5 for OOV (names / unlisted words
 * are not evidence of difficulty).
 */
export function wordDifficultyWeight(
  term: string,
  prefs: DifficultyPrefs,
  learning: boolean,
): number {
  if (learning) return 1.5;
  const entry = lookupWord(term);
  if (!entry) return 0.5;
  if (entry.rank <= prefs.freqBand) return 0;
  const bandSteps = Math.max(
    0,
    BAND_INDEX[bandOf(entry.rank)] - BAND_INDEX[prefs.freqBand],
  );
  return 1 + 0.5 * bandSteps;
}

/** Long sentences add a little difficulty — deliberately a low weight. */
export function sentenceFactor(avgSentenceWords: number): number {
  if (avgSentenceWords <= 0) return 1;
  const raw = 1 + 0.15 * ((avgSentenceWords - 18) / 18);
  return Math.max(0.9, Math.min(1.25, raw));
}

export function difficultyFromScore(
  score: number,
  edges: DifficultyEdges = DEFAULT_EDGES,
): DifficultyLevel {
  if (score < edges[0]) return "easy";
  if (score < edges[1]) return "normal";
  if (score < edges[2]) return "hard";
  if (score < edges[3]) return "harder";
  return "hardest";
}

export type DifficultyResult = {
  /** Raw score; bucket it with `difficultyFromScore` + calibrated edges. */
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
  knownTerms: string[] = [],
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
  const known = new Set(
    knownTerms.map((t) => t.trim().toLowerCase()).filter((t) => t.length >= 2),
  );

  let total = 0;
  for (const tok of tokens) {
    if (known.has(tok)) continue; // known words add no difficulty
    total += wordDifficultyWeight(tok, prefs, learning.has(tok));
  }
  const density = total / tokens.length;

  const sentences = content.match(SENTENCE_RE) ?? [];
  const avgSentenceWords =
    sentences.length > 0 ? tokens.length / sentences.length : tokens.length;

  const score = density * sentenceFactor(avgSentenceWords);
  return { score, avgSentenceWords };
}

export function difficultyLabel(level: DifficultyLevel): string {
  return DIFFICULTY_LABELS[level];
}

/** CSS modifier for the badge color ramp (green → red). */
export function difficultyClassName(level: DifficultyLevel): string {
  return `difficulty-badge d-${level}`;
}

