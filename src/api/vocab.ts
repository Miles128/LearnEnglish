import { invoke } from "@tauri-apps/api/core";
import type { VocabItem } from "./types";

export type AddVocabInput = {
  term: string;
  contextSentence: string;
  articleId?: string | null;
  definitionZh?: string | null;
  wordType?: string | null;
  collocations?: string[] | null;
};

export const apiVocab = {
  addVocab: (input: AddVocabInput) =>
    invoke<VocabItem>("add_vocab", {
      input: {
        term: input.term,
        context_sentence: input.contextSentence,
        article_id: input.articleId ?? null,
        definition_zh: input.definitionZh ?? null,
        word_type: input.wordType ?? null,
        collocations: input.collocations ?? null,
      },
    }),
  listVocab: (status?: string) =>
    invoke<VocabItem[]>("list_vocab", { status: status ?? null }),
  dueVocab: () => invoke<VocabItem[]>("due_vocab"),
  reviewVocab: (id: string, rating: string) =>
    invoke<VocabItem>("review_vocab", { id, rating }),
  setVocabStatus: (id: string, status: string) =>
    invoke<void>("set_vocab_status", { id, status }),
  deleteVocab: (id: string) => invoke<void>("delete_vocab", { id }),
};