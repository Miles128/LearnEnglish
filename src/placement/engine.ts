import type { CefrLevel, FreqBand } from "../wordLevels";

export const PLACEMENT_TOTAL = 50;
export const L_MIN = 400;
export const L_MAX = 25000;
export const L0 = 3000;

export type PoolItem = {
  term: string;
  rank: number;
  zh: string;
};

export function clampL(L: number): number {
  return Math.max(L_MIN, Math.min(L_MAX, L));
}

/** n is 1-based question index (1..50). */
export function updateL(
  L: number,
  d: number,
  correct: boolean,
  n: number,
): number {
  const decay = 1 - (n - 1) / PLACEMENT_TOTAL;
  const alpha = 0.18 * decay;
  const beta = 0.22 * decay;
  if (correct) {
    return clampL(L * (1 + alpha) * 0.7 + d * 1.15 * 0.3);
  }
  return clampL(L * (1 - beta) * 0.7 + d * 0.75 * 0.3);
}

const BANDS = [1000, 3000, 5000, 10000, 20000] as const satisfies readonly FreqBand[];
const CEFRS: CefrLevel[] = ["A2", "B1", "B2", "C1", "C2"];

export function mapLToBand(L: number): {
  freqBand: FreqBand;
  cefrLevel: CefrLevel;
} {
  for (let i = 0; i < BANDS.length - 1; i++) {
    const mid = Math.sqrt(BANDS[i]! * BANDS[i + 1]!);
    if (L < mid) {
      return { freqBand: BANDS[i]!, cefrLevel: CEFRS[i]! };
    }
  }
  return { freqBand: BANDS[BANDS.length - 1]!, cefrLevel: CEFRS[CEFRS.length - 1]! };
}

function normalizeZh(zh: string): string {
  return zh.trim().replace(/\s+/g, "").toLowerCase();
}

export function pickNext(
  pool: PoolItem[],
  used: Set<string>,
  L: number,
  rng: () => number = Math.random,
): PoolItem | null {
  const available = pool.filter((p) => !used.has(p.term));
  if (available.length === 0) return null;
  const jitter = 0.85 + rng() * 0.3;
  const t = Math.max(1, L * jitter);
  const logT = Math.log(t);
  const ranked = available
    .map((p) => ({
      p,
      dist: Math.abs(Math.log(Math.max(1, p.rank)) - logT),
    }))
    .sort((a, b) => a.dist - b.dist);
  const k = Math.min(25, ranked.length);
  const idx = Math.min(k - 1, Math.floor(rng() * k));
  return ranked[idx]!.p;
}

export function buildChoices(
  item: PoolItem,
  pool: PoolItem[],
  rng: () => number = Math.random,
): { options: string[]; correctIndex: number } {
  const correctKey = normalizeZh(item.zh);
  const distractors: string[] = [];
  const seen = new Set<string>([correctKey]);

  const near = [...pool]
    .filter((p) => p.term !== item.term)
    .sort((a, b) => Math.abs(a.rank - item.rank) - Math.abs(b.rank - item.rank));

  for (const p of near) {
    const key = normalizeZh(p.zh);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    distractors.push(p.zh.trim());
    if (distractors.length >= 3) break;
  }

  // Fallback: any remaining glosses if neighborhood exhausted
  if (distractors.length < 3) {
    for (const p of pool) {
      if (p.term === item.term) continue;
      const key = normalizeZh(p.zh);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      distractors.push(p.zh.trim());
      if (distractors.length >= 3) break;
    }
  }

  const options = [item.zh.trim(), ...distractors.slice(0, 3)];
  while (options.length < 4) {
    options.push(`（干扰 ${options.length}）`);
  }

  // Fisher–Yates shuffle
  for (let i = options.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = options[i]!;
    options[i] = options[j]!;
    options[j] = tmp;
  }

  const correctIndex = options.findIndex((o) => normalizeZh(o) === correctKey);
  return {
    options,
    correctIndex: correctIndex >= 0 ? correctIndex : 0,
  };
}
