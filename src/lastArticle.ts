/** Remember where the reader was, so leaving to other pages is reversible. */

const KEY = "shiyan:last-article";
const SCROLL_PREFIX = "shiyan:scroll:";

/** In-memory fallback: keeps functions total in tests / non-DOM contexts. */
const memory = new Map<string, string>();

function storage(kind: "local" | "session"): Storage | null {
  try {
    const s = kind === "local" ? window.localStorage : window.sessionStorage;
    return s ?? null;
  } catch {
    return null;
  }
}

function read(kind: "local" | "session", key: string): string | null {
  const s = storage(kind);
  return s ? s.getItem(key) : (memory.get(`${kind}:${key}`) ?? null);
}

function write(kind: "local" | "session", key: string, value: string) {
  const s = storage(kind);
  if (s) {
    s.setItem(key, value);
  } else {
    memory.set(`${kind}:${key}`, value);
  }
}

/** Test helper: clear the in-memory fallback. */
export function resetLastArticleMemory() {
  memory.clear();
}

export function rememberLastArticle(id: string) {
  if (!id) return;
  write("local", KEY, id);
}

export function getLastArticleId(): string | null {
  const id = read("local", KEY);
  return id && id.length > 0 ? id : null;
}

/** Router path for resuming the last article, or null when there is none. */
export function lastArticlePath(): string | null {
  const id = getLastArticleId();
  return id ? `/article/${id}` : null;
}

export function saveScroll(id: string, y: number) {
  if (!id) return;
  write("session", `${SCROLL_PREFIX}${id}`, String(Math.max(0, Math.round(y))));
}

export function loadScroll(id: string): number | null {
  if (!id) return null;
  const raw = read("session", `${SCROLL_PREFIX}${id}`);
  if (raw == null) return null;
  const y = Number(raw);
  return Number.isFinite(y) ? y : null;
}
