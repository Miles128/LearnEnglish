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
});
