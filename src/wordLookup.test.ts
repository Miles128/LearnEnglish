import { beforeAll, describe, expect, it } from "vitest";
import { ensureLexiconLoaded } from "./wordLevels";
import { isAllCaps, prepareLookup } from "./wordLookup";

beforeAll(async () => {
  await ensureLexiconLoaded();
});

describe("prepareLookup", () => {
  it("reduces single words to their base form", () => {
    expect(prepareLookup("Cities").term).toBe("city");
    expect(prepareLookup("running").term).toBe("run");
    expect(prepareLookup("went").term).toBe("go");
    expect(prepareLookup("policies,").source).toBe("policies,");
  });

  it("keeps the raw selection for context", () => {
    const target = prepareLookup("  Cities  ");
    expect(target.source).toBe("Cities");
    expect(target.term).toBe("city");
  });

  it("passes phrases through untouched", () => {
    expect(prepareLookup("central bank").term).toBe("central bank");
    expect(prepareLookup("a few words").term).toBe("a few words");
  });

  it("trims and collapses whitespace", () => {
    expect(prepareLookup("  run   fast ").term).toBe("run fast");
  });

  it("keeps ALL-CAPS terms verbatim", () => {
    expect(prepareLookup("NATO").term).toBe("NATO");
    expect(prepareLookup("AI").term).toBe("AI");
    expect(prepareLookup("GDP").term).toBe("GDP");
    expect(prepareLookup("NASA's").term).toBe("NASA's");
    expect(prepareLookup("U.S.").term).toBe("U.S.");
  });

  it("still reduces ordinary capitalized words", () => {
    expect(prepareLookup("Cities").term).toBe("city");
    expect(prepareLookup("Running").term).toBe("run");
  });
});

describe("isAllCaps", () => {
  it("detects acronyms but not ordinary words", () => {
    expect(isAllCaps("NATO")).toBe(true);
    expect(isAllCaps("AI")).toBe(true);
    expect(isAllCaps("I")).toBe(false);
    expect(isAllCaps("Cities")).toBe(false);
    expect(isAllCaps("a")).toBe(false);
    expect(isAllCaps("A1")).toBe(true);
  });
});
