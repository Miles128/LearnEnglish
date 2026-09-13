import { describe, expect, it } from "vitest";
import { articleListBlurb, articleNeedsCardZh } from "./articleList";

describe("articleListBlurb", () => {
  it("prefers the Chinese summary", () => {
    expect(
      articleListBlurb({ summary_zh: "简介", excerpt: "A long English excerpt" }),
    ).toBe("简介");
  });

  it("does not pretend an English excerpt is the Chinese synopsis", () => {
    expect(
      articleListBlurb({ summary_zh: "", excerpt: "x".repeat(200) }),
    ).toBe("");
  });
});

describe("articleNeedsCardZh", () => {
  it("is missing when title or synopsis is empty", () => {
    expect(
      articleNeedsCardZh({ title_zh: "译题", summary_zh: "一两句简介。" }),
    ).toBe(false);
    expect(articleNeedsCardZh({ title_zh: "", summary_zh: "简介" })).toBe(true);
    expect(articleNeedsCardZh({ title_zh: "译题", summary_zh: "" })).toBe(true);
  });
});
