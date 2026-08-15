import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { api, defaultAppConfig, type AppConfig } from "./api";
import { normalizeReadingPrefs } from "./readingPrefs";
import { isCefrLevel, isFreqBand } from "./wordLevels";

/** Merge raw config over defaults, clamping difficulty fields. */
export function normalizeConfig(raw: AppConfig): AppConfig {
  return {
    ...defaultAppConfig(),
    ...raw,
    cefr_level: isCefrLevel(raw.cefr_level) ? raw.cefr_level : "B1",
    freq_band: isFreqBand(raw.freq_band) ? raw.freq_band : 3000,
    ...normalizeReadingPrefs(raw),
  };
}

type AppConfigState = {
  /** Current config. Starts as defaults; becomes the loaded file once `ready`. */
  cfg: AppConfig;
  /** True after the first successful `get_config` round-trip. */
  ready: boolean;
  save: (next: AppConfig) => Promise<void>;
  refresh: () => Promise<void>;
};

const AppConfigContext = createContext<AppConfigState | null>(null);

export function AppConfigProvider({ children }: { children: ReactNode }) {
  const [cfg, setCfg] = useState<AppConfig>(() => defaultAppConfig());
  const [ready, setReady] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const loaded = await api.getConfig();
      setCfg(normalizeConfig(loaded));
      setReady(true);
    } catch {
      // Tauri may not be ready yet; stay on defaults and leave `ready` false.
    }
  }, []);

  const save = useCallback(async (next: AppConfig) => {
    await api.saveConfig(next);
    setCfg(normalizeConfig(next));
    setReady(true);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const value = useMemo(
    () => ({ cfg, ready, save, refresh }),
    [cfg, ready, save, refresh],
  );
  return (
    <AppConfigContext.Provider value={value}>
      {children}
    </AppConfigContext.Provider>
  );
}

export function useAppConfig(): AppConfigState {
  const ctx = useContext(AppConfigContext);
  if (!ctx) throw new Error("useAppConfig must be used within AppConfigProvider");
  return ctx;
}

type VocabState = {
  /** Term strings of everything currently in `learning` status. */
  learningTerms: string[];
  refreshLearningTerms: () => Promise<void>;
};

const VocabContext = createContext<VocabState | null>(null);

export function VocabProvider({ children }: { children: ReactNode }) {
  const [learningTerms, setLearningTerms] = useState<string[]>([]);

  const refreshLearningTerms = useCallback(async () => {
    try {
      const list = await api.listVocab("learning");
      setLearningTerms(list.map((v) => v.term));
    } catch {
      // highlight list is optional
    }
  }, []);

  useEffect(() => {
    void refreshLearningTerms();
  }, [refreshLearningTerms]);

  const value = useMemo(
    () => ({ learningTerms, refreshLearningTerms }),
    [learningTerms, refreshLearningTerms],
  );
  return (
    <VocabContext.Provider value={value}>{children}</VocabContext.Provider>
  );
}

export function useVocab(): VocabState {
  const ctx = useContext(VocabContext);
  if (!ctx) throw new Error("useVocab must be used within VocabProvider");
  return ctx;
}