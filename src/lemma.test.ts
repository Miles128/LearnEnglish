import { beforeAll, describe, expect, it } from "vitest";
import { ensureLexiconLoaded, lemmaCandidates } from "./wordLevels";
import { toLemma } from "./lemma";

beforeAll(async () => {
  await ensureLexiconLoaded();
});

describe("lemmaCandidates", () => {
  it("handles plurals", () => {
    expect(lemmaCandidates("cities")[0]).toBe("city");
    expect(lemmaCandidates("books")[0]).toBe("book");
    expect(lemmaCandidates("boxes")[0]).toBe("box");
    expect(lemmaCandidates("leaves")).toContain("leaf");
  });

  it("handles verb inflections", () => {
    expect(lemmaCandidates("running")).toContain("run");
    expect(lemmaCandidates("stopped")).toContain("stop");
    expect(lemmaCandidates("making")).toContain("make");
    expect(lemmaCandidates("studied")).toContain("study");
  });

  it("handles adverbs and comparatives", () => {
    expect(lemmaCandidates("quickly")).toContain("quick");
    expect(lemmaCandidates("happily")).toContain("happy");
    expect(lemmaCandidates("bigger")).toContain("big");
  });
});

describe("toLemma", () => {
  it("reduces irregulars", () => {
    expect(toLemma("went")).toBe("go");
    expect(toLemma("children")).toBe("child");
    expect(toLemma("better")).toBe("good");
    expect(toLemma("said")).toBe("say");
  });

  it("reduces regular inflections", () => {
    expect(toLemma("cities")).toBe("city");
    expect(toLemma("running")).toBe("run");
    expect(toLemma("policies")).toBe("policy");
    expect(toLemma("announced")).toBe("announce");
  });

  it("leaves base forms and phrases alone", () => {
    expect(toLemma("city")).toBe("city");
    expect(toLemma("the")).toBe("the");
    expect(toLemma("central bank")).toBe("central bank");
    expect(toLemma("  running  ")).toBe("run");
    expect(toLemma("")).toBe("");
  });

  it("handles capitalization and possessives", () => {
    expect(toLemma("Cities")).toBe("city");
    expect(toLemma("company's")).toBe("company");
  });
});
