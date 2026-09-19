import { useCallback, useEffect, useState } from "react";
import { clipContext } from "../readerUtils";
import { api, type MemoryItem, type MemoryKind } from "../api";

type Tab = "learning" | "review" | "mastered";

const USAGE_LABELS: Record<string, string> = {
  idiom: "习语",
  "phrasal-verb": "短语动词",
  collocation: "搭配",
  "fixed-expression": "固定表达",
  slang: "俚语",
  phrase: "短语",
};

/** Words show their part of speech verbatim; phrases map usage to a CN label. */
function typeLabel(kind: MemoryKind, wordType: string): string {
  if (kind !== "phrase") return wordType;
  return USAGE_LABELS[wordType] ?? wordType;
}

type Props = {
  kind: MemoryKind;
  searchPlaceholder: string;
  emptyText: string;
  /** Called after any add/review/status/delete so the host can refresh highlights. */
  onChanged?: () => void;
};

/** Shared library view for words and phrases (tabs / search / flashcard review). */
export default function MemoryLibrary({
  kind,
  searchPlaceholder,
  emptyText,
  onChanged,
}: Props) {
  const [tab, setTab] = useState<Tab>("learning");
  const [items, setItems] = useState<MemoryItem[]>([]);
  const [due, setDue] = useState<MemoryItem[]>([]);
  const [current, setCurrent] = useState<MemoryItem | null>(null);
  const [flipped, setFlipped] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");

  const load = useCallback(async () => {
    setError(null);
    try {
      if (tab === "review") {
        const d = await api.dueMemory(kind);
        setDue(d);
        setCurrent(d[0] ?? null);
        setFlipped(false);
      } else {
        setItems(await api.listMemory(kind, tab));
      }
    } catch (e) {
      setError(String(e));
    }
  }, [kind, tab]);

  useEffect(() => {
    void load();
  }, [load]);

  const filtered = items.filter((v) => {
    if (!q.trim()) return true;
    const s = q.toLowerCase();
    return (
      v.term.toLowerCase().includes(s) ||
      v.definition_zh.includes(q) ||
      v.word_type.toLowerCase().includes(s)
    );
  });

  async function rate(rating: string) {
    if (!current) return;
    try {
      await api.reviewMemory(current.id, rating);
      onChanged?.();
      const rest = due.filter((d) => d.id !== current.id);
      setDue(rest);
      setCurrent(rest[0] ?? null);
      setFlipped(false);
    } catch (e) {
      setError(String(e));
    }
  }

  async function setStatus(id: string, status: string) {
    try {
      await api.setMemoryStatus(id, status);
      await load();
      onChanged?.();
    } catch (e) {
      setError(String(e));
    }
  }

  async function remove(id: string) {
    try {
      await api.deleteMemory(id);
      await load();
      onChanged?.();
    } catch (e) {
      setError(String(e));
    }
  }

  return (
    <>
      <div className="tabs">
        {(
          [
            ["learning", "学习中"],
            ["review", "复习"],
            ["mastered", "已掌握"],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            className={tab === id ? "tab active" : "tab"}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </div>

      {error && <p className="banner err">{error}</p>}

      {tab !== "review" && (
        <>
          <input
            className="search"
            placeholder={searchPlaceholder}
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <ul className="vocab-list">
            {filtered.map((v) => (
              <li key={v.id} className="vocab-card">
                <div className="vocab-head">
                  <strong>{v.term}</strong>
                  {v.word_type && (
                    <span className="pill">{typeLabel(kind, v.word_type)}</span>
                  )}
                </div>
                <p>{v.definition_zh}</p>
                {v.collocations?.length > 0 && (
                  <p className="muted">
                    常见搭配：{v.collocations.join(" · ")}
                  </p>
                )}
                {v.context_sentence && (
                  <p className="context">“{clipContext(v.context_sentence)}”</p>
                )}
                <div className="row-actions">
                  {tab === "learning" && (
                    <button
                      className="btn small"
                      onClick={() => void setStatus(v.id, "mastered")}
                    >
                      标记已掌握
                    </button>
                  )}
                  {tab === "mastered" && (
                    <button
                      className="btn small"
                      onClick={() => void setStatus(v.id, "learning")}
                    >
                      恢复学习
                    </button>
                  )}
                  <button
                    className="btn small danger"
                    onClick={() => void remove(v.id)}
                  >
                    删除
                  </button>
                </div>
              </li>
            ))}
            {filtered.length === 0 && <p className="muted">{emptyText}</p>}
          </ul>
        </>
      )}

      {tab === "review" && (
        <div className="review-panel">
          {!current && <p className="muted">今日没有到期复习的词条。</p>}
          {current && (
            <>
              <p className="muted">剩余 {due.length} 张</p>
              <button
                type="button"
                className="flashcard"
                aria-pressed={flipped}
                onClick={() => setFlipped((f) => !f)}
              >
                <p className="flash-context">
                  “{clipContext(current.context_sentence || current.term)}”
                </p>
                {flipped ? (
                  <div className="flash-back">
                    <div className="flash-term">{current.term}</div>
                    <p>{current.definition_zh}</p>
                    {current.word_type && (
                      <p className="pill inline">
                        {typeLabel(kind, current.word_type)}
                      </p>
                    )}
                    {current.collocations?.length > 0 && (
                      <p className="muted">
                        常见搭配：{current.collocations.join(" · ")}
                      </p>
                    )}
                  </div>
                ) : (
                  <p className="muted tip">点击或按 Enter 查看释义</p>
                )}
              </button>
              <div className="rate-row">
                <button className="btn" onClick={() => void rate("again")}>
                  不认识
                </button>
                <button className="btn" onClick={() => void rate("hard")}>
                  模糊
                </button>
                <button className="btn primary" onClick={() => void rate("easy")}>
                  认识
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </>
  );
}
