import { beforeAll, describe, expect, it } from "vitest";
import { decodeDetail, ensureDetailsLoaded, lookupDetail } from "./wordResolve";

/**
 * Validates the generated artifact (src/data/word-details.json) so a broken
 * build fails here instead of at the first word click.
 */
beforeAll(async () => {
  await ensureDetailsLoaded();
});

describe("word-details artifact", () => {
  it("loads a substantial dictionary", async () => {
    const rows = (await import("./data/word-details.json")).default as unknown[];
    expect(rows.length).toBeGreaterThan(15000);
    const decoded = rows.slice(0, 200).map(decodeDetail).filter(Boolean);
    expect(decoded.length).toBe(200);
  });

  it("has rich entries for common words", () => {
    const run = lookupDetail("run");
    expect(run).not.toBeNull();
    expect(run!.senses.length).toBeGreaterThan(0);
    expect(run!.phonetic.length).toBeGreaterThan(0);
  });

  it("carries examples with Chinese translations for common words", () => {
    const withExamples = ["the", "time", "people", "work", "world"]
      .map((w) => lookupDetail(w))
      .filter((d) => d && d.examples.length > 0);
    expect(withExamples.length).toBeGreaterThan(2);
    const sample = withExamples[0]!;
    expect(sample.examples[0]!.en.length).toBeGreaterThan(3);
    expect(sample.examples[0]!.zh.length).toBeGreaterThan(0);
  });
});
