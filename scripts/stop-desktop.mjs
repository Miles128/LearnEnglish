#!/usr/bin/env node
/**
 * Stop any running `pnpm dev:desktop` (tauri dev) session before tests.
 * tauri dev watches src-tauri and relaunches the macOS window on rebuild,
 * which steals focus during cargo/vitest runs. Plain `pnpm dev` (browser
 * Vite) is left alone — it has no window.
 *
 * Never matches shells that merely *mention* the pattern in their cmdline,
 * and never kills this process or its parents.
 */
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

const SELF = new Set([String(process.pid), String(process.ppid)]);

/** Processes whose full cmdline contains every token and looks like a real session. */
function listCandidates(pattern) {
  let out = "";
  try {
    out = execSync(`pgrep -f ${JSON.stringify(pattern)}`, {
      stdio: ["ignore", "pipe", "ignore"],
    }).toString();
  } catch {
    return [];
  }
  return out
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

function cmdlineOf(pid) {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ").trim();
  } catch {
    // macOS: no /proc; use ps
    try {
      return execSync(`ps -p ${pid} -o args=`, {
        stdio: ["ignore", "pipe", "ignore"],
      }).toString().trim();
    } catch {
      return "";
    }
  }
}

function isRealDesktopSession(pid, pattern) {
  if (SELF.has(pid)) return false;
  const cmd = cmdlineOf(pid);
  if (!cmd) return false;
  // Shells / editors / CI wrappers that only *quote* the pattern are not sessions.
  if (/^(\/bin\/|\/usr\/bin\/|\/usr\/local\/bin\/)?(zsh|bash|sh|dash)\b/.test(cmd)) {
    // Exception: an interactive shell running `pnpm dev:desktop` / `tauri dev` for real.
    if (/\b(tauri(\.js)?\s+dev|pnpm\s+dev:desktop)\b/.test(cmd) && !/stop-desktop|pretest|pnpm test/.test(cmd)) {
      return /tauri\.js dev|\bnode\b.*tauri|target\/debug\/shiyan/.test(cmd);
    }
    return false;
  }
  // Node hosting the tauri CLI dev loop
  if (/tauri\.js dev|@tauri-apps\/cli.*dev/.test(cmd) && /\bnode\b/.test(cmd)) return true;
  // The compiled app itself
  if (/target\/debug\/shiyan(\s|$)/.test(cmd)) return true;
  // Fallback: exact-ish pattern without shell wrappers
  return cmd.includes(pattern) && !/stop-desktop|pgrep|ps -p/.test(cmd);
}

const patterns = ["tauri.js dev", "target/debug/shiyan", "target/debug/shiyan.exe"];

const pids = new Set();
for (const p of patterns) {
  for (const pid of listCandidates(p)) {
    if (isRealDesktopSession(pid, p)) pids.add(pid);
  }
}

if (pids.size === 0) {
  console.log("[pretest] no desktop session");
  process.exit(0);
}

console.log(`[pretest] stopping desktop session: ${[...pids].join(", ")}`);
try {
  execSync(`kill -TERM ${[...pids].join(" ")}`, { stdio: "ignore" });
} catch {
  // fall through to SIGKILL
}

setTimeout(() => {
  const rest = new Set();
  for (const p of patterns) {
    for (const pid of listCandidates(p)) {
      if (isRealDesktopSession(pid, p)) rest.add(pid);
    }
  }
  if (rest.size > 0) {
    try {
      execSync(`kill -KILL ${[...rest].join(" ")}`, { stdio: "ignore" });
    } catch {
      // already gone
    }
  }
  console.log("[pretest] desktop session stopped");
}, 400);
