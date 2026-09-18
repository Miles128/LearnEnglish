import { useState } from "react";
import { Link } from "react-router-dom";
import type { ArticleListItem, FeedCategory } from "../api";
import { articleListBlurb } from "../articleList";
import { categoryLabel } from "../readerUtils";
import {
  difficultyClassName,
  difficultyLabel,
  type DifficultyLevel,
} from "../difficulty";
import { articleIsRead } from "../learningStats";
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
};

/** One per-source board on the home page: header + article list. */
export default function SourceBoard({ section, categories, difficultyById }: Props) {
  const [collapsed, setCollapsed] = useState(
    () => loadCollapsedSources().has(section.source),
  );

  function toggle() {
    const next = toggleSourceCollapsed(loadCollapsedSources(), section.source);
    saveCollapsedSources(next);
    setCollapsed(next.has(section.source));
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
          {section.articles.map((a) => {
            const level = difficultyById.get(a.id) ?? null;
            const blurb = articleListBlurb(a);
            return (
              <li key={a.id}>
                <Link
                  to={`/article/${a.id}`}
                  className={
                    articleIsRead(a) ? "article-row is-read" : "article-row"
                  }
                >
                  <div className="article-title-line">
                    <h3 className="article-title-en">{a.title}</h3>
                    {level && (
                      <span className={difficultyClassName(level)}>
                        {difficultyLabel(level)}
                      </span>
                    )}
                  </div>
                  {a.title_zh ? (
                    <p className="article-title-zh">{a.title_zh}</p>
                  ) : null}
                  {blurb ? <p className="article-summary-zh">{blurb}</p> : null}
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
