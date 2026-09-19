// Backward-compatible facade: `import { api, Article, ... } from "../api"`.
export * from "./types";
export { apiArticles as articles } from "./articles";
export { apiFeeds as feeds } from "./feeds";
export { apiConfig as config } from "./config";
export { apiMemory as memory } from "./memory";
export { apiData as data } from "./data";
export type { AddMemoryInput, MemoryKind } from "./memory";

import { apiArticles } from "./articles";
import { apiConfig } from "./config";
import { apiData } from "./data";
import { apiFeeds } from "./feeds";
import { apiMemory } from "./memory";

export const api = {
  ...apiConfig,
  ...apiFeeds,
  ...apiArticles,
  ...apiMemory,
  ...apiData,
};
