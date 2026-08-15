import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import {
  defaultReadingPrefs,
  type ReadingPrefs,
} from "./readingPrefs";

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
      "当前不在拾言桌面窗口中。请关闭浏览器页，使用已打开的拾言窗口（或重新运行 pnpm tauri dev）。",
    );
  }
  return tauriInvoke<T>(cmd, args);
}

export type AppConfig = {
  base_url: string;
  api_key: string;
  model: string;
  disabled_feeds: string[];
  /** User CEFR level (A1–C2). */
  cefr_level: string;
  /** Known vocab band: 1000 | 3000 | 5000 | 10000 | 20000 */
  freq_band: number;
  /** Adaptive placement test completed. */
  vocab_placement_done?: boolean;
  /** Final continuous ability L from last placement. */
  vocab_placement_l?: number | null;
  /** ISO timestamp of last placement. */
  vocab_placement_at?: string | null;
  /** User dismissed the placement prompt; don't force it again. */
  vocab_placement_skipped?: boolean;
} & ReadingPrefs;

export function defaultAppConfig(): AppConfig {
  return {
    base_url: "https://api.openai.com/v1",
    api_key: "",
    model: "gpt-4o-mini",
    disabled_feeds: [],
    cefr_level: "B1",
    freq_band: 3000,
    vocab_placement_done: false,
    vocab_placement_l: null,
    vocab_placement_at: null,
    vocab_placement_skipped: false,
    ...defaultReadingPrefs(),
  };
}

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
  /** Where the article came from: rss | url | file. */
  origin: "rss" | "url" | "file" | string;
};

export type FeedSource = {
  id: string;
  name: string;
  category: string;
  url: string;
  enabled: boolean;
  origin: "curated" | "user" | string;
  description: string;
};

export type FeedCategory = {
  id: string;
  label: string;
  builtin: boolean;
};

export type FeedDiscoverCandidate = {
  name: string;
  url: string;
  description: string;
};

export type FeedValidation = {
  ok: boolean;
  title: string | null;
  entry_count: number;
  error: string | null;
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
  /** Articles whose stored body was upgraded to a fuller fetched copy. */
  updated: number;
  errors: string[];
};

export type FullTranslateResult = {
  rows: TranslationRow[];
  errors: string[];
};

export const api = {
  getConfig: () => invoke<AppConfig>("get_config"),
  saveConfig: (cfg: AppConfig) => invoke<void>("save_config_cmd", { cfg }),
  listArticles: (category?: string, limit?: number, offset?: number) =>
    invoke<Article[]>("list_articles", {
      category: category ?? null,
      limit: limit ?? null,
      offset: offset ?? null,
    }),
  getArticle: (id: string) => invoke<Article | null>("get_article", { id }),
  listFeeds: () => invoke<FeedSource[]>("list_feeds"),
  setFeedEnabled: (id: string, enabled: boolean) =>
    invoke<void>("set_feed_enabled", { id, enabled }),
  listFeedCategories: () => invoke<FeedCategory[]>("list_feed_categories"),
  addFeedCategory: (label: string) =>
    invoke<FeedCategory>("add_feed_category", { label }),
  discoverFeeds: (categoryId: string) =>
    invoke<FeedDiscoverCandidate[]>("discover_feeds", { categoryId }),
  validateFeed: (url: string) => invoke<FeedValidation>("validate_feed", { url }),
  subscribeFeed: (input: {
    name: string;
    category: string;
    url: string;
    description?: string;
  }) =>
    invoke<FeedSource>("subscribe_feed", {
      input: {
        name: input.name,
        category: input.category,
        url: input.url,
        description: input.description ?? null,
      },
    }),
  refreshFeeds: () => invoke<RefreshResult>("refresh_feeds"),
  translateMissingTitles: () => invoke<number>("translate_missing_titles"),
  importArticleUrl: (url: string) =>
    invoke<Article>("import_article_url", { url }),
  importArticleFile: (path: string) =>
    invoke<Article>("import_article_file", { path }),
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
    invoke<FullTranslateResult>("translate_full_article", { articleId }),
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
