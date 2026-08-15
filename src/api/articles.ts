import { invoke } from "@tauri-apps/api/core";
import type {
  Article,
  FullTranslateResult,
  TranslationRow,
} from "./types";

export const apiArticles = {
  listArticles: (category?: string, limit?: number, offset?: number) =>
    invoke<Article[]>("list_articles", {
      category: category ?? null,
      limit: limit ?? null,
      offset: offset ?? null,
    }),
  getArticle: (id: string) => invoke<Article | null>("get_article", { id }),
  importArticleUrl: (url: string) =>
    invoke<Article>("import_article_url", { url }),
  importArticleFile: (path: string) =>
    invoke<Article>("import_article_file", { path }),
  getParagraphs: (id: string) => invoke<string[]>("get_paragraphs", { id }),
  listParagraphTranslations: (articleId: string) =>
    invoke<TranslationRow[]>("list_paragraph_translations", {
      articleId,
    }),
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
  translateMissingTitles: () => invoke<number>("translate_missing_titles"),
};