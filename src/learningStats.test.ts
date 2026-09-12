import { describe, expect, it } from "vitest";
import {
  articleIsRead,
  formatLearningInsight,
  shouldRecordOpen,
} from "./learningStats";

describe("formatLearningInsight", () => {
  it("explains the empty state", () => {
    expect(
      formatLearningInsight({
        opened_total: 0,
        opened_7d: 0,
        top_source: null,
        top_category: null,
        vocab_created_7d: 0,
        vocab_learning: 0,
      }),
    ).toBe("读过的文章会记在这里，用来看你常读什么。");
  });

  it("summarizes week, total, favorite source, and new words", () => {
    expect(
      formatLearningInsight({
        opened_total: 12,
        opened_7d: 3,
        top_source: "BBC",
        top_category: "world",
        vocab_created_7d: 5,
        vocab_learning: 20,
      }),
    ).toBe("本周读 3 篇 · 累计 12 篇 · 常读 BBC · 本周新词 5");
  });
});

describe("articleIsRead", () => {
  it("is true only after an implicit open", () => {
    expect(articleIsRead({ last_opened_at: null })).toBe(false);
    expect(articleIsRead({ last_opened_at: "2026-09-13T00:00:00Z" })).toBe(
      true,
    );
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
