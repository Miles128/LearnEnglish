/** Estimate how familiar an article feels given freq band + learning vocab. */

import { lookupWord } from "./wordLevels";
import type { FreqBand } from "./wordLevels";

const WORD_RE = /[A-Za-z][A-Za-z'-]*/g;

/**
 * Cap on how much of an article is sampled for the estimate. The list page
 * computes this synchronously for every visible article; full bodies can be
 * 30k+ chars, so sampling keeps the main-thread cost bounded with negligible
 * accuracy loss for the displayed percentage.
 */
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

/**
 * Tokens with rank <= freqBand (or OOV) count as known, except learning terms.
 * Returns 0–100, or null if the article has too few tokens.
 * Requires lexicon loaded for accurate band checks.
 */
export function estimateKnownPercent(
  rawContent: string,
  learningTerms: string[],
  freqBand: FreqBand,
): number | null {
  const content =
    rawContent.length > MAX_SAMPLE_CHARS
      ? rawContent.slice(0, MAX_SAMPLE_CHARS)
      : rawContent;
  const tokens = tokenizeWords(content);
  if (tokens.length < 40) return null;

  const learning = learningTerms
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length >= 2);

  const single = new Set(learning.filter((t) => !/\s/.test(t)));
  const phrases = learning
    .filter((t) => /\s/.test(t))
    .sort((a, b) => b.length - a.length);

  const lowerContent = content.toLowerCase();
  const learningWordHits = new Set<string>();

  for (const phrase of phrases) {
    if (lowerContent.includes(phrase)) {
      for (const w of tokenizeWords(phrase)) {
        learningWordHits.add(w);
      }
    }
  }

  let known = 0;
  for (const tok of tokens) {
    if (single.has(tok) || learningWordHits.has(tok)) {
      continue; // learning = not yet known
    }
    const entry = lookupWord(tok);
    if (!entry || entry.rank <= freqBand) {
      known += 1;
    }
  }

  const pct = Math.round((100 * known) / tokens.length);
  return Math.max(0, Math.min(100, pct));
}

export function formatKnownPercent(pct: number | null): string | null {
  if (pct == null) return null;
  return `约认识 ${pct}%`;
}
