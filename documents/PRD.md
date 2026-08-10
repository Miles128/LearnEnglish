# LearnEnglish — Product Requirements Document

## 1. Overview

| Field | Value |
|-------|-------|
| Product | LearnEnglish |
| Platform (MVP) | macOS desktop (Tauri) |
| Type | Local-first learning app |
| Primary user | Self — learning English via real articles |

**One-liner:** Read free English articles on Mac, translate on demand, and review saved vocabulary until mastered.

## 2. Problem

Learners need authentic English (tech/finance/world/blogs) with frictionless lookup and a lightweight vocab loop — without paywalled news or always-on translation clutter.

## 3. Goals

1. Aggregate **free full-text** English articles from curated RSS sources; support refresh.
2. Show full article text in a clean reader.
3. Provide on-demand translation (full / paragraph / selection); **hidden by default**.
4. Save rare words/phrases/usages to a vocab bank with type and collocations.
5. Vocab overview + spaced review; auto-remove (mastered) when review criteria met.

## 4. Non-goals (MVP)

- Accounts / multi-device sync
- Paywall bypass or paid sources
- TTS / speaking assessment
- Windows / iOS shipping
- Auto-translate entire articles on open

## 5. User flows

### 5.1 Refresh & read

User opens Home → taps Refresh → sees categorized list → opens article → reads English full text offline from cache.

### 5.2 Translate

- Toggle full-article translation (paragraph-wise LLM + cache).
- Hover paragraph gutter → show translate control → show/hide that paragraph’s Chinese.
- Select word/phrase → popover translate → optional Add to vocab.

### 5.3 Vocab & review

Add from selection (LLM fills definition, word_type, collocations). Overview lists learning items. Review mode: front (term + context), back (zh + type + collocations); rate 不认识 / 模糊 / 认识. Auto-master when consecutive_know ≥ 3 and interval at 14-day step; archive restorable.

## 6. Settings

`config.local.json` (gitignored): `base_url`, `api_key`, `model`, optional feed overrides. Example file committed without secrets.

## 7. Tech constraints

- Tauri 2 + React + TypeScript + Vite + SQLite
- OpenAI-compatible `chat/completions`
- Secrets only in local config file

## 8. Acceptance criteria

- [ ] App launches on Mac via `tauri dev`
- [ ] Refresh loads free full-text articles into list
- [ ] Reader shows full English; translations default off
- [ ] Paragraph controls hidden until hover
- [ ] Selection translate + add vocab with type/collocations
- [ ] Vocab overview, review, auto/manual mastered
- [ ] Settings persist to `config.local.json`

## 9. Success metrics (personal)

Daily: can refresh, finish ≥1 article with lookups, clear due reviews without UI friction.
