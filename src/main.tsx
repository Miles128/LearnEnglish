import React from "react";
import ReactDOM from "react-dom/client";
import { HashRouter, Navigate, Route, Routes } from "react-router-dom";
import App from "./App";
import ErrorBoundary from "./ErrorBoundary";
import Home from "./pages/Home";
import Reader from "./pages/Reader";
import Vocab from "./pages/Vocab";
import Settings from "./pages/Settings";
import Placement from "./pages/Placement";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary>
      <HashRouter>
        <Routes>
          <Route path="/" element={<App />}>
            <Route index element={<Home />} />
            <Route path="article/:id" element={<Reader />} />
            <Route path="vocab" element={<Vocab />} />
            <Route path="settings" element={<Settings />} />
            <Route path="placement" element={<Placement />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </HashRouter>
    </ErrorBoundary>
  </React.StrictMode>,
);
