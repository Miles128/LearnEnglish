import { invoke } from "@tauri-apps/api/core";
import type {
  Article,
  ArticleListItem,
  ArticleView,
  FullTranslateResult,
  LearningStats,
  ReadingStats,
  TranslationRow,
} from "./types";

export const apiArticles = {
  listArticles: (category?: string, limit?: number, offset?: number) =>
    invoke<ArticleListItem[]>("list_articles", {
      category: category ?? null,
      limit: limit ?? null,
      offset: offset ?? null,
    }),
  listArticlesRanked: (
    category?: string,
    tags?: string[],
    source?: string,
    unreadOnly?: boolean,
    limit?: number,
    offset?: number,
  ) =>
    invoke<ArticleListItem[]>("list_articles_ranked", {
      category: category ?? null,
      tags: tags && tags.length > 0 ? tags : null,
      source: source ?? null,
      unreadOnly: unreadOnly ?? null,
      limit: limit ?? null,
      offset: offset ?? null,
    }),
  listLibrary: (filters: {
    category?: string;
    tags?: string[];
    source?: string;
    readState?: "all" | "unread" | "read";
    likedOnly?: boolean;
    limit?: number;
    offset?: number;
  }) =>
    invoke<ArticleListItem[]>("list_library", {
      category: filters.category ?? null,
      tags: filters.tags && filters.tags.length > 0 ? filters.tags : null,
      source: filters.source ?? null,
      readState: filters.readState ?? null,
      likedOnly: filters.likedOnly ?? null,
      limit: filters.limit ?? null,
      offset: filters.offset ?? null,
    }),
  listArticleSources: () =>
    invoke<[string, number][]>("list_article_sources"),
  fillMissingTags: (limit?: number) =>
    invoke<number>("fill_missing_tags", { limit: limit ?? null }),
  getArticleView: (id: string) =>
    invoke<ArticleView | null>("get_article_view", { id }),
  markArticleOpened: (id: string) =>
    invoke<void>("mark_article_opened", { id }),
  markArticleProgress: (id: string, dwellMsDelta: number, readCompleted: boolean) =>
    invoke<void>("mark_article_progress", {
      id,
      dwellMsDelta,
      readCompleted,
    }),
  setArticleLiked: (id: string, liked: boolean) =>
    invoke<void>("set_article_liked", { id, liked }),
  getLearningStats: () => invoke<LearningStats>("get_learning_stats"),
  getReadingStats: () => invoke<ReadingStats>("get_reading_stats"),
  fillMissingCardZh: () => invoke<number>("fill_missing_card_zh"),
  importArticleUrl: (url: string) =>
    invoke<Article>("import_article_url", { url }),
  importArticleFile: (path: string) =>
    invoke<Article>("import_article_file", { path }),
  translateParagraph: (
    articleId: string,
    paragraphIndex: number,
    text: string,
  ) =>
    invoke<TranslationRow>("translate_paragraph", {
      articleId,
      paragraphIndex,
      text,
    }),
  translateSelection: (articleId: string, text: string) =>
    invoke<TranslationRow>("translate_selection", { articleId, text }),
  translatePlainText: (text: string) =>
    invoke<string>("translate_plain_text", { text }),
  translateFullArticle: (articleId: string) =>
    invoke<FullTranslateResult>("translate_full_article", { articleId }),
};
