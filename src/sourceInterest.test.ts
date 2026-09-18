import { describe, expect, it } from "vitest";
import { groupBySource } from "./sourceInterest";

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

  it("groups by first appearance, which is the ranked order from the backend", () => {
    const grouped = groupBySource([
      { id: "1", source: "CNN", category: "world" },
      { id: "2", source: "BBC", category: "world" },
      { id: "3", source: "CNN", category: "world" },
    ]);
    expect(grouped.map((s) => s.source)).toEqual(["CNN", "BBC"]);
  });
});
