import { describe, expect, it } from "vitest";
import {
  L0,
  L_MAX,
  L_MIN,
  buildChoices,
  describePlacementResult,
  mapLToBand,
  pickNext,
  shouldForcePlacement,
  shouldHideAppNav,
  updateL,
  type PoolItem,
} from "./engine";

const pool: PoolItem[] = [
  { term: "cat", rank: 800, zh: "猫" },
  { term: "dog", rank: 900, zh: "狗" },
  { term: "bird", rank: 1200, zh: "鸟" },
  { term: "tree", rank: 1500, zh: "树" },
  { term: "ubiquitous", rank: 9000, zh: "无处不在的" },
];

describe("shouldForcePlacement", () => {
  it("forces placement when neither done nor skipped", () => {
    expect(shouldForcePlacement({})).toBe(true);
  });

  it("skips when already done", () => {
    expect(shouldForcePlacement({ vocab_placement_done: true })).toBe(false);
  });

  it("skips when the user skipped", () => {
    expect(shouldForcePlacement({ vocab_placement_skipped: true })).toBe(false);
  });
});

describe("shouldHideAppNav", () => {
  it("hides other routes only when placement is forced and config loaded", () => {
    expect(
      shouldHideAppNav({
        ready: true,
        loadError: null,
        forcePlacement: true,
      }),
    ).toBe(true);
    expect(
      shouldHideAppNav({
        ready: true,
        loadError: "boom",
        forcePlacement: true,
      }),
    ).toBe(false);
    expect(
      shouldHideAppNav({
        ready: true,
        loadError: null,
        forcePlacement: false,
      }),
    ).toBe(false);
  });
});

describe("describePlacementResult", () => {
  it("does not claim the band was saved when persist failed", () => {
    expect(
      describePlacementResult({
        saved: false,
        shownL: 4200,
        freqBand: 3000,
        cefrLevel: "B1",
      }).summary,
    ).toContain("设置未写入");
    expect(
      describePlacementResult({
        saved: true,
        shownL: 4200,
        freqBand: 3000,
        cefrLevel: "B1",
      }).summary,
    ).toContain("已设为 3k / B1");
  });
});

describe("updateL", () => {
  it("raises L on a correct answer", () => {
    expect(updateL(L0, 3000, true, 1)).toBeGreaterThan(L0);
  });

  it("lowers L on an incorrect answer", () => {
    expect(updateL(L0, 3000, false, 1)).toBeLessThan(L0);
  });

  it("clamps to L_MIN / L_MAX", () => {
    expect(updateL(L_MIN, 400, false, 50)).toBe(L_MIN);
    expect(updateL(L_MAX, 25000, true, 1)).toBe(L_MAX);
  });
});

describe("mapLToBand", () => {
  it("maps a low L to A2 / 1000", () => {
    expect(mapLToBand(800)).toEqual({ freqBand: 1000, cefrLevel: "A2" });
  });

  it("maps a high L to C2 / 20000", () => {
    expect(mapLToBand(30000)).toEqual({ freqBand: 20000, cefrLevel: "C2" });
  });
});

describe("pickNext", () => {
  const rng = () => 0;

  it("returns null when the pool is exhausted", () => {
    const used = new Set(pool.map((p) => p.term));
    expect(pickNext(pool, used, L0, rng)).toBeNull();
  });

  it("picks from unused items near L", () => {
    const next = pickNext(pool, new Set(), 900, rng);
    expect(next).not.toBeNull();
    expect(pool.map((p) => p.term)).toContain(next!.term);
  });
});

describe("buildChoices", () => {
  const rng = () => 0;

  it("returns four options and a matching correctIndex", () => {
    const item = pool[0]!;
    const { options, correctIndex } = buildChoices(item, pool, rng);
    expect(options).toHaveLength(4);
    expect(options[correctIndex]).toBe(item.zh);
  });
});
