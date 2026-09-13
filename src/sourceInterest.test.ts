import { describe, expect, it } from "vitest";
import {
  groupBySource,
  sortSectionsByInterest,
  sourceInterestScore,
} from "./sourceInterest";

const NOW = Date.parse("2026-09-13T12:00:00Z");
const TODAY = "2026-09-12T12:00:00Z";
const OLD = "2026-01-01T00:00:00Z";

describe("sourceInterestScore", () => {
  it("is zero when nothing has been opened", () => {
    expect(
      sourceInterestScore([{ open_count: 0, last_opened_at: null }], NOW),
    ).toBe(0);
  });

  it("counts opens, and doubles them when last opened this week", () => {
    expect(
      sourceInterestScore([{ open_count: 3, last_opened_at: OLD }], NOW),
    ).toBe(3);
    expect(
      sourceInterestScore([{ open_count: 3, last_opened_at: TODAY }], NOW),
    ).toBe(6);
  });
});

describe("sortSectionsByInterest", () => {
  it("puts the most-read source first and keeps unread order", () => {
    const sections = [
      {
        source: "Al Jazeera",
        articles: [{ open_count: 0, last_opened_at: null }],
      },
      {
        source: "BBC",
        articles: [{ open_count: 2, last_opened_at: TODAY }],
      },
      {
        source: "CNN",
        articles: [{ open_count: 0, last_opened_at: null }],
      },
    ];
    expect(sortSectionsByInterest(sections, NOW).map((s) => s.source)).toEqual([
      "BBC",
      "Al Jazeera",
      "CNN",
    ]);
  });
});

describe("groupBySource", () => {
  it("keeps article order inside a source", () => {
    const grouped = groupBySource([
      { id: "1", source: "BBC", category: "world" },
      { id: "2", source: "NPR", category: "world" },
      { id: "3", source: "BBC", category: "world" },
    ]);
    expect(grouped.map((s) => s.source)).toEqual(["BBC", "NPR"]);
    expect(grouped[0]?.articles.map((a) => a.id)).toEqual(["1", "3"]);
  });
});
