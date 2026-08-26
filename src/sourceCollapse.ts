export const SOURCE_COLLAPSE_KEY = "shiyan.sourceCollapsed";

export function parseCollapsedSources(raw: string | null): Set<string> {
  if (!raw) return new Set();
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(
      parsed.filter((x): x is string => typeof x === "string" && x.length > 0),
    );
  } catch {
    return new Set();
  }
}

export function serializeCollapsedSources(collapsed: Set<string>): string {
  return JSON.stringify([...collapsed]);
}

export function toggleSourceCollapsed(
  collapsed: Set<string>,
  source: string,
): Set<string> {
  const next = new Set(collapsed);
  if (next.has(source)) next.delete(source);
  else next.add(source);
  return next;
}

export function loadCollapsedSources(): Set<string> {
  try {
    return parseCollapsedSources(localStorage.getItem(SOURCE_COLLAPSE_KEY));
  } catch {
    return new Set();
  }
}

export function saveCollapsedSources(collapsed: Set<string>): void {
  try {
    localStorage.setItem(
      SOURCE_COLLAPSE_KEY,
      serializeCollapsedSources(collapsed),
    );
  } catch {
    /* private mode / quota */
  }
}
