import { invoke } from "@tauri-apps/api/core";
import type { AppConfig } from "./types";

export const apiConfig = {
  getConfig: () => invoke<AppConfig>("get_config"),
  saveConfig: (cfg: AppConfig) => invoke<void>("save_config_cmd", { cfg }),
};