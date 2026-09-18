import { useEffect, useState } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import {
  shouldForcePlacement,
  shouldHideAppNav,
  shouldShowPlacementNav,
} from "./placement/engine";
import { useAppConfig } from "./store";
import { applyTheme, isThemePref } from "./theme";
import { lastArticlePath } from "./lastArticle";
import { api, type RefreshResult } from "./api";
import { type RefreshProgress } from "./api";
import ManageFeedsDrawer from "./components/ManageFeedsDrawer";
import "./App.css";

/** Frontend-only signal bus: the top bar triggers cross-page actions that
 * mounted pages (e.g. Home) listen for. */
export function emitUiSignal(name: "feeds-changed" | "refreshed", detail?: unknown) {
  window.dispatchEvent(new CustomEvent(`shiyan:${name}`, { detail }));
}

function IconImport() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 3v12" />
      <path d="m7 10 5 5 5-5" />
      <path d="M4 19h16" />
    </svg>
  );
}

function IconRefresh() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M21 12a9 9 0 1 1-2.64-6.36" />
      <path d="M21 3v6h-6" />
    </svg>
  );
}

function IconVocab() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
      <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
    </svg>
  );
}

function IconResume() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 21a9 9 0 1 0-9-9" />
      <path d="M3 3v6h6" />
    </svg>
  );
}

function IconLibrary() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M4 4h5v16H4z" />
      <path d="M10.5 4h5v16h-5z" />
      <path d="m17.5 5.5 3.2.9-4.2 15-3.2-.9z" />
    </svg>
  );
}

function IconFeeds() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M4 11a9 9 0 0 1 9 9" />
      <path d="M4 4a16 16 0 0 1 16 16" />
      <circle cx="5" cy="19" r="1" fill="currentColor" stroke="none" />
    </svg>
  );
}

function IconStats() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M4 20V10" />
      <path d="M10 20V4" />
      <path d="M16 20v-7" />
      <path d="M22 20H2" />
    </svg>
  );
}

function IconSettings() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.06l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .06-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.06-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.06H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.06l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.06 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

