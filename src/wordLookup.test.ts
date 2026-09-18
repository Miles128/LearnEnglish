import { beforeAll, describe, expect, it } from "vitest";
import { ensureLexiconLoaded } from "./wordLevels";
import { prepareLookup } from "./wordLookup";

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
});
