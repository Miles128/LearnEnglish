import { useState } from "react";
import type { ArticleListItem, FeedCategory } from "../api";
import type { DifficultyLevel } from "../difficulty";
import { categoryLabel } from "../readerUtils";
import ArticleRow from "./ArticleRow";
import {
  loadCollapsedSources,
  saveCollapsedSources,
  toggleSourceCollapsed,
} from "../sourceCollapse";

export type SourceSection = {
  source: string;
  category: string;
  articles: ArticleListItem[];
};

type Props = {
  section: SourceSection;
  categories: FeedCategory[];
  /** article id → local difficulty level (computed by the parent). */
  difficultyById: Map<string, DifficultyLevel | null>;
  /** Persist collapse state under this key instead of the source name.
   *  No stored preference = expanded (今日推荐 is open by default). */
  collapseKey?: string;
  /** Forwarded to ArticleRow: hide tags until the 标签 toggle is on. */
  showTags?: boolean;
};

/** One per-source board on the home page: header + article list. */
export default function SourceBoard({
  section,
  categories,
  difficultyById,
  collapseKey,
  showTags,
}: Props) {
  const key = collapseKey ?? section.source;
  const [collapsed, setCollapsed] = useState(() =>
    loadCollapsedSources().has(key),
  );

  function toggle() {
    const next = toggleSourceCollapsed(loadCollapsedSources(), key);
    saveCollapsedSources(next);
    setCollapsed(next.has(key));
  }

  return (
    <section className="source-board">
      <button
        type="button"
        className="source-board-head"
        aria-expanded={!collapsed}
        onClick={toggle}
      >
        <span className="source-board-chevron" aria-hidden>
          ▾
        </span>
        <h2>{section.source}</h2>
        <span className="pill">
          {categoryLabel(section.category, categories)}
        </span>
        <span className="muted">{section.articles.length} 篇</span>
      </button>
      {collapsed ? null : (
        <ul className="article-list">
          {section.articles.map((a) => (
            <ArticleRow
              key={a.id}
              article={a}
              difficulty={difficultyById.get(a.id) ?? null}
              showTags={showTags}
            />
          ))}
        </ul>
      )}
    </section>
  );
}
