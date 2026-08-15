import { beforeAll, describe, expect, it } from "vitest";
import { ensureLexiconLoaded } from "./wordLevels";
import {
  estimateKnownPercent,
  formatKnownPercent,
  tokenizeWords,
} from "./knownPercent";

const COMMON = [
  "the",
  "and",
  "for",
  "you",
  "that",
  "with",
  "have",
  "this",
  "from",
  "they",
  "will",
  "would",
  "there",
  "their",
  "what",
  "about",
  "which",
  "when",
  "make",
  "time",
  "know",
  "take",
  "think",
  "good",
  "help",
  "like",
];

beforeAll(async () => {
  await ensureLexiconLoaded();
});

function repeatTo(words: string[], n: number): string {
  const out: string[] = [];
  while (out.length < n) out.push(...words);
  return out.slice(0, n).join(" ");
}

describe("tokenizeWords", () => {
  it("lowercases and keeps letters/apostrophes/hyphens", () => {
    expect(tokenizeWords("Hello, WORLD! It's fine.")).toEqual([
      "hello",
      "world",
      "it's",
      "fine",
    ]);
  });

  it("drops single-character tokens", () => {
    expect(tokenizeWords("a b c d")).toEqual([]);
  });
});

describe("formatKnownPercent", () => {
  it("maps null to null", () => {
    expect(formatKnownPercent(null)).toBeNull();
  });

  it("formats a percent label", () => {
    expect(formatKnownPercent(75)).toBe("约认识 75%");
  });
});

describe("estimateKnownPercent", () => {
  const body = repeatTo(COMMON, 60);

  it("returns null when the article has fewer than 40 tokens", () => {
    expect(estimateKnownPercent("the cat sat on the mat", [], 3000)).toBeNull();
  });

  it("is 100 when every token is within the freq band", () => {
    expect(estimateKnownPercent(body, [], 3000)).toBe(100);
  });

  it("excludes learning terms from the known count", () => {
    const pct = estimateKnownPercent(body, ["time"], 3000);
    expect(pct).not.toBeNull();
    expect(pct!).toBeLessThan(100);
    expect(pct!).toBeGreaterThanOrEqual(95);
  });

  it("never decreases as the freq band widens", () => {
    const narrow = estimateKnownPercent(body, [], 1000);
    const wide = estimateKnownPercent(body, [], 20000);
    expect(narrow).not.toBeNull();
    expect(wide).not.toBeNull();
    expect(wide!).toBeGreaterThanOrEqual(narrow!);
  });
});