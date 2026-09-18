import { useCallback, useEffect, useMemo, useState } from "react";
import { api, type ArticleListItem } from "../api";
import { articleDifficulty, calibrateEdges, difficultyFromScore,
  DIFFICULTY_LEVELS, difficultyLabel, type DifficultyLevel } from "../difficulty";
import { useAppConfig, useVocab } from "../store";
import { ensureLexiconLoaded, isFreqBand, type FreqBand } from "../wordLevels";
import { topTags } from "./Home";
import ArticleRow from "../components/ArticleRow";

const PAGE_SIZE = 60;

type ReadFilter = "all" | "unread" | "read";

export default function Library() {
  const { cfg } = useAppConfig();
  const { learningTerms } = useVocab();
  const freqBand: FreqBand = isFreqBand(cfg.freq_band) ? cfg.freq_band : 3000;
  const [articles, setArticles] = useState<ArticleListItem[]>([]);
  const [sources, setSources] = useState<[string, number][]>([]);
  const [readFilter, setReadFilter] = useState<ReadFilter>("all");
  const [likedOnly, setLikedOnly] = useState(false);
  const [levelFilter, setLevelFilter] = useState<DifficultyLevel | "all">("all");
  const [activeTags, setActiveTags] = useState<string[]>([]);
  const [sourceFilter, setSourceFilter] = useState("");
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const difficultyPrefs = useMemo(() => ({ freqBand }), [freqBand]);

  // Difficulty per loaded article + calibrated edges (shared with Home logic).
  const { difficultyById, levelCounts } = useMemo(() => {
    const scored: { id: string; score: number | null }[] = [];
    for (const a of articles) {
      const result = articleDifficulty(a.excerpt, learningTerms, difficultyPrefs);
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
  }, [articles, learningTerms, difficultyPrefs]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await api.listLibrary({
        tags: activeTags,
        source: sourceFilter || undefined,
        readState: readFilter,
        likedOnly,
        limit: PAGE_SIZE,
        offset: 0,
      });
      setArticles(list);
      setHasMore(list.length >= PAGE_SIZE);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [activeTags, sourceFilter, readFilter, likedOnly]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void api.listArticleSources().then(setSources).catch(() => undefined);
    void ensureLexiconLoaded().catch(() => undefined);
  }, []);

  async function loadMore() {
    setLoading(true);
    try {
      const next = await api.listLibrary({
        tags: activeTags,
        source: sourceFilter || undefined,
        readState: readFilter,
        likedOnly,
        limit: PAGE_SIZE,
        offset: articles.length,
      });
      const seen = new Set(articles.map((a) => a.id));
      setArticles(articles.concat(next.filter((a) => !seen.has(a.id))));
      setHasMore(next.length >= PAGE_SIZE);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  // Difficulty filtering is local (the index is computed from the lexicon).
  const visible = useMemo(
    () =>
      levelFilter === "all"
        ? articles
        : articles.filter((a) => difficultyById.get(a.id) === levelFilter),
    [articles, levelFilter, difficultyById],
  );

  const tags = useMemo(() => topTags(articles), [articles]);
  const hasFilter =
    readFilter !== "all" ||
    likedOnly ||
    levelFilter !== "all" ||
    activeTags.length > 0 ||
    sourceFilter !== "";

  function clearFilters() {
    setReadFilter("all");
    setLikedOnly(false);
    setLevelFilter("all");
    setActiveTags([]);
    setSourceFilter("");
  }

  return (
    <div className="page library-page">
      <div className="library-filters">
        <div className="filter-row">
          <div className="filter-group">
            {(
              [
                ["all", "全部"],
                ["unread", "未读"],
                ["read", "已读"],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                className={readFilter === id ? "tag-chip active" : "tag-chip"}
                onClick={() => setReadFilter(id)}
              >
                {label}
              </button>
            ))}
          </div>
          <button
            type="button"
            className={likedOnly ? "tag-chip active" : "tag-chip"}
            onClick={() => setLikedOnly((v) => !v)}
          >
            ★ 收藏
          </button>
          <select
            className="filter-select"
            value={sourceFilter}
            onChange={(e) => setSourceFilter(e.target.value)}
          >
            <option value="">全部来源</option>
            {sources.map(([name, count]) => (
              <option key={name} value={name}>
                {name}（{count}）
              </option>
            ))}
          </select>
          {hasFilter && (
            <button type="button" className="tag-chip clear" onClick={clearFilters}>
              清除筛选
            </button>
          )}
        </div>

        <div className="filter-row">
          <div className="filter-group">
            <button
              type="button"
              className={levelFilter === "all" ? "tag-chip active" : "tag-chip"}
              onClick={() => setLevelFilter("all")}
            >
              全部难度
            </button>
            {DIFFICULTY_LEVELS.map((level) => (
              <button
                key={level}
                type="button"
                className={levelFilter === level ? "tag-chip active" : "tag-chip"}
                onClick={() => setLevelFilter(level)}
              >
                {difficultyLabel(level)}
                {levelCounts.get(level) ? ` ${levelCounts.get(level)}` : ""}
              </button>
            ))}
          </div>
        </div>

        {tags.length > 0 && (
          <div className="filter-row">
            <div className="filter-group">
              {tags.map((tag) => {
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
            </div>
          </div>
        )}
      </div>

      {error && <p className="banner err">{error}</p>}
      {loading && articles.length === 0 && <p className="muted">加载中…</p>}
      {!loading && visible.length === 0 && !error && (
        <div className="empty">
          <p>没有符合条件的文章。</p>
        </div>
      )}

      {visible.length > 0 && (
        <ul className="article-list library-list">
          {visible.map((a) => (
            <ArticleRow
              key={a.id}
              article={a}
              difficulty={difficultyById.get(a.id) ?? null}
              showSource
            />
          ))}
        </ul>
      )}

      {hasMore && (
        <div className="load-more-row">
          <button
            type="button"
            className="btn"
            onClick={() => void loadMore()}
            disabled={loading}
          >
            {loading ? "加载中…" : "加载更多"}
          </button>
        </div>
      )}
    </div>
  );
}
