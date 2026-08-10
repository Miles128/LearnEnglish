import { NavLink, Outlet } from "react-router-dom";
import "./App.css";

export default function App() {
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">LearnEnglish</div>
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
    </div>
  );
}
