import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, ArticleListItem, LearningStats } from "../api";
import {
  applyDifficultyOrder,
  articleNeedsCardZh,
  pickTopArticles,
  topTags,
} from "../homeDerived";
import { useArticleBackfill, useHomeDifficulty, useInfiniteScroll } from "../homeHooks";
import { formatLearningInsight } from "../learningStats";
import {
  DIFFICULTY_LEVELS,
  difficultyLabel,
  type DifficultyLevel,
} from "../difficulty";
import { useAppConfig, useSearchQuery, useShell, useVocab } from "../store";
import { useToast } from "../components/Toaster";
import { emitEvent, onEvent } from "../events";
import {
  ensureLexiconLoaded,
  isCefrLevel,
  isFreqBand,
  type CefrLevel,
  type FreqBand,
} from "../wordLevels";
import ArticleRow from "../components/ArticleRow";
import { lastArticlePath } from "../useArticle";
import WordPopoverShell from "../components/WordPopoverShell";
import {
  bundledGloss,
  cachedTranslation,
  rememberTranslation,
} from "../wordResolve";
import { useTts } from "../useTts";
import { useWordPopover } from "../useWordPopover";

function IconRefresh() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M21 12a9 9 0 1 1-2.64-6.36" />
      <path d="M21 3v6h-6" />
    </svg>
  );
}

function IconSearch() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="11" cy="11" r="7" />
      <path d="m21 21-4.3-4.3" />
    </svg>
  );
}

const PAGE_SIZE = 60;
/** 今日推荐: the first N ranked unread articles, shown expanded. */
const TOP_PICKS = 10;

/** 未完成 (default) / 未读 / 在读 / 已读 / 全部. */
type ReadFilter = "unfinished" | "unread" | "reading" | "read" | "all";

/** Filter-panel state as one object: reset = one assignment, no setter juggling.
 *  Tags and source live in the shell (sidebar owns them); the panel keeps the
 *  reading-state / favourite / difficulty refinement. */
type Filters = {
  read: ReadFilter;
  likedOnly: boolean;
  level: DifficultyLevel | "all";
};

const DEFAULT_FILTERS: Filters = {
  read: "unfinished",
  likedOnly: false,
  level: "all",
};

