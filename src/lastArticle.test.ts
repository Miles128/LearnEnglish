import { beforeEach, describe, expect, it } from "vitest";
import {
  getLastArticleId,
  lastArticlePath,
  loadScroll,
  rememberLastArticle,
  resetLastArticleMemory,
  saveScroll,
} from "./lastArticle";

beforeEach(() => {
  resetLastArticleMemory();
});

describe("last article", () => {
  it("remembers the last opened article", () => {
    expect(getLastArticleId()).toBeNull();
    expect(lastArticlePath()).toBeNull();
    rememberLastArticle("a1");
    expect(getLastArticleId()).toBe("a1");
    expect(lastArticlePath()).toBe("/article/a1");
  });

  it("ignores empty ids", () => {
    rememberLastArticle("");
    expect(getLastArticleId()).toBeNull();
  });
});

describe("scroll memory", () => {
  it("round-trips a scroll offset per article", () => {
    expect(loadScroll("a1")).toBeNull();
    saveScroll("a1", 1234.6);
    expect(loadScroll("a1")).toBe(1235);
    expect(loadScroll("a2")).toBeNull();
  });

  it("clamps negatives", () => {
    saveScroll("a1", -50);
    expect(loadScroll("a1")).toBe(0);
  });
});
