import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { open } from "@tauri-apps/plugin-dialog";
import { api, Article, FeedCategory, RefreshResult } from "../api";
import { estimateKnownPercent } from "../knownPercent";
import { useAppConfig, useVocab } from "../store";
import { ensureLexiconLoaded, isFreqBand, type FreqBand } from "../wordLevels";
import ImportRow from "../components/ImportRow";
import SourceBoard, { type SourceSection } from "../components/SourceBoard";
import ManageFeedsDrawer from "./ManageFeedsDrawer";

const PAGE_SIZE = 60;

export default function Home() {
  const navigate = useNavigate();
  const [category, setCategory] = useState("all");
  const [categories, setCategories] = useState<FeedCategory[]>([]);
  const [articles, setArticles] = useState<Article[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [importUrl, setImportUrl] = useState("");
  const [importing, setImporting] = useState(false);
  const [manageOpen, setManageOpen] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { cfg } = useAppConfig();
  const { learningTerms } = useVocab();
  const freqBand: FreqBand = isFreqBand(cfg.freq_band) ? cfg.freq_band : 3000;

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      await ensureLexiconLoaded();
      const [list, cats] = await Promise.all([
        api.listArticles(
          category === "all" ? undefined : category,
          PAGE_SIZE,
          0,
        ),
        api.listFeedCategories().catch(() => [] as FeedCategory[]),
      ]);
      setArticles(list);
      setHasMore(list.length >= PAGE_SIZE);
      setCategories(cats);
      if (cfg.api_key) {
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
  }, [category, cfg.api_key]);

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

      <ImportRow
        importing={importing}
        importUrl={importUrl}
        onImportUrlChange={setImportUrl}
        onImport={(e) => void onImport(e)}
        onImportFile={() => void onImportFile()}
      />

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
          <SourceBoard
            key={sec.source}
            section={sec}
            categories={categories}
            knownPctById={knownPctById}
          />
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
