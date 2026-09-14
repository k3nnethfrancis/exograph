import { describe, expect, it } from "vitest";

import {
  DEFAULT_UTILITY_SURFACE_STATE,
  isUtilityDestinationActive,
  reduceUtilitySurface,
} from "./utilitySurfaceModel";

describe("utility surface model", () => {
  it("opens directly on the selected destination", () => {
    const state = reduceUtilitySurface(DEFAULT_UTILITY_SURFACE_STATE, {
      type: "select",
      destination: "preview",
    });

    expect(state).toEqual({ open: true, destination: "preview" });
    expect(isUtilityDestinationActive(state, "preview")).toBe(true);
    expect(isUtilityDestinationActive(state, "terminal")).toBe(false);
  });

  it("switches destinations without representing two active surfaces", () => {
    const preview = reduceUtilitySurface(DEFAULT_UTILITY_SURFACE_STATE, {
      type: "select",
      destination: "preview",
    });
    const graph = reduceUtilitySurface(preview, {
      type: "select",
      destination: "graph",
    });

    expect(graph).toEqual({ open: true, destination: "graph" });
    expect(["terminal", "preview", "graph", "context"].filter((destination) =>
      isUtilityDestinationActive(graph, destination as "terminal" | "preview" | "graph" | "context"),
    )).toEqual(["graph"]);
  });

  it("retains the selected destination while the whole surface is hidden", () => {
    const selected = reduceUtilitySurface(DEFAULT_UTILITY_SURFACE_STATE, {
      type: "select",
      destination: "context",
    });
    const hidden = reduceUtilitySurface(selected, { type: "toggle" });
    const reopened = reduceUtilitySurface(hidden, { type: "toggle" });

    expect(hidden).toEqual({ open: false, destination: "context" });
    expect(reopened).toEqual(selected);
  });
});
