import { useCallback, useEffect, useState } from "react";
import { api, type LookupEntry } from "../api";
import { useVocab } from "../store";
import { useToast } from "./Toaster";

/**
 * Lookup history: every term resolved through the selection popover, with
 * quick paths into the vocab/known libraries.
 */
export default function LookupHistory() {
  const [entries, setEntries] = useState<LookupEntry[]>([]);
  const [q, setQ] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [added, setAdded] = useState<Set<number>>(new Set());
  const { refreshLearningTerms } = useVocab();
  const toast = useToast();

  const load = useCallback(async (search: string) => {
    setError(null);
    try {
      setEntries(await api.listLookups(search || undefined, 200, 0));
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    void load(q);
  }, [load, q]);

  async function addToVocab(entry: LookupEntry) {
    try {
      await api.addMemory({
        kind: "word",
        term: entry.term,
        contextSentence: entry.context,
        articleId: entry.article_id,
        definitionZh: null,
      });
      setAdded((prev) => new Set(prev).add(entry.id));
      toast.ok(`已加入生词库：${entry.term}`);
      void refreshLearningTerms();
    } catch (e) {
      toast.err(String(e));
    }
  }

  async function markKnown(entry: LookupEntry) {
    try {
      await api.addKnownWord(entry.term.trim().toLowerCase());
      setAdded((prev) => new Set(prev).add(entry.id));
      toast.ok(`已标记认识：${entry.term}`);
    } catch (e) {
      toast.err(String(e));
    }
  }

  async function remove(entry: LookupEntry) {
    try {
      await api.deleteLookup(entry.id);
      setEntries((prev) => prev.filter((e) => e.id !== entry.id));
    } catch (e) {
      setError(String(e));
    }
  }

  async function clearAll() {
    if (!window.confirm("确定清空全部查词历史？此操作不可恢复。")) return;
    try {
      await api.clearLookups();
      setEntries([]);
    } catch (e) {
      setError(String(e));
    }
  }

  return (
    <div className="lookup-history">
      <div className="lookup-toolbar">
        <input
          className="search"
          placeholder="搜索查过的词…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        {entries.length > 0 && (
          <button type="button" className="btn small" onClick={() => void clearAll()}>
            清空
          </button>
        )}
      </div>
      {error && <p className="banner err">{error}</p>}
      <ul className="vocab-list">
        {entries.map((entry) => (
          <li key={entry.id} className="vocab-card">
            <div className="vocab-head">
              <strong>{entry.term}</strong>
              <span className="pill">
                {new Date(entry.created_at).toLocaleString()}
              </span>
            </div>
            {entry.context && <p className="context">“{entry.context}”</p>}
            <div className="row-actions">
              {added.has(entry.id) ? (
                <span className="muted">已处理</span>
              ) : (
                <>
                  <button
                    className="btn small"
                    onClick={() => void addToVocab(entry)}
                  >
                    加入生词库
                  </button>
                  <button
                    className="btn small"
                    onClick={() => void markKnown(entry)}
                  >
                    标记已知
                  </button>
                </>
              )}
              <button
                className="btn small danger"
                onClick={() => void remove(entry)}
              >
                删除
              </button>
            </div>
          </li>
        ))}
        {entries.length === 0 && !error && (
          <p className="muted">还没有查词记录。阅读或浏览列表时划词查询会自动留档。</p>
        )}
      </ul>
    </div>
  );
}
