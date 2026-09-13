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
  getArticleView: (id: string) =>
    invoke<ArticleView | null>("get_article_view", { id }),
  markArticleOpened: (id: string) =>
    invoke<void>("mark_article_opened", { id }),
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
