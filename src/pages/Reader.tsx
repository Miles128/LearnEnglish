import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from "react";
import { Link, useParams } from "react-router-dom";
import { listen } from "@tauri-apps/api/event";
import { api, type FeedCategory, type TranslateProgress } from "../api";
import {
  readingCssVars,
  resolveReadingPrefs,
  type ResolvedReading,
} from "../readingPrefs";
import { AnnotatedPara } from "../annotateText";
import { shouldRenderMarkdown } from "../markdown";
import { bundledGloss, prepareLookup } from "../wordLookup";
import { ensureDetailsLoaded, lookupDetail } from "../wordDetails";
import SelectionPopover, { type Popover } from "../components/SelectionPopover";
import ReaderParagraph from "../components/ReaderParagraph";
import { useAppConfig, useVocab } from "../store";
import { useArticle } from "../useArticle";
import { useTts } from "../useTts";
import { useEscapeKey } from "../useEscapeKey";
import { loadScroll, rememberLastArticle, saveScroll } from "../lastArticle";
import {
  applyTranslateProgress,
  categoryLabel,
  findContext,
  translateProgressLabel,
} from "../readerUtils";
import {
  ensureLexiconLoaded,
  isCefrLevel,
  isFreqBand,
  lookupWord,
  type DifficultyPrefs,
} from "../wordLevels";

