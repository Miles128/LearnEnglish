import { describe, expect, it, vi } from "vitest";
import { createKnownToggle, filterKnownWords } from "./knownWords";

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

describe("createKnownToggle", () => {
  it("marks unknown words and unmarks known ones", async () => {
    const markKnown = vi.fn(async (_t: string) => undefined);
    const unmarkKnown = vi.fn(async (_t: string) => undefined);
    const onError = vi.fn();
    const toggle = createKnownToggle({
      knownTerms: ["hello"],
      markKnown,
      unmarkKnown,
      onError,
    });
    await toggle("  World ");
    expect(markKnown).toHaveBeenCalledWith("world");
    await toggle("HELLO");
    expect(unmarkKnown).toHaveBeenCalledWith("hello");
    expect(onError).not.toHaveBeenCalled();
  });

  it("folds curly apostrophes to the canonical key", async () => {
    const markKnown = vi.fn(async (_t: string) => undefined);
    const unmarkKnown = vi.fn(async (_t: string) => undefined);
    const toggle = createKnownToggle({
      knownTerms: ["it's"],
      markKnown,
      unmarkKnown,
      onError: vi.fn(),
    });
    // Known under the straight form: toggling the curly form unmarks it.
    await toggle("it’s");
    expect(markKnown).not.toHaveBeenCalled();
    expect(unmarkKnown).toHaveBeenCalledWith("it's");
  });

  it("routes failures to onError", async () => {
    const onError = vi.fn();
    const toggle = createKnownToggle({
      knownTerms: [],
      markKnown: async () => {
        throw new Error("db locked");
      },
      unmarkKnown: async () => undefined,
      onError,
    });
    await toggle("x");
    expect(onError).toHaveBeenCalledWith("Error: db locked");
  });
});
