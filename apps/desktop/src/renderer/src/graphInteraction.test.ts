import { describe, expect, it } from "vitest";

import {
  graphConceptDisplayKind,
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
