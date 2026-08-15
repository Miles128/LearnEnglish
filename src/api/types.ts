import {
  defaultReadingPrefs,
  type ReadingPrefs,
} from "../readingPrefs";

export type { Article } from "../../src-tauri/bindings/Article";
export type { FeedCategory } from "../../src-tauri/bindings/FeedCategory";
export type { FeedDiscoverCandidate } from "../../src-tauri/bindings/FeedDiscoverCandidate";
export type { FeedSource } from "../../src-tauri/bindings/FeedSource";
export type { FeedValidation } from "../../src-tauri/bindings/FeedValidation";
export type { FullTranslateResult } from "../../src-tauri/bindings/FullTranslateResult";
export type { RefreshProgress } from "../../src-tauri/bindings/RefreshProgress";
export type { RefreshResult } from "../../src-tauri/bindings/RefreshResult";
export type { TranslationRow } from "../../src-tauri/bindings/TranslationRow";
export type { VocabItem } from "../../src-tauri/bindings/VocabItem";

export type AppConfig = {
  base_url: string;
  api_key: string;
  model: string;
  disabled_feeds: string[];
  /** User CEFR level (A1–C2). */
  cefr_level: string;
  /** Known vocab band: 1000 | 3000 | 5000 | 10000 | 20000 */
  freq_band: number;
  /** Adaptive placement test completed. */
  vocab_placement_done?: boolean;
  /** Final continuous ability L from last placement. */
  vocab_placement_l?: number | null;
  /** ISO timestamp of last placement. */
  vocab_placement_at?: string | null;
  /** User dismissed the placement prompt; don't force it again. */
  vocab_placement_skipped?: boolean;
} & ReadingPrefs;

export function defaultAppConfig(): AppConfig {
  return {
    base_url: "https://api.openai.com/v1",
    api_key: "",
    model: "gpt-4o-mini",
    disabled_feeds: [],
    cefr_level: "B1",
    freq_band: 3000,
    vocab_placement_done: false,
    vocab_placement_l: null,
    vocab_placement_at: null,
    vocab_placement_skipped: false,
    ...defaultReadingPrefs(),
  };
}