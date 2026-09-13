import { describe, expect, it } from "vitest";
import { shouldAnnotateMarkdownTag } from "./ReaderParagraph";

describe("shouldAnnotateMarkdownTag", () => {
  it("annotates headings and list items, not links", () => {
    expect(shouldAnnotateMarkdownTag("p")).toBe(true);
    expect(shouldAnnotateMarkdownTag("h1")).toBe(true);
    expect(shouldAnnotateMarkdownTag("h2")).toBe(true);
    expect(shouldAnnotateMarkdownTag("h3")).toBe(true);
    expect(shouldAnnotateMarkdownTag("li")).toBe(true);
    expect(shouldAnnotateMarkdownTag("blockquote")).toBe(true);
    expect(shouldAnnotateMarkdownTag("a")).toBe(false);
    expect(shouldAnnotateMarkdownTag("code")).toBe(false);
  });
});
