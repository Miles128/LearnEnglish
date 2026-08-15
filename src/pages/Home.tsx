import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { open } from "@tauri-apps/plugin-dialog";
import { api, Article, FeedCategory, RefreshResult, VocabItem } from "../api";
import { estimateKnownPercent, formatKnownPercent } from "../knownPercent";
import {
  ensureLexiconLoaded,
  isFreqBand,
  type FreqBand,
} from "../wordLevels";
import ManageFeedsDrawer from "./ManageFeedsDrawer";

type SourceSection = {
  source: string;
  category: string;
  articles: Article[];
};

const PAGE_SIZE = 60;

export default function Home() {
  const navigate = useNavigate();
  const [category, setCategory] = useState("all");
  const [categories, setCategories] = useState<FeedCategory[]>([]);
  const [articles, setArticles] = useState<Article[]>([]);
  const [learningTerms, setLearningTerms] = useState<string[]>([]);
  const [freqBand, setFreqBand] = useState<FreqBand>(3000);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [importUrl, setImportUrl] = useState("");
  const [importing, setImporting] = useState(false);
  const [manageOpen, setManageOpen] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      await ensureLexiconLoaded();
      const [list, learning, cats, cfg] = await Promise.all([
        api.listArticles(
          category === "all" ? undefined : category,
          PAGE_SIZE,
          0,
        ),
        api.listVocab("learning").catch(() => [] as VocabItem[]),
        api.listFeedCategories().catch(() => [] as FeedCategory[]),
        api.getConfig().catch(() => null),
      ]);
      setArticles(list);
      setHasMore(list.length >= PAGE_SIZE);
      setLearningTerms(learning.map((v) => v.term));
      setCategories(cats);
      if (cfg && isFreqBand(cfg.freq_band)) setFreqBand(cfg.freq_band);
      if (cfg?.api_key) {
        const missing = list.some((a) => !a.title_zh);
        if (missing) {
          try {
            const n = await api.translateMissingTitles();
            if (n > 0) {
              const refreshed = await api.listArticles(
                category === "all" ? undefined : category,
                PAGE_SIZE,
                0,
              );
              setArticles(refreshed);
            }
          } catch {
            // LLM 调用失败时忽略
          }
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

  async function loadMore() {
    if (loadingMore) return;
    setLoadingMore(true);
    try {
      const next = await api.listArticles(
        category === "all" ? undefined : category,
        PAGE_SIZE,
        articles.length,
      );
      const seen = new Set(articles.map((a) => a.id));
      const merged = articles.concat(next.filter((a) => !seen.has(a.id)));
      setArticles(merged);
      setHasMore(next.length >= PAGE_SIZE);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoadingMore(false);
    }
  }

  const sections = useMemo(() => groupBySource(articles), [articles]);
  const tabCategories = useMemo(() => {
    const tabs = [{ id: "all", label: "全部" }];
    for (const c of categories) {
      tabs.push({ id: c.id, label: c.label });
    }
    return tabs;
  }, [categories]);

  // Recompute known% only when the inputs change, not on every re-render.
  const knownPctById = useMemo(() => {
    const map = new Map<string, number | null>();
    for (const a of articles) {
      map.set(
        a.id,
        estimateKnownPercent(a.content_text, learningTerms, freqBand),
      );
    }
    return map;
  }, [articles, learningTerms, freqBand]);

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

  async function onImportFile() {
    setMessage(null);
    setError(null);
    let selected: string | string[] | null;
    try {
      selected = await open({
        multiple: false,
        filters: [
          {
            name: "文档",
            extensions: ["txt", "pdf", "docx"],
          },
        ],
      });
    } catch (err) {
      setError(String(err));
      return;
    }
    if (selected === null) return;
    const path = Array.isArray(selected) ? selected[0] : selected;
    if (!path) return;

    setImporting(true);
    try {
      const article = await api.importArticleFile(path);
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
        <div className="page-header-actions">
          <button type="button" className="btn" onClick={() => setManageOpen(true)}>
            管理订阅
          </button>
          <button className="btn primary" onClick={onRefresh} disabled={refreshing}>
            {refreshing ? "刷新中…" : "刷新"}
          </button>
        </div>
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
        <button
          className="btn"
          type="button"
          disabled={importing}
          onClick={() => void onImportFile()}
        >
          导入文件
        </button>
      </form>

      <div className="tabs">
        {tabCategories.map((c) => (
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
              <span className="pill">
                {categories.find((c) => c.id === sec.category)?.label ??
                  sec.category}
              </span>
              <span className="muted">{sec.articles.length} 篇</span>
            </header>
            <ul className="article-list">
              {sec.articles.map((a) => {
                const pct = knownPctById.get(a.id) ?? null;
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

      {hasMore && (
        <div className="load-more-row">
          <button
            type="button"
            className="btn"
            onClick={() => void loadMore()}
            disabled={loadingMore}
          >
            {loadingMore ? "加载中…" : "加载更多"}
          </button>
        </div>
      )}

      <ManageFeedsDrawer
        open={manageOpen}
        onClose={() => {
          setManageOpen(false);
          void load();
        }}
      />
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
