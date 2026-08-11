# Vocab Placement Test Implementation Plan

> **For agentic workers:** Implement task-by-task. Steps use checkbox syntax.

**Goal:** ~50-question adaptive ABCD vocab placement that writes `freq_band`/`cefr_level`, plus freq-based「约认识 %」.

**Architecture:** Pure TS adaptive engine (`src/placement/`) + Placement page; extend `AppConfig`; change `knownPercent` to use `freq_band` + learning list.

**Tech Stack:** React, existing Tauri config, `word-levels.json`.

## Global Constraints

- Fixed 50 items; continuous L (not band windows); auto-save config on finish
- No new npm deps; `pnpm test` = `tsc --noEmit`
- Follow existing App.css patterns

## File map

| File | Role |
|------|------|
| `src/placement/engine.ts` | L update, map to band, pick next word, build choices |
| `src/placement/pool.ts` | Build test pool from lexicon |
| `src/pages/Placement.tsx` | Intro / quiz / result UI |
| `src/knownPercent.ts` | Freq-band based estimate |
| `src/wordLevels.ts` | Export iterable entries for pool |
| `src/api.ts` + `config.rs` | Placement fields on AppConfig |
| `src/main.tsx` / `App.tsx` | Route + first-run redirect |
| `src/pages/Home.tsx` / `Settings.tsx` | Wire freq_band + retest CTA |

## Tasks

### Task 1: Config fields
- [x] Add `vocab_placement_done`, `vocab_placement_L`, `vocab_placement_at` to Rust + TS AppConfig (serde defaults)
- [x] Update `config.local.json.example`

### Task 2: Engine + pool
- [x] Export lexicon entries from `wordLevels`
- [x] Implement `updateL`, `mapLToBand`, `pickNext`, `buildChoices` per spec
- [x] Sanity via `pnpm test`

### Task 3: knownPercent
- [x] Signature: `(content, learningTerms, freqBand)`
- [x] Update Home callers (load freq_band from config)

### Task 4: Placement UI + routes
- [x] Placement page (intro / 50 Q / result → saveConfig)
- [x] Route `/placement`; gate when `!done` unless session skip
- [x] Settings: show last L + link to retest

### Task 5: Verify
- [x] `pnpm test && pnpm build && cd src-tauri && cargo test`
