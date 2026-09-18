import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ArticleListItem, FeedCategory, LearningStats, RefreshResult } from "../api";
import { articleNeedsCardZh } from "../articleList";
import { formatLearningInsight } from "../learningStats";
import { estimateKnownPercent } from "../knownPercent";
import { useAppConfig, useVocab } from "../store";
import { ensureLexiconLoaded, isFreqBand, type FreqBand } from "../wordLevels";
import SourceBoard from "../components/SourceBoard";
import { groupBySource } from "../sourceInterest";
import { pickTopArticles, topPickIds } from "../topPicks";
import { applyDifficultyOrder } from "../difficultyRank";

const PAGE_SIZE = 60;

export default function Home() {
  const [category, setCategory] = useState("all");
  const [categories, setCategories] = useState<FeedCategory[]>([]);
  const [articles, setArticles] = useState<ArticleListItem[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
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
        api.listArticlesRanked(
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
      const next = await api.listArticlesRanked(
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

  // Difficulty fit nudges the backend rank: the sweet spot (a few new words
  // per paragraph) floats up, word walls and trivially-easy pieces sink.
  const orderedArticles = useMemo(
    () => applyDifficultyOrder(articles, knownPctById),
    [articles, knownPctById],
  );
  const topPicks = useMemo(() => pickTopArticles(orderedArticles), [orderedArticles]);
  const picksIds = useMemo(() => topPickIds(topPicks), [topPicks]);
  // Difficulty-adjusted rank order: section order = first appearance, and
  // articles within a board keep their adjusted rank.
  const sections = useMemo(
    () =>
      groupBySource(orderedArticles.filter((a) => !picksIds.has(a.id))),
    [orderedArticles, picksIds],
  );

  // The top bar drives refresh + feed management; Home only reacts.
  useEffect(() => {
    function onRefreshed(e: Event) {
      const detail = (e as CustomEvent).detail as
        | (RefreshResult & { error?: string })
        | undefined;
      if (!detail) return;
      if (detail.error) {
        setError(detail.error);
        return;
      }
      setMessage(
        `新增 ${detail.added_or_updated}` +
          (detail.skipped_existing ? ` · 已有 ${detail.skipped_existing}` : "") +
          (detail.skipped_duplicate ? ` · 去重 ${detail.skipped_duplicate}` : "") +
          (detail.purged_teasers ? ` · 清理残篇 ${detail.purged_teasers}` : "") +
          (detail.purged_old ? ` · 过期清理 ${detail.purged_old}` : "") +
          (detail.feeds_unchanged ? ` · ${detail.feeds_unchanged} 源无更新` : "") +
          (detail.titles_translated ? ` · 译题/简介 ${detail.titles_translated}` : "") +
          (detail.errors.length ? ` · ${detail.errors.length} 个问题` : ""),
      );
      void load();
    }
    function onFeedsChanged() {
      void load();
    }
    window.addEventListener("shiyan:refreshed", onRefreshed);
    window.addEventListener("shiyan:feeds-changed", onFeedsChanged);
    return () => {
      window.removeEventListener("shiyan:refreshed", onRefreshed);
      window.removeEventListener("shiyan:feeds-changed", onFeedsChanged);
    };
  }, [load]);

  return (
    <div className="page">
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

      {topPicks.length > 0 && (
        <div className="source-boards top-picks">
          <SourceBoard
            section={{
              source: "今日精选",
              category: topPicks[0].category,
              articles: topPicks,
            }}
            categories={categories}
            knownPctById={knownPctById}
          />
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
    </div>
  );
}

