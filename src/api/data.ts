import { invoke } from "@tauri-apps/api/core";

export const apiData = {
  /** Whole-database snapshot via VACUUM INTO; returns the path or null on cancel. */
  backupDatabase: () => invoke<string | null>("backup_database"),
  /** Stage a backup file for restore; takes effect after app restart. */
  restoreDatabase: () => invoke<string>("restore_database"),
};
