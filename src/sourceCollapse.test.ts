import { describe, expect, it } from "vitest";
import {
  parseCollapsedSources,
  serializeCollapsedSources,
  toggleSourceCollapsed,
} from "./sourceCollapse";

describe("parseCollapsedSources", () => {
  it("returns empty for missing or invalid input", () => {
    expect([...parseCollapsedSources(null)]).toEqual([]);
    expect([...parseCollapsedSources("")]).toEqual([]);
    expect([...parseCollapsedSources("{")]).toEqual([]);
    expect([...parseCollapsedSources("null")]).toEqual([]);
    expect([...parseCollapsedSources("1")]).toEqual([]);
  });

  it("keeps only non-empty strings", () => {
    const set = parseCollapsedSources(JSON.stringify(["NPR", "", 3, "BBC"]));
    expect(set.has("NPR")).toBe(true);
    expect(set.has("BBC")).toBe(true);
    expect(set.size).toBe(2);
  });
});

describe("toggleSourceCollapsed", () => {
  it("collapses an expanded source and expands a collapsed one", () => {
    const once = toggleSourceCollapsed(new Set(), "NPR");
    expect([...once]).toEqual(["NPR"]);
    const twice = toggleSourceCollapsed(once, "NPR");
    expect([...twice]).toEqual([]);
  });
});

describe("serializeCollapsedSources", () => {
  it("round-trips through JSON", () => {
    const raw = serializeCollapsedSources(new Set(["NPR", "BBC"]));
    const parsed = parseCollapsedSources(raw);
    expect(parsed.has("NPR")).toBe(true);
    expect(parsed.has("BBC")).toBe(true);
    expect(parsed.size).toBe(2);
  });
});
