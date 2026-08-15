import { useEffect, useState } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { listen } from "@tauri-apps/api/event";
import { shouldForcePlacement } from "./pages/Placement";
import { useAppConfig } from "./store";
import "./App.css";

export type RefreshProgress = {
  phase: "download" | "translate" | "done" | string;
  current: number;
  total: number;
  label: string;
  percent: number;
};

export default function App() {
  const [progress, setProgress] = useState<RefreshProgress | null>(null);
  const navigate = useNavigate();
  const location = useLocation();
  const { cfg, ready } = useAppConfig();

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
    if (!ready) return;
    if (location.pathname.startsWith("/placement")) return;
    if (shouldForcePlacement(cfg)) {
      navigate("/placement", { replace: true });
    }
  }, [cfg, ready, location.pathname, navigate]);

  const showBar = progress != null && progress.phase !== "done";
  const showDoneBriefly = progress?.phase === "done";

  return (
    <div className={`app-shell${progress ? " refreshing" : ""}`}>
      <aside className="sidebar">
        <div className="brand">
          拾言
          <span className="brand-en">Shiyan</span>
        </div>
        <nav>
          <NavLink to="/" end>
            今日阅读
          </NavLink>
          <NavLink to="/vocab">生词库</NavLink>
          <NavLink to="/settings">设置</NavLink>
        </nav>
      </aside>
      <main className="main">
        <Outlet />
      </main>

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
