import { describe, expect, it } from "vitest";
import {
  COLLAPSE_ALL,
  COLLAPSE_NONE,
  isSourceCollapsed,
  parseCollapseState,
  serializeCollapseState,
  toggleSourceCollapsed,
} from "./sourceCollapse";

describe("parseCollapseState", () => {
  it("returns the default for missing or invalid input", () => {
    expect(parseCollapseState(null)).toEqual(COLLAPSE_NONE);
    expect(parseCollapseState("")).toEqual(COLLAPSE_NONE);
    expect(parseCollapseState("{")).toEqual(COLLAPSE_NONE);
    expect(parseCollapseState("null")).toEqual(COLLAPSE_NONE);
    expect(parseCollapseState("1")).toEqual(COLLAPSE_NONE);
  });

  it("migrates the legacy array shape to per-source collapsing", () => {
    const state = parseCollapseState(JSON.stringify(["NPR", "", 3, "BBC"]));
    expect(state).toEqual({ all: false, keys: ["NPR", "BBC"] });
  });

  it("reads the mode and drops junk keys", () => {
    const state = parseCollapseState(
      JSON.stringify({ all: true, keys: ["NPR", "NPR", 7, ""] }),
    );
    expect(state).toEqual({ all: true, keys: ["NPR"] });
    expect(parseCollapseState(JSON.stringify({ all: "yes" })).all).toBe(false);
  });
});

describe("isSourceCollapsed", () => {
  it("collapses everything unlisted while in collapse-all mode", () => {
    expect(isSourceCollapsed(COLLAPSE_ALL, "NPR")).toBe(true);
    const withException = { all: true, keys: ["NPR"] };
    expect(isSourceCollapsed(withException, "NPR")).toBe(false);
    expect(isSourceCollapsed(withException, "BBC")).toBe(true);
  });

  it("only collapses the listed sources otherwise", () => {
    const state = { all: false, keys: ["NPR"] };
    expect(isSourceCollapsed(state, "NPR")).toBe(true);
    expect(isSourceCollapsed(state, "BBC")).toBe(false);
  });
});

describe("toggleSourceCollapsed", () => {
  it("flips a single board in either mode", () => {
    const collapsed = toggleSourceCollapsed(COLLAPSE_NONE, "NPR");
    expect(collapsed).toEqual({ all: false, keys: ["NPR"] });
    expect(toggleSourceCollapsed(collapsed, "NPR")).toEqual(COLLAPSE_NONE);

    const excepted = toggleSourceCollapsed(COLLAPSE_ALL, "NPR");
    expect(isSourceCollapsed(excepted, "NPR")).toBe(false);
    expect(toggleSourceCollapsed(excepted, "NPR")).toEqual(COLLAPSE_ALL);
  });

  it("keeps collapse-all mode when one board is expanded", () => {
    const state = toggleSourceCollapsed(COLLAPSE_ALL, "NPR");
    expect(state.all).toBe(true);
    // A board that only shows up later is still collapsed.
    expect(isSourceCollapsed(state, "BBC")).toBe(true);
  });
});

describe("serializeCollapseState", () => {
  it("round-trips through JSON", () => {
    const state = { all: true, keys: ["BBC"] };
    expect(parseCollapseState(serializeCollapseState(state))).toEqual(state);
  });
});
