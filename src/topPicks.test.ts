import { describe, expect, it } from "vitest";
import type { ArticleListItem } from "./api/types";
import { pickTopArticles, topPickIds } from "./topPicks";

function item(id: string, opened: boolean): ArticleListItem {
  return {
    id,
    url: `https://example.com/${id}`,
    title: id,
    title_zh: "",
    source: "S",
    category: "tech",
    published_at: null,
    excerpt: "",
    fetched_at: "2020-01-01T00:00:00Z",
    origin: "rss",
    summary_zh: "",
    last_opened_at: opened ? "2020-01-02T00:00:00Z" : null,
    open_count: opened ? 1 : 0,
    word_count: 800,
    rank_score: 0,
    dwell_ms: 0,
    read_completed: false,
    liked: false,
    tags: [],
  };
}

describe("pickTopArticles", () => {
  it("takes the unread prefix in ranked order", () => {
    const ranked = [item("a", true), item("b", false), item("c", false)];
    expect(pickTopArticles(ranked, 2).map((a) => a.id)).toEqual(["b", "c"]);
  });

  it("respects the max and skips fully-read lists", () => {
    const all = [item("a", true), item("b", true)];
    expect(pickTopArticles(all, 5)).toEqual([]);
    const many = ["1", "2", "3", "4", "5", "6", "7"].map((id) =>
      item(id, false),
    );
    expect(pickTopArticles(many, 5).map((a) => a.id)).toEqual([
      "1",
      "2",
      "3",
      "4",
      "5",
    ]);
  });

  it("topPickIds covers picks only", () => {
    const picks = pickTopArticles(
      [item("x", false), item("y", false)],
      5,
    );
    const ids = topPickIds(picks);
    expect(ids.has("x")).toBe(true);
    expect(ids.has("missing")).toBe(false);
  });
});
