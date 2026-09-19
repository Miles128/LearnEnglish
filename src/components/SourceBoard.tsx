import type { ArticleListItem } from "../api";
import type { DifficultyLevel } from "../difficulty";
import ArticleRow from "./ArticleRow";

export type SourceSection = {
  source: string;
  category: string;
  articles: ArticleListItem[];
};

type Props = {
  section: SourceSection;
  /** article id → local difficulty level (computed by the parent). */
  difficultyById: Map<string, DifficultyLevel | null>;
  /** Collapse state is owned by the parent (Home) so 全部折叠 can work. */
  collapsed: boolean;
  onToggleCollapsed: () => void;
  /** Forwarded to ArticleRow: hide tags until the 标签 toggle is on. */
  showTags?: boolean;
  /** Keyboard navigation highlight (article id), forwarded to ArticleRow. */
  highlightedId?: string | null;
};

/** One per-source board on the home page: header + article list. */
export default function SourceBoard({
  section,
  difficultyById,
  collapsed,
  onToggleCollapsed,
  showTags,
  highlightedId,
}: Props) {
  return (
    <section className="source-board">
      <button
        type="button"
        className="source-board-head"
        aria-expanded={!collapsed}
        onClick={onToggleCollapsed}
      >
        <span className="source-board-chevron" aria-hidden>
          ▾
        </span>
        <h2>{section.source}</h2>
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
              highlighted={a.id === highlightedId}
            />
          ))}
        </ul>
      )}
    </section>
  );
}
