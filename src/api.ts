import { invoke as tauriInvoke } from "@tauri-apps/api/core";

function isTauri(): boolean {
  return (
    typeof window !== "undefined" &&
    // Tauri 2
    ("__TAURI_INTERNALS__" in window || "__TAURI__" in window)
  );
}

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri()) {
    throw new Error(
      "当前不在 LearnEnglish 桌面窗口中。请关闭浏览器页，使用已打开的 LearnEnglish 窗口（或重新运行 pnpm tauri dev）。",
    );
  }
  return tauriInvoke<T>(cmd, args);
}

export type AppConfig = {
  base_url: string;
  api_key: string;
  model: string;
  disabled_feeds: string[];
};

export type Article = {
  id: string;
  url: string;
  title: string;
  title_zh: string;
  source: string;
  category: string;
  published_at: string | null;
  content_text: string;
  fetched_at: string;
};

export type FeedSource = {
  id: string;
  name: string;
  category: string;
  url: string;
  enabled: boolean;
};

export type TranslationRow = {
  id: number;
  article_id: string;
  scope: string;
  scope_key: string;
  source_text: string;
  translated_text: string;
  model: string;
};

export type VocabItem = {
  id: string;
  term: string;
  definition_zh: string;
  word_type: string;
  collocations: string[];
  context_sentence: string;
  article_id: string | null;
  status: string;
  interval_days: number;
  reps: number;
  consecutive_know: number;
  next_review_at: string;
  created_at: string;
};

export type RefreshResult = {
  fetched_feeds: number;
  added_or_updated: number;
  skipped_existing: number;
  skipped_short: number;
  skipped_non_english: number;
  titles_translated: number;
  errors: string[];
};

export const api = {
  getConfig: () => invoke<AppConfig>("get_config"),
  saveConfig: (cfg: AppConfig) => invoke<void>("save_config_cmd", { cfg }),
  listArticles: (category?: string) =>
    invoke<Article[]>("list_articles", { category: category ?? null }),
  getArticle: (id: string) => invoke<Article | null>("get_article", { id }),
  listFeeds: () => invoke<FeedSource[]>("list_feeds"),
  setFeedEnabled: (id: string, enabled: boolean) =>
    invoke<void>("set_feed_enabled", { id, enabled }),
  refreshFeeds: () => invoke<RefreshResult>("refresh_feeds"),
  translateMissingTitles: () => invoke<number>("translate_missing_titles"),
  getParagraphs: (id: string) => invoke<string[]>("get_paragraphs", { id }),
  listParagraphTranslations: (articleId: string) =>
    invoke<TranslationRow[]>("list_paragraph_translations", {
      articleId,
    }),
  translateParagraph: (articleId: string, paragraphIndex: number, text: string) =>
    invoke<TranslationRow>("translate_paragraph", {
      articleId,
      paragraphIndex,
      text,
    }),
  translateSelection: (articleId: string, text: string) =>
    invoke<TranslationRow>("translate_selection", { articleId, text }),
  translateFullArticle: (articleId: string) =>
    invoke<TranslationRow[]>("translate_full_article", { articleId }),
  addVocab: (input: {
    term: string;
    contextSentence: string;
    articleId?: string | null;
    definitionZh?: string | null;
    wordType?: string | null;
    collocations?: string[] | null;
  }) =>
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
