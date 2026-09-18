import { describe, expect, it } from "vitest";
import { isThemePref, resolveTheme, THEME_LABELS } from "./theme";

describe("isThemePref", () => {
  it("accepts the three preferences only", () => {
    expect(isThemePref("system")).toBe(true);
    expect(isThemePref("light")).toBe(true);
    expect(isThemePref("dark")).toBe(true);
    expect(isThemePref("sepia")).toBe(false);
    expect(isThemePref("")).toBe(false);
  });
});

describe("resolveTheme", () => {
  it("follows the system for the system preference", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
  });

  it("forces the explicit preference", () => {
    expect(resolveTheme("dark", false)).toBe("dark");
    expect(resolveTheme("light", true)).toBe("light");
  });

  it("labels every preference", () => {
    expect(THEME_LABELS.dark).toBe("深色");
    expect(THEME_LABELS.system).toBe("跟随系统");
  });
});
