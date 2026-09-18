import { invoke } from "@tauri-apps/api/core";
import type {
  Article,
  ArticleListItem,
  ArticleView,
  FullTranslateResult,
  LearningStats,
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
    limit?: number,
    offset?: number,
  ) =>
    invoke<ArticleListItem[]>("list_articles_ranked", {
      category: category ?? null,
      tags: tags && tags.length > 0 ? tags : null,
      limit: limit ?? null,
      offset: offset ?? null,
    }),
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
  translateFullArticle: (articleId: string) =>
    invoke<FullTranslateResult>("translate_full_article", { articleId }),
};
