import { describe, expect, it } from "vitest";
import type { ArticleListItem } from "./api/types";
import {
  adjustedScore,
  applyDifficultyOrder,
  difficultyAdjustment,
} from "./difficultyRank";

function item(id: string, rankScore: number): ArticleListItem {
  return {
    id,
    url: `https://example.com/${id}`,
    title: id,
    title_zh: "",
    source: "S",
    category: "tech",
    published_at: null,
    excerpt: "",
    fetched_at: "2020-01-01T00:00:00Z",
    origin: "rss",
    summary_zh: "",
    last_opened_at: null,
    open_count: 0,
    word_count: 800,
    rank_score: rankScore,
    dwell_ms: 0,
    read_completed: false,
    liked: false,
  };
}

describe("difficultyAdjustment", () => {
  it("rewards the sweet spot and demotes extremes", () => {
    expect(difficultyAdjustment(90)).toBe(0.3);
    expect(difficultyAdjustment(85)).toBe(0.3);
    expect(difficultyAdjustment(90)).toBeGreaterThan(difficultyAdjustment(75));
    expect(difficultyAdjustment(75)).toBe(-0.4);
    expect(difficultyAdjustment(100)).toBe(-0.3);
    expect(difficultyAdjustment(null)).toBe(0);
  });

  it("adjustedScore adds the delta to the backend rank", () => {
    expect(adjustedScore(item("a", 1.0), 90)).toBeCloseTo(1.3);
    expect(adjustedScore(item("a", 1.0), null)).toBeCloseTo(1.0);
  });
});

describe("applyDifficultyOrder", () => {
  it("re-sorts by adjusted score, unknown difficulty keeps rank order", () => {
    const known = new Map<string, number | null>([
      ["hard", 70],
      ["sweet", 90],
      ["plain", null],
    ]);
    const ordered = applyDifficultyOrder(
      [item("hard", 2.0), item("plain", 1.0), item("sweet", 0.5)],
      known,
    );
    // sweet gets +0.3 (0.8), plain stays 1.0, hard drops to 1.6 → hard first.
    expect(ordered.map((a) => a.id)).toEqual(["hard", "plain", "sweet"]);
  });
});
