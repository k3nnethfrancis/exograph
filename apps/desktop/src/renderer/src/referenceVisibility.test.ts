import { describe, expect, it } from "vitest";

import {
  REFERENCES_HIDE_PROGRESS,
  REFERENCES_REVEAL_PROGRESS,
  referencesVisibleAtScroll,
} from "./referenceVisibility";

describe("editor References visibility", () => {
  it("reveals only after the reveal threshold", () => {
    expect(referencesVisibleAtScroll(false, 719, 2_000, 1_000)).toBe(false);
    expect(referencesVisibleAtScroll(false, 720, 2_000, 1_000)).toBe(true);
    expect(REFERENCES_REVEAL_PROGRESS).toBe(0.72);
  });

  it("remains stable inside the hysteresis band and hides above it", () => {
    expect(referencesVisibleAtScroll(true, 650, 2_000, 1_000)).toBe(true);
    expect(referencesVisibleAtScroll(true, 599, 2_000, 1_000)).toBe(false);
    expect(REFERENCES_HIDE_PROGRESS).toBe(0.6);
  });

  it("reveals on a short document that cannot cross a scroll threshold", () => {
    expect(referencesVisibleAtScroll(false, 0, 800, 800)).toBe(true);
  });
});
