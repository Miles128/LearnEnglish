import { useCallback, useEffect, useRef, useState } from "react";
import { api, Article } from "./api";
import { shouldRecordOpen } from "./learningStats";

export type ArticleViewState = "loading" | "missing" | "error" | "ready";

/** Derive Reader empty-states. A loaded article stays `ready` even if a later action fails. */
export function articleViewState(input: {
  loading: boolean;
  article: { id: string } | null;
  error: string | null;
}): ArticleViewState {
  if (input.article) return "ready";
  if (input.loading) return "loading";
  if (input.error) return "error";
  return "missing";
}

/** Map cached paragraph rows to scope_key → text. */
export function translationsMap(
  rows: { scope_key: string; translated_text: string }[],
): Record<string, string> {
  const map: Record<string, string> = {};
  for (const r of rows) {
    map[r.scope_key] = r.translated_text;
  }
  return map;
}

export function useArticle(id: string | undefined) {
  const [article, setArticle] = useState<Article | null>(null);
  const [paragraphs, setParagraphs] = useState<string[]>([]);
  const [translations, setTranslations] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!id) {
      setArticle(null);
      setParagraphs([]);
      setTranslations({});
      setLoading(false);
      return;
    }
    setError(null);
    setLoading(true);
    try {
      const loaded = await api.getArticleView(id);
      if (!loaded) {
        setArticle(null);
        setParagraphs([]);
        setTranslations({});
        return;
      }
      setArticle(loaded.article);
      setParagraphs(loaded.paragraphs);
      setTranslations(translationsMap(loaded.translations));
    } catch (e) {
      setArticle(null);
      setParagraphs([]);
      setTranslations({});
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  const recordedId = useRef<string | undefined>(undefined);
  useEffect(() => {
    const id = shouldRecordOpen(recordedId.current, article);
    if (!id) return;
    recordedId.current = id;
    void api.markArticleOpened(id).catch(() => {
      recordedId.current = undefined;
    });
  }, [article]);

  const view = articleViewState({ loading, article, error });
  return { article, paragraphs, translations, setTranslations, error, setError, loading, view };
}
