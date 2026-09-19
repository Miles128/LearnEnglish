import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api, defaultAppConfig, type AppConfig } from "../api";
import { normalizeConfig, useAppConfig } from "../store";
import PageBack from "../components/PageBack";
import { isThemePref, THEME_LABELS, THEME_PREFS, type ThemePref } from "../theme";
import {
  READER_FONTS,
  READER_FONT_SIZES,
  READER_LINE_HEIGHTS,
  READER_LINE_WIDTHS,
  readingCssVars,
  resolveReadingPrefs,
  type ReaderFontId,
  type ReaderFontSize,
  type ReaderLineHeight,
  type ReaderLineWidthId,
} from "../readingPrefs";
import {
  CEFR_LEVELS,
  FREQ_BANDS,
  type CefrLevel,
  type FreqBand,
} from "../wordLevels";
import ManageFeeds from "../components/ManageFeeds";

type Tab = "reading" | "appearance" | "subscriptions" | "llm";

const TABS = [
  ["reading", "阅读"],
  ["appearance", "外观"],
  ["subscriptions", "订阅"],
  ["llm", "大模型"],
] as const;

export default function Settings() {
  const { cfg: savedCfg, ready, save: saveCfg } = useAppConfig();
  const [cfg, setCfg] = useState<AppConfig>(() =>
    normalizeConfig(defaultAppConfig()),
  );
  const [tab, setTab] = useState<Tab>("reading");
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [repairing, setRepairing] = useState(false);
  const [repairMsg, setRepairMsg] = useState<string | null>(null);

  async function repairParagraphs() {
    setRepairing(true);
    setRepairMsg(null);
    try {
      const n = await api.repairParagraphs(30);
      setRepairMsg(n > 0 ? `已重抓修复 ${n} 篇的段落。` : "没有需要修复的文章。");
    } catch (e) {
      setRepairMsg(String(e));
    } finally {
      setRepairing(false);
    }
  }
  const readingPreview = useMemo(() => resolveReadingPrefs(cfg), [cfg]);

  useEffect(() => {
    if (ready) setCfg(normalizeConfig(savedCfg));
  }, [ready, savedCfg]);

  async function save() {
    setMsg(null);
    setError(null);
    try {
      await saveCfg(normalizeConfig(cfg));
      setMsg("已保存到 config.local.json");
    } catch (e) {
      setError(String(e));
    }
  }

  return (
    <div className="page">
      <header className="page-header page-header-slim">
        <div>
          <p className="muted">难度、排版与 LLM（写入本地 config.local.json）</p>
        </div>
        <button className="btn primary" onClick={() => void save()}>
          保存
        </button>
        <PageBack />
      </header>

      <div className="tabs">
        {TABS.map(([id, label]) => (
          <button
            key={id}
            type="button"
            className={tab === id ? "tab active" : "tab"}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </div>

      {msg && <p className="banner ok">{msg}</p>}
      {error && <p className="banner err">{error}</p>}

      {tab === "appearance" && (
        <section className="settings-section">
          <h2>外观</h2>
          <label>
            主题
            <select
              value={isThemePref(cfg.theme) ? cfg.theme : "system"}
              onChange={(e) =>
                setCfg({ ...cfg, theme: e.target.value as ThemePref })
              }
            >
              {THEME_PREFS.map((p) => (
                <option key={p} value={p}>
                  {THEME_LABELS[p]}
                </option>
              ))}
            </select>
          </label>
        </section>
      )}

      {tab === "reading" && (
        <>
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
            <div className="placement-settings">
              <p className="muted">
                {cfg.vocab_placement_done
                  ? `上次测验：约 ${Math.round(cfg.vocab_placement_l ?? cfg.freq_band)} 词${
                      cfg.vocab_placement_at
                        ? ` · ${new Date(cfg.vocab_placement_at).toLocaleString()}`
                        : ""
                    }`
                  : "尚未完成词汇量测验。"}
              </p>
              <Link className="btn" to="/placement">
                {cfg.vocab_placement_done ? "重新测验" : "测一下词汇量"}
              </Link>
            </div>
          </section>

          <section className="settings-section">
            <h2>阅读排版</h2>
            <p className="muted">只作用于阅读页正文。保存后打开文章即可看到效果。</p>
            <div className="settings-type-grid">
              <label>
                字体
                <select
                  value={cfg.reader_font}
                  onChange={(e) =>
                    setCfg({ ...cfg, reader_font: e.target.value as ReaderFontId })
                  }
                >
                  {READER_FONTS.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                字号
                <select
                  value={cfg.reader_font_size}
                  onChange={(e) =>
                    setCfg({
                      ...cfg,
                      reader_font_size: Number(e.target.value) as ReaderFontSize,
                    })
                  }
                >
                  {READER_FONT_SIZES.map((s) => (
                    <option key={s.value} value={s.value}>
                      {s.label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                行距
                <select
                  value={cfg.reader_line_height}
                  onChange={(e) =>
                    setCfg({
                      ...cfg,
                      reader_line_height: Number(
                        e.target.value,
                      ) as ReaderLineHeight,
                    })
                  }
                >
                  {READER_LINE_HEIGHTS.map((h) => (
                    <option key={h.value} value={h.value}>
                      {h.label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                行宽
                <select
                  value={cfg.reader_line_width}
                  onChange={(e) =>
                    setCfg({
                      ...cfg,
                      reader_line_width: e.target.value as ReaderLineWidthId,
                    })
                  }
                >
                  {READER_LINE_WIDTHS.map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div
              className={`reader-preview${readingPreview.fullWidth ? " reader-full" : ""}`}
              style={readingCssVars(readingPreview)}
            >
              <p>
                The best time to plant a tree was twenty years ago. The second
                best time is now. Reading English news works the same way: a
                little every day, in a column that does not tire the eye.
              </p>
            </div>
          </section>

          <section className="settings-section">
            <h2>文章缓存</h2>
            <label>
              自动收录文章保留天数
              <input
                type="number"
                min={0}
                max={365}
                value={cfg.article_retention_days}
                onChange={(e) =>
                  setCfg({
                    ...cfg,
                    article_retention_days: Math.max(
                      0,
                      Math.min(365, Number(e.target.value) || 0),
                    ),
                  })
                }
              />
            </label>
            <p className="muted">
              刷新时自动删除发布时间早于该天数的收录文章（0 =
              永久保留）。你收藏的文章和手动导入的文件/链接不会被清理。默认 14 天。
            </p>
          </section>

          <section className="settings-section">
            <h2>维护</h2>
            <p className="muted">
              重新抓取「正文丢失段落换行」的文章并替换正文（每次最多 30 篇）。
            </p>
            <button
              className="btn"
              onClick={() => void repairParagraphs()}
              disabled={repairing}
            >
              {repairing ? "修复中…" : "重抓修复段落"}
            </button>
            {repairMsg && <p className="banner ok">{repairMsg}</p>}
          </section>
        </>
      )}

      {tab === "subscriptions" && (
        <section className="settings-section">
          <h2>RSS 订阅</h2>
          <ManageFeeds />
        </section>
      )}

      {tab === "llm" && (
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
      )}
    </div>
  );
}
