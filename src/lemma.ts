/**
 * English word-form reduction (lemma lookup for clicks/translations).
 *
 * Rule-based with an irregular table — no dictionary needed for the common
 * inflections that show up in news text. Only single words are reduced;
 * phrases pass through untouched.
 */

import { lookupWord, normalizeKey } from "./wordLevels";

/** Irregular forms worth hard-coding (news-frequency verbs/nouns/adjectives). */
const IRREGULAR: Record<string, string> = {
  // be / have / do
  am: "be", is: "be", are: "be", was: "be", were: "be", been: "be", being: "be",
  has: "have", had: "have", having: "have",
  does: "do", did: "do", done: "do", doing: "do",
  // irregular verbs
  went: "go", gone: "go", goes: "go",
  said: "say", says: "say",
  made: "make", took: "take", taken: "take",
  came: "come", got: "get", gotten: "get",
  saw: "see", seen: "see", knew: "know", known: "know",
  gave: "give", given: "give", found: "find",
  thought: "think", told: "tell", became: "become",
  left: "leave", felt: "feel", brought: "bring", began: "begin", begun: "begin",
  kept: "keep", held: "hold", wrote: "write", written: "write",
  stood: "stand", heard: "hear", let: "let", meant: "mean",
  met: "meet", ran: "run", paid: "pay", sat: "sit", spoke: "speak", spoken: "speak",
  led: "lead", grew: "grow", grown: "grow", lost: "lose", fell: "fall", fallen: "fall",
  sent: "send", built: "build", understood: "understand", drew: "draw", drawn: "draw",
  broke: "break", broken: "break", spent: "spend", cut: "cut", rose: "rise", risen: "rise",
  drove: "drive", driven: "drive", bought: "buy", wore: "wear", worn: "wear",
  chose: "choose", chosen: "choose", ate: "eat", eaten: "eat", won: "win",
  sought: "seek", threw: "throw", thrown: "throw", caught: "catch", taught: "teach",
  dealt: "deal", hid: "hide", hidden: "hide", sang: "sing", sung: "sing",
  slept: "sleep", shot: "shoot", struck: "strike", hung: "hang", bore: "bear", borne: "bear",
  // irregular nouns / adjectives
  children: "child", men: "man", women: "woman", people: "person", teeth: "tooth",
  feet: "foot", mice: "mouse", geese: "goose", lives: "life", knives: "knife",
  wives: "wife", halves: "half", selves: "self", leaves: "leaf", shelves: "shelf",
  wolves: "wolf", thieves: "thief", data: "datum", criteria: "criterion",
  better: "good", best: "good", worse: "bad", worst: "bad",
  more: "much", most: "much", less: "little", least: "little",
  farther: "far", farthest: "far", further: "far", furthest: "far",
};

/**
 * Rule-based candidates for a surface form, most likely first.
 * Kept small and conservative: only structures that are unambiguous enough
 * to be worth a base form.
 */
export function lemmaCandidates(word: string): string[] {
  const w = word.toLowerCase();
  if (w.length < 3) return [];
  const out: string[] = [];
  const push = (c: string) => {
    if (c && c !== w && c.length >= 2 && !out.includes(c)) out.push(c);
  };

  // possessives / contractions
  if (w.endsWith("'s")) push(w.slice(0, -2));
  if (w.endsWith("'")) push(w.slice(0, -1));

  // plurals
  if (w.endsWith("ies") && w.length > 3) push(`${w.slice(0, -3)}y`);
  if (w.endsWith("ves")) {
    push(`${w.slice(0, -3)}f`);
    push(`${w.slice(0, -3)}fe`);
  }
  if (w.endsWith("es")) {
    push(w.slice(0, -2));
    if (/(ch|sh|ss|x|z)es$/.test(w)) push(w.slice(0, -2));
  }
  if (w.endsWith("s") && !w.endsWith("ss") && !w.endsWith("us") && !w.endsWith("is")) {
    push(w.slice(0, -1));
  }
  if (w.endsWith("men")) push(`${w.slice(0, -3)}man`);

  // -ing (running → run, making → make)
  if (w.endsWith("ing") && w.length > 4) {
    const stem = w.slice(0, -3);
    if (stem.length >= 2 && stem[stem.length - 1] === stem[stem.length - 2]) {
      push(stem.slice(0, -1)); // doubled consonant
    }
    push(stem);
    push(`${stem}e`);
  }

  // -ed (walked → walk, studied → study, stopped → stop, liked → like)
  if (w.endsWith("ed") && w.length > 3) {
    const stem = w.slice(0, -2);
    if (w.endsWith("ied")) push(`${w.slice(0, -3)}y`);
    if (stem.length >= 2 && stem[stem.length - 1] === stem[stem.length - 2]) {
      push(stem.slice(0, -1));
    }
    push(stem);
    push(`${stem}e`);
  }

  // comparative / superlative (bigger → big, nicer → nice)
  if (w.endsWith("est") && w.length > 4) {
    const stem = w.slice(0, -3);
    if (stem.length >= 2 && stem[stem.length - 1] === stem[stem.length - 2]) {
      push(stem.slice(0, -1));
    }
    push(stem);
    push(`${stem}e`);
  }
  if (w.endsWith("er") && w.length > 3) {
    const stem = w.slice(0, -2);
    if (stem.length >= 2 && stem[stem.length - 1] === stem[stem.length - 2]) {
      push(stem.slice(0, -1));
    }
    push(stem);
    push(`${stem}e`);
  }

  // adverbs
  if (w.endsWith("ly") && w.length > 4) {
    push(w.slice(0, -2));
    if (w.endsWith("ily")) push(`${w.slice(0, -3)}y`);
    push(w.slice(0, -2) + "e");
  }

  return out;
}

/**
 * Reduce a token to its base form:
 * 1. irregular table; 2. a candidate that exists in the lexicon;
 * 3. the most likely rule-based candidate; 4. the word itself.
 * Phrases (containing whitespace) are returned unchanged.
 */
export function toLemma(word: string): string {
  const trimmed = word.trim();
  if (!trimmed || /\s/.test(trimmed)) return trimmed;
  const key = normalizeKey(trimmed);

  const irregular = IRREGULAR[key];
  if (irregular) return irregular;

  const candidates = lemmaCandidates(key);

  // Prefer a candidate that is a real dictionary word.
  for (const candidate of candidates) {
    if (lookupWord(candidate)) return candidate;
  }
  // Otherwise fall back to the most likely rule-based form, but only when the
  // surface form itself is not already a dictionary word.
  if (candidates.length > 0 && !lookupWord(key)) return candidates[0]!;
  return key;
}
