import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, AppConfig } from "../api";
import {
  CEFR_LEVELS,
  FREQ_BANDS,
  isCefrLevel,
  isFreqBand,
  type CefrLevel,
  type FreqBand,
} from "../wordLevels";

const defaultCfg = (): AppConfig => ({
  base_url: "https://api.openai.com/v1",
  api_key: "",
  model: "gpt-4o-mini",
  disabled_feeds: [],
  cefr_level: "B1",
  freq_band: 3000,
});

export default function Settings() {
  const [cfg, setCfg] = useState<AppConfig>(defaultCfg);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const loaded = await api.getConfig();
        setCfg({
          ...defaultCfg(),
          ...loaded,
          cefr_level: isCefrLevel(loaded.cefr_level) ? loaded.cefr_level : "B1",
          freq_band: isFreqBand(loaded.freq_band) ? loaded.freq_band : 3000,
        });
      } catch (e) {
        setError(String(e));
      }
    })();
  }, []);

  async function save() {
    setMsg(null);
    setError(null);
    try {
      await api.saveConfig(cfg);
      setMsg("已保存到 config.local.json");
    } catch (e) {
      setError(String(e));
    }
  }

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>设置</h1>
          <p className="muted">难度与 LLM（写入本地 config.local.json）</p>
        </div>
        <button className="btn primary" onClick={() => void save()}>
          保存
        </button>
      </header>

      {msg && <p className="banner ok">{msg}</p>}
      {error && <p className="banner err">{error}</p>}

      <section className="settings-section">
        <h2>阅读难度</h2>
        <p className="muted">
          正文会给「超出 CEFR」或「超出词频上限」的词/短语加下划线。两套阈值同时生效。
        </p>
        <label>
          我的 CEFR 水平
          <select
            value={cfg.cefr_level}
            onChange={(e) =>
              setCfg({ ...cfg, cefr_level: e.target.value as CefrLevel })
            }
          >
            {CEFR_LEVELS.map((lv) => (
              <option key={lv} value={lv}>
                {lv}
              </option>
            ))}
          </select>
        </label>
        <label>
          词频上限（大约认识多少词）
          <select
            value={cfg.freq_band}
            onChange={(e) =>
              setCfg({
                ...cfg,
                freq_band: Number(e.target.value) as FreqBand,
              })
            }
          >
            {FREQ_BANDS.map((n) => (
              <option key={n} value={n}>
                {n >= 1000 ? `${n / 1000}k` : n}
              </option>
            ))}
          </select>
        </label>
      </section>

      <section className="settings-section">
        <h2>大模型（OpenAI 兼容）</h2>
        <label>
          Base URL
          <input
            value={cfg.base_url}
            onChange={(e) => setCfg({ ...cfg, base_url: e.target.value })}
            placeholder="https://api.openai.com/v1"
          />
        </label>
        <label>
          API Key
          <input
            type="password"
            value={cfg.api_key}
            onChange={(e) => setCfg({ ...cfg, api_key: e.target.value })}
            placeholder="sk-..."
          />
        </label>
        <label>
          Model
          <input
            value={cfg.model}
            onChange={(e) => setCfg({ ...cfg, model: e.target.value })}
            placeholder="gpt-4o-mini"
          />
        </label>
        <p className="muted">
          可复制 <code>config.local.json.example</code> 为{" "}
          <code>config.local.json</code> 后编辑；该文件已 gitignore。
        </p>
      </section>

      <section className="settings-section">
        <h2>RSS 订阅</h2>
        <p className="muted">
          请到{" "}
          <Link to="/">今日阅读 → 管理订阅</Link>
          {" "}新增、退订与按分类搜索推荐源。
        </p>
      </section>
    </div>
  );
}
