import { describe, expect, it } from "vitest";
import type { ArticleListItem } from "./api/types";
import { topTags } from "./pages/Home";

function item(id: string, tags: string[]): ArticleListItem {
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
    last_opened_at: null,
    open_count: 0,
    word_count: 800,
    rank_score: 0,
    dwell_ms: 0,
    read_completed: false,
    liked: false,
    tags,
  };
}

describe("topTags", () => {
  it("ranks tags by frequency and caps the list", () => {
    const tags = topTags(
      [
        item("a", ["ai", "economy"]),
        item("b", ["ai"]),
        item("c", ["economy", "chips"]),
      ],
      2,
    );
    expect(tags).toEqual(["ai", "economy"]);
  });

  it("tolerates missing tags and empty input", () => {
    expect(topTags([], 12)).toEqual([]);
    expect(topTags([item("a", [])])).toEqual([]);
  });
});
