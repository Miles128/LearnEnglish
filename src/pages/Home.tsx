import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, Article, RefreshResult, VocabItem } from "../api";
import { estimateKnownPercent, formatKnownPercent } from "../knownPercent";

const CATEGORIES = [
  { id: "all", label: "全部" },
  { id: "tech", label: "科技" },
  { id: "finance", label: "财经" },
  { id: "world", label: "国际" },
  { id: "other", label: "其他" },
];

type SourceSection = {
  source: string;
  category: string;
  articles: Article[];
};

export default function Home() {
  const navigate = useNavigate();
  const [category, setCategory] = useState("all");
  const [articles, setArticles] = useState<Article[]>([]);
  const [learningTerms, setLearningTerms] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [importUrl, setImportUrl] = useState("");
  const [importing, setImporting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [list, learning] = await Promise.all([
        api.listArticles(category === "all" ? undefined : category),
        api.listVocab("learning").catch(() => [] as VocabItem[]),
      ]);
      setArticles(list);
      setLearningTerms(learning.map((v) => v.term));
      const missing = list.some((a) => !a.title_zh);
      if (missing) {
        try {
          const n = await api.translateMissingTitles();
          if (n > 0) {
            const refreshed = await api.listArticles(
              category === "all" ? undefined : category,
            );
            setArticles(refreshed);
          }
        } catch {
          // LLM 未配置时忽略
        }
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [category]);

  useEffect(() => {
    void load();
  }, [load]);

  const sections = useMemo(() => groupBySource(articles), [articles]);

  async function onRefresh() {
    setRefreshing(true);
    setMessage(null);
    setError(null);
    await new Promise<void>((r) => requestAnimationFrame(() => r()));
    try {
      const result: RefreshResult = await api.refreshFeeds();
      setMessage(
        `新增 ${result.added_or_updated}` +
          (result.skipped_existing ? ` · 已有 ${result.skipped_existing}` : "") +
          (result.titles_translated ? ` · 译题 ${result.titles_translated}` : "") +
          (result.errors.length ? ` · ${result.errors.length} 个问题` : ""),
      );
      await load();
    } catch (e) {
      setError(String(e));
    } finally {
      setRefreshing(false);
    }
  }

  async function onImport(e: FormEvent) {
    e.preventDefault();
    const url = importUrl.trim();
    if (!url) return;
    setImporting(true);
    setMessage(null);
    setError(null);
    try {
      const article = await api.importArticleUrl(url);
      setImportUrl("");
      setMessage(`已导入：${article.title}`);
      navigate(`/article/${article.id}`);
    } catch (err) {
      setError(String(err));
    } finally {
      setImporting(false);
    }
  }

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>今日阅读</h1>
        </div>
        <button className="btn primary" onClick={onRefresh} disabled={refreshing}>
          {refreshing ? "刷新中…" : "刷新"}
        </button>
      </header>

      <form className="import-row" onSubmit={(e) => void onImport(e)}>
        <input
          className="import-input"
          type="url"
          placeholder="粘贴公开文章链接导入…"
          value={importUrl}
          onChange={(e) => setImportUrl(e.target.value)}
          disabled={importing}
        />
        <button className="btn" type="submit" disabled={importing || !importUrl.trim()}>
          {importing ? "导入中…" : "导入"}
        </button>
      </form>

      <div className="tabs">
        {CATEGORIES.map((c) => (
          <button
            key={c.id}
            className={category === c.id ? "tab active" : "tab"}
            onClick={() => setCategory(c.id)}
          >
            {c.label}
          </button>
        ))}
      </div>

      {message && <p className="banner ok">{message}</p>}
      {error && <p className="banner err">{error}</p>}
      {loading && <p className="muted">加载中…</p>}

      {!loading && articles.length === 0 && !error && (
        <div className="empty">
          <p>还没有文章。点「刷新」或粘贴链接导入。</p>
        </div>
      )}

      <div className="source-boards">
        {sections.map((sec) => (
          <section key={sec.source} className="source-board">
            <header className="source-board-head">
              <h2>{sec.source}</h2>
              <span className="pill">{labelCategory(sec.category)}</span>
              <span className="muted">{sec.articles.length} 篇</span>
            </header>
            <ul className="article-list">
              {sec.articles.map((a) => {
                const pct = estimateKnownPercent(a.content_text, learningTerms);
                const pctLabel = formatKnownPercent(pct);
                return (
                  <li key={a.id}>
                    <Link to={`/article/${a.id}`} className="article-row">
                      {pctLabel && (
                        <div className="article-row-meta">
                          <span className="known-pct">{pctLabel}</span>
                        </div>
                      )}
                      <h3 className="article-title-en">{a.title}</h3>
                      {a.title_zh ? (
                        <p className="article-title-zh">{a.title_zh}</p>
                      ) : null}
                      <p className="snippet">{a.content_text.slice(0, 140)}…</p>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}

function groupBySource(articles: Article[]): SourceSection[] {
  const map = new Map<string, SourceSection>();
  for (const a of articles) {
    const key = a.source || "其他";
    let sec = map.get(key);
    if (!sec) {
      sec = { source: key, category: a.category, articles: [] };
      map.set(key, sec);
    }
    sec.articles.push(a);
  }
  return Array.from(map.values());
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
