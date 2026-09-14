import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import type { NoteDocument, WorkspaceGraphContext } from "@exograph/core";

import {
  buildNoteGraphContext,
  getWikilinkCompletionContext,
  graphReferencesForMarkdownMode,
  markdownPreviewExcerpt,
  wikilinkSuggestionEdit,
} from "./graphAffordances";

describe("markdown editor wikilink behavior", () => {
  it("finds the active wikilink query and accepts a selected suggestion", () => {
    const state = EditorState.create({ doc: "See [[go]] next" });
    const pos = "See [[go".length;
    const context = getWikilinkCompletionContext(state, pos);

    expect(context).toEqual({ from: "See ".length, to: "See [[go]]".length, query: "go" });
    expect(wikilinkSuggestionEdit(context!, { label: "goals", target: "goals" })).toEqual({
      insert: "[[goals]]",
      selection: "See [[goals]]".length,
    });
    expect(wikilinkSuggestionEdit(context!, { label: "Self-Improving Business Systems", target: "garden/blog/self-improving-business-systems" })).toEqual({
      insert: "[[garden/blog/self-improving-business-systems|Self-Improving Business Systems]]",
      selection: context!.from + "[[garden/blog/self-improving-business-systems|Self-Improving Business Systems]]".length,
    });
  });

  it("does not open wikilink completion outside bracket boundaries", () => {
    const state = EditorState.create({ doc: "[[goals]]" });

    expect(getWikilinkCompletionContext(state, 0)).toBeNull();
    expect(getWikilinkCompletionContext(state, 1)).toBeNull();
    expect(getWikilinkCompletionContext(state, 2)).toEqual({ from: 0, to: "[[goals]]".length, query: "goals" });
    expect(getWikilinkCompletionContext(state, "[[goals]]".length)).toBeNull();
  });

  it("hides generated graph references in raw markdown mode", () => {
    const graphContext = buildNoteGraphContext(graphContextFixture());

    expect(graphReferencesForMarkdownMode(true, false, graphContext)).toEqual({
      backlinks: [{ label: "Source", target: "/vault/source.md" }],
      references: [{ label: "goals", target: "goals" }],
    });
    expect(graphReferencesForMarkdownMode(true, true, graphContext)).toBeNull();
  });

  it("keeps backlink entries navigable by their file path target", () => {
    const references = graphReferencesForMarkdownMode(true, false, buildNoteGraphContext(graphContextFixture()));

    expect(references?.backlinks[0]).toEqual({ label: "Source", target: "/vault/source.md" });
  });

  it("renders one graph reference per target rather than one per mention", () => {
    const base = graphContextFixture();
    const fixture: WorkspaceGraphContext = {
      ...base,
      outgoing: [
        ...base.outgoing,
        { source: base.note.id, target: "goals", label: "Goals alias", resolution: "unresolved" },
        { source: base.note.id, target: "later", label: "Later", resolution: "unresolved" },
        { source: base.note.id, target: "goals", label: "goals", resolution: "unresolved" },
      ],
    };

    expect(graphReferencesForMarkdownMode(true, false, buildNoteGraphContext(fixture))?.references).toEqual([
      { label: "goals", target: "goals" },
      { label: "Later", target: "later" },
    ]);
  });

  it("derives active-note graph context from the bounded renderer snapshot adapter", () => {
    const baseFixture = graphContextFixture({ frontmatter: { status: "draft", tags: ["lab"] }, tags: ["lab"] });
    const ontologyTarget = baseFixture.neighborhood[1]!;
    const fixture: WorkspaceGraphContext = { ...baseFixture, neighborhoodRelations: [{
      source: baseFixture.note.id,
      target: ontologyTarget.id,
      label: "supports",
      predicate: "supports",
      origin: "ontology",
      evidence: [{ kind: "ontology-rule", detail: "properties.supports" }],
    }] };
    const graphContext = buildNoteGraphContext(fixture);

    expect(graphContext?.properties).toEqual({ status: "draft", tags: ["lab"] });
    expect(graphContext?.outgoingLinks.map((item) => item.target).sort()).toEqual(["goals", "https://example.com"]);
    expect(graphContext?.externalLinks.map((item) => item.target)).toEqual(["https://example.com"]);
    expect(graphContext?.backlinks).toEqual([{ label: "Source", target: "/vault/source.md" }]);
    expect(graphContext?.neighborhood.focusPath).toBe("/vault/current.md");
    expect(graphContext?.neighborhood.nodes.map((item) => item.kind)).toEqual(["note", "note"]);
    expect(graphContext?.neighborhood.edges).toContainEqual(expect.objectContaining({
      source: "note:notes:source.md",
      target: "note:notes:current.md",
    }));
    expect(graphContext?.neighborhood.edges).toContainEqual(expect.objectContaining({
      source: "note:notes:current.md",
      target: "note:notes:source.md",
      kind: "ontology",
    }));
    expect(graphReferencesForMarkdownMode(true, false, graphContext)).toEqual({
      backlinks: [{ label: "Source", target: "/vault/source.md" }],
      references: [{ label: "goals", target: "goals" }],
    });
  });

  it("returns a lightweight hover preview fallback for empty or missing note bodies", () => {
    expect(markdownPreviewExcerpt("")).toBe("Empty note");
    expect(markdownPreviewExcerpt("# Goals\n\nUse [[daily|daily notes]] and [docs](docs.md).")).toBe(
      "Goals Use daily notes and docs.",
    );
  });
});

function noteDocument(overrides: Partial<NoteDocument> = {}): NoteDocument {
  return {
    filePath: "/vault/current.md",
    title: "Current",
    frontmatter: {},
    body: "",
    kind: "markdown",
    ...overrides,
  };
}

function graphContextFixture(overrides: Partial<WorkspaceGraphContext["note"]> = {}): WorkspaceGraphContext {
  const note = {
    id: "note:notes:current.md" as const,
    filePath: "/vault/current.md",
    rootId: "notes",
    relativePath: "current.md",
    title: "Current",
    tags: [],
    frontmatter: {},
    ...overrides,
  };
  const source = { ...note, id: "note:notes:source.md" as const, filePath: "/vault/source.md", relativePath: "source.md", title: "Source" };
  return {
    note,
    outgoing: [
      { source: note.id, target: "goals", label: "goals", resolution: "unresolved" },
      { source: note.id, target: "https://example.com", label: "external", resolution: "external" },
    ],
    backlinks: [{ source: source.id, target: source.filePath, label: "Source", resolution: "resolved", note: source }],
    unresolved: [{ source: note.id, target: "goals", label: "goals", resolution: "unresolved" }],
    neighborhood: [note, source],
    neighborhoodRelations: [],
  };
}
