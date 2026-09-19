import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from "react";
import { useParams } from "react-router-dom";
import { listen } from "@tauri-apps/api/event";
import { api, type FeedCategory, type TranslateProgress } from "../api";
import {
  readingCssVars,
  resolveReadingPrefs,
  type ResolvedReading,
} from "../readingPrefs";
import { AnnotatedPara } from "../annotateText";
import { bundledGloss, isPhraseSelection } from "../wordResolve";
import SelectionPopover from "../components/SelectionPopover";
import ReaderParagraph from "../components/ReaderParagraph";
import { useAppConfig, useVocab } from "../store";
import { loadScroll, rememberLastArticle, saveScroll, useArticle } from "../useArticle";
import { useTts } from "../useTts";
import { useWordPopover } from "../useWordPopover";
import {
  applyTranslateProgress,
  categoryLabel,
  findContext,
  shouldRenderMarkdown,
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
  const [categories, setCategories] = useState<FeedCategory[]>([]);
  const [likedOverride, setLikedOverride] = useState<boolean | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const clickGuardRef = useRef(false);
  const readCompletedRef = useRef(false);
  /** Accumulated visible+focused dwell, used for the finish threshold. */
  const dwellMsRef = useRef(0);
  const atBottomRef = useRef(false);
  const wordCountRef = useRef(0);

  const tts = useTts();
  const { speaking, speakTarget, startSpeak, stopSpeak } = tts;
  const { cfg } = useAppConfig();
  const {
    learningTerms: vocabTerms,
    knownTerms,
    refreshLearningTerms,
    markKnown,
    unmarkKnown,
  } = useVocab();
  const prefs: DifficultyPrefs = useMemo(
    () => ({
      cefrLevel: isCefrLevel(cfg.cefr_level) ? cfg.cefr_level : "B1",
      freqBand: isFreqBand(cfg.freq_band) ? cfg.freq_band : 3000,
    }),
    [cfg.cefr_level, cfg.freq_band],
  );
  const reading: ResolvedReading = useMemo(() => resolveReadingPrefs(cfg), [cfg]);
  const {
    popover,
    setPopover,
    closePopover,
    toast,
    showMeaning,
    speakWord,
    addToVocab,
    addToPhrase,
  } = useWordPopover({
    articleId: id ?? null,
    tts,
    localGloss: (term) => lookupWord(term)?.zh ?? bundledGloss(term),
    translate: async (term) => {
      if (!id) throw new Error("文章未加载");
      const row = await api.translateSelection(id, term);
      return row.translated_text;
    },
    contextFor: (source, term) => findContext(paragraphs, source ?? term),
    onError: (m) => setError(m),
    onVocabAdded: () => void refreshLearningTerms(),
  });

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
  }, [setPopover]);

  const title = useMemo(() => article?.title ?? "阅读", [article]);
  const liked = likedOverride ?? article?.liked ?? false;

  useEffect(() => {
    wordCountRef.current = article?.word_count ?? 0;
  }, [article]);

  /** Finish = reached the bottom AND dwelled at least words/200 minutes. */
  const tryComplete = useCallback(() => {
    if (!id || readCompletedRef.current) return;
    if (!atBottomRef.current) return;
    const wc = wordCountRef.current;
    const requiredMs = wc > 0 ? (wc / 200) * 60_000 : 0;
    if (dwellMsRef.current < requiredMs) return;
    readCompletedRef.current = true;
    void api.markArticleProgress(id, 0, true).catch(() => undefined);
  }, [id]);

  // Reading-time tracking: flush while the window is visible AND focused,
  // on losing focus/hiding, and on unmount. Capped per flush so sleep/resume
  // can't inflate it.
  useEffect(() => {
    if (!id) return;
    dwellMsRef.current = 0;
    atBottomRef.current = false;
    let flushedAt = Date.now();
    const flush = () => {
      const now = Date.now();
      const delta = Math.min(now - flushedAt, 60_000);
      flushedAt = now;
      if (delta >= 1000) {
        dwellMsRef.current += delta;
        void api
          .markArticleProgress(id, delta, readCompletedRef.current)
          .catch(() => undefined);
        tryComplete();
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
  }, [id, tryComplete]);

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
    atBottomRef.current = false;
    setLikedOverride(null);
    let lastSaved = 0;
    const onScroll = () => {
      const now = Date.now();
      if (now - lastSaved > 500) {
        lastSaved = now;
        saveScroll(id, window.scrollY);
      }
      const doc = document.documentElement;
      atBottomRef.current =
        window.innerHeight + window.scrollY >= doc.scrollHeight - 400;
      if (atBottomRef.current) tryComplete();
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => {
      window.removeEventListener("scroll", onScroll);
      saveScroll(id, window.scrollY);
    };
  }, [id, tryComplete]);

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
          knownTerms={knownTerms}
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
    [lexReady, prefs, vocabTerms, knownTerms, onHardWordClick],
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

  async function toggleKnown(term: string) {
    const key = term.trim().toLowerCase();
    try {
      if (knownTerms.includes(key)) await unmarkKnown(key);
      else await markKnown(key);
    } catch (e) {
      setError(String(e));
    }
  }

  if (view !== "ready" || !article) {
    return (
      <div className="page">
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
      <header className="page-header page-header-slim page-header-end">
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
                knownTerms={knownTerms}
                onHardClick={onHardWordClick}
              />
            ) : (
              title
            )}
          </h1>
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
          onAddPhrase={
            popover.source && isPhraseSelection(popover.source)
              ? () => void addToPhrase()
              : undefined
          }
          onToggleKnown={
            popover.source && isPhraseSelection(popover.source)
              ? undefined
              : () => void toggleKnown(popover.text)
          }
          known={knownTerms.includes(popover.text.trim().toLowerCase())}
          onClose={closePopover}
        />
      )}
    </div>
  );
}
