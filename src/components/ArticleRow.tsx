import { Link } from "react-router-dom";
import type { ArticleListItem } from "../api";
import { articleListBlurb } from "../articleList";
import {
  difficultyClassName,
  difficultyLabel,
  type DifficultyLevel,
} from "../difficulty";
import { articleIsRead } from "../learningStats";

type Props = {
  article: ArticleListItem;
  /** Local difficulty level (computed by the page). */
  difficulty: DifficultyLevel | null;
  /** Show the source name (library view). */
  showSource?: boolean;
};

/** One article row, shared by the home boards and the library list. */
export default function ArticleRow({ article, difficulty, showSource }: Props) {
  const blurb = articleListBlurb(article);
  return (
    <li>
      <Link
        to={`/article/${article.id}`}
        className={articleIsRead(article) ? "article-row is-read" : "article-row"}
      >
        <div className="article-title-line">
          <h3 className="article-title-en">{article.title}</h3>
          {difficulty && (
            <span className={difficultyClassName(difficulty)}>
              {difficultyLabel(difficulty)}
            </span>
          )}
        </div>
        {showSource ? (
          <p className="article-row-source muted">
            {article.source}
            {article.liked ? " · ★ 收藏" : ""}
            {articleIsRead(article) ? " · 已读" : ""}
          </p>
        ) : null}
        {article.title_zh ? (
          <p className="article-title-zh">{article.title_zh}</p>
        ) : null}
        {blurb ? <p className="article-summary-zh">{blurb}</p> : null}
        {article.tags.length > 0 ? (
          <p className="article-tags muted">{article.tags.join(" · ")}</p>
        ) : null}
      </Link>
    </li>
  );
}
