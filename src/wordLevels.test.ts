import { beforeAll, describe, expect, it } from "vitest";
import {
  annotateText,
  ensureChunksLoaded,
  ensureLexiconLoaded,
  isHardWord,
  isSuperHardWord,
  lookupChunk,
  lookupWord,
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

function chunkSpan(spans: AnnotatedSpan[], term: string) {
  return spans.find(
    (s) => s.type === "token" && s.kind === "chunk" && s.term === term,
  );
}

describe("lexical chunks (chunks.json)", () => {
  beforeAll(async () => {
    await ensureChunksLoaded();
  });

  it("lookupChunk resolves a bundled phrasal verb", () => {
    expect(lookupChunk("put up with")?.type).toBe("phrasal");
  });

  it("underlines a multi-token chunk and keeps its surface span", () => {
    const spans = annotateText("I learned to put up with noise.", prefsC2, []);
    const hit = chunkSpan(spans, "put up with");
    expect(hit).toBeDefined();
    if (hit?.type === "token") {
      expect(hit.hard).toBe(true);
      expect(hit.text).toBe("put up with");
    }
  });

  it("matches inflected forms (looking → look forward to)", () => {
    const spans = annotateText("We are looking forward to it.", prefsC2, []);
    const hit = chunkSpan(spans, "look forward to");
    expect(hit).toBeDefined();
    if (hit?.type === "token") expect(hit.text).toBe("looking forward to");
  });

  it("suppresses a chunk the learner already knows", () => {
    const spans = annotateText("Please bear in mind.", prefsC2, [], [
      "bear in mind",
    ]);
    const hit = chunkSpan(spans, "bear in mind");
    expect(hit).toBeDefined();
    if (hit?.type === "token") {
      expect(hit.hard).toBe(false);
      expect(hit.learning).toBe(false);
    }
  });

  it("marks a saved learning chunk", () => {
    const spans = annotateText("You must bear in mind.", prefsC2, [
      "bear in mind",
    ]);
    const hit = chunkSpan(spans, "bear in mind");
    if (hit?.type === "token") expect(hit.learning).toBe(true);
  });

  it("still round-trips to the original text with chunks active", () => {
    const text = "They decided to cut corners, and it backfired.";
    expect(plain(annotateText(text, prefsC2, []))).toBe(text);
  });

  it("matches a hyphenated single-token chunk (rubber-stamp)", () => {
    const spans = annotateText("It was just a rubber-stamp approval.", prefsC2, []);
    const hit = chunkSpan(spans, "rubber-stamp");
    expect(hit).toBeDefined();
    if (hit?.type === "token") expect(hit.text).toBe("rubber-stamp");
  });

  it("matches a hyphenated chunk written with spaces (bidirectional)", () => {
    const spans = annotateText("The approval was a rubber stamp formality.", prefsC2, []);
    const hit = chunkSpan(spans, "rubber-stamp");
    expect(hit).toBeDefined();
    if (hit?.type === "token") expect(hit.text).toBe("rubber stamp");
  });

  it("matches an ambiguous hyphenated chunk when the text hyphenates it", () => {
    const spans = annotateText("The scheme was fast-track for graduates.", prefsC2, []);
    const hit = chunkSpan(spans, "fast-track");
    expect(hit).toBeDefined();
    if (hit?.type === "token") expect(hit.text).toBe("fast-track");
  });

  it("does not match an ambiguous chunk written as free words", () => {
    const text = "Cyclists used a fast track near the river.";
    const spans = annotateText(text, prefsC2, []);
    expect(chunkSpan(spans, "fast-track")).toBeUndefined();
    expect(plain(spans)).toBe(text);
  });
});
describe("spaced aliases of hyphenated headwords", () => {
  function wordSpan(spans: AnnotatedSpan[], term: string) {
    return spans.find(
      (s) => s.type === "token" && s.kind === "word" && s.term === term,
    );
  }

  it("annotates the unhyphenated spelling as its headword", () => {
    const spans = annotateText("a world class chip", prefsB1, []);
    const hit = wordSpan(spans, "world-class");
    expect(hit).toBeDefined();
    if (hit?.type === "token") {
      expect(hit.text).toBe("world class");
      expect(hit.hard).toBe(true);
      expect(hit.zh).toBeTruthy();
    }
  });

  it("resolves the spaced form through the dictionary lookup", () => {
    expect(lookupWord("world class")?.term).toBe("world-class");
  });

  it("leaves a free word combination to the single-word pass", () => {
    const text = "He raised his left hand and said it was hard work.";
    const spans = annotateText(text, prefsB1, []);
    expect(wordSpan(spans, "left-handed")).toBeUndefined();
    expect(wordSpan(spans, "hard-working")).toBeUndefined();
  });

  it("does not claim a spaced phrasal verb for the noun compound", () => {
    const text = "She had to take off her shoes.";
    expect(wordSpan(annotateText(text, prefsB1, []), "take-off")).toBeUndefined();
  });

  it("suppresses an alias the learner already knows", () => {
    const spans = annotateText("a world class chip", prefsB1, [], [
      "world-class",
    ]);
    const hit = wordSpan(spans, "world-class");
    if (hit?.type === "token") expect(hit.hard).toBe(false);
  });

  it("round-trips a paragraph full of compounds", () => {
    const text =
      "The long term, up to date deal was world class, so it won win support.";
    expect(plain(annotateText(text, prefsB1, []))).toBe(text);
  });
});

describe("hyphenated news compounds in the chunk table", () => {
  beforeAll(async () => {
    await ensureChunksLoaded();
  });

  it("matches the spaced spelling of a political compound", () => {
    const spans = annotateText("The far right took a hard line.", prefsC2, []);
    expect(chunkSpan(spans, "far-right")).toBeDefined();
    expect(chunkSpan(spans, "hard-line")).toBeDefined();
  });

  it("leaves the phrasal verb alone when only the noun is hyphenated", () => {
    const text = "Troops cut off the highway.";
    const spans = annotateText(text, prefsC2, []);
    expect(chunkSpan(spans, "cut-off")).toBeUndefined();
    expect(chunkSpan(annotateText("the water cut-off lasted hours.", prefsC2, []), "cut-off")).toBeDefined();
  });
});
