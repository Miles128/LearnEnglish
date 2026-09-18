import { describe, expect, it } from "vitest";
import { decodeDetail, detailsLoaded, lookupDetail } from "./wordDetails";

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
