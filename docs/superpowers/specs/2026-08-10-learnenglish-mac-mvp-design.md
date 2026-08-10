# LearnEnglish Mac MVP — Design Spec

**Date:** 2026-08-10  
**Status:** Approved

## Goal

Mac desktop app for learning English via free high-quality articles: read full text, translate on demand (hidden by default), save vocab with type/collocations, and review with simplified spaced repetition until mastered.

## Architecture

Local-first **Tauri 2 + React + TypeScript + Vite**. Rust handles RSS fetch, SQLite, and OpenAI-compatible LLM HTTP. Frontend invokes Tauri commands only. No accounts, no cloud sync in MVP.

## Locked decisions

| Topic | Decision |
|-------|----------|
| Shell | Tauri 2 (macOS first) |
| Articles | Curated free full-text RSS; refresh pulls latest; reject short/paywalled summaries |
| Translation | User-configured cloud LLM (`base_url`, `api_key`, `model`) |
| Translate UX | Default hidden; full toggle; paragraph control on hover only; selection popover |
| Secrets | `config.local.json` in project root, gitignored |
| Vocab | Term + zh definition + word_type + collocations + context sentence |
| SRS | 不认识 / 模糊 / 认识; intervals 10m / 1d / 1→3→7→14d; mastered after 3 consecutive 认识 at 14d step (or manual) |

## Surfaces

1. **Home** — categorized article list + refresh  
2. **Reader** — English full text; translation layers; add vocab  
3. **Vocab** — overview (type/collocations), review, mastered archive  
4. **Settings** — LLM + feed toggles → `config.local.json`

## Data model (SQLite)

- `articles` — url unique, title, source, category, published_at, content, fetched_at  
- `translations` — article_id, scope (`full`|`paragraph`|`selection`), scope_key, texts, model  
- `vocab` — term, definition_zh, word_type, collocations_json, context, article_id, status, interval fields, consecutive_know  
- `feed_sources` — name, category, url, enabled  

## Feed policy

Only free, full-text (or reliably free) sources. Minimum body length on ingest. No paywall bypass.

## Out of scope

Multi-device sync, accounts, TTS, Windows/iOS packaging, non-free sources.

## Verification

`pnpm` frontend build + `tauri dev`/`build` on Mac; manual path refresh → read → translate → vocab → review to mastered.
