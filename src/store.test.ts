import { describe, expect, it } from "vitest";
import { defaultAppConfig } from "./api";
import { applyConfigLoadResult, normalizeConfig } from "./store";

describe("applyConfigLoadResult", () => {
  it("marks ready and keeps defaults when loading fails", () => {
    const previous = defaultAppConfig();
    const next = applyConfigLoadResult(previous, {
      ok: false,
      message: "config missing",
    });
    expect(next.ready).toBe(true);
    expect(next.loadError).toBe("config missing");
    expect(next.cfg).toEqual(previous);
  });

  it("replaces cfg and clears loadError on success", () => {
    const previous = defaultAppConfig();
    const loaded = {
      ...defaultAppConfig(),
      cefr_level: "C1",
      freq_band: 8000,
    };
    const next = applyConfigLoadResult(previous, { ok: true, loaded });
    expect(next.ready).toBe(true);
    expect(next.loadError).toBeNull();
    expect(next.cfg).toEqual(normalizeConfig(loaded));
    expect(next.cfg.cefr_level).toBe("C1");
  });

  it("defaults show_hard_word_gloss on so reading aids appear out-of-the-box", () => {
    expect(defaultAppConfig().show_hard_word_gloss).toBe(true);
  });

  it("normalizeConfig preserves an explicit false for show_hard_word_gloss", () => {
    const next = normalizeConfig({
      ...defaultAppConfig(),
      show_hard_word_gloss: false,
    });
    expect(next.show_hard_word_gloss).toBe(false);
  });
});
