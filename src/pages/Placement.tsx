import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, defaultAppConfig, type AppConfig } from "../api";
import {
  L0,
  PLACEMENT_TOTAL,
  buildChoices,
  mapLToBand,
  pickNext,
  updateL,
  type PoolItem,
} from "../placement/engine";
import { buildPlacementPool } from "../placement/pool";
import { ensureLexiconLoaded } from "../wordLevels";

const SKIP_KEY = "shiyan_placement_skip";

export function markPlacementSkippedThisSession() {
  try {
    sessionStorage.setItem(SKIP_KEY, "1");
  } catch {
    /* ignore */
  }
}

export function isPlacementSkippedThisSession(): boolean {
  try {
    return sessionStorage.getItem(SKIP_KEY) === "1";
  } catch {
    return false;
  }
}

type Phase = "intro" | "quiz" | "result";

type Question = {
  item: PoolItem;
  options: string[];
  correctIndex: number;
};

const defaultCfg = defaultAppConfig;

export default function Placement() {
  const navigate = useNavigate();
  const [phase, setPhase] = useState<Phase>("intro");
  const [pool, setPool] = useState<PoolItem[]>([]);
  const [L, setL] = useState(L0);
  const [n, setN] = useState(0); // completed count
  const [used, setUsed] = useState<Set<string>>(() => new Set());
  const [question, setQuestion] = useState<Question | null>(null);
  const [cfg, setCfg] = useState<AppConfig>(defaultCfg);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [finalL, setFinalL] = useState<number | null>(null);

  const mapped = useMemo(
    () => mapLToBand(finalL ?? L),
    [finalL, L],
  );

  useEffect(() => {
    void (async () => {
      try {
        await ensureLexiconLoaded();
        setPool(buildPlacementPool());
        const loaded = await api.getConfig();
        setCfg({ ...defaultCfg(), ...loaded });
      } catch (e) {
        setError(String(e));
      }
    })();
  }, []);

  function startQuiz() {
    setError(null);
    if (pool.length < 20) {
      setError("词表未就绪，请稍后再试。");
      return;
    }
    const used0 = new Set<string>();
    const Lstart = L0;
    const item = pickNext(pool, used0, Lstart);
    if (!item) {
      setError("题库不足。");
      return;
    }
    used0.add(item.term);
    const choices = buildChoices(item, pool);
    setUsed(used0);
    setL(Lstart);
    setN(0);
    setQuestion({ item, options: choices.options, correctIndex: choices.correctIndex });
    setPhase("quiz");
  }

  async function finish(endL: number) {
    setFinalL(endL);
    const band = mapLToBand(endL);
    setSaving(true);
    setError(null);
    try {
      const next: AppConfig = {
        ...cfg,
        freq_band: band.freqBand,
        cefr_level: band.cefrLevel,
        vocab_placement_done: true,
        vocab_placement_l: Math.round(endL),
        vocab_placement_at: new Date().toISOString(),
      };
      await api.saveConfig(next);
      setCfg(next);
      setPhase("result");
    } catch (e) {
      setError(String(e));
      setPhase("result");
    } finally {
      setSaving(false);
    }
  }

  function answer(choiceIndex: number) {
    if (!question || saving) return;
    const correct = choiceIndex === question.correctIndex;
    const nextN = n + 1;
    const nextL = updateL(L, question.item.rank, correct, nextN);
    setL(nextL);
    setN(nextN);

    if (nextN >= PLACEMENT_TOTAL) {
      void finish(nextL);
      return;
    }

    const nextUsed = new Set(used);
    const item = pickNext(pool, nextUsed, nextL);
    if (!item) {
      void finish(nextL);
      return;
    }
    nextUsed.add(item.term);
    setUsed(nextUsed);
    const choices = buildChoices(item, pool);
    setQuestion({
      item,
      options: choices.options,
      correctIndex: choices.correctIndex,
    });
  }

  function onSkip() {
    markPlacementSkippedThisSession();
    navigate("/", { replace: true });
  }

  if (phase === "intro") {
    return (
      <div className="page placement-page">
        <header className="page-header">
          <div>
            <h1>词汇量测验</h1>
            <p className="muted">
              约 {PLACEMENT_TOTAL} 题，选英文词的正确中文意思。对了变难、错了变易，测完自动写入阅读难度。
            </p>
          </div>
        </header>
        {error && <p className="banner err">{error}</p>}
        <div className="placement-actions">
          <button type="button" className="btn primary" onClick={startQuiz}>
            开始
          </button>
          <button type="button" className="btn" onClick={onSkip}>
            稍后
          </button>
        </div>
      </div>
    );
  }

  if (phase === "result") {
    const shownL = Math.round(finalL ?? L);
    const bandLabel =
      mapped.freqBand >= 1000
        ? `${mapped.freqBand / 1000}k`
        : String(mapped.freqBand);
    return (
      <div className="page placement-page">
        <header className="page-header">
          <div>
            <h1>测验完成</h1>
            <p className="muted">
              大约认识约 <strong>{shownL}</strong> 词 · 已设为{" "}
              <strong>
                {bandLabel} / {mapped.cefrLevel}
              </strong>
            </p>
          </div>
        </header>
        {error && <p className="banner err">{error}</p>}
        {saving && <p className="muted">保存中…</p>}
        <div className="placement-actions">
          <Link className="btn primary" to="/">
            回今日阅读
          </Link>
          <Link className="btn" to="/settings">
            设置
          </Link>
        </div>
      </div>
    );
  }

  const progress = Math.min(PLACEMENT_TOTAL, n + 1);

  return (
    <div className="page placement-page">
      <header className="page-header">
        <div>
          <h1>词汇量测验</h1>
          <p className="muted">
            {progress} / {PLACEMENT_TOTAL}
          </p>
        </div>
      </header>
      {error && <p className="banner err">{error}</p>}
      {question && (
        <div className="placement-quiz">
          <p className="placement-term">{question.item.term}</p>
          <div className="placement-options">
            {question.options.map((opt, i) => (
              <button
                key={`${question.item.term}-${i}`}
                type="button"
                className="btn placement-option"
                disabled={saving}
                onClick={() => answer(i)}
              >
                <span className="placement-opt-letter">
                  {String.fromCharCode(65 + i)}
                </span>
                <span>{opt}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export function shouldForcePlacement(cfg: {
  vocab_placement_done?: boolean;
}): boolean {
  if (cfg.vocab_placement_done) return false;
  if (isPlacementSkippedThisSession()) return false;
  return true;
}
