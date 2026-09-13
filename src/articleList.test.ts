import { describe, expect, it } from "vitest";
import { articleListBlurb } from "./articleList";

describe("articleListBlurb", () => {
  it("prefers the Chinese summary", () => {
    expect(
      articleListBlurb({ summary_zh: "简介", excerpt: "A long English excerpt" }),
    ).toBe("简介");
  });

  it("falls back to a short excerpt", () => {
    expect(
      articleListBlurb({ summary_zh: "", excerpt: "x".repeat(200) }),
    ).toBe(`${"x".repeat(140)}…`);
  });
});
