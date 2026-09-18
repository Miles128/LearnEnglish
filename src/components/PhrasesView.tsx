import { useCallback, useEffect, useState } from "react";
import { clipContext } from "../readerUtils";
import { api, PhraseItem } from "../api";

type Tab = "learning" | "review" | "mastered";

const USAGE_LABELS: Record<string, string> = {
  idiom: "习语",
  "phrasal-verb": "短语动词",
  collocation: "搭配",
  "fixed-expression": "固定表达",
  slang: "俚语",
  phrase: "短语",
};

function usageLabel(usage: string): string {
  return USAGE_LABELS[usage] ?? usage;
}

/** 短语组合 view, embedded in the学习界面 (Vocab page). */
export default function PhrasesView() {
  const [tab, setTab] = useState<Tab>("learning");
  const [items, setItems] = useState<PhraseItem[]>([]);
  const [due, setDue] = useState<PhraseItem[]>([]);
  const [current, setCurrent] = useState<PhraseItem | null>(null);
  const [flipped, setFlipped] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");

  const load = useCallback(async () => {
    setError(null);
    try {
      if (tab === "review") {
        const d = await api.duePhrases();
        setDue(d);
        setCurrent(d[0] ?? null);
        setFlipped(false);
      } else {
        setItems(await api.listPhrases(tab));
      }
    } catch (e) {
      setError(String(e));
    }
  }, [tab]);

  useEffect(() => {
    void load();
  }, [load]);

  const filtered = items.filter((p) => {
    if (!q.trim()) return true;
    const s = q.toLowerCase();
    return (
      p.phrase.toLowerCase().includes(s) ||
      p.meaning_zh.includes(q) ||
      p.context_sentence.toLowerCase().includes(s)
    );
  });

  async function rate(rating: string) {
    if (!current) return;
    try {
      await api.reviewPhrase(current.id, rating);
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
      await api.setPhraseStatus(id, status);
      await load();
    } catch (e) {
      setError(String(e));
    }
  }

  async function remove(id: string) {
    try {
      await api.deletePhrase(id);
      await load();
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
            placeholder="搜索短语 / 释义 / 例句"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <ul className="vocab-list">
            {filtered.map((p) => (
              <li key={p.id} className="vocab-card">
                <div className="vocab-head">
                  <strong>{p.phrase}</strong>
                  <span className="pill">{usageLabel(p.usage)}</span>
                </div>
                <p>{p.meaning_zh}</p>
                {p.context_sentence && (
                  <p className="context">“{clipContext(p.context_sentence)}”</p>
                )}
                <div className="row-actions">
                  {tab === "learning" && (
                    <button
                      className="btn small"
                      onClick={() => void setStatus(p.id, "mastered")}
                    >
                      标记已掌握
                    </button>
                  )}
                  {tab === "mastered" && (
                    <button
                      className="btn small"
                      onClick={() => void setStatus(p.id, "learning")}
                    >
                      恢复学习
                    </button>
                  )}
                  <button
                    className="btn small danger"
                    onClick={() => void remove(p.id)}
                  >
                    删除
                  </button>
                </div>
              </li>
            ))}
            {filtered.length === 0 && (
              <p className="muted">
                还没有短语。阅读时选中一串词语，点「加入短语组合」即可收藏。
              </p>
            )}
          </ul>
        </>
      )}

      {tab === "review" && (
        <div className="review-panel">
          {!current && <p className="muted">今日没有到期复习的短语。</p>}
          {current && (
            <>
              <p className="muted">剩余 {due.length} 张</p>
              <button
                type="button"
                className="flashcard"
                aria-pressed={flipped}
                onClick={() => setFlipped((f) => !f)}
              >
                <div className="flash-term">{current.phrase}</div>
                <p className="context">“{clipContext(current.context_sentence)}”</p>
                {flipped ? (
                  <div className="flash-back">
                    <p>{current.meaning_zh}</p>
                    <p className="pill inline">{usageLabel(current.usage)}</p>
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
