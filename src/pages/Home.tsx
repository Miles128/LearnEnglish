import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api, Article, RefreshResult } from "../api";

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
  const [category, setCategory] = useState("all");
  const [articles, setArticles] = useState<Article[]>([]);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await api.listArticles(category === "all" ? undefined : category);
      setArticles(list);
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
          // LLM 未配置时忽略，英文标题仍可显示
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
    try {
      const result: RefreshResult = await api.refreshFeeds();
      setMessage(
        `刷新完成：更新 ${result.added_or_updated} 篇，标题翻译 ${result.titles_translated}，跳过短文 ${result.skipped_short}` +
          (result.errors.length ? `；${result.errors.length} 个问题` : ""),
      );
      await load();
    } catch (e) {
      setError(String(e));
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>今日阅读</h1>
          <p className="muted">按 RSS 源分板块 · 标题含中文翻译</p>
        </div>
        <button className="btn primary" onClick={onRefresh} disabled={refreshing}>
          {refreshing ? "刷新中…" : "刷新"}
        </button>
      </header>

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
          <p>还没有文章。点击「刷新」从免费 RSS 源拉取全文。</p>
          <p className="muted" style={{ marginTop: 8 }}>
            请在 LearnEnglish 桌面窗口中操作，不要用浏览器打开 localhost:1420。
          </p>
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
              {sec.articles.map((a) => (
                <li key={a.id}>
                  <Link to={`/article/${a.id}`} className="article-row">
                    <h3 className="article-title-en">{a.title}</h3>
                    {a.title_zh ? (
                      <p className="article-title-zh">{a.title_zh}</p>
                    ) : (
                      <p className="article-title-zh muted">中文标题待翻译…</p>
                    )}
                    <p className="snippet">{a.content_text.slice(0, 140)}…</p>
                  </Link>
                </li>
              ))}
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
    const existing = map.get(a.source);
    if (existing) {
      existing.articles.push(a);
    } else {
      map.set(a.source, {
        source: a.source,
        category: a.category,
        articles: [a],
      });
    }
  }
  return Array.from(map.values());
}

function labelCategory(c: string) {
  return CATEGORIES.find((x) => x.id === c)?.label ?? c;
}
