import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { open } from "@tauri-apps/plugin-dialog";
import { api, ArticleListItem, FeedCategory, LearningStats, RefreshResult } from "../api";
import { articleNeedsCardZh } from "../articleList";
import { formatLearningInsight } from "../learningStats";
import { estimateKnownPercent } from "../knownPercent";
import { useAppConfig, useVocab } from "../store";
import { ensureLexiconLoaded, isFreqBand, type FreqBand } from "../wordLevels";
import ImportRow from "../components/ImportRow";
import SourceBoard from "../components/SourceBoard";
import ManageFeedsDrawer from "../components/ManageFeedsDrawer";
import { groupBySource, sortSectionsByInterest } from "../sourceInterest";

const PAGE_SIZE = 60;

export default function Home() {
  const navigate = useNavigate();
  const [category, setCategory] = useState("all");
  const [categories, setCategories] = useState<FeedCategory[]>([]);
  const [articles, setArticles] = useState<ArticleListItem[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [importUrl, setImportUrl] = useState("");
  const [importing, setImporting] = useState(false);
  const [manageOpen, setManageOpen] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [learningStats, setLearningStats] = useState<LearningStats | null>(null);

  const { cfg } = useAppConfig();
  const { learningTerms } = useVocab();
  const freqBand: FreqBand = isFreqBand(cfg.freq_band) ? cfg.freq_band : 3000;
  const hasLlm = Boolean(cfg.api_key?.trim());
  const didBackfill = useRef(false);
  const [cardFillError, setCardFillError] = useState<string | null>(null);
  const [cardFilling, setCardFilling] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [list, cats, stats] = await Promise.all([
        api.listArticles(
          category === "all" ? undefined : category,
          PAGE_SIZE,
          0,
        ),
        api.listFeedCategories().catch(() => [] as FeedCategory[]),
        api.getLearningStats().catch(() => null),
        ensureLexiconLoaded().catch(() => undefined),
      ]);
      setArticles(list);
      setHasMore(list.length >= PAGE_SIZE);
      setCategories(cats);
      setLearningStats(stats);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [category]);

  useEffect(() => {
    didBackfill.current = false;
    void load();
  }, [load]);

  const fillCards = useCallback(async () => {
    setCardFilling(true);
    setCardFillError(null);
    try {
      const n = await api.fillMissingCardZh();
      if (n > 0) await load();
    } catch (e) {
      didBackfill.current = false;
      setCardFillError(String(e));
    } finally {
      setCardFilling(false);
    }
  }, [load]);

  useEffect(() => {
    if (didBackfill.current) return;
    if (!hasLlm || loading || articles.length === 0) return;
    if (!articles.some(articleNeedsCardZh)) return;
    didBackfill.current = true;
    void fillCards();
  }, [articles, hasLlm, loading, fillCards]);

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

  const sections = useMemo(
    () => sortSectionsByInterest(groupBySource(articles), Date.now()),
    [articles],
  );
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
        estimateKnownPercent(a.excerpt, learningTerms, freqBand),
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
          (result.titles_translated ? ` · 译题/简介 ${result.titles_translated}` : "") +
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

      {learningStats && (
        <p className="learning-insight">{formatLearningInsight(learningStats)}</p>
      )}
      {!hasLlm && articles.some(articleNeedsCardZh) && (
        <p className="muted">
          设置里填 API Key 后，列表会自动补中文译题和一两句简介。
        </p>
      )}
      {hasLlm && cardFilling && (
        <p className="muted">正在补中文译题与简介…</p>
      )}
      {cardFillError && (
        <p className="banner err with-action">
          <span>简介未生成：{cardFillError}</span>
          <button
            type="button"
            className="btn small"
            onClick={() => {
              didBackfill.current = true;
              void fillCards();
            }}
          >
            重试
          </button>
        </p>
      )}

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