export default function Reader() {
  const { id } = useParams();
  const {
    article,
    paragraphs,
    translations,
    setTranslations,
    error,
    setError,
    view,
  } = useArticle(id);
  const [lexReady, setLexReady] = useState(false);
  const [showFullZh, setShowFullZh] = useState(false);
  const [visibleParas, setVisibleParas] = useState<Record<number, boolean>>({});
  const [busyFull, setBusyFull] = useState(false);
  const [fullProgress, setFullProgress] = useState<TranslateProgress | null>(null);
  const [busyPara, setBusyPara] = useState<number | null>(null);
  const [popover, setPopover] = useState<Popover | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [categories, setCategories] = useState<FeedCategory[]>([]);
  const [likedOverride, setLikedOverride] = useState<boolean | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const clickGuardRef = useRef(false);
  const readCompletedRef = useRef(false);

  const { speaking, speakTarget, startSpeak, stopSpeak } = useTts();
  const { cfg } = useAppConfig();
  const { learningTerms: vocabTerms, refreshLearningTerms } = useVocab();
  const prefs: DifficultyPrefs = useMemo(
    () => ({
      cefrLevel: isCefrLevel(cfg.cefr_level) ? cfg.cefr_level : "B1",
      freqBand: isFreqBand(cfg.freq_band) ? cfg.freq_band : 3000,
    }),
    [cfg.cefr_level, cfg.freq_band],
  );
  const reading: ResolvedReading = useMemo(() => resolveReadingPrefs(cfg), [cfg]);
  const closePopover = useCallback(() => setPopover(null), []);
  useEscapeKey(popover != null, closePopover);

  useEffect(() => {
    void ensureLexiconLoaded()
      .then(() => setLexReady(true))
      .catch(() => setLexReady(true));
    void api.listFeedCategories().then(setCategories).catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!id) return;
    let unlisten: (() => void) | undefined;
    void listen<TranslateProgress>("translate-progress", (event) => {
      const next = event.payload;
      if (next.article_id !== id) return;
      setTranslations((map) => applyTranslateProgress(map, next));
      if (next.done) {
        setFullProgress(null);
        return;
      }
      setFullProgress(next);
      setShowFullZh(true);
    }).then((fn) => {
      unlisten = fn;
    });
    return () => unlisten?.();
  }, [id, setTranslations]);

  useEffect(() => {
    function onDocMouseDown(e: globalThis.MouseEvent) {
      if (!rootRef.current?.contains(e.target as Node)) {
        setPopover(null);
      }
    }
    document.addEventListener("mousedown", onDocMouseDown);
    return () => document.removeEventListener("mousedown", onDocMouseDown);
  }, []);

  const title = useMemo(() => article?.title ?? "阅读", [article]);
  const liked = likedOverride ?? article?.liked ?? false;

  // Reading-time tracking: flush while the window is visible AND focused,
  // on losing focus/hiding, and on unmount. Capped per flush so sleep/resume
  // can't inflate it.
  useEffect(() => {
    if (!id) return;
    let flushedAt = Date.now();
    const flush = () => {
      const now = Date.now();
      const delta = Math.min(now - flushedAt, 60_000);
      flushedAt = now;
      if (delta >= 1000) {
        void api
          .markArticleProgress(id, delta, readCompletedRef.current)
          .catch(() => undefined);
      }
    };
    const isCounting = () => !document.hidden && document.hasFocus();
    const flushIfCounting = () => {
      if (isCounting()) flush();
    };
    const flushIfNotCounting = () => {
      if (!isCounting()) flush();
    };
    const timer = window.setInterval(flushIfCounting, 15_000);
    document.addEventListener("visibilitychange", flushIfNotCounting);
    window.addEventListener("blur", flushIfNotCounting);
    const onFocus = () => {
      flushedAt = Date.now();
    };
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", flushIfNotCounting);
      window.removeEventListener("blur", flushIfNotCounting);
      window.removeEventListener("focus", onFocus);
      if (!document.hidden && document.hasFocus()) flush();
    };
  }, [id]);

  // Remember the article so other pages can offer "continue reading".
  useEffect(() => {
    if (id) rememberLastArticle(id);
  }, [id]);

  // Restore the previous scroll offset once the body is on screen.
  const restoredRef = useRef<string | null>(null);
  useEffect(() => {
    if (!id || view !== "ready" || restoredRef.current === id) return;
    restoredRef.current = id;
    const y = loadScroll(id);
    if (y && y > 0) {
      requestAnimationFrame(() => window.scrollTo({ top: y, behavior: "auto" }));
    }
  }, [id, view]);

  // Read-to-the-end detection + scroll memory.
  useEffect(() => {
    if (!id) return;
    readCompletedRef.current = false;
    setLikedOverride(null);
    let lastSaved = 0;
    const onScroll = () => {
      const now = Date.now();
      if (now - lastSaved > 500) {
        lastSaved = now;
        saveScroll(id, window.scrollY);
      }
      if (readCompletedRef.current) return;
      const doc = document.documentElement;
      if (window.innerHeight + window.scrollY >= doc.scrollHeight - 400) {
        readCompletedRef.current = true;
        void api.markArticleProgress(id, 0, true).catch(() => undefined);
      }
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => {
      window.removeEventListener("scroll", onScroll);
      saveScroll(id, window.scrollY);
    };
  }, [id]);

  function toggleLiked() {
    if (!id) return;
    const next = !(likedOverride ?? article?.liked ?? false);
    setLikedOverride(next);
    api.setArticleLiked(id, next).catch(() => setLikedOverride(null));
  }

  const asMarkdown = useMemo(() => {
    if (!article) return false;
    const body = paragraphs.length > 0 ? paragraphs.join("\n\n") : article.content_text;
    return shouldRenderMarkdown(article.url, body);
  }, [article, paragraphs]);

  function speakArticle() {
    if (speaking && speakTarget?.kind === "article") {
      stopSpeak();
      return;
    }
    if (paragraphs.length === 0) return;
    startSpeak({ kind: "article" }, paragraphs);
  }

  function speakParagraph(index: number) {
    if (speaking && speakTarget?.kind === "paragraph" && speakTarget.index === index) {
      stopSpeak();
      return;
    }
    const text = paragraphs[index];
    if (!text) return;
    startSpeak({ kind: "paragraph", index }, [text]);
  }

  function speakWord(text: string) {
    if (speaking && speakTarget?.kind === "word") {
      stopSpeak();
      return;
    }
    if (!text.trim()) return;
    startSpeak({ kind: "word" }, [text]);
  }

  const showMeaning = useCallback(
    async function showMeaning(opts: {
      text: string;
      x: number;
      y: number;
      bundledZh?: string;
    }) {
      const { text, x, y, bundledZh } = opts;
      // Clicking an inflected word looks it up as its base form.
      const { term: ruleTerm, source } = prepareLookup(text);
      let detail: ReturnType<typeof lookupDetail> = null;
      try {
        await ensureDetailsLoaded();
        detail = lookupDetail(source) ?? lookupDetail(ruleTerm);
      } catch {
        // details are optional — fall through to the bundled gloss / LLM
      }
      const term = detail?.lemma || ruleTerm;
      if (detail) {
        setPopover({ x, y, text: term, source, detail, origin: "local", loading: false });
        return;
      }
      const fromLexicon = bundledZh || lookupWord(term)?.zh || bundledGloss(term);
      if (fromLexicon) {
        setPopover({
          x,
          y,
          text: term,
          source,
          translation: fromLexicon,
          origin: "local",
          loading: false,
        });
        return;
      }

      setPopover({ x, y, text: term, source, loading: true });
      if (!id) return;
      try {
        const row = await api.translateSelection(id, term);
        setPopover((p) =>
          p && p.text === term
            ? { ...p, translation: row.translated_text, origin: "ai" as const, loading: false }
            : p,
        );
      } catch (err) {
        setPopover((p) =>
          p && p.text === term
            ? { ...p, error: String(err), loading: false }
            : p,
        );
      }
    },
    [id],
  );

  const onHardWordClick = useCallback(
    function onHardWordClick(info: {
      term: string;
      display: string;
      zh?: string;
      clientX: number;
      clientY: number;
    }) {
      clickGuardRef.current = true;
      void showMeaning({
        text: info.term,
        x: info.clientX || 80,
        y: info.clientY || 120,
        bundledZh: info.zh,
      });
    },
    [showMeaning],
  );

  const annotateChildren = useCallback(
    (children: ReactNode): ReactNode => {
      if (!lexReady) return children;
      const annotate = (text: string, key?: number) => (
        <AnnotatedPara
          key={key}
          text={text}
          prefs={prefs}
          learningTerms={vocabTerms}
          onHardClick={onHardWordClick}
        />
      );
      if (typeof children === "string") return annotate(children);
      if (Array.isArray(children)) {
        return children.map((child, i) =>
          typeof child === "string" ? annotate(child, i) : child,
        );
      }
      return children;
    },
    [lexReady, prefs, vocabTerms, onHardWordClick],
  );

  async function toggleFullTranslation() {
    if (!id) return;
    if (showFullZh) {
      setShowFullZh(false);
      return;
    }
    setBusyFull(true);
    setError(null);
    try {
      const result = await api.translateFullArticle(id);
      const map: Record<string, string> = { ...translations };
      result.rows.forEach((r) => {
        map[r.scope_key] = r.translated_text;
      });
      setTranslations(map);
      if (result.errors.length > 0) {
        setError(`部分段落翻译失败（${result.errors.length} 段），其余译文已就绪。`);
      }
      setShowFullZh(true);
      const all: Record<number, boolean> = {};
      paragraphs.forEach((_, i) => {
        all[i] = true;
      });
      setVisibleParas(all);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusyFull(false);
    }
  }

  async function translatePara(index: number) {
    if (!id) return;
    if (visibleParas[index] && translations[String(index)]) {
      setVisibleParas((v) => ({ ...v, [index]: false }));
      return;
    }
    if (translations[String(index)]) {
      setVisibleParas((v) => ({ ...v, [index]: true }));
      return;
    }
    setBusyPara(index);
    setError(null);
    try {
      const row = await api.translateParagraph(id, index, paragraphs[index]);
      setTranslations((t) => ({ ...t, [String(index)]: row.translated_text }));
      setVisibleParas((v) => ({ ...v, [index]: true }));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusyPara(null);
    }
  }

  async function onMouseUp(e: MouseEvent) {
    if (clickGuardRef.current) {
      clickGuardRef.current = false;
      return;
    }
    const sel = window.getSelection();
    const text = sel?.toString().trim() ?? "";
    if (!text || text.length > 120) {
      setPopover(null);
      return;
    }
    await showMeaning({ text, x: e.clientX, y: e.clientY });
  }

  async function addToVocab() {
    if (!popover || !id) return;
    try {
      await api.addVocab({
        term: popover.text,
        contextSentence: findContext(paragraphs, popover.source ?? popover.text),
        articleId: id,
        definitionZh: popover.translation ?? null,
      });
      setToast(`已加入生词库：${popover.text}`);
      setPopover(null);
      await refreshLearningTerms();
      setTimeout(() => setToast(null), 2500);
    } catch (e) {
      setError(String(e));
    }
  }

  if (view !== "ready" || !article) {
    return (
      <div className="page">
        <Link to="/" className="back">
          ← 返回
        </Link>
        {view === "error" && error ? (
          <p className="banner err">{error}</p>
        ) : view === "missing" ? (
          <p className="muted">找不到这篇文章。</p>
        ) : (
          <p className="muted">加载中…</p>
        )}
      </div>
    );
  }

  const articleSpeaking = speaking && speakTarget?.kind === "article";

  return (
    <div
      className={`page reader${reading.fullWidth ? " reader-full" : ""}`}
      ref={rootRef}
      style={readingCssVars(reading)}
    >
      <header className="page-header page-header-slim">
        <Link to="/" className="back">
          ← 返回
        </Link>
        <div className="page-header-actions">
          <button
            className="btn"
            type="button"
            onClick={toggleLiked}
            title={liked ? "取消收藏" : "收藏，之后优先推荐同类文章"}
          >
            {liked ? "★ 已收藏" : "☆ 收藏"}
          </button>
          <button
            className="btn"
            type="button"
            onClick={speakArticle}
            disabled={paragraphs.length === 0}
            title={articleSpeaking ? "停止朗读" : "朗读全文"}
          >
            {articleSpeaking ? "停止朗读" : "朗读全文"}
          </button>
          <button className="btn" onClick={() => void toggleFullTranslation()} disabled={busyFull}>
            {busyFull
              ? (translateProgressLabel(fullProgress) ?? "…")
              : showFullZh
                ? "隐藏译文"
                : "全文翻译"}
          </button>
        </div>
      </header>

      {error && <p className="banner err">{error}</p>}
      {toast && <p className="banner ok">{toast}</p>}

      <article className="article-body" onMouseUp={onMouseUp}>
        <div className="reader-heading">
          <h1>
            {lexReady ? (
              <AnnotatedPara
                text={title}
                prefs={prefs}
                learningTerms={vocabTerms}
                onHardClick={onHardWordClick}
              />
            ) : (
              title
            )}
          </h1>
          {article.title_zh && <p className="article-title-zh">{article.title_zh}</p>}
          {article.summary_zh && (
            <p className="article-summary-zh">{article.summary_zh}</p>
          )}
          <p className="muted">
            {article.source} · {categoryLabel(article.category, categories)} · 难度{" "}
            {prefs.cefrLevel} / {prefs.freqBand / 1000}k
          </p>
        </div>
        {paragraphs.map((p, i) => (
          <ReaderParagraph
            key={i}
            text={p}
            asMarkdown={asMarkdown}
            annotateChildren={annotateChildren}
            zhVisible={!!((showFullZh || visibleParas[i]) && translations[String(i)])}
            zhText={translations[String(i)]}
            translating={busyPara === i}
            visiblePara={!!visibleParas[i]}
            paraSpeaking={
              !!(speaking && speakTarget?.kind === "paragraph" && speakTarget.index === i)
            }
            onTranslate={() => void translatePara(i)}
            onSpeak={() => speakParagraph(i)}
          />
        ))}
      </article>

      <p className="muted source-link">
        原文：{" "}
        {article.url.startsWith("file://") ? (
          <span>本地导入 · {article.title}</span>
        ) : (
          <a href={article.url} target="_blank" rel="noreferrer">
            {article.url}
          </a>
        )}
      </p>

      {popover && (
        <SelectionPopover
          popover={popover}
          speaking={speaking}
          speakTarget={speakTarget}
          onSpeakWord={speakWord}
          onAddVocab={() => void addToVocab()}
          onClose={closePopover}
        />
      )}
    </div>
  );
}
