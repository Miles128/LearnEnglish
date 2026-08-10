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
import { shouldRenderMarkdown } from "../markdown";

type Popover = {
  x: number;
  y: number;
  text: string;
  translation?: string;
  loading?: boolean;
  error?: string;
};

export default function Reader() {
  const { id } = useParams();
  const [article, setArticle] = useState<Article | null>(null);
  const [paragraphs, setParagraphs] = useState<string[]>([]);
  const [translations, setTranslations] = useState<Record<string, string>>({});
  const [showFullZh, setShowFullZh] = useState(false);
  const [visibleParas, setVisibleParas] = useState<Record<number, boolean>>({});
  const [busyFull, setBusyFull] = useState(false);
  const [busyPara, setBusyPara] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [popover, setPopover] = useState<Popover | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

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
    } catch (e) {
      setError(String(e));
    }
  }, [id]);

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

  const title = useMemo(() => article?.title ?? "阅读", [article]);

  const asMarkdown = useMemo(() => {
    if (!article) return false;
    const body = paragraphs.length > 0 ? paragraphs.join("\n\n") : article.content_text;
    return shouldRenderMarkdown(article.url, body);
  }, [article, paragraphs]);

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
    const sel = window.getSelection();
    const text = sel?.toString().trim() ?? "";
    if (!text || text.length > 120) {
      setPopover(null);
      return;
    }
    setPopover({
      x: e.clientX,
      y: e.clientY,
      text,
      loading: true,
    });
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

  async function addToVocab() {
    if (!popover || !id) return;
    try {
      await api.addVocab({
        term: popover.text,
        contextSentence: findContext(paragraphs, popover.text),
        articleId: id,
      });
      setToast(`已加入生词库：${popover.text}`);
      setPopover(null);
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

  return (
    <div className="page reader" ref={rootRef}>
      <header className="page-header">
        <div>
          <Link to="/" className="back">
            ← 返回
          </Link>
          <h1>{title}</h1>
          {article.title_zh && <p className="article-title-zh">{article.title_zh}</p>}
          <p className="muted">
            {article.source} · {labelCategory(article.category)}
          </p>
        </div>
        <button className="btn" onClick={toggleFullTranslation} disabled={busyFull}>
          {busyFull
            ? "翻译中…"
            : showFullZh
              ? "隐藏全文翻译"
              : "显示全文翻译"}
        </button>
      </header>

      {error && <p className="banner err">{error}</p>}
      {toast && <p className="banner ok">{toast}</p>}

      <article className="article-body" onMouseUp={onMouseUp}>
        {paragraphs.map((p, i) => (
          <div key={i} className="para-block">
            <div className="para-gutter" aria-hidden>
              <button
                className="para-btn"
                title="翻译本段"
                onClick={() => void translatePara(i)}
                disabled={busyPara === i}
              >
                {busyPara === i ? "…" : visibleParas[i] ? "隐" : "译"}
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
                    }}
                  >
                    {p}
                  </Markdown>
                </div>
              ) : (
                <p>{p}</p>
              )}
              {(showFullZh || visibleParas[i]) && translations[String(i)] && (
                <p className="zh">{translations[String(i)]}</p>
              )}
            </div>
          </div>
        ))}
      </article>

      <p className="muted source-link">
        原文：{" "}
        <a href={article.url} target="_blank" rel="noreferrer">
          {article.url}
        </a>
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
  const hit = paragraphs.find((p) => p.includes(term));
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
