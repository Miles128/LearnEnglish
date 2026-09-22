import { describe, expect, it } from "vitest";
import {
  articleIsRead,
  formatLearningInsight,
  shouldRecordOpen,
} from "./learningStats";

describe("formatLearningInsight", () => {
  it("shows today's opens over the total", () => {
    expect(
      formatLearningInsight({
        opened_total: 12,
        opened_today: 3,
        opened_7d: 3,
        top_source: "BBC",
        top_category: "world",
        vocab_created_7d: 5,
        vocab_learning: 20,
      }),
    ).toBe("今日 3 · 本周 3 · 总 12 · 本周新词 5");
  });

  it("handles the empty state", () => {
    expect(
      formatLearningInsight({
        opened_total: 0,
        opened_today: 0,
        opened_7d: 0,
        top_source: null,
        top_category: null,
        vocab_created_7d: 0,
        vocab_learning: 0,
      }),
    ).toBe("今日 0 · 本周 0 · 总 0");
  });
});

describe("articleIsRead", () => {
  it("is true only once finished, not merely opened", () => {
    expect(articleIsRead({ read_completed: false })).toBe(false);
    expect(articleIsRead({ read_completed: true })).toBe(true);
    expect(articleIsRead({})).toBe(false);
  });
});

describe("shouldRecordOpen", () => {
  it("records the first successful load of an article", () => {
    expect(shouldRecordOpen(undefined, { id: "a1" })).toBe("a1");
    expect(shouldRecordOpen("a1", { id: "a1" })).toBe(null);
    expect(shouldRecordOpen("a1", { id: "a2" })).toBe("a2");
    expect(shouldRecordOpen(undefined, null)).toBe(null);
  });
});
