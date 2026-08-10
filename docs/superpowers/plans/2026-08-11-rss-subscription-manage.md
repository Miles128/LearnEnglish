# RSS Subscription Manage Implementation Plan

> **For agentic workers:** Implement task-by-task. Steps use checkbox syntax.

**Goal:** Home drawer to manage RSS feeds: toggle, LLM discover by category, custom categories, paste URL.

**Architecture:** Extend SQLite feed tables + Tauri commands; React drawer on Home; Settings drops duplicate feed list.

**Tech Stack:** Tauri 2, React/TS, rusqlite, feed_rs, existing OpenAI-compatible LLM.

## Global Constraints

- Local-first; no cloud search API
- Unsubscribe = disable only
- Never delete `origin=user` on seed
- Follow PRD non-goals

---

### Task 1: DB schema + seed fix + tests

**Files:** `src-tauri/src/db.rs`, `src-tauri/src/db_tests.rs`

- [ ] Add `origin`, `description` to `FeedSource`; `feed_categories` table
- [ ] Fix seed to preserve user feeds
- [ ] CRUD helpers + category helpers
- [ ] Tests: user feed survives reseed; categories seed

### Task 2: Discover / validate / subscribe commands

**Files:** `src-tauri/src/vocab.rs`, `src-tauri/src/feeds.rs`, `src-tauri/src/lib.rs`

- [ ] LLM discover JSON candidates
- [ ] validate_feed via feed_rs
- [ ] Wire Tauri commands (blocking pool for network)

### Task 3: Frontend API + drawer + Settings

**Files:** `src/api.ts`, `src/pages/Home.tsx`, `src/pages/ManageFeedsDrawer.tsx`, `src/pages/Settings.tsx`, `src/App.css`

- [ ] API wrappers
- [ ] Drawer UI
- [ ] Settings redirect copy

### Task 4: Verify

- [ ] `pnpm test && pnpm build && cd src-tauri && cargo test`
