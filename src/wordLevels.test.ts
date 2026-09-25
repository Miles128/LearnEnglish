import { beforeAll, describe, expect, it } from "vitest";
import {
  annotateText,
  ensureLexiconLoaded,
  isHardWord,
  isSuperHardWord,
  type AnnotatedSpan,
  type DifficultyPrefs,
} from "./wordLevels";

const prefsB1: DifficultyPrefs = { cefrLevel: "B1", freqBand: 3000 };
const prefsC2: DifficultyPrefs = { cefrLevel: "C2", freqBand: 20000 };

beforeAll(async () => {
  await ensureLexiconLoaded();
});

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

describe("isSuperHardWord", () => {
  // B1 user (rank 3 on CEFR ladder): 2 steps up = C1 (rank 5).
  it("fires when the word is ≥2 CEFR steps above the learner", () => {
    expect(isSuperHardWord({ cefr: "C1", rank: 500 }, prefsB1)).toBe(true);
    expect(isSuperHardWord({ cefr: "C2", rank: 500 }, prefsB1)).toBe(true);
  });

  it("stays silent at only 1 CEFR step above", () => {
    // B2 for a B1 user is hard but not super-hard.
    expect(isSuperHardWord({ cefr: "B2", rank: 100 }, prefsB1)).toBe(false);
  });

  it("fires when rank exceeds 2× the freq band", () => {
    expect(isSuperHardWord({ cefr: "A2", rank: 6500 }, prefsB1)).toBe(true);
    expect(isSuperHardWord({ cefr: "A2", rank: 5000 }, prefsB1)).toBe(false);
  });

  it("is a strict subset of isHardWord", () => {
    // Any word superHard must also be hard.
    const samples = [
      { cefr: "C1" as const, rank: 500 },
      { cefr: "A2" as const, rank: 6500 },
      { cefr: "B2" as const, rank: 100 },
      { cefr: "A1" as const, rank: 100 },
    ];
    for (const s of samples) {
      if (isSuperHardWord(s, prefsB1)) expect(isHardWord(s, prefsB1)).toBe(true);
    }
  });

  it("keeps the ceiling prefs (C2 / 20000) essentially superHard-free", () => {
    // Realistic news word: C1 rank 4500 → still within reach of C2/20k user.
    expect(isSuperHardWord({ cefr: "C1", rank: 4500 }, prefsC2)).toBe(false);
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

  it("emits a token for every word so any word can be clicked", () => {
    const spans = annotateText("The cat sat.", prefsC2, []);
    const words = spans.filter((s) => s.type === "token");
    expect(words.map((s) => (s.type === "token" ? s.text : ""))).toEqual([
      "The",
      "cat",
      "sat",
    ]);
    expect(words.every((s) => s.type === "token" && !s.hard)).toBe(true);
  });

  it("stricter prefs mark at least as many hard tokens", () => {
    const text = "The cat sat on the mat while the warden watched the prey.";
    const hardCount = (prefs: DifficultyPrefs) =>
      annotateText(text, prefs, []).filter((s) => s.type === "token" && s.hard)
        .length;
    const b1 = hardCount(prefsB1);
    const c2 = hardCount(prefsC2);
    expect(b1).toBeGreaterThan(0);
    expect(b1).toBeGreaterThanOrEqual(c2);
  });
});