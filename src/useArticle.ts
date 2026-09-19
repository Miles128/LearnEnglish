import { useCallback, useEffect, useRef, useState } from "react";
import { api, Article } from "./api";
import { shouldRecordOpen } from "./learningStats";

// 文章域：加载 hook + 上次阅读/滚动位置记忆（原 lastArticle.ts）。

const LAST_KEY = "shiyan:last-article";
const SCROLL_PREFIX = "shiyan:scroll:";

/** In-memory fallback: keeps functions total in tests / non-DOM contexts. */
const storageMemory = new Map<string, string>();

function backingStorage(kind: "local" | "session"): Storage | null {
  try {
    const s = kind === "local" ? window.localStorage : window.sessionStorage;
    return s ?? null;
  } catch {
    return null;
  }
}

function readStored(kind: "local" | "session", key: string): string | null {
  const s = backingStorage(kind);
  return s ? s.getItem(key) : (storageMemory.get(`${kind}:${key}`) ?? null);
}

function writeStored(kind: "local" | "session", key: string, value: string) {
  const s = backingStorage(kind);
  if (s) {
    s.setItem(key, value);
  } else {
    storageMemory.set(`${kind}:${key}`, value);
  }
}

/** Test helper: clear the in-memory fallback. */
export function resetLastArticleMemory() {
  storageMemory.clear();
}

export function rememberLastArticle(id: string) {
  if (!id) return;
  writeStored("local", LAST_KEY, id);
}

export function getLastArticleId(): string | null {
  const id = readStored("local", LAST_KEY);
  return id && id.length > 0 ? id : null;
}

/** Router path for resuming the last article, or null when there is none. */
export function lastArticlePath(): string | null {
  const id = getLastArticleId();
  return id ? `/article/${id}` : null;
}

export function saveScroll(id: string, y: number) {
  if (!id) return;
  writeStored("session", `${SCROLL_PREFIX}${id}`, String(Math.max(0, Math.round(y))));
}

export function loadScroll(id: string): number | null {
  if (!id) return null;
  const raw = readStored("session", `${SCROLL_PREFIX}${id}`);
  if (raw == null) return null;
  const y = Number(raw);
  return Number.isFinite(y) ? y : null;
}

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

export function shouldApplyLoad(requestSeq: number, latestSeq: number): boolean {
  return requestSeq === latestSeq;
}

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

  const loadSeq = useRef(0);
  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    if (!id) {
      if (!shouldApplyLoad(seq, loadSeq.current)) return;
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
      if (!shouldApplyLoad(seq, loadSeq.current)) return;
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
      if (!shouldApplyLoad(seq, loadSeq.current)) return;
      setArticle(null);
      setParagraphs([]);
      setTranslations({});
      setError(String(e));
    } finally {
      if (shouldApplyLoad(seq, loadSeq.current)) setLoading(false);
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