export default function Home() {
  const [articles, setArticles] = useState<ArticleListItem[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  /** Top-bar search input is collapsed until the button is pressed or text is present. */
  const [searchOpen, setSearchOpen] = useState(false);
  const navigate = useNavigate();
  const { cfg } = useAppConfig();
  const {
    selectedTags,
    publishAvailableTags,
    rerankNonce,
    filtersOpen,
    focusSource,
    setFocusSource,
    publishTopPickSources,
  } = useShell();
  const { query, setQuery } = useSearchQuery();
  /** Archive filters (merged in from the old Library page). */
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
  const patchFilters = useCallback(
    (patch: Partial<Filters>) => setFilters((f) => ({ ...f, ...patch })),
    [],
  );
  const clearFilters = useCallback(() => {
    // Panel collapse resets the archive filters only; tag selection lives in the
    // sidebar and is cleared by its own 清除 control.
    setFilters(DEFAULT_FILTERS);
  }, []);
  const toast = useToast();
  const [learningStats, setLearningStats] = useState<LearningStats | null>(null);

  const {
    learningTerms,
    knownTerms,
    refreshLearningTerms,
    markKnown,
    unmarkKnown,
  } = useVocab();
  const tts = useTts();
  const freqBand: FreqBand = isFreqBand(cfg.freq_band) ? cfg.freq_band : 3000;
  const cefrLevel: CefrLevel = isCefrLevel(cfg.cefr_level)
    ? cfg.cefr_level
    : "B1";
  const hasLlm = Boolean(cfg.api_key?.trim());

  /** Main-list model (single focused list, never a multi-source page):
   *  - 今日推荐 (default): no source focused and no other filter active.
   *  - source view: a sidebar source is focused → that source's articles.
   *  - archive view: some refinement (status/收藏/难度/标签) active with no
   *    focused source → a flat filtered list. */
  const hasOtherFilter =
    filters.read !== "unfinished" ||
    filters.likedOnly ||
    filters.level !== "all" ||
    selectedTags.length > 0;
  const showPicks = focusSource === null && !hasOtherFilter;

  const fetchPage = useCallback(
    (offset: number, cursor?: { score: number; id: string } | null) =>
      showPicks
        ? api.listArticlesRanked(
            undefined,
            [],
            undefined,
            true,
            PAGE_SIZE,
            offset,
            cursor ?? null,
          )
        : api.listLibrary({
            category: undefined,
            tags: selectedTags,
            source: focusSource ?? undefined,
            readState: filters.read,
            likedOnly: filters.likedOnly,
            limit: PAGE_SIZE,
            offset,
          }),
    [showPicks, selectedTags, focusSource, filters],
  );

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [list, stats] = await Promise.all([
        fetchPage(0),
        api.getLearningStats().catch(() => null),
        ensureLexiconLoaded().catch(() => undefined),
      ]);
      setArticles(list);
      setHasMore(list.length >= PAGE_SIZE);
      setLearningStats(stats);
    } catch (e) {
      toast.err(String(e));
    } finally {
      setLoading(false);
    }
  }, [fetchPage, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  // A sidebar priority reorder bumps rerankNonce → re-fetch the ranked list.
  // Skip the initial mount (already covered by the load effect above).
  const rerankMounted = useRef(false);
  useEffect(() => {
    if (!rerankMounted.current) {
      rerankMounted.current = true;
      return;
    }
    void load();
    // Only rerankNonce should retrigger this; `load` is read fresh each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rerankNonce]);

  const { cardFilling, cardFillError, retryFillCards } = useArticleBackfill({
    articles,
    hasLlm,
    loading,
    load,
  });

  const loadMoreRef = useRef(false);
  async function loadMore() {
    if (loadMoreRef.current) return;
    loadMoreRef.current = true;
    setLoadingMore(true);
    try {
      // Cursor pagination for the ranked 今日推荐 feed: immune to inserts above
      // the cursor. Source/archive views keep offset paging.
      const last = articles.length > 0 ? articles[articles.length - 1] : null;
      const next = await fetchPage(
        articles.length,
        showPicks && last ? { score: last.rank_score, id: last.id } : null,
      );
      setArticles((prev) => {
        const seen = new Set(prev.map((a) => a.id));
        return prev.concat(next.filter((a) => !seen.has(a.id)));
      });
      setHasMore(next.length >= PAGE_SIZE);
    } catch (e) {
      toast.err(String(e));
    } finally {
      loadMoreRef.current = false;
      setLoadingMore(false);
    }
  }

  // Refresh lives on the list it refreshes: signal Home via the shared event.
  async function onRefresh() {
    if (refreshing) return;
    setRefreshing(true);
    try {
      const result = await api.refreshFeeds();
      emitEvent("shiyan:refreshed", { result });
    } catch (e) {
      emitEvent("shiyan:refreshed", { error: String(e) });
    } finally {
      setRefreshing(false);
    }
  }

  // Tag chips come from the loaded window; keeping the filter row stable
  // while filtered results are shown requires remembering them.
  const availableTags = useMemo(() => topTags(articles), [articles]);

  // The always-visible tag filter now lives in the sidebar: publish the tags
  // available in this window so its chips match what Home could filter on.
  useEffect(() => {
    publishAvailableTags(availableTags);
  }, [availableTags, publishAvailableTags]);

  // Top-bar search: a lightweight client-side filter over the loaded window
  // (title / blurb / source / tags). No backend full-text command exists yet.
  const matchesQuery = useCallback(
    (a: ArticleListItem) => {
      const q = query.trim().toLowerCase();
      if (!q) return true;
      return (
        a.title.toLowerCase().includes(q) ||
        a.summary_zh.toLowerCase().includes(q) ||
        a.source.toLowerCase().includes(q) ||
        (a.tags ?? []).some((t) => t.toLowerCase().includes(q))
      );
    },
    [query],
  );

  // Local difficulty index per article — see useHomeDifficulty.
  const { difficultyById, levelCounts } = useHomeDifficulty({
    articles,
    learningTerms,
    knownTerms,
    cefrLevel,
    freqBand,
  });

  const matchesLevel = useCallback(
    (a: ArticleListItem) =>
      filters.level === "all" || difficultyById.get(a.id) === filters.level,
    [filters.level, difficultyById],
  );

  /** Flat list for the source / archive views (difficulty + search refined). */
  const visible = useMemo(
    () => articles.filter((a) => matchesLevel(a) && matchesQuery(a)),
    [articles, matchesLevel, matchesQuery],
  );

  // Difficulty fit nudges the 今日推荐 ranking: the sweet spot (a few new words
  // per paragraph) floats up, word walls and trivially-easy pieces sink.
  const orderedArticles = useMemo(
    () =>
      applyDifficultyOrder(articles, difficultyById).filter(
        (a) => matchesLevel(a) && matchesQuery(a),
      ),
    [articles, difficultyById, matchesLevel, matchesQuery],
  );
  const topPicks = useMemo(
    () => pickTopArticles(orderedArticles, TOP_PICKS),
    [orderedArticles],
  );

  // Publish the distinct sources behind today's picks so the sidebar's
  // 今日推荐 node can expand to show them (glance only, not draggable).
  useEffect(() => {
    const seen = new Set<string>();
    const srcs: string[] = [];
    for (const a of topPicks) {
      if (!seen.has(a.source)) {
        seen.add(a.source);
        srcs.push(a.source);
      }
    }
    publishTopPickSources(srcs);
  }, [topPicks, publishTopPickSources]);

  // Collapsing the filter panel (from the sidebar icon) resets archive filters.
  const filtersOpenPrev = useRef(filtersOpen);
  useEffect(() => {
    if (filtersOpenPrev.current && !filtersOpen) clearFilters();
    filtersOpenPrev.current = filtersOpen;
  }, [filtersOpen, clearFilters]);

  /** The one list the main area shows: 今日推荐, or the focused/filtered set. */
  const displayList = showPicks ? topPicks : visible;
  const listHeading = showPicks
    ? "今日推荐"
    : focusSource ?? "筛选结果";

  // The top bar drives refresh + feed management; Home only reacts.
  useEffect(() => {
    return onEvent("shiyan:refreshed", (detail) => {
      const result = detail.result;
      if (detail.error || !result) {
        toast.err(detail.error ?? "刷新失败");
        return;
      }
      toast.ok(
        `新增 ${result.added_or_updated}` +
          (result.skipped_existing ? ` · 已有 ${result.skipped_existing}` : "") +
          (result.skipped_duplicate ? ` · 去重 ${result.skipped_duplicate}` : "") +
          (result.purged_teasers ? ` · 清理残篇 ${result.purged_teasers}` : "") +
          (result.purged_old ? ` · 过期清理 ${result.purged_old}` : "") +
          (result.feeds_unchanged ? ` · ${result.feeds_unchanged} 源无更新` : "") +
          (result.titles_translated ? ` · 补简介 ${result.titles_translated}` : "") +
          (result.errors.length ? ` · ${result.errors.length} 个问题` : ""),
      );
      if (result.errors.length) {
        toast.err(
          "刷新问题：" +
            result.errors.slice(0, 3).join("；") +
            (result.errors.length > 3 ? ` 等 ${result.errors.length} 条` : ""),
        );
      }
      void load();
    });
  }, [load, toast]);

  // Selection-to-translate on the home list (titles / summaries).
  const { popover, showMeaning, mount: popoverMount } = useWordPopover({
    articleId: null,
    tts,
    localGloss: (term) => bundledGloss(term) ?? cachedTranslation(term),
    translate: async (term) => {
      const translated = await api.translatePlainText(term);
      rememberTranslation(term, translated);
      return translated;
    },
    contextFor: (source, term) => source ?? term,
    onError: (m) => toast.err(m),
    onSuccess: (m) => toast.ok(m),
    onVocabAdded: () => void refreshLearningTerms(),
    knownTerms,
    markKnown,
    unmarkKnown,
  });

  // Keyboard flow (j/k/Enter/o): navigate exactly what is on screen.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const navList = useMemo(() => displayList, [displayList]);

  // Infinite scroll only makes sense while there is something on screen to
  // read; with everything collapsed it would just stream in new (collapsed)
  // boards. Re-arms as soon as one board is expanded again.
  const sentinelRef = useInfiniteScroll(
    hasMore && navList.length > 0,
    loadMore,
  );

  useEffect(() => {
    function onNavKey(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const key = e.key;
      if (key !== "j" && key !== "k" && key !== "Enter" && key !== "o") return;
      const t = e.target as HTMLElement | null;
      const tag = t?.tagName;
      if (
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        tag === "SELECT" ||
        t?.isContentEditable
      ) {
        return;
      }
      // Don't hijack Enter on a focused button/link (it would double-act),
      // and not while the selection popover is open.
      if ((key === "Enter" || key === "o") && (tag === "BUTTON" || tag === "A")) {
        return;
      }
      if (popover || navList.length === 0) return;
      e.preventDefault();
      if (key === "j" || key === "k") {
        setSelectedId((prev) => {
          const idx = prev ? navList.findIndex((a) => a.id === prev) : -1;
          const next =
            key === "j"
              ? Math.min(navList.length - 1, idx + 1)
              : Math.max(0, idx - 1);
          return navList[next]?.id ?? null;
        });
        return;
      }
      // Enter/o: with a selection open it; without one, select the first row.
      const target = selectedId
        ? navList.find((a) => a.id === selectedId)
        : navList[0];
      if (selectedId && target) navigate(`/article/${target.id}`);
      else if (target) setSelectedId(target.id);
    }
    window.addEventListener("keydown", onNavKey);
    return () => window.removeEventListener("keydown", onNavKey);
  }, [navList, popover, selectedId, navigate]);

  // Keep the keyboard-selected row in view.
  useEffect(() => {
    if (!selectedId) return;
    document
      .querySelector(`[data-article-row="${selectedId}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [selectedId]);

  async function onPageMouseUp(e: React.MouseEvent) {
    const sel = window.getSelection();
    const text = sel?.toString().trim() ?? "";
    if (!text || text.length > 120) {
      return;
    }
    await showMeaning({ text, x: e.clientX, y: e.clientY });
  }

  const resumePath = lastArticlePath();

  return (
    <div className="page home-page" onMouseUp={(e) => void onPageMouseUp(e)}>
      <div className="home-toolbar">
        <button
          type="button"
          className={`iconlike${refreshing ? " spin" : ""}`}
          onClick={() => void onRefresh()}
          disabled={refreshing}
          title="刷新订阅"
          aria-label="刷新订阅"
        >
          <IconRefresh />
        </button>
        <div className={`home-search${searchOpen || query ? " open" : ""}`}>
          <button
            type="button"
            className="iconlike"
            onClick={() => {
              if (query) {
                setQuery("");
              }
              setSearchOpen((v) => !v);
            }}
            title="搜索文章"
            aria-label="搜索文章"
          >
            <IconSearch />
          </button>
          {searchOpen && (
            <input
              className="search-input"
              type="search"
              autoFocus
              placeholder="搜索标题 / 简介 / 来源 / 标签"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  setQuery("");
                  setSearchOpen(false);
                }
              }}
              onBlur={() => {
                if (!query) setSearchOpen(false);
              }}
            />
          )}
        </div>
        <div className="tabs-right">
          {learningStats && (
            <span className="learning-insight-inline">
              {formatLearningInsight(learningStats)} ·{" "}
              <Link to="/stats">统计</Link>
            </span>
          )}
          {resumePath && (
            <button
              type="button"
              className="linklike"
              onClick={() => navigate(resumePath)}
            >
              继续阅读
            </button>
          )}
        </div>
      </div>

      {filtersOpen && (
        <>
          <div className="library-filters">
            <div className="filter-row">
              <div className="filter-group">
                {(
                  [
                    ["unfinished", "未完成"],
                    ["unread", "未读"],
                    ["read", "已读"],
                    ["all", "全部"],
                  ] as const
                ).map(([id, label]) => (
                  <button
                    key={id}
                    type="button"
                    className={filters.read === id ? "tag-chip active" : "tag-chip"}
                    onClick={() => patchFilters({ read: id })}
                  >
                    {label}
                  </button>
                ))}
                <button
                  type="button"
                  className={filters.likedOnly ? "tag-chip active" : "tag-chip"}
                  onClick={() =>
                    setFilters((f) => ({ ...f, likedOnly: !f.likedOnly }))
                  }
                >
                  ★ 收藏
                </button>
              </div>
              {hasOtherFilter && (
                <button
                  type="button"
                  className="tag-chip clear filter-clear"
                  onClick={clearFilters}
                >
                  清除筛选
                </button>
              )}
            </div>

            <div className="filter-row">
              <select
                className="filter-select"
                value={filters.level}
                onChange={(e) =>
                  patchFilters({ level: e.target.value as DifficultyLevel | "all" })
                }
              >
                <option value="all">全部难度</option>
                {DIFFICULTY_LEVELS.map((level) => (
                  <option key={level} value={level}>
                    {difficultyLabel(level)}
                    {levelCounts.get(level) ? ` (${levelCounts.get(level)})` : ""}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </>
      )}

      {!hasLlm && articles.some(articleNeedsCardZh) && (
        <p className="muted">设置里填 API Key 后，列表会自动补一两句中文简介。</p>
      )}
      {hasLlm && cardFilling && <p className="muted">正在补中文简介…</p>}
      {cardFillError && (
        <p className="banner err with-action">
          <span>简介未生成：{cardFillError}</span>
          <button
            type="button"
            className="btn small"
            onClick={retryFillCards}
          >
            重试
          </button>
        </p>
      )}

      {loading && <p className="muted">加载中…</p>}
      {!loading && articles.length === 0 && (
        <div className="empty">
          <p>
            还没有文章。点上方「刷新」拉取订阅；也可以用右上角按钮导入文件，
            或在 设置 → 订阅 里粘贴文章链接。
          </p>
        </div>
      )}
      {!loading && articles.length > 0 && displayList.length === 0 && (
        <div className="empty">
          <p>没有符合条件的文章。</p>
        </div>
      )}

      {displayList.length > 0 && (
        <>
          <div className="list-heading-row">
            <h2 className="list-heading">{listHeading}</h2>
            {focusSource && (
              <button
                type="button"
                className="linklike"
                onClick={() => setFocusSource(null)}
              >
                回到今日推荐
              </button>
            )}
          </div>
          <ul className="article-list library-list">
            {displayList.map((a) => (
              <ArticleRow
                key={a.id}
                article={a}
                difficulty={difficultyById.get(a.id) ?? null}
                showSource={!focusSource}
                showTags={filtersOpen}
                highlighted={a.id === selectedId}
              />
            ))}
          </ul>
        </>
      )}

      {popoverMount && <WordPopoverShell {...popoverMount} />}

      {hasMore && (
        <div ref={sentinelRef}>
          {loadingMore && <p className="muted">加载中…</p>}
        </div>
      )}
    </div>
  );
}

