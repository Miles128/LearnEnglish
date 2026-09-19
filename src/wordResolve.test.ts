import { beforeAll, describe, expect, it } from "vitest";
import { ensureLexiconLoaded } from "./wordLevels";
import {
  decodeDetail,
  detailsLoaded,
  isAllCaps,
  isPhraseSelection,
  lookupDetail,
  prepareLookup,
} from "./wordResolve";

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

describe("isPhraseSelection", () => {
  it("accepts short phrases", () => {
    expect(isPhraseSelection("on the house")).toBe(true);
    expect(isPhraseSelection("give up")).toBe(true);
    expect(isPhraseSelection("a piece of cake")).toBe(true);
    expect(isPhraseSelection("take it for granted")).toBe(true);
  });

  it("rejects single words, long spans and sentences", () => {
    expect(isPhraseSelection("run")).toBe(false);
    expect(isPhraseSelection("This is a complete sentence.")).toBe(false);
    expect(
      isPhraseSelection("one two three four five six seven eight"),
    ).toBe(false);
    expect(isPhraseSelection("hello, world")).toBe(false);
    expect(isPhraseSelection("")).toBe(false);
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

describe("decodeDetail", () => {
  it("decodes a full row", () => {
    const detail = decodeDetail([
      "run",
      "跑\n经营",
      "rʌn",
      "v./n.",
      5,
      1,
      380,
      "",
      "He runs every morning.",
      "他每天早上跑步。",
      "She runs a bakery.",
      "她经营一家面包店。",
    ]);
    expect(detail).not.toBeNull();
    expect(detail!.senses).toEqual(["跑", "经营"]);
    expect(detail!.phonetic).toBe("rʌn");
    expect(detail!.pos).toBe("v./n.");
    expect(detail!.collins).toBe(5);
    expect(detail!.oxford).toBe(1);
    expect(detail!.rank).toBe(380);
    expect(detail!.examples).toHaveLength(2);
    expect(detail!.examples[0]).toEqual({
      en: "He runs every morning.",
      zh: "他每天早上跑步。",
    });
  });

  it("decodes lemma and tolerates missing extras", () => {
    const detail = decodeDetail([
      "perceived",
      "察觉到的",
      "",
      "adj.",
      0,
      0,
      0,
      "perceive",
    ]);
    expect(detail!.lemma).toBe("perceive");
    expect(detail!.examples).toEqual([]);
  });

  it("rejects rows with no content or wrong shape", () => {
    expect(decodeDetail(["word", "", "", "", 0, 0, 0, ""])).toBeNull();
    expect(decodeDetail("nope")).toBeNull();
    expect(decodeDetail([])).toBeNull();
  });
});

describe("lookupDetail", () => {
  it("returns null before the details chunk is loaded", () => {
    expect(detailsLoaded()).toBe(false);
    expect(lookupDetail("run")).toBeNull();
  });
});
