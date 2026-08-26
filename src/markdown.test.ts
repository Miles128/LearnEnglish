import { describe, expect, it } from "vitest";
import {
  contentLooksLikeMarkdown,
  shouldRenderMarkdown,
  urlLooksLikeMarkdown,
} from "./markdown";

describe("urlLooksLikeMarkdown", () => {
  it("detects .md and .markdown paths", () => {
    expect(urlLooksLikeMarkdown("https://ex.com/notes.md")).toBe(true);
    expect(urlLooksLikeMarkdown("https://ex.com/a.markdown?x=1")).toBe(true);
  });

  it("rejects non-markdown URLs", () => {
    expect(urlLooksLikeMarkdown("https://ex.com/story.html")).toBe(false);
  });

  it("falls back to the raw string when URL parsing fails", () => {
    expect(urlLooksLikeMarkdown("notes.md")).toBe(true);
  });
});

describe("contentLooksLikeMarkdown", () => {
  it("needs two heuristic hits, or a strong single signal", () => {
    expect(contentLooksLikeMarkdown("Just a plain paragraph.")).toBe(false);
    expect(contentLooksLikeMarkdown("# Title\n\n- item one")).toBe(true);
    expect(contentLooksLikeMarkdown("```\ncode\n```")).toBe(true);
    expect(contentLooksLikeMarkdown("# One\n\n# Two")).toBe(true);
  });
});

describe("shouldRenderMarkdown", () => {
  it("is true when either the URL or the body looks like markdown", () => {
    expect(shouldRenderMarkdown("https://ex.com/a.md", "plain")).toBe(true);
    expect(shouldRenderMarkdown("https://ex.com/a.html", "# A\n\n# B")).toBe(
      true,
    );
    expect(shouldRenderMarkdown("https://ex.com/a.html", "plain")).toBe(false);
  });
});
