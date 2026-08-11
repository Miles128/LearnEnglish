import { listLexiconTerms } from "../wordLevels";
import type { PoolItem } from "./engine";

const STOP = new Set([
  "a",
  "an",
  "the",
  "of",
  "to",
  "and",
  "or",
  "in",
  "on",
  "at",
  "is",
  "are",
  "be",
  "am",
  "was",
  "were",
  "been",
  "i",
  "you",
  "he",
  "she",
  "it",
  "we",
  "they",
  "my",
  "your",
  "his",
  "her",
  "its",
  "our",
  "their",
  "this",
  "that",
  "these",
  "those",
  "as",
  "by",
  "for",
  "with",
  "from",
  "not",
  "no",
  "yes",
  "do",
  "does",
  "did",
  "have",
  "has",
  "had",
]);

/** Build placement pool from loaded lexicon (must call ensureLexiconLoaded first). */
export function buildPlacementPool(): PoolItem[] {
  const out: PoolItem[] = [];
  for (const row of listLexiconTerms()) {
    if (row.term.includes(" ")) continue;
    if (STOP.has(row.term)) continue;
    if (row.term.length < 2) continue;
    const zh = row.zh?.trim();
    if (!zh) continue;
    if (row.rank < 1) continue;
    out.push({ term: row.term, rank: row.rank, zh });
  }
  return out;
}
