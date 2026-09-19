import { useState } from "react";
import { Link } from "react-router-dom";
import { useAppConfig, useVocab } from "../store";
import { api } from "../api";
import KnownWords from "../components/KnownWords";
import MemoryLibrary from "../components/MemoryLibrary";

type Library = "vocab" | "phrases" | "known";

export default function Vocab() {
  const { refreshLearningTerms } = useVocab();
  const { cfg } = useAppConfig();
  const placementDone = Boolean(cfg.vocab_placement_done);
  const placementSummary = placementDone
    ? `${Math.round(cfg.vocab_placement_l ?? cfg.freq_band)} 词`
    : null;
  const [library, setLibrary] = useState<Library>("vocab");
  const [exportMsg, setExportMsg] = useState<string | null>(null);

  async function exportCsv() {
    setExportMsg(null);
    try {
      const path = await api.exportVocabCsv();
      setExportMsg(path ? `已导出到 ${path}` : "已取消导出");
    } catch (e) {
      setExportMsg(String(e));
    }
  }

  return (
    <div className="page">
      <header className="page-header page-header-slim">
        <div>
          <p className="muted">
            {placementSummary
              ? `我的词频水平：约 ${placementSummary}`
              : "生词与短语的学习与复习"}
          </p>
        </div>
        <div className="row-actions">
          <button className="btn small" onClick={() => void exportCsv()}>
            导出 CSV
          </button>
          <Link className="btn small" to="/placement">
            {placementDone ? "重新测词汇量" : "测一下词汇量"}
          </Link>
        </div>
      </header>
      {exportMsg && <p className="muted">{exportMsg}</p>}

      <div className="tabs library-switch">
        {(
          [
            ["vocab", "生词"],
            ["phrases", "短语组合"],
            ["known", "已认识"],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            className={library === id ? "tab active" : "tab"}
            onClick={() => setLibrary(id)}
          >
            {label}
          </button>
        ))}
      </div>

      {library === "known" ? (
        <KnownWords />
      ) : library === "phrases" ? (
        <MemoryLibrary
          kind="phrase"
          searchPlaceholder="搜索短语 / 释义 / 例句"
          emptyText="还没有短语。阅读时选中一串词语，点「加入短语组合」即可收藏。"
        />
      ) : (
        <MemoryLibrary
          kind="word"
          searchPlaceholder="搜索词条 / 释义 / 类型"
          emptyText="暂无词条"
          onChanged={() => void refreshLearningTerms()}
        />
      )}
    </div>
  );
}
