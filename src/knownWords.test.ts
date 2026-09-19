import { describe, expect, it } from "vitest";
import { filterKnownWords } from "./knownWords";

describe("filterKnownWords", () => {
  const words = ["serendipity", "Ubiquitous", "hello", "world"];

  it("returns everything for a blank query", () => {
    expect(filterKnownWords(words, "")).toEqual(words);
    expect(filterKnownWords(words, "   ")).toEqual(words);
  });

  it("matches case-insensitively", () => {
    expect(filterKnownWords(words, "UBI")).toEqual(["Ubiquitous"]);
    expect(filterKnownWords(words, "hello")).toEqual(["hello"]);
  });

  it("returns empty when nothing matches", () => {
    expect(filterKnownWords(words, "zzz")).toEqual([]);
  });

  it("keeps order and supports multiple matches", () => {
    const many = ["cat", "catalog", "dog", "category"];
    expect(filterKnownWords(many, "cat")).toEqual(["cat", "catalog", "category"]);
  });
});
