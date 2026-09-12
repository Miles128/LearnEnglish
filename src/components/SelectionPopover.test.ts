import { describe, expect, it } from "vitest";
import { clampPopoverPosition } from "./SelectionPopover";

describe("clampPopoverPosition", () => {
  const size = { popW: 280, popH: 160, gap: 12, margin: 8, shiftX: 0.3 };

  it("keeps a centered click inside the viewport", () => {
    const pos = clampPopoverPosition({
      x: 400,
      y: 300,
      viewW: 800,
      viewH: 600,
      ...size,
    });
    const left = pos.x - size.popW * size.shiftX;
    const top = pos.y + size.gap;
    expect(left).toBeGreaterThanOrEqual(size.margin);
    expect(left + size.popW).toBeLessThanOrEqual(800 - size.margin);
    expect(top).toBeGreaterThanOrEqual(size.margin);
    expect(top + size.popH).toBeLessThanOrEqual(600 - size.margin);
  });

  it("pulls a right-edge click back onto the screen", () => {
    const pos = clampPopoverPosition({
      x: 790,
      y: 20,
      viewW: 800,
      viewH: 600,
      ...size,
    });
    const left = pos.x - size.popW * size.shiftX;
    expect(left + size.popW).toBeLessThanOrEqual(800 - size.margin);
    expect(left).toBeGreaterThanOrEqual(size.margin);
  });

  it("flips above when there is no room below", () => {
    const pos = clampPopoverPosition({
      x: 400,
      y: 580,
      viewW: 800,
      viewH: 600,
      ...size,
    });
    const top = pos.y + size.gap;
    expect(top + size.popH).toBeLessThanOrEqual(600 - size.margin);
    expect(top).toBeLessThan(580);
  });
});
