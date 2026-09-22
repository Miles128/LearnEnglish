export const SOURCE_COLLAPSE_KEY = "shiyan.sourceCollapsed";

/**
 * Source-board collapse state. `all` is the mode, `keys` are the exceptions:
 * - `all: true`  — every board is collapsed unless its source is listed in `keys`
 * - `all: false` — only the sources listed in `keys` are collapsed
 *
 * Storing the mode (instead of a flat list of collapsed names) is what makes
 * 全部折叠 stick: boards that only show up later — next infinite-scroll page,
 * re-ranking after the difficulty lexicon loads, 今日推荐 swapping members —
 * default to collapsed instead of popping up expanded.
 */
export type CollapseState = { all: boolean; keys: string[] };

export const COLLAPSE_NONE: CollapseState = { all: false, keys: [] };
export const COLLAPSE_ALL: CollapseState = { all: true, keys: [] };

export function isSourceCollapsed(
  state: CollapseState,
  source: string,
): boolean {
  const listed = state.keys.includes(source);
  return state.all ? !listed : listed;
}

/** Flips one board; `keys` membership is the flip in both modes. */
export function toggleSourceCollapsed(
  state: CollapseState,
  source: string,
): CollapseState {
  const listed = state.keys.includes(source);
  return {
    all: state.all,
    keys: listed
      ? state.keys.filter((k) => k !== source)
      : [...state.keys, source],
  };
}

function cleanKeys(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const keys = value.filter(
    (x): x is string => typeof x === "string" && x.length > 0,
  );
  return [...new Set(keys)];
}

export function parseCollapseState(raw: string | null): CollapseState {
  if (!raw) return COLLAPSE_NONE;
  try {
    const parsed: unknown = JSON.parse(raw);
    // Legacy shape: a bare array of collapsed source names.
    if (Array.isArray(parsed)) {
      return { all: false, keys: cleanKeys(parsed) };
    }
    if (typeof parsed !== "object" || parsed === null) return COLLAPSE_NONE;
    const obj = parsed as { all?: unknown; keys?: unknown };
    return { all: obj.all === true, keys: cleanKeys(obj.keys) };
  } catch {
    return COLLAPSE_NONE;
  }
}

export function serializeCollapseState(state: CollapseState): string {
  return JSON.stringify({ all: state.all, keys: state.keys });
}

export function loadCollapseState(): CollapseState {
  try {
    return parseCollapseState(localStorage.getItem(SOURCE_COLLAPSE_KEY));
  } catch {
    return COLLAPSE_NONE;
  }
}

export function saveCollapseState(state: CollapseState): void {
  try {
    localStorage.setItem(SOURCE_COLLAPSE_KEY, serializeCollapseState(state));
  } catch {
    /* private mode / quota */
  }
}
