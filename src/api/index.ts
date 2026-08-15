// Backward-compatible facade: `import { api, Article, ... } from "../api"`.
export * from "./types";
export { apiArticles as articles } from "./articles";
export { apiFeeds as feeds } from "./feeds";
export { apiConfig as config } from "./config";
export { apiVocab as vocab } from "./vocab";
export type { AddVocabInput } from "./vocab";

import { apiArticles } from "./articles";
import { apiConfig } from "./config";
import { apiFeeds } from "./feeds";
import { apiVocab } from "./vocab";

export const api = {
  ...apiConfig,
  ...apiFeeds,
  ...apiArticles,
  ...apiVocab,
};