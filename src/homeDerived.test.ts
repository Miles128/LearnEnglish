import { describe, expect, it } from "vitest";
import type { ArticleListItem } from "./api/types";
import type { DifficultyLevel } from "./difficulty";
import {
  adjustedScore,
  applyDifficultyOrder,
  articleLengthLabel,
  articleListBlurb,
  articleNeedsCardZh,
  difficultyAdjustment,
  pickTopArticles,
  topTags,
} from "./homeDerived";

function item(
  id: string,
  opts: {
    tags?: string[];
    opened?: boolean;
    category?: string;
    rankScore?: number;
  } = {},
): ArticleListItem {
  return {
    id,
    url: `https://example.com/${id}`,
    title: id,
    source: "S",
    category: opts.category ?? "tech",
    published_at: null,
    excerpt: "",
    fetched_at: "2020-01-01T00:00:00Z",
    origin: "rss",
    summary_zh: "",
    last_opened_at: opts.opened ? "2020-01-02T00:00:00Z" : null,
    open_count: opts.opened ? 1 : 0,
    word_count: 800,
    rank_score: opts.rankScore ?? 0,
    dwell_ms: 0,
    read_completed: false,
    liked: false,
    tags: opts.tags ?? [],
  };
}

describe("articleListBlurb", () => {
  it("prefers the Chinese summary", () => {
    expect(
      articleListBlurb({ summary_zh: "简介", excerpt: "A long English excerpt" }),
    ).toBe("简介");
  });

  it("does not pretend an English excerpt is the Chinese synopsis", () => {
    expect(
      articleListBlurb({ summary_zh: "", excerpt: "x".repeat(200) }),
    ).toBe("");
  });
});

describe("articleLengthLabel", () => {
  it("maps word counts to the length bands", () => {
    expect(articleLengthLabel(450)).toBe("很短");
    expect(articleLengthLabel(599)).toBe("很短");
    expect(articleLengthLabel(600)).toBe("短");
    expect(articleLengthLabel(899)).toBe("短");
    expect(articleLengthLabel(900)).toBe("中");
    expect(articleLengthLabel(1199)).toBe("中");
    expect(articleLengthLabel(1200)).toBe("长");
    expect(articleLengthLabel(1799)).toBe("长");
    expect(articleLengthLabel(1800)).toBe("很长");
    expect(articleLengthLabel(2999)).toBe("很长");
    expect(articleLengthLabel(3000)).toBe("极长");
    expect(articleLengthLabel(19661)).toBe("极长");
  });

  it("hides unknown lengths", () => {
    expect(articleLengthLabel(0)).toBe("");
    expect(articleLengthLabel(-3)).toBe("");
  });
});

describe("articleNeedsCardZh", () => {
  it("is missing only when the Chinese synopsis is empty", () => {
    expect(articleNeedsCardZh({ summary_zh: "一两句简介。" })).toBe(false);
    expect(articleNeedsCardZh({ summary_zh: "" })).toBe(true);
    expect(articleNeedsCardZh({ summary_zh: "   " })).toBe(true);
  });
});

describe("topTags", () => {
  it("ranks tags by frequency and caps the list", () => {
    const tags = topTags(
      [
        item("a", { tags: ["ai", "economy"] }),
        item("b", { tags: ["ai"] }),
        item("c", { tags: ["economy", "chips"] }),
      ],
      2,
    );
    expect(tags).toEqual(["ai", "economy"]);
  });

  it("tolerates missing tags and empty input", () => {
    expect(topTags([], 12)).toEqual([]);
    expect(topTags([item("a")])).toEqual([]);
  });
});

describe("pickTopArticles", () => {
  it("takes the unread prefix in ranked order", () => {
    const ranked = [item("a", { opened: true }), item("b"), item("c")];
    expect(pickTopArticles(ranked, 2).map((a) => a.id)).toEqual(["b", "c"]);
  });

  it("respects the max and skips fully-read lists", () => {
    const all = [item("a", { opened: true }), item("b", { opened: true })];
    expect(pickTopArticles(all, 5)).toEqual([]);
    const many = ["1", "2", "3", "4", "5", "6", "7"].map((id) => item(id));
    expect(pickTopArticles(many, 5).map((a) => a.id)).toEqual([
      "1",
      "2",
      "3",
      "4",
      "5",
    ]);
  });

  it("spreads picks across categories so one section can't dominate", () => {
    const ranked = [
      item("w1", { category: "world" }),
      item("w2", { category: "world" }),
      item("w3", { category: "world" }),
      item("w4", { category: "world" }),
      item("t1", { category: "tech" }),
      item("t2", { category: "tech" }),
      item("f1", { category: "finance" }),
    ];
    const picks = pickTopArticles(ranked, 5).map((a) => a.id);
    // world is capped at 3, so the rest of the row comes from other sections.
    expect(picks.filter((id) => id.startsWith("w"))).toHaveLength(3);
    expect(picks.some((id) => !id.startsWith("w"))).toBe(true);
  });
});

describe("difficultyAdjustment", () => {
  it("peaks at 正常 and falls off with distance", () => {
    expect(difficultyAdjustment("normal")).toBe(0.5);
    expect(difficultyAdjustment("hard")).toBe(0.25);
    expect(difficultyAdjustment("easy")).toBe(0.1);
    expect(difficultyAdjustment("harder")).toBe(-0.2);
    expect(difficultyAdjustment("hardest")).toBe(-0.5);
    expect(difficultyAdjustment(null)).toBe(0);
    // 正常 > 邻近 > 极端
    expect(difficultyAdjustment("normal")).toBeGreaterThan(
      difficultyAdjustment("hard"),
    );
    expect(difficultyAdjustment("hard")).toBeGreaterThan(
      difficultyAdjustment("hardest"),
    );
  });

  it("adjustedScore adds the delta to the backend rank", () => {
    expect(adjustedScore(item("a", { rankScore: 1.0 }), "normal")).toBeCloseTo(1.5);
    expect(adjustedScore(item("a", { rankScore: 1.0 }), null)).toBeCloseTo(1.0);
  });
});

describe("applyDifficultyOrder", () => {
  it("re-sorts by adjusted score; unknown difficulty keeps rank order", () => {
    const levels = new Map<string, DifficultyLevel | null>([
      ["wall", "hardest"], // 2.0 - 0.5 = 1.5
      ["sweet", "normal"], // 0.5 + 0.5 = 1.0
      ["plain", null], // 1.0
    ]);
    const ordered = applyDifficultyOrder(
      [
        item("wall", { rankScore: 2.0 }),
        item("plain", { rankScore: 1.0 }),
        item("sweet", { rankScore: 0.5 }),
      ],
      levels,
    );
    expect(ordered.map((a) => a.id)).toEqual(["wall", "plain", "sweet"]);
  });
});
