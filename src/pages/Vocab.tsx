import { useCallback, useEffect, useState } from "react";
import { api, VocabItem } from "../api";
import { useVocab } from "../store";

type Tab = "learning" | "review" | "mastered";

export default function Vocab() {
  const { refreshLearningTerms } = useVocab();
  const [tab, setTab] = useState<Tab>("learning");
  const [items, setItems] = useState<VocabItem[]>([]);
  const [due, setDue] = useState<VocabItem[]>([]);
  const [current, setCurrent] = useState<VocabItem | null>(null);
  const [flipped, setFlipped] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");

  const load = useCallback(async () => {
    setError(null);
    try {
      if (tab === "review") {
        const d = await api.dueVocab();
        setDue(d);
        setCurrent(d[0] ?? null);
        setFlipped(false);
      } else {
        const list = await api.listVocab(tab);
        setItems(list);
      }
    } catch (e) {
      setError(String(e));
    }
  }, [tab]);

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
      await api.reviewVocab(current.id, rating);
      void refreshLearningTerms();
      const rest = due.filter((d) => d.id !== current.id);
      setDue(rest);
      setCurrent(rest[0] ?? null);
      setFlipped(false);
    } catch (e) {
      setError(String(e));
    }
  }

  async function markMastered(id: string) {
    await api.setVocabStatus(id, "mastered");
    await load();
    await refreshLearningTerms();
  }

  async function restore(id: string) {
    await api.setVocabStatus(id, "learning");
    await load();
    await refreshLearningTerms();
  }

  async function remove(id: string) {
    await api.deleteVocab(id);
    await load();
    await refreshLearningTerms();
  }

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>生词库</h1>
          <p className="muted">总览 · 复习 · 已掌握归档</p>
        </div>
      </header>

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
            placeholder="搜索词条 / 释义 / 类型"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <ul className="vocab-list">
            {filtered.map((v) => (
              <li key={v.id} className="vocab-card">
                <div className="vocab-head">
                  <strong>{v.term}</strong>
                  <span className="pill">{v.word_type}</span>
                </div>
                <p>{v.definition_zh}</p>
                {v.collocations?.length > 0 && (
                  <p className="muted">
                    常见搭配：{v.collocations.join(" · ")}
                  </p>
                )}
                {v.context_sentence && (
                  <p className="context">“{v.context_sentence}”</p>
                )}
                <div className="row-actions">
                  {tab === "learning" && (
                    <button className="btn small" onClick={() => void markMastered(v.id)}>
                      标记已掌握
                    </button>
                  )}
                  {tab === "mastered" && (
                    <button className="btn small" onClick={() => void restore(v.id)}>
                      恢复学习
                    </button>
                  )}
                  <button className="btn small danger" onClick={() => void remove(v.id)}>
                    删除
                  </button>
                </div>
              </li>
            ))}
            {filtered.length === 0 && <p className="muted">暂无词条</p>}
          </ul>
        </>
      )}

      {tab === "review" && (
        <div className="review-panel">
          {!current && <p className="muted">今日没有到期复习的词条。</p>}
          {current && (
            <>
              <p className="muted">剩余 {due.length} 张</p>
              <div className="flashcard" onClick={() => setFlipped((f) => !f)}>
                <div className="flash-term">{current.term}</div>
                <p className="context">“{current.context_sentence}”</p>
                {flipped ? (
                  <div className="flash-back">
                    <p>{current.definition_zh}</p>
                    <p className="pill inline">{current.word_type}</p>
                    {current.collocations?.length > 0 && (
                      <p className="muted">
                        常见搭配：{current.collocations.join(" · ")}
                      </p>
                    )}
                  </div>
                ) : (
                  <p className="muted tip">点击卡片查看释义</p>
                )}
              </div>
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
    </div>
  );
}
