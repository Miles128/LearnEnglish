import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
} from "react";
import Markdown from "react-markdown";
import { Link, useParams } from "react-router-dom";
import { api, Article, TranslationRow } from "../api";
import {
  defaultReadingPrefs,
  readingCssVars,
  resolveReadingPrefs,
  type ResolvedReading,
} from "../readingPrefs";
import { renderAnnotatedParagraph } from "../annotateText";
import { shouldRenderMarkdown } from "../markdown";
import { getTts } from "../tts";
import {
  defaultDifficultyPrefs,
  ensureLexiconLoaded,
  isCefrLevel,
  isFreqBand,
  lookupWord,
  type DifficultyPrefs,
} from "../wordLevels";

type Popover = {
  x: number;
  y: number;
  text: string;
  translation?: string;
  loading?: boolean;
  error?: string;
};

type SpeakTarget =
  | { kind: "article" }
  | { kind: "paragraph"; index: number }
  | { kind: "word" };

export default function Reader() {
  const { id } = useParams();
  const [article, setArticle] = useState<Article | null>(null);
  const [paragraphs, setParagraphs] = useState<string[]>([]);
  const [translations, setTranslations] = useState<Record<string, string>>({});
  const [vocabTerms, setVocabTerms] = useState<string[]>([]);
  const [prefs, setPrefs] = useState<DifficultyPrefs>(defaultDifficultyPrefs);
  const [reading, setReading] = useState<ResolvedReading>(() =>
    resolveReadingPrefs(defaultReadingPrefs()),
  );
  const [lexReady, setLexReady] = useState(false);
  const [showFullZh, setShowFullZh] = useState(false);
  const [visibleParas, setVisibleParas] = useState<Record<number, boolean>>({});
  const [busyFull, setBusyFull] = useState(false);
  const [busyPara, setBusyPara] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [popover, setPopover] = useState<Popover | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [speaking, setSpeaking] = useState(false);
  const [speakTarget, setSpeakTarget] = useState<SpeakTarget | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const clickGuardRef = useRef(false);

  const loadVocabTerms = useCallback(async () => {
    try {
      const list = await api.listVocab("learning");
      setVocabTerms(list.map((v) => v.term));
    } catch {
      // vocab highlight is optional if list fails
    }
  }, []);

  const loadPrefs = useCallback(async () => {
    try {
      const cfg = await api.getConfig();
      setPrefs({
        cefrLevel: isCefrLevel(cfg.cefr_level) ? cfg.cefr_level : "B1",
        freqBand: isFreqBand(cfg.freq_band) ? cfg.freq_band : 3000,
      });
      setReading(resolveReadingPrefs(cfg));
    } catch {
      setPrefs(defaultDifficultyPrefs());
      setReading(resolveReadingPrefs(defaultReadingPrefs()));
    }
  }, []);

  const load = useCallback(async () => {
    if (!id) return;
    setError(null);
    try {
      const a = await api.getArticle(id);
      setArticle(a);
      const paras = await api.getParagraphs(id);
      setParagraphs(paras);
      const rows = await api.listParagraphTranslations(id);
      const map: Record<string, string> = {};
      rows.forEach((r: TranslationRow) => {
        map[r.scope_key] = r.translated_text;
      });
      setTranslations(map);
      await Promise.all([loadVocabTerms(), loadPrefs()]);
    } catch (e) {
      setError(String(e));
    }
  }, [id, loadVocabTerms, loadPrefs]);

  useEffect(() => {
    void ensureLexiconLoaded()
      .then(() => setLexReady(true))
      .catch(() => setLexReady(true));
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    function onDocMouseDown(e: globalThis.MouseEvent) {
      if (!rootRef.current?.contains(e.target as Node)) {
        setPopover(null);
      }
    }
    document.addEventListener("mousedown", onDocMouseDown);
    return () => document.removeEventListener("mousedown", onDocMouseDown);
  }, []);

  useEffect(() => {
    const tts = getTts();
    return tts.subscribe((isSpeaking) => {
      setSpeaking(isSpeaking);
      if (!isSpeaking) {
        setSpeakTarget(null);
      }
    });
  }, []);

  useEffect(() => {
    return () => {
      getTts().stop();
    };
  }, []);

  const title = useMemo(() => article?.title ?? "阅读", [article]);

  const asMarkdown = useMemo(() => {
    if (!article) return false;
    const body = paragraphs.length > 0 ? paragraphs.join("\n\n") : article.content_text;
    return shouldRenderMarkdown(article.url, body);
  }, [article, paragraphs]);

  function startSpeak(target: SpeakTarget, chunks: string[]) {
    setSpeakTarget(target);
    getTts().speakChunks(chunks);
  }

  function stopSpeak() {
    getTts().stop();
    setSpeakTarget(null);
  }

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

  async function showMeaning(opts: {
    text: string;
    x: number;
    y: number;
    bundledZh?: string;
  }) {
    const { text, x, y, bundledZh } = opts;
    const fromLexicon = bundledZh || lookupWord(text)?.zh;
    if (fromLexicon) {
      setPopover({
        x,
        y,
        text,
        translation: fromLexicon,
        loading: false,
      });
      return;
    }

    setPopover({ x, y, text, loading: true });
    if (!id) return;
    try {
      const row = await api.translateSelection(id, text);
      setPopover((p) =>
        p && p.text === text
          ? { ...p, translation: row.translated_text, loading: false }
          : p,
      );
    } catch (err) {
      setPopover((p) =>
        p && p.text === text
          ? { ...p, error: String(err), loading: false }
          : p,
      );
    }
  }

  async function toggleFullTranslation() {
    if (!id) return;
    if (showFullZh) {
      setShowFullZh(false);
      return;
    }
    setBusyFull(true);
    setError(null);
    try {
      const rows = await api.translateFullArticle(id);
      const map: Record<string, string> = { ...translations };
      rows.forEach((r) => {
        map[r.scope_key] = r.translated_text;
      });
      setTranslations(map);
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
  }

  async function addToVocab() {
    if (!popover || !id) return;
    try {
      await api.addVocab({
        term: popover.text,
        contextSentence: findContext(paragraphs, popover.text),
        articleId: id,
        definitionZh: popover.translation ?? null,
      });
      setToast(`已加入生词库：${popover.text}`);
      setPopover(null);
      await loadVocabTerms();
      setTimeout(() => setToast(null), 2500);
    } catch (e) {
      setError(String(e));
    }
  }

  if (!article) {
    return (
      <div className="page">
        <Link to="/" className="back">
          ← 返回
        </Link>
        {error ? <p className="banner err">{error}</p> : <p className="muted">加载中…</p>}
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
      <header className="page-header">
        <div>
          <Link to="/" className="back">
            ← 返回
          </Link>
          <h1>{title}</h1>
          {article.title_zh && <p className="article-title-zh">{article.title_zh}</p>}
          <p className="muted">
            {article.source} · {labelCategory(article.category)} · 难度 {prefs.cefrLevel} /{" "}
            {prefs.freqBand / 1000}k
          </p>
        </div>
        <div className="page-header-actions">
          <button
            className="btn"
            type="button"
            onClick={speakArticle}
            disabled={paragraphs.length === 0}
            title={articleSpeaking ? "停止朗读" : "朗读全文"}
          >
            {articleSpeaking ? "停止朗读" : "朗读全文"}
          </button>
          <button className="btn" onClick={toggleFullTranslation} disabled={busyFull}>
            {busyFull ? "…" : showFullZh ? "隐藏译文" : "全文翻译"}
          </button>
        </div>
      </header>

      {error && <p className="banner err">{error}</p>}
      {toast && <p className="banner ok">{toast}</p>}

      <article className="article-body" onMouseUp={onMouseUp}>
        {paragraphs.map((p, i) => {
          const paraSpeaking =
            speaking && speakTarget?.kind === "paragraph" && speakTarget.index === i;
          return (
            <div key={i} className="para-block">
              <div className="para-gutter">
                <button
                  className="para-btn"
                  type="button"
                  title="翻译本段"
                  onClick={() => void translatePara(i)}
                  disabled={busyPara === i}
                >
                  {busyPara === i ? "…" : visibleParas[i] ? "隐" : "译"}
                </button>
                <button
                  className={`para-btn${paraSpeaking ? " active" : ""}`}
                  type="button"
                  title={paraSpeaking ? "停止朗读" : "朗读本段"}
                  onClick={() => speakParagraph(i)}
                >
                  {paraSpeaking ? "停" : "读"}
                </button>
              </div>
              <div className="para-content">
                {asMarkdown ? (
                  <div className="md-preview">
                    <Markdown
                      components={{
                        a: ({ href, children }) => (
                          <a href={href} target="_blank" rel="noreferrer">
                            {children}
                          </a>
                        ),
                        p: ({ children }) => (
                          <p>
                            {lexReady && typeof children === "string"
                              ? renderAnnotatedParagraph(
                                  children,
                                  prefs,
                                  vocabTerms,
                                  onHardWordClick,
                                )
                              : children}
                          </p>
                        ),
                      }}
                    >
                      {p}
                    </Markdown>
                  </div>
                ) : (
                  <p>
                    {lexReady
                      ? renderAnnotatedParagraph(p, prefs, vocabTerms, onHardWordClick)
                      : p}
                  </p>
                )}
                {(showFullZh || visibleParas[i]) && translations[String(i)] && (
                  <p className="zh">{translations[String(i)]}</p>
                )}
              </div>
            </div>
          );
        })}
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
        <div
          className="selection-pop"
          style={{ left: popover.x, top: popover.y + 12 }}
        >
          <div className="pop-term">{popover.text}</div>
          {popover.loading && <div className="muted">翻译中…</div>}
          {popover.error && <div className="err-inline">{popover.error}</div>}
          {popover.translation && <div className="pop-zh">{popover.translation}</div>}
          <div className="pop-actions">
            <button
              className="btn small"
              type="button"
              onClick={() => speakWord(popover.text)}
            >
              {speaking && speakTarget?.kind === "word" ? "停止" : "朗读"}
            </button>
            <button className="btn small primary" onClick={() => void addToVocab()}>
              加入生词库
            </button>
            <button className="btn small" onClick={() => setPopover(null)}>
              关闭
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function findContext(paragraphs: string[], term: string): string {
  const lower = term.toLowerCase();
  const hit = paragraphs.find((p) => p.toLowerCase().includes(lower));
  return hit ?? term;
}

function labelCategory(c: string) {
  const map: Record<string, string> = {
    tech: "科技",
    finance: "财经",
    world: "国际",
    other: "其他",
  };
  return map[c] ?? c;
}
