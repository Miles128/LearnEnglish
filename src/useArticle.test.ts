import { describe, expect, it } from "vitest";
import { articleViewState, shouldApplyLoad, translationsMap } from "./useArticle";

describe("articleViewState", () => {
  it("is loading while the first fetch is in flight", () => {
    expect(
      articleViewState({ loading: true, article: null, error: null }),
    ).toBe("loading");
  });

  it("is missing when fetch finished with no article", () => {
    expect(
      articleViewState({ loading: false, article: null, error: null }),
    ).toBe("missing");
  });

  it("is error when fetch failed before an article arrived", () => {
    expect(
      articleViewState({
        loading: false,
        article: null,
        error: "数据库未就绪",
      }),
    ).toBe("error");
  });

  it("is ready once an article is present, even if a later action failed", () => {
    expect(
      articleViewState({
        loading: false,
        article: { id: "a1" },
        error: "翻译失败",
      }),
    ).toBe("ready");
  });
});

describe("shouldApplyLoad", () => {
  it("drops stale responses when a newer request started", () => {
    expect(shouldApplyLoad(1, 2)).toBe(false);
    expect(shouldApplyLoad(2, 2)).toBe(true);
  });
});

describe("translationsMap", () => {
  it("indexes paragraph rows by scope_key", () => {
    expect(
      translationsMap([
        { scope_key: "0", translated_text: "你好" },
        { scope_key: "2", translated_text: "世界" },
      ]),
    ).toEqual({ "0": "你好", "2": "世界" });
  });
});
