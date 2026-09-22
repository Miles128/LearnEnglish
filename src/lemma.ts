/**
 * English word-form reduction (lemma lookup for clicks/translations).
 *
 * Policy layer: irregular table first, then a candidate that exists in the
 * lexicon, then the most likely rule-based form. The candidate rules live in
 * `wordLevels.lemmaCandidates` (single implementation shared with the
 * annotator); only single words are reduced, phrases pass through untouched.
 */

import { lemmaCandidates, lookupWord, normalizeKey } from "./wordLevels";

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
