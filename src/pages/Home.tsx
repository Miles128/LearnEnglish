import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, ArticleListItem, FeedCategory, LearningStats, RefreshResult } from "../api";
import {
  applyDifficultyOrder,
  articleNeedsCardZh,
  groupBySource,
  pickTopArticles,
  topPickIds,
  topTags,
} from "../homeDerived";
import { formatLearningInsight } from "../learningStats";
import {
  articleDifficulty,
  calibrateEdges,
  difficultyFromScore,
  DIFFICULTY_LEVELS,
  difficultyLabel,
  type DifficultyLevel,
} from "../difficulty";
import { useAppConfig, useVocab } from "../store";
import { ensureLexiconLoaded, isFreqBand, type FreqBand } from "../wordLevels";
import SourceBoard from "../components/SourceBoard";
import ArticleRow from "../components/ArticleRow";
import {
  loadCollapsedSources,
  saveCollapsedSources,
  toggleSourceCollapsed,
} from "../sourceCollapse";
import { lastArticlePath } from "../useArticle";
import SelectionPopover from "../components/SelectionPopover";
import {
  bundledGloss,
  cachedTranslation,
  isPhraseSelection,
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

const PAGE_SIZE = 60;
/** Tags shown in the filter row before folding into a +N expander. */
const TAG_PREVIEW = 5;
/** 今日推荐: the first N ranked unread articles, shown expanded. */
const TOP_PICKS = 10;

/** 未完成 (default) / 未读 / 在读 / 已读 / 全部. */
type ReadFilter = "unfinished" | "unread" | "reading" | "read" | "all";

/** Filter-panel state as one object: reset = one assignment, no setter juggling. */
type Filters = {
  read: ReadFilter;
  likedOnly: boolean;
  source: string;
  level: DifficultyLevel | "all";
  tags: string[];
};

const DEFAULT_FILTERS: Filters = {
  read: "unfinished",
  likedOnly: false,
  source: "",
  level: "all",
  tags: [],
};

export default function Home() {
  const [category, setCategory] = useState("all");
  /** Tags + filters stay hidden until the 筛选 toggle is opened. */
  const [filtersOpen, setFiltersOpen] = useState(false);
  /** Tag chips fold into a +N expander; reset when the panel closes. */
  const [tagsExpanded, setTagsExpanded] = useState(false);
  const [categories, setCategories] = useState<FeedCategory[]>([]);
  const [articles, setArticles] = useState<ArticleListItem[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  /** Archive filters (merged in from the old Library page). */
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
  const patchFilters = useCallback(
    (patch: Partial<Filters>) => setFilters((f) => ({ ...f, ...patch })),
    [],
  );
  const clearFilters = useCallback(() => setFilters(DEFAULT_FILTERS), []);
  const [sources, setSources] = useState<[string, number][]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [learningStats, setLearningStats] = useState<LearningStats | null>(null);
  /** Collapsed source boards (incl. 今日推荐 via "home-top-picks"), persisted. */
  const [collapsedSources, setCollapsedSources] = useState<Set<string>>(
    () => loadCollapsedSources(),
  );

  const navigate = useNavigate();
  const { cfg } = useAppConfig();
  const {
    learningTerms,
    knownTerms,
    refreshLearningTerms,
    markKnown,
    unmarkKnown,
  } = useVocab();
  const tts = useTts();
  const { speaking, speakTarget } = tts;
  const freqBand: FreqBand = isFreqBand(cfg.freq_band) ? cfg.freq_band : 3000;
  const hasLlm = Boolean(cfg.api_key?.trim());
  const didBackfill = useRef(false);
  const [cardFillError, setCardFillError] = useState<string | null>(null);
  const [cardFilling, setCardFilling] = useState(false);

  /** Any non-default filter switches from the ranked digest to the flat archive list. */
  const archiveMode =
    filters.read !== "unfinished" || filters.likedOnly || filters.source !== "";

  const fetchPage = useCallback(
    (offset: number) =>
      archiveMode
        ? api.listLibrary({
            category: category === "all" ? undefined : category,
            tags: filters.tags,
            source: filters.source || undefined,
            readState: filters.read,
            likedOnly: filters.likedOnly,
            limit: PAGE_SIZE,
            offset,
          })
        : api.listArticlesRanked(
            category === "all" ? undefined : category,
            filters.tags,
            undefined,
            true,
            PAGE_SIZE,
            offset,
          ),
    [archiveMode, category, filters],
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [list, cats, stats] = await Promise.all([
        fetchPage(0),
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
  }, [fetchPage]);

  useEffect(() => {
    didBackfill.current = false;
    void load();
  }, [load]);

  useEffect(() => {
    void api.listArticleSources().then(setSources).catch(() => undefined);
  }, []);

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

  // Tag backfill shares the once-per-mount guard with the card backfill.
  useEffect(() => {
    if (didBackfill.current) return;
    if (!hasLlm || loading || articles.length === 0) return;
    if (!articles.some((a) => a.tags.length === 0)) return;
    didBackfill.current = true;
    void (async () => {
      try {
        const n = await api.fillMissingTags(100);
        if (n > 0) await load();
      } catch {
        didBackfill.current = false;
      }
    })();
  }, [articles, hasLlm, loading, load]);

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
      const next = await fetchPage(articles.length);
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

  // Infinite scroll: a sentinel near the list bottom triggers loadMore.
  // Ref indirection keeps the observer callback on the latest closure.
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const loadMoreRef = useRef(loadMore);
  useEffect(() => {
    loadMoreRef.current = loadMore;
  });
  useEffect(() => {
    if (!hasMore) return;
    const el = sentinelRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) loadMoreRef.current();
      },
      { rootMargin: "600px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [hasMore]);

  // Refresh lives on the list it refreshes: signal Home via the shared event.
  async function onRefresh() {
    if (refreshing) return;
    setRefreshing(true);
    try {
      const result = await api.refreshFeeds();
      window.dispatchEvent(new CustomEvent("shiyan:refreshed", { detail: result }));
    } catch (e) {
      window.dispatchEvent(
        new CustomEvent("shiyan:refreshed", { detail: { error: String(e) } }),
      );
    } finally {
      setRefreshing(false);
    }
  }

  // Tag chips come from the loaded window; keeping the filter row stable
  // while filtered results are shown requires remembering them.
  const availableTags = useMemo(() => topTags(articles), [articles]);

  const tabCategories = useMemo(() => {
    const tabs = [{ id: "all", label: "全部" }];
    for (const c of categories) {
      tabs.push({ id: c.id, label: c.label });
    }
    return tabs;
  }, [categories]);

  // Local difficulty index per article: density of words above this
  // learner's word-frequency size (plus their learning terms).
  const difficultyPrefs = useMemo(() => ({ freqBand }), [freqBand]);
  const { difficultyById, levelCounts } = useMemo(() => {
    // Score every visible article, calibrate the five bucket edges against
    // this sample, then bucket. Calibration keeps 简单/普通/较难 relative to
    // what this learner actually gets served.
    const scored: { id: string; score: number | null }[] = [];
    for (const a of articles) {
      const result = articleDifficulty(
        a.excerpt,
        learningTerms,
        difficultyPrefs,
        knownTerms,
      );
      scored.push({ id: a.id, score: result?.score ?? null });
    }
    const edges = calibrateEdges(
      scored.map((s) => s.score).filter((s): s is number => s !== null),
    );
    const byId = new Map<string, DifficultyLevel | null>();
    const counts = new Map<DifficultyLevel, number>();
    for (const { id, score } of scored) {
      const level = score === null ? null : difficultyFromScore(score, edges);
      byId.set(id, level);
      if (level) counts.set(level, (counts.get(level) ?? 0) + 1);
    }
    return { difficultyById: byId, levelCounts: counts };
  }, [articles, learningTerms, knownTerms, difficultyPrefs]);

  const matchesLevel = useCallback(
    (a: ArticleListItem) =>
      filters.level === "all" || difficultyById.get(a.id) === filters.level,
    [filters.level, difficultyById],
  );
  /** Flat archive list (read/收藏/来源 filters active). */
  const visible = useMemo(() => articles.filter(matchesLevel), [articles, matchesLevel]);

  // Difficulty fit nudges the backend rank: the sweet spot (a few new words
  // per paragraph) floats up, word walls and trivially-easy pieces sink.
  const orderedArticles = useMemo(
    () => applyDifficultyOrder(articles, difficultyById).filter(matchesLevel),
    [articles, difficultyById, matchesLevel],
  );
  const topPicks = useMemo(
    () => pickTopArticles(orderedArticles, TOP_PICKS),
    [orderedArticles],
  );
  const picksIds = useMemo(() => topPickIds(topPicks), [topPicks]);
  // Difficulty-adjusted rank order: section order = first appearance, and
  // articles within a board keep their adjusted rank.
  const sections = useMemo(
    () =>
      groupBySource(orderedArticles.filter((a) => !picksIds.has(a.id))),
    [orderedArticles, picksIds],
  );

  // Collapse state lives here so 全部折叠/全部展开 can flip every board.
  const boardKeys = useMemo(
    () => ["home-top-picks", ...sections.map((s) => s.source)],
    [sections],
  );
  const allBoardsCollapsed =
    boardKeys.length > 0 && boardKeys.every((k) => collapsedSources.has(k));

  function toggleSourceBoard(key: string) {
    setCollapsedSources((prev) => {
      const next = toggleSourceCollapsed(prev, key);
      saveCollapsedSources(next);
      return next;
    });
  }

  function toggleAllBoards() {
    const next = allBoardsCollapsed ? new Set<string>() : new Set(boardKeys);
    saveCollapsedSources(next);
    setCollapsedSources(next);
  }

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
    window.addEventListener("shiyan:refreshed", onRefreshed);
    return () => {
      window.removeEventListener("shiyan:refreshed", onRefreshed);
    };
  }, [load]);

  // Selection-to-translate on the home list (titles / summaries).
  const {
    popover,
    closePopover,
    toast,
    showMeaning,
    speakWord,
    addToVocab,
    addToPhrase,
  } = useWordPopover({
    articleId: null,
    tts,
    localGloss: (term) => bundledGloss(term) ?? cachedTranslation(term),
    translate: async (term) => {
      const translated = await api.translatePlainText(term);
      rememberTranslation(term, translated);
      return translated;
    },
    contextFor: (source, term) => source ?? term,
    onError: (m) => setError(m),
    onVocabAdded: () => void refreshLearningTerms(),
  });

  async function onPageMouseUp(e: React.MouseEvent) {
    const sel = window.getSelection();
    const text = sel?.toString().trim() ?? "";
    if (!text || text.length > 120) {
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

  const resumePath = lastArticlePath();
  const hasFilter =
    filters.read !== "unfinished" ||
    filters.likedOnly ||
    filters.level !== "all" ||
    filters.tags.length > 0 ||
    filters.source !== "";

  return (
    <div className="page" onMouseUp={(e) => void onPageMouseUp(e)}>
      <div className="tabs home-tabs">
        {tabCategories.map((c) => (
          <button
            key={c.id}
            className={category === c.id ? "tab active" : "tab"}
            onClick={() => setCategory(c.id)}
          >
            {c.label}
          </button>
        ))}
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
        <div className="tabs-right">
          {learningStats && (
            <span className="learning-insight-inline">
              {formatLearningInsight(learningStats)} ·{" "}
              <Link to="/stats">统计</Link>
            </span>
          )}
          <button
            type="button"
            className={hasFilter ? "linklike active" : "linklike"}
            onClick={() => {
              if (filtersOpen) {
                // 收起筛选面板 = 回到原始主页：清空全部筛选条件。
                setTagsExpanded(false);
                clearFilters();
              }
              setFiltersOpen(!filtersOpen);
            }}
            aria-expanded={filtersOpen}
          >
            筛选
          </button>
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
              {hasFilter && (
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
                value={filters.source}
                onChange={(e) => patchFilters({ source: e.target.value })}
              >
                <option value="">全部来源</option>
                {sources.map(([name, count]) => (
                  <option key={name} value={name}>
                    {name}（{count}）
                  </option>
                ))}
              </select>
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
              {availableTags.length > 0 && (
                <>
                  <span className="filter-label">标签</span>
                  {(tagsExpanded
                    ? availableTags
                    : availableTags.slice(0, TAG_PREVIEW)
                  ).map((tag) => {
                    const on = filters.tags.includes(tag);
                    return (
                      <button
                        key={tag}
                        type="button"
                        className={on ? "tag-chip active" : "tag-chip"}
                        onClick={() =>
                          setFilters((f) => ({
                            ...f,
                            tags: f.tags.includes(tag)
                              ? f.tags.filter((x) => x !== tag)
                              : [...f.tags, tag],
                          }))
                        }
                      >
                        {tag}
                      </button>
                    );
                  })}
                  {availableTags.length > TAG_PREVIEW && (
                    <button
                      type="button"
                      className="tag-chip tag-more"
                      onClick={() => setTagsExpanded((v) => !v)}
                    >
                      {tagsExpanded
                        ? "收起"
                        : `+${availableTags.length - TAG_PREVIEW}`}
                    </button>
                  )}
                </>
              )}
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
          <p>
            还没有文章。点上方「刷新」拉取订阅；也可以用右上角按钮导入文件，
            或在 设置 → 订阅 里粘贴文章链接。
          </p>
        </div>
      )}
      {!loading && articles.length > 0 && visible.length === 0 && !error && (
        <div className="empty">
          <p>没有符合条件的文章。</p>
        </div>
      )}

      {archiveMode ? (
        visible.length > 0 && (
          <ul className="article-list library-list">
            {visible.map((a) => (
              <ArticleRow
                key={a.id}
                article={a}
                difficulty={difficultyById.get(a.id) ?? null}
                showSource
                showTags={filtersOpen}
              />
            ))}
          </ul>
        )
      ) : (
        <>
          <div className="boards-toolbar">
            <span className="muted">
              {sections.length} 个来源
              {allBoardsCollapsed ? " · 已全部折叠" : ""}
            </span>
            <button
              type="button"
              className="linklike"
              onClick={toggleAllBoards}
              disabled={boardKeys.length === 0}
            >
              {allBoardsCollapsed ? "全部展开" : "全部折叠"}
            </button>
          </div>

          {topPicks.length > 0 && (
            <div className="source-boards top-picks">
              <SourceBoard
                section={{
                  source: "今日推荐",
                  category: topPicks[0].category,
                  articles: topPicks,
                }}
                difficultyById={difficultyById}
                collapsed={collapsedSources.has("home-top-picks")}
                onToggleCollapsed={() => toggleSourceBoard("home-top-picks")}
                showTags={filtersOpen}
              />
            </div>
          )}

          <div className="source-boards">
            {sections.map((sec) => (
              <SourceBoard
                key={sec.source}
                section={sec}
                difficultyById={difficultyById}
                collapsed={collapsedSources.has(sec.source)}
                onToggleCollapsed={() => toggleSourceBoard(sec.source)}
                showTags={filtersOpen}
              />
            ))}
          </div>
        </>
      )}

      {toast && <p className="banner ok">{toast}</p>}

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

      {hasMore && (
        <div ref={sentinelRef} className="load-more-row">
          {loadingMore && <p className="muted">加载中…</p>}
        </div>
      )}
    </div>
  );
}

