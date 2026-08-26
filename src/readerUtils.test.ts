import { describe, expect, it } from "vitest";
import type { TranslateProgress } from "./api";
import {
  applyTranslateProgress,
  categoryLabel,
  findContext,
  translateProgressLabel,
} from "./readerUtils";

describe("categoryLabel", () => {
  const cats = [
    { id: "tech", label: "科技" },
    { id: "world", label: "国际" },
  ];

  it("uses the API label when present", () => {
    expect(categoryLabel("tech", cats)).toBe("科技");
  });

  it("falls back to the raw id", () => {
    expect(categoryLabel("custom", cats)).toBe("custom");
  });
});

describe("findContext", () => {
  const paras = [
    "Hello world.",
    "The committee reached a serendipity of sorts.",
  ];

  it("returns the paragraph that contains the term", () => {
    expect(findContext(paras, "Serendipity")).toBe(paras[1]);
  });

  it("returns the term when no paragraph matches", () => {
    expect(findContext(paras, "quantum")).toBe("quantum");
  });
});

function progress(partial: Partial<TranslateProgress> = {}): TranslateProgress {
  return {
    article_id: "a1",
    current: 1,
    total: 4,
    scope_key: "0",
    translated_text: "译文",
    done: false,
    ...partial,
  };
}

describe("applyTranslateProgress", () => {
  it("merges a finished paragraph into the cache", () => {
    const next = applyTranslateProgress({}, progress({ scope_key: "2" }));
    expect(next).toEqual({ "2": "译文" });
  });

  it("ignores the terminal done event", () => {
    const prev = { "0": "已有" };
    expect(
      applyTranslateProgress(
        prev,
        progress({ scope_key: "", translated_text: "", done: true }),
      ),
    ).toBe(prev);
  });
});

describe("translateProgressLabel", () => {
  it("shows current over total while in flight", () => {
    expect(translateProgressLabel(progress({ current: 3, total: 10 }))).toBe(
      "翻译中 3/10",
    );
  });

  it("hides when done or missing", () => {
    expect(translateProgressLabel(null)).toBeNull();
    expect(
      translateProgressLabel(progress({ done: true, scope_key: "" })),
    ).toBeNull();
  });
});
