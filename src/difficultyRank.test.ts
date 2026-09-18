import { describe, expect, it } from "vitest";
import type { ArticleListItem } from "./api/types";
import type { DifficultyLevel } from "./difficulty";
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
  it("floats the sweet spot and sinks the extremes", () => {
    expect(difficultyAdjustment("normal")).toBe(0.3);
    expect(difficultyAdjustment("hard")).toBe(0.2);
    expect(difficultyAdjustment("easy")).toBe(-0.3);
    expect(difficultyAdjustment("harder")).toBe(-0.2);
    expect(difficultyAdjustment("hardest")).toBe(-0.5);
    expect(difficultyAdjustment(null)).toBe(0);
    expect(difficultyAdjustment("hard")).toBeGreaterThan(
      difficultyAdjustment("hardest"),
    );
  });

  it("adjustedScore adds the delta to the backend rank", () => {
    expect(adjustedScore(item("a", 1.0), "normal")).toBeCloseTo(1.3);
    expect(adjustedScore(item("a", 1.0), null)).toBeCloseTo(1.0);
  });
});

describe("applyDifficultyOrder", () => {
  it("re-sorts by adjusted score; unknown difficulty keeps rank order", () => {
    const levels = new Map<string, DifficultyLevel | null>([
      ["wall", "hardest"], // 2.0 - 0.5 = 1.5
      ["sweet", "normal"], // 0.5 + 0.3 = 0.8
      ["plain", null], // 1.0
    ]);
    const ordered = applyDifficultyOrder(
      [item("wall", 2.0), item("plain", 1.0), item("sweet", 0.5)],
      levels,
    );
    expect(ordered.map((a) => a.id)).toEqual(["wall", "plain", "sweet"]);
  });
});
