import { useCallback, useEffect, useState } from "react";
import { clipContext } from "../readerUtils";
import { api, type MemoryItem, type MemoryKind } from "../api";
import { useTts } from "../useTts";
import { useToast } from "./Toaster";

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

/** Fisher-Yates; returns a fresh array. */
function shuffled<T>(list: T[]): T[] {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
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
  /** Free-practice deck (shuffled learning list); non-null = practice mode, no SRS writes. */
  const [practiceDeck, setPracticeDeck] = useState<MemoryItem[] | null>(null);
  const tts = useTts();
  const toast = useToast();

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

  // Leaving the review tab ends practice mode.
  useEffect(() => {
    if (tab !== "review") setPracticeDeck(null);
  }, [tab]);

  const speakTerm = useCallback((text: string) => {
    if (!text.trim()) return;
    tts.startSpeak({ kind: "word" }, [text]);
  }, [tts]);

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
    // Practice mode never writes to the SRS schedule — just advance.
    if (practiceDeck) {
      advancePractice();
      return;
    }
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

  function advancePractice() {
    setPracticeDeck((prev) => (prev ? prev.slice(1) : prev));
    setFlipped(false);
  }

  async function startPractice() {
    try {
      const list = await api.listMemory(kind, "learning");
      if (list.length === 0) {
        toast.ok("学习库还是空的，先去积累几个生词吧。");
        return;
      }
      setPracticeDeck(shuffled(list));
      setFlipped(false);
    } catch (e) {
      setError(String(e));
    }
  }

  // Practice deck exhausted → wrap up.
  useEffect(() => {
    if (practiceDeck && practiceDeck.length === 0) {
      setPracticeDeck(null);
      setFlipped(false);
      toast.ok("练习完成！");
    }
  }, [practiceDeck, toast]);

  // Keyboard: Space/Enter flips, 1/2/3 rate (or advance in practice mode).
  useEffect(() => {
    if (tab !== "review") return;
    const activeCard = practiceDeck ? practiceDeck[0] ?? null : current;
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement;
      // Let buttons, links, and form controls handle their own Enter/Space.
      if (
        el &&
        (el.tagName === "INPUT" ||
          el.tagName === "TEXTAREA" ||
          el.tagName === "BUTTON" ||
          el.tagName === "A" ||
          el.tagName === "SELECT" ||
          el.getAttribute("role") === "button")
      )
        return;
      if (e.key === " " || e.key === "Enter") {
        e.preventDefault();
        setFlipped((f) => !f);
      } else if (e.key === "1" || e.key === "2" || e.key === "3") {
        if (!activeCard) return;
        e.preventDefault();
        void rate(e.key === "1" ? "again" : e.key === "2" ? "hard" : "easy");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, practiceDeck, current]);

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
          {(() => {
            const activeCard = practiceDeck ? practiceDeck[0] ?? null : current;
            const deckDone = practiceDeck !== null && practiceDeck.length === 0;
            if (deckDone) return null;
            if (!activeCard) {
              return (
                <>
                  <p className="muted">今日没有到期复习的词条。</p>
                  <button
                    type="button"
                    className="btn"
                    onClick={() => void startPractice()}
                  >
                    自由练习（学习中的词 · 不计入复习计划）
                  </button>
                </>
              );
            }
            return (
              <>
                <p className="muted review-meta">
                  {practiceDeck ? (
                    <>
                      练习模式 · 剩余 {practiceDeck.length} 张 · 不计入复习计划{" "}
                      <button
                        type="button"
                        className="linklike"
                        onClick={() => setPracticeDeck(null)}
                      >
                        退出练习
                      </button>
                    </>
                  ) : (
                    <>剩余 {due.length} 张</>
                  )}
                  {" · Space 翻面 · 1/2/3 评分 "}
                  <button
                    type="button"
                    className="linklike"
                    onClick={() => speakTerm(activeCard.term)}
                  >
                    🔊 发音
                  </button>
                </p>
                <button
                  type="button"
                  className="flashcard"
                  aria-pressed={flipped}
                  onClick={() => setFlipped((f) => !f)}
                >
                  <p className="flash-context">
                    “{clipContext(activeCard.context_sentence || activeCard.term)}”
                  </p>
                  {flipped ? (
                    <div className="flash-back">
                      <div className="flash-term">{activeCard.term}</div>
                      <p>{activeCard.definition_zh}</p>
                      {activeCard.word_type && (
                        <p className="pill inline">
                          {typeLabel(kind, activeCard.word_type)}
                        </p>
                      )}
                      {activeCard.collocations?.length > 0 && (
                        <p className="muted">
                          常见搭配：{activeCard.collocations.join(" · ")}
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
                  <button
                    className="btn primary"
                    onClick={() => void rate("easy")}
                  >
                    认识
                  </button>
                </div>
              </>
            );
          })()}
        </div>
      )}
    </>
  );
}
