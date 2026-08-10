import { useEffect, useState } from "react";
import { api, AppConfig, FeedSource } from "../api";

export default function Settings() {
  const [cfg, setCfg] = useState<AppConfig>({
    base_url: "https://api.openai.com/v1",
    api_key: "",
    model: "gpt-4o-mini",
    disabled_feeds: [],
  });
  const [feeds, setFeeds] = useState<FeedSource[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        setCfg(await api.getConfig());
        setFeeds(await api.listFeeds());
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

  async function toggleFeed(id: string, enabled: boolean) {
    await api.setFeedEnabled(id, enabled);
    setFeeds((fs) => fs.map((f) => (f.id === id ? { ...f, enabled } : f)));
  }

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>设置</h1>
          <p className="muted">LLM 与 RSS 源（密钥写入本地 config.local.json）</p>
        </div>
        <button className="btn primary" onClick={() => void save()}>
          保存
        </button>
      </header>

      {msg && <p className="banner ok">{msg}</p>}
      {error && <p className="banner err">{error}</p>}

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
        <h2>RSS 源（免费全文）</h2>
        <ul className="feed-list">
          {feeds.map((f) => (
            <li key={f.id}>
              <label className="feed-row">
                <input
                  type="checkbox"
                  checked={f.enabled}
                  onChange={(e) => void toggleFeed(f.id, e.target.checked)}
                />
                <span>
                  <strong>{f.name}</strong>
                  <span className="muted"> · {f.category}</span>
                </span>
              </label>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
