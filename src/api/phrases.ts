import { invoke } from "@tauri-apps/api/core";
import type { PhraseItem } from "./types";

export type AddPhraseInput = {
  phrase: string;
  contextSentence: string;
  articleId?: string | null;
  meaningZh?: string | null;
  usage?: string | null;
};

export const apiPhrases = {
  addPhrase: (input: AddPhraseInput) =>
    invoke<PhraseItem>("add_phrase", {
      input: {
        phrase: input.phrase,
        context_sentence: input.contextSentence,
        article_id: input.articleId ?? null,
        meaning_zh: input.meaningZh ?? null,
        usage: input.usage ?? null,
      },
    }),
  listPhrases: (status?: string) =>
    invoke<PhraseItem[]>("list_phrases", { status: status ?? null }),
  duePhrases: () => invoke<PhraseItem[]>("due_phrases"),
  reviewPhrase: (id: string, rating: string) =>
    invoke<PhraseItem>("review_phrase", { id, rating }),
  setPhraseStatus: (id: string, status: string) =>
    invoke<void>("set_phrase_status", { id, status }),
  deletePhrase: (id: string) => invoke<void>("delete_phrase", { id }),
};
