import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, ArticleListItem, FeedCategory, LearningStats } from "../api";
import {
  applyDifficultyOrder,
  articleNeedsCardZh,
  groupBySource,
  pickTopArticles,
  topPickIds,
  topTags,
} from "../homeDerived";
import { useArticleBackfill, useHomeDifficulty, useInfiniteScroll } from "../homeHooks";
import { formatLearningInsight } from "../learningStats";
import {
  DIFFICULTY_LEVELS,
  difficultyLabel,
  type DifficultyLevel,
} from "../difficulty";
import { useAppConfig, useVocab } from "../store";
import { useToast } from "../components/Toaster";
import { emitEvent, onEvent } from "../events";
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
  const toast = useToast();
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

  /** Presenting rule, stated once: home = category tabs + 今日推荐 pinned +
   *  per-source boards; the flat archive list appears whenever ANY filter is
   *  active (status/收藏/来源/难度/标签) — a filtered digest is an archive. */
  const hasFilter =
    filters.read !== "unfinished" ||
    filters.likedOnly ||
    filters.level !== "all" ||
    filters.tags.length > 0 ||
    filters.source !== "";
  const archiveMode = hasFilter;

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
      toast.err(String(e));
    } finally {
      setLoading(false);
    }
  }, [fetchPage, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void api.listArticleSources().then(setSources).catch(() => undefined);
  }, []);

  const { cardFilling, cardFillError, retryFillCards } = useArticleBackfill({
    articles,
    hasLlm,
    loading,
    load,
  });

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
      toast.err(String(e));
    } finally {
      setLoadingMore(false);
    }
  }

  const sentinelRef = useInfiniteScroll(hasMore, loadMore);

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

  const tabCategories = useMemo(() => {
    const tabs = [{ id: "all", label: "全部" }];
    for (const c of categories) {
      tabs.push({ id: c.id, label: c.label });
    }
    return tabs;
  }, [categories]);

  // Local difficulty index per article — see useHomeDifficulty.
  const { difficultyById, levelCounts } = useHomeDifficulty({
    articles,
    learningTerms,
    knownTerms,
    freqBand,
  });

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
          (result.titles_translated ? ` · 译题/简介 ${result.titles_translated}` : "") +
          (result.errors.length ? ` · ${result.errors.length} 个问题` : ""),
      );
      void load();
    });
  }, [load, toast]);

  // Selection-to-translate on the home list (titles / summaries).
  const {
    popover,
    closePopover,
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
    onError: (m) => toast.err(m),
    onSuccess: (m) => toast.ok(m),
    onVocabAdded: () => void refreshLearningTerms(),
  });

  // Keyboard flow (j/k/Enter/o): the navigation list mirrors what is actually
  // on screen — collapsed boards are skipped, archive mode uses the flat list.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const navList = useMemo(() => {
    if (archiveMode) return visible;
    const list: ArticleListItem[] = [];
    if (topPicks.length > 0 && !collapsedSources.has("home-top-picks")) {
      list.push(...topPicks);
    }
    for (const sec of sections) {
      if (!collapsedSources.has(sec.source)) list.push(...sec.articles);
    }
    return list;
  }, [archiveMode, visible, topPicks, sections, collapsedSources]);

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

  async function toggleKnown(term: string) {
    const key = term.trim().toLowerCase();
    try {
      if (knownTerms.includes(key)) await unmarkKnown(key);
      else await markKnown(key);
    } catch (e) {
      toast.err(String(e));
    }
  }

  const resumePath = lastArticlePath();

  return (
    <div className="page home-page" onMouseUp={(e) => void onPageMouseUp(e)}>
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
      {!loading && articles.length > 0 && visible.length === 0 && (
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
                highlighted={a.id === selectedId}
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
                highlightedId={selectedId}
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
                highlightedId={selectedId}
              />
            ))}
          </div>
        </>
      )}

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