export default function App() {
  const [progress, setProgress] = useState<RefreshProgress | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [importingFile, setImportingFile] = useState(false);
  const [topbarError, setTopbarError] = useState<string | null>(null);
  const [manageOpen, setManageOpen] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();
  const { cfg, ready, loadError, refresh } = useAppConfig();

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let hideTimer: number | undefined;

    void listen<RefreshProgress>("refresh-progress", (event) => {
      const next = event.payload;
      setProgress(next);
      if (hideTimer) window.clearTimeout(hideTimer);
      if (next.phase === "done") {
        hideTimer = window.setTimeout(() => setProgress(null), 1200);
      }
    }).then((fn) => {
      unlisten = fn;
    });

    return () => {
      unlisten?.();
      if (hideTimer) window.clearTimeout(hideTimer);
    };
  }, []);

  useEffect(() => {
    applyTheme(isThemePref(cfg.theme) ? cfg.theme : "system");
  }, [cfg.theme]);

  useEffect(() => {
    if (!ready || loadError) return;
    if (location.pathname.startsWith("/placement")) return;
    if (shouldForcePlacement(cfg)) {
      navigate("/placement", { replace: true });
    }
  }, [cfg, ready, loadError, location.pathname, navigate]);

  async function onRefresh() {
    if (refreshing) return;
    setRefreshing(true);
    try {
      const result: RefreshResult = await api.refreshFeeds();
      emitUiSignal("refreshed", result);
    } catch (e) {
      emitUiSignal("refreshed", { error: String(e) });
    } finally {
      setRefreshing(false);
    }
  }

  // Top-bar page buttons act as toggles: clicking the active page goes home.
  function toggleNav(to: string) {
    if (location.pathname === to) navigate("/");
  }

  async function onImportFile() {
    if (importingFile) return;
    setTopbarError(null);
    let selected: string | string[] | null;
    try {
      selected = await open({
        multiple: false,
        filters: [{ name: "文档", extensions: ["txt", "pdf", "docx"] }],
      });
    } catch (e) {
      setTopbarError(String(e));
      return;
    }
    if (selected === null) return;
    const path = Array.isArray(selected) ? selected[0] : selected;
    if (!path) return;
    setImportingFile(true);
    try {
      const article = await api.importArticleFile(path);
      navigate(`/article/${article.id}`);
    } catch (e) {
      setTopbarError(String(e));
    } finally {
      setImportingFile(false);
    }
  }

  const resumePath = lastArticlePath();

  const forcePlacement = shouldForcePlacement(cfg);
  const hideNav = shouldHideAppNav({
    ready,
    loadError,
    forcePlacement,
  });
  const showPlacementNav = shouldShowPlacementNav({
    ready,
    loadError,
    forcePlacement,
  });
  const showBar = progress != null && progress.phase !== "done";
  const showDoneBriefly = progress?.phase === "done";

  return (
    <div className={`app-shell${progress ? " refreshing" : ""}`}>
      <header className="topbar" data-tauri-drag-region>
        {!hideNav && (
          <nav className="topbar-nav">
            <span className="brand-mini" data-tauri-drag-region>
              拾言
            </span>
            <NavLink to="/" end className="topbar-link" data-tauri-drag-region>
              今日阅读
            </NavLink>
            {showPlacementNav && (
              <NavLink to="/placement" className="topbar-link">
                词汇测评
              </NavLink>
            )}
          </nav>
        )}
        {hideNav && showPlacementNav && (
          <nav className="topbar-nav">
            <span className="brand-mini" data-tauri-drag-region>
              拾言
            </span>
            <NavLink to="/placement" className="topbar-link">
              词汇测评
            </NavLink>
          </nav>
        )}
        {!hideNav && (
          <div className="topbar-actions">
            {resumePath && location.pathname !== resumePath && (
              <button
                type="button"
                className="topbar-btn"
                onClick={() => navigate(resumePath)}
                title="继续上次阅读"
                aria-label="继续上次阅读"
              >
                <IconResume />
              </button>
            )}
            <button
              type="button"
              className={`topbar-btn${refreshing ? " spin" : ""}`}
              onClick={() => void onRefresh()}
              disabled={refreshing}
              title="刷新订阅"
              aria-label="刷新订阅"
            >
              <IconRefresh />
            </button>
            <button
              type="button"
              className="topbar-btn"
              onClick={() => void onImportFile()}
              disabled={importingFile}
              title="导入文件（txt / pdf / docx）"
              aria-label="导入文件"
            >
              <IconImport />
            </button>
            <NavLink
              to="/library"
              className="topbar-btn"
              title="文章库"
              aria-label="文章库"
              onClick={() => toggleNav("/library")}
            >
              <IconLibrary />
            </NavLink>
            <NavLink
              to="/vocab"
              className="topbar-btn"
              title="生词库"
              aria-label="生词库"
              onClick={() => toggleNav("/vocab")}
            >
              <IconVocab />
            </NavLink>
            <button
              type="button"
              className="topbar-btn"
              onClick={() => setManageOpen(true)}
              title="管理订阅"
              aria-label="管理订阅"
            >
              <IconFeeds />
            </button>
            <NavLink
              to="/stats"
              className="topbar-btn"
              title="阅读统计"
              aria-label="阅读统计"
              onClick={() => toggleNav("/stats")}
            >
              <IconStats />
            </NavLink>
            <NavLink
              to="/settings"
              className="topbar-btn"
              title="设置"
              aria-label="设置"
              onClick={() => toggleNav("/settings")}
            >
              <IconSettings />
            </NavLink>
          </div>
        )}
      </header>
      <main className="main">
        {loadError && (
          <div className="banner err with-action" role="status">
            <span>配置加载失败：{loadError}</span>
            <button type="button" className="btn small" onClick={() => void refresh()}>
              重试
            </button>
          </div>
        )}
        {topbarError && <p className="banner err">{topbarError}</p>}
        <Outlet />
      </main>

      <ManageFeedsDrawer
        open={manageOpen}
        onClose={() => {
          setManageOpen(false);
          emitUiSignal("feeds-changed");
        }}
      />

      {(showBar || showDoneBriefly) && progress && (
        <div
          className={`refresh-progress ${progress.phase === "done" ? "done" : ""}`}
          role="status"
          aria-live="polite"
        >
          <div className="refresh-progress-meta">
            <span className="refresh-progress-label">{progress.label}</span>
            <span className="refresh-progress-pct">{Math.min(100, progress.percent)}%</span>
          </div>
          <div className="refresh-progress-track">
            <div
              className="refresh-progress-fill"
              style={{ width: `${Math.min(100, progress.percent)}%` }}
            />
          </div>
        </div>
      )}
    </div>
  );
}
