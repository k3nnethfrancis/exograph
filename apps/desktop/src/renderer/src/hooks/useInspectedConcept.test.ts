import { describe, expect, it } from "vitest";

import {
  EMPTY_INSPECTED_CONCEPT_STATE,
  reduceInspectedConcept,
} from "./useInspectedConcept";

describe("inspected Concept ownership", () => {
  it("separates ordinary inspection from a camera focus request", () => {
    const inspected = reduceInspectedConcept(EMPTY_INSPECTED_CONCEPT_STATE, {
      type: "inspect",
      concept: { filePath: "/notes/one.md" },
    });

    expect(inspected.concept).toEqual({ filePath: "/notes/one.md" });
    expect(inspected.focusRequest).toBeNull();
  });

  it("emits a new focus sequence for repeated requests on the same Concept", () => {
    const first = reduceInspectedConcept(EMPTY_INSPECTED_CONCEPT_STATE, {
      type: "focus",
      concept: { filePath: "/notes/one.md" },
    });
    const second = reduceInspectedConcept(first, {
      type: "focus",
      concept: { filePath: "/notes/one.md" },
    });

    expect(first.focusRequest?.sequence).toBe(1);
    expect(second.focusRequest?.sequence).toBe(2);
  });
});
