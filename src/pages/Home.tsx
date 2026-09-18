import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ArticleListItem, FeedCategory, LearningStats, RefreshResult } from "../api";
import { articleNeedsCardZh } from "../articleList";
import { formatLearningInsight } from "../learningStats";
import {
  articleDifficulty,
  calibrateEdges,
  difficultyFromScore,
  type DifficultyLevel,
} from "../difficulty";
import { useAppConfig, useVocab } from "../store";
import { ensureLexiconLoaded, isFreqBand, type FreqBand } from "../wordLevels";
import SourceBoard from "../components/SourceBoard";
import { groupBySource } from "../sourceInterest";
import { pickTopArticles, topPickIds } from "../topPicks";
import { applyDifficultyOrder } from "../difficultyRank";
import SelectionPopover, { type Popover } from "../components/SelectionPopover";
import {
  bundledGloss,
  cachedTranslation,
  prepareLookup,
  rememberTranslation,
} from "../wordLookup";
import { useTts } from "../useTts";
import { useEscapeKey } from "../useEscapeKey";

const PAGE_SIZE = 60;
/** 今日推荐: the first N ranked unread articles, shown expanded. */
const TOP_PICKS = 10;

/** Tag chips shown in the filter row: most frequent first, capped. */
export function topTags(articles: ArticleListItem[], max: number = 12): string[] {
  const counts = new Map<string, number>();
  for (const a of articles) {
    for (const tag of a.tags ?? []) {
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))
    .slice(0, max)
    .map(([tag]) => tag);
}

export default function Home() {
  const [category, setCategory] = useState("all");
  const [activeTags, setActiveTags] = useState<string[]>([]);
  const [categories, setCategories] = useState<FeedCategory[]>([]);
  const [articles, setArticles] = useState<ArticleListItem[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [learningStats, setLearningStats] = useState<LearningStats | null>(null);

  const { cfg } = useAppConfig();
  const { learningTerms, refreshLearningTerms } = useVocab();
  const { speaking, speakTarget, startSpeak, stopSpeak } = useTts();
  const [popover, setPopover] = useState<Popover | null>(null);
  const [toast, setToast] = useState<string | null>(null);
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
          activeTags,
          undefined,
          true,
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
  }, [category, activeTags]);

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
      const next = await api.listArticlesRanked(
        category === "all" ? undefined : category,
        activeTags,
        undefined,
        true,
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
  const difficultyById = useMemo(() => {
    // Score every visible article, calibrate the five bucket edges against
    // this sample, then bucket. Calibration keeps 简单/普通/较难 relative to
    // what this learner actually gets served.
    const scored: { id: string; score: number | null }[] = [];
    for (const a of articles) {
      const result = articleDifficulty(a.excerpt, learningTerms, difficultyPrefs);
      scored.push({ id: a.id, score: result?.score ?? null });
    }
    const edges = calibrateEdges(
      scored.map((s) => s.score).filter((s): s is number => s !== null),
    );
    const map = new Map<string, DifficultyLevel | null>();
    for (const { id, score } of scored) {
      map.set(id, score === null ? null : difficultyFromScore(score, edges));
    }
    return map;
  }, [articles, learningTerms, difficultyPrefs]);

  // Difficulty fit nudges the backend rank: the sweet spot (a few new words
  // per paragraph) floats up, word walls and trivially-easy pieces sink.
  const orderedArticles = useMemo(
    () => applyDifficultyOrder(articles, difficultyById),
    [articles, difficultyById],
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

  const closePopover = useCallback(() => setPopover(null), []);
  useEscapeKey(popover != null, closePopover);

  // Selection-to-translate on the home list (titles / summaries).
  const showMeaning = useCallback(
    async (text: string, x: number, y: number) => {
      const { term, source } = prepareLookup(text);
      const gloss = bundledGloss(term) ?? cachedTranslation(term);
      if (gloss) {
        setPopover({ x, y, text: term, source, translation: gloss, loading: false });
        return;
      }
      setPopover({ x, y, text: term, source, loading: true });
      try {
        const translated = await api.translatePlainText(term);
        rememberTranslation(term, translated);
        setPopover((p) =>
          p && p.text === term
            ? { ...p, translation: translated, loading: false }
            : p,
        );
      } catch (err) {
        setPopover((p) =>
          p && p.text === term ? { ...p, error: String(err), loading: false } : p,
        );
      }
    },
    [],
  );

  async function onPageMouseUp(e: React.MouseEvent) {
    const sel = window.getSelection();
    const text = sel?.toString().trim() ?? "";
    if (!text || text.length > 120) {
      return;
    }
    await showMeaning(text, e.clientX, e.clientY);
  }

  function speakWord(text: string) {
    if (speaking && speakTarget?.kind === "word") {
      stopSpeak();
      return;
    }
    if (!text.trim()) return;
    startSpeak({ kind: "word" }, [text]);
  }

  async function addPopoverToVocab() {
    if (!popover) return;
    try {
      await api.addVocab({
        term: popover.text,
        contextSentence: popover.source ?? popover.text,
        articleId: null,
        definitionZh: popover.translation ?? null,
      });
      setToast(`已加入生词库：${popover.text}`);
      setPopover(null);
      await refreshLearningTerms();
      setTimeout(() => setToast(null), 2500);
    } catch (err) {
      setError(String(err));
    }
  }

  return (
    <div className="page" onMouseUp={(e) => void onPageMouseUp(e)}>
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

      {availableTags.length > 0 && (
        <div className="tag-filter">
          {availableTags.map((tag) => {
            const on = activeTags.includes(tag);
            return (
              <button
                key={tag}
                type="button"
                className={on ? "tag-chip active" : "tag-chip"}
                onClick={() =>
                  setActiveTags((prev) =>
                    prev.includes(tag)
                      ? prev.filter((t) => t !== tag)
                      : [...prev, tag],
                  )
                }
              >
                {tag}
              </button>
            );
          })}
          {activeTags.length > 0 && (
            <button
              type="button"
              className="tag-chip clear"
              onClick={() => setActiveTags([])}
            >
              清除筛选
            </button>
          )}
        </div>
      )}

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
              source: "今日推荐",
              category: topPicks[0].category,
              articles: topPicks,
            }}
            categories={categories}
            difficultyById={difficultyById}
            collapseKey="home-top-picks"
          />
        </div>
      )}

      <div className="source-boards">
        {sections.map((sec) => (
          <SourceBoard
            key={sec.source}
            section={sec}
            categories={categories}
            difficultyById={difficultyById}
          />
        ))}
      </div>

      {toast && <p className="banner ok">{toast}</p>}

      {popover && (
        <SelectionPopover
          popover={popover}
          speaking={speaking}
          speakTarget={speakTarget}
          onSpeakWord={speakWord}
          onAddVocab={() => void addPopoverToVocab()}
          onClose={closePopover}
        />
      )}

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

