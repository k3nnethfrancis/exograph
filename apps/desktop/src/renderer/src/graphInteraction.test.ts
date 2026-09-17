import { describe, expect, it } from "vitest";

import {
  graphConceptDisplayKind,
  graphDirectionalNeighbor,
  graphEscapeDecision,
  graphNodeClickDecision,
  graphNodeDoubleClickDecision,
  graphNodeDoubleClickIndex,
} from "./graphInteraction";

describe("Graph interaction contract", () => {
  it("uses every ordinary node click for inspection and reserves Shift-click for a route", () => {
    expect(graphNodeClickDecision(4, 1, false)).toEqual({ kind: "inspect", index: 4 });
    expect(graphNodeClickDecision(4, 1, true)).toEqual({ kind: "route", index: 4 });
    expect(graphNodeClickDecision(1, 1, true)).toEqual({ kind: "inspect", index: 1 });
  });

  it("opens an unopened Note, focuses an already-open Note, and focuses non-file concepts in place", () => {
    expect(graphNodeDoubleClickDecision("/notes/one.md", false)).toBe("open");
    expect(graphNodeDoubleClickDecision("/notes/one.md", true)).toBe("focus");
    expect(graphNodeDoubleClickDecision(null, false)).toBe("focus-node");
  });

  it("never presents unresolved or external concepts as Notes", () => {
    expect(graphConceptDisplayKind({ filePath: "/notes/one.md", resolution: "resolved", conceptTypes: [] })).toBe("Note");
    expect(graphConceptDisplayKind({ resolution: "unresolved", conceptTypes: [] })).toBe("Unresolved reference");
    expect(graphConceptDisplayKind({ resolution: "ambiguous", conceptTypes: [] })).toBe("Ambiguous reference");
    expect(graphConceptDisplayKind({ resolution: "external", conceptTypes: [] })).toBe("External reference");
    expect(graphConceptDisplayKind({ resolution: "resolved", conceptTypes: ["organization"] })).toBe("organization");
  });

  it("keeps a double-click on the node selected by its pointer gesture when layout shifts", () => {
    expect(graphNodeDoubleClickIndex({
      picked: 8,
      recentIndex: 3,
      recentAgeMilliseconds: 10,
      recentDistancePixels: 0,
    })).toBe(3);
    expect(graphNodeDoubleClickIndex({
      picked: 8,
      recentIndex: 3,
      recentAgeMilliseconds: 700,
      recentDistancePixels: 0,
    })).toBe(8);
  });

  it("peels a route before restoring inspection to Graph's historical return Note", () => {
    expect(graphEscapeDecision(true, "/notes/source.md", "/notes/target.md")).toBe("clear-route");
    expect(graphEscapeDecision(false, "/notes/source.md", "/notes/target.md")).toBe("restore-editor");
    expect(graphEscapeDecision(false, "/notes/source.md", "/notes/source.md")).toBe("none");
  });
});


function navigationFixture() {
  return {
    topology: {
      topologyHash: "navigation", layoutEpochId: "navigation", seed: 1,
      nodes: { seeds: new Uint32Array(5), identityKeys: new Uint32Array(10), groups: new Uint32Array(5),
        degrees: new Uint32Array(5), visualClasses: new Uint8Array(5) },
      // Both inbound and outbound connections are traversable; node 3 is unrelated.
      edges: { endpoints: new Uint32Array([1, 0, 1, 2, 0, 4, 0, 0, 0, 1]), visualClasses: new Uint8Array(5) },
    },
    projection: {
      nodes: new Float32Array([100, 100, .5, 1, 200, 100, .5, 1, 300, 100, .5, 1,
        110, 100, .5, 1, 120, 150, .5, 1]),
      viewport: { width: 400, height: 200 },
      pickIndex: { cellSize: 48, columns: 0, rows: 0, offsets: new Uint32Array(), nodeIndices: new Uint32Array() },
    },
  };
}

describe("directional graph traversal", () => {
  it("follows successive incident edges rather than closer unrelated nodes", () => {
    const { topology, projection } = navigationFixture();
    expect(graphDirectionalNeighbor(topology, projection, 0, "ArrowRight")).toBe(1);
    expect(graphDirectionalNeighbor(topology, projection, 1, "ArrowRight")).toBe(2);
    expect(graphDirectionalNeighbor(topology, projection, 2, "ArrowLeft")).toBe(1);
    expect(graphDirectionalNeighbor(topology, projection, 0, "ArrowDown")).toBe(4);
  });
  it("stays put at a directional dead end or isolated node", () => {
    const { topology, projection } = navigationFixture();
    expect(graphDirectionalNeighbor(topology, projection, 0, "ArrowLeft")).toBe(-1);
    expect(graphDirectionalNeighbor(topology, projection, 3, "ArrowRight")).toBe(-1);
    expect(graphDirectionalNeighbor(topology, projection, 0, "]")).toBe(-1);
  });
  it("can reach an offscreen connection but excludes points behind the camera", () => {
    const { topology, projection } = navigationFixture();
    projection.nodes.set([500, 100, .5, 0], 4);
    expect(graphDirectionalNeighbor(topology, projection, 0, "ArrowRight")).toBe(1);
    projection.nodes.set([0, 0, 0, 0], 4);
    expect(graphDirectionalNeighbor(topology, projection, 0, "ArrowRight")).toBe(4);
  });
  it("starts at the visible node nearest the viewport center", () => {
    const { topology, projection } = navigationFixture();
    expect(graphDirectionalNeighbor(topology, projection, -1, "ArrowRight")).toBe(1);
    projection.nodes.fill(0);
    expect(graphDirectionalNeighbor(topology, projection, -1, "ArrowRight")).toBe(-1);
  });
});
