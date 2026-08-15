import { beforeAll, describe, expect, it } from "vitest";
import {
  annotateText,
  ensureLexiconLoaded,
  isHardWord,
  type AnnotatedSpan,
  type DifficultyPrefs,
} from "./wordLevels";

const prefsB1: DifficultyPrefs = { cefrLevel: "B1", freqBand: 3000 };
const prefsC2: DifficultyPrefs = { cefrLevel: "C2", freqBand: 20000 };

beforeAll(async () => {
  await ensureLexiconLoaded();
});

function tokenCount(spans: AnnotatedSpan[]): number {
  return spans.filter((s) => s.type === "token").length;
}

function plain(spans: AnnotatedSpan[]): string {
  return spans.map((s) => s.text).join("");
}

describe("isHardWord", () => {
  it("flags words above the freq band", () => {
    expect(isHardWord({ cefr: "B1", rank: 9000 }, prefsB1)).toBe(true);
  });

  it("flags words above the CEFR level", () => {
    expect(isHardWord({ cefr: "C2", rank: 500 }, prefsB1)).toBe(true);
  });

  it("keeps easy words unflagged", () => {
    expect(isHardWord({ cefr: "A2", rank: 800 }, prefsB1)).toBe(false);
  });
});

describe("annotateText", () => {
  it("round-trips to the original text", () => {
    const text = "The cat sat on the mat while prey walked by.";
    expect(plain(annotateText(text, prefsB1, []))).toBe(text);
  });

  it("marks learning terms as token spans", () => {
    const spans = annotateText("The cat sat on the mat.", prefsB1, ["cat"]);
    const cat = spans.find((s) => s.type === "token" && s.text === "cat");
    expect(cat).toBeDefined();
    if (cat?.type === "token") {
      expect(cat.learning).toBe(true);
    }
  });

  it("marks hard words under stricter prefs", () => {
    const spans = annotateText("A warden watched the prey.", prefsB1, []);
    const prey = spans.find((s) => s.type === "token" && s.text === "prey");
    expect(prey).toBeDefined();
    if (prey?.type === "token") {
      expect(prey.hard).toBe(true);
    }
  });

  it("produces no token spans when everything is easy", () => {
    const spans = annotateText(
      "The cat sat on the mat and that was it.",
      prefsC2,
      [],
    );
    expect(tokenCount(spans)).toBe(0);
  });

  it("stricter prefs mark at least as many tokens", () => {
    const text = "The cat sat on the mat while the warden watched the prey.";
    const b1 = tokenCount(annotateText(text, prefsB1, []));
    const c2 = tokenCount(annotateText(text, prefsC2, []));
    expect(b1).toBeGreaterThan(0);
    expect(b1).toBeGreaterThanOrEqual(c2);
  });
});