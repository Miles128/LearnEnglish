import { invoke } from "@tauri-apps/api/core";
import type { LookupEntry, MemoryItem } from "./types";

export type MemoryKind = "word" | "phrase";

export type AddMemoryInput = {
  kind: MemoryKind;
  term: string;
  contextSentence: string;
  articleId?: string | null;
  definitionZh?: string | null;
  wordType?: string | null;
  collocations?: string[] | null;
};

export const apiMemory = {
  addMemory: (input: AddMemoryInput) =>
    invoke<MemoryItem>("add_memory", {
      input: {
        kind: input.kind,
        term: input.term,
        context_sentence: input.contextSentence,
        article_id: input.articleId ?? null,
        definition_zh: input.definitionZh ?? null,
        word_type: input.wordType ?? null,
        collocations: input.collocations ?? null,
      },
    }),
  listMemory: (kind: MemoryKind, status?: string) =>
    invoke<MemoryItem[]>("list_memory", { kind, status: status ?? null }),
  dueMemory: (kind: MemoryKind) =>
    invoke<MemoryItem[]>("due_memory", { kind }),
  reviewMemory: (id: string, rating: string) =>
    invoke<MemoryItem>("review_memory", { id, rating }),
  setMemoryStatus: (id: string, status: string) =>
    invoke<void>("set_memory_status", { id, status }),
  deleteMemory: (id: string) => invoke<void>("delete_memory", { id }),

  // Export the whole vocab library (words + phrases) as CSV; returns the
  // written path, or null when the save dialog was cancelled.
  exportVocabCsv: () => invoke<string | null>("export_memory_csv"),

  // Known words: marked as already known, so they stop being highlighted.
  listKnownWords: () => invoke<string[]>("list_known_words"),
  addKnownWord: (term: string) => invoke<void>("add_known_word", { term }),
  removeKnownWord: (term: string) => invoke<void>("remove_known_word", { term }),

  // Lookup history: every term resolved via the selection popover.
  recordLookup: (term: string, context?: string | null, articleId?: string | null) =>
    invoke<void>("record_lookup", {
      term,
      context: context ?? null,
      articleId: articleId ?? null,
    }),
  listLookups: (search?: string, limit?: number, offset?: number) =>
    invoke<LookupEntry[]>("list_lookups", {
      search: search ?? null,
      limit: limit ?? null,
      offset: offset ?? null,
    }),
  deleteLookup: (id: number) => invoke<void>("delete_lookup", { id }),
  clearLookups: () => invoke<void>("clear_lookups"),
};
