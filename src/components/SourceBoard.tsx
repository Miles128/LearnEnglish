import { Link } from "react-router-dom";
import type { Article, FeedCategory } from "../api";
import { formatKnownPercent } from "../knownPercent";

export type SourceSection = {
  source: string;
  category: string;
  articles: Article[];
};

type Props = {
  section: SourceSection;
  categories: FeedCategory[];
  /** article id → known % estimate (precomputed by the parent). */
  knownPctById: Map<string, number | null>;
};

/** One per-source board on the home page: header + article list. */
export default function SourceBoard({ section, categories, knownPctById }: Props) {
  return (
    <section key={section.source} className="source-board">
      <header className="source-board-head">
        <h2>{section.source}</h2>
        <span className="pill">
          {categories.find((c) => c.id === section.category)?.label ??
            section.category}
        </span>
        <span className="muted">{section.articles.length} 篇</span>
      </header>
      <ul className="article-list">
        {section.articles.map((a) => {
          const pct = knownPctById.get(a.id) ?? null;
          const pctLabel = formatKnownPercent(pct);
          return (
            <li key={a.id}>
              <Link to={`/article/${a.id}`} className="article-row">
                {pctLabel && (
                  <div className="article-row-meta">
                    <span className="known-pct">{pctLabel}</span>
                  </div>
                )}
                <h3 className="article-title-en">{a.title}</h3>
                {a.title_zh ? (
                  <p className="article-title-zh">{a.title_zh}</p>
                ) : null}
                <p className="snippet">{a.content_text.slice(0, 140)}…</p>
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}