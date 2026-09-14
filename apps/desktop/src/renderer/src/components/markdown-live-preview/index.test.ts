import { EditorState, StateField } from "@codemirror/state";
import { describe, expect, it } from "vitest";

import { advanceMarkdownPreviewProjection, markdownLivePreview } from "./index";
import { markdownPreviewMetadata } from "./metadata";

function foldedListParentAnchorsField() {
  const field = markdownLivePreview({
    onOpenTarget: () => {},
    onOpenTag: () => {},
    onResolveImage: async () => ({ url: "" }),
  }).find((extension): extension is StateField<Set<number>> => extension instanceof StateField);
  if (!field) throw new Error("markdown live preview must include folded-list state");
  return field;
}

function stateWithFoldedParent(doc: string, lineNumber: number) {
  const field = foldedListParentAnchorsField();
  const state = EditorState.create({
    doc,
    extensions: field.init((initialState) => new Set([initialState.doc.line(lineNumber).from])),
  });
  return { field, state };
}

describe("markdown live preview folded-list identity", () => {
  it("keeps heading and tag fold anchors through edits to their children", () => {
    for (const doc of ["# Parent\nchild", "#project\n  child"]) {
      const { field, state } = stateWithFoldedParent(doc, 1);
      const child = state.doc.line(2);
      const edited = state.update({ changes: { from: child.to, insert: " updated" } }).state;
      expect(edited.field(field)).toEqual(new Set([0]));
    }
  });

  it("keeps a nested parent folded when sibling lines are inserted and deleted before it", () => {
    const { field, state } = stateWithFoldedParent(["- outer", "  - nested parent", "    - child", "  - sibling", "- after"].join("\n"), 2);
    const parent = state.doc.line(2);
    const inserted = state.update({ changes: { from: parent.from, insert: "  - before\n" } }).state;
    expect(inserted.field(field)).toEqual(new Set([inserted.doc.line(3).from]));

    const before = inserted.doc.line(2);
    const deleted = inserted.update({ changes: { from: before.from, to: before.to + 1 } }).state;
    expect(deleted.field(field)).toEqual(new Set([deleted.doc.line(2).from]));
  });

  it("clears a fold when its parent list line is replaced", () => {
    const { field, state } = stateWithFoldedParent(["- parent", "  - child", "- successor"].join("\n"), 1);
    const parent = state.doc.line(1);
    const replaced = state.update({ changes: { from: parent.from, to: parent.to, insert: "- replacement" } }).state;
    expect(replaced.field(field)).toEqual(new Set());
  });

  it("clears a fold when its parent list line is deleted", () => {
    const { field, state } = stateWithFoldedParent(["- parent", "  - child", "- successor"].join("\n"), 1);
    const parent = state.doc.line(1);
    const deleted = state.update({ changes: { from: parent.from, to: parent.to + 1 } }).state;
    expect(deleted.field(field)).toEqual(new Set());
  });

  it("retains a folded parent through a nested task checkbox edit", () => {
    const { field, state } = stateWithFoldedParent(["- parent", "  - [ ] child", "- successor"].join("\n"), 1);
    const task = state.doc.line(2);
    const checkbox = task.from + task.text.indexOf(" ", task.text.indexOf("[") + 1);
    const edited = state.update({ changes: { from: checkbox, to: checkbox + 1, insert: "x" } }).state;
    expect(edited.field(field)).toEqual(new Set([0]));
  });

  it("retains a fold through parent indent and outdent", () => {
    const { field, state } = stateWithFoldedParent(["- parent", "  - child", "- successor"].join("\n"), 1);
    const child = state.doc.line(2);
    const indented = state.update({ changes: [{ from: 0, insert: "  " }, { from: child.from, insert: "  " }] }).state;
    expect(indented.field(field)).toEqual(new Set([0]));

    const indentedChild = indented.doc.line(2);
    const outdented = indented.update({ changes: [{ from: 0, to: 2 }, { from: indentedChild.from, to: indentedChild.from + 2 }] }).state;
    expect(outdented.field(field)).toEqual(new Set([0]));
  });

  it("retains the parent fold across a multi-change transaction", () => {
    const { field, state } = stateWithFoldedParent(["- parent", "  - [ ] child", "- successor"].join("\n"), 1);
    const task = state.doc.line(2);
    const checkbox = task.from + task.text.indexOf(" ", task.text.indexOf("[") + 1);
    const changed = state.update({ changes: [
      { from: 0, insert: "- before\n" },
      { from: checkbox, to: checkbox + 1, insert: "x" },
    ] }).state;
    expect(changed.field(field)).toEqual(new Set([changed.doc.line(2).from]));
  });
});

describe("markdown live preview projection ordering", () => {
  it("repairs structural metadata before compiling the projection", () => {
    const state = EditorState.create({ doc: "- parent\nplain item" });
    const plainItem = state.doc.line(2);
    const transaction = state.update({
      changes: {
        from: plainItem.from,
        to: plainItem.to,
        insert: "  - [ ] repaired task",
      },
    });
    const initialMetadata = markdownPreviewMetadata(state.doc);

    const next = advanceMarkdownPreviewProjection({
      previousDoc: state.doc,
      nextDoc: transaction.state.doc,
      changes: transaction.changes,
      docChanged: true,
      rebuild: true,
    }, initialMetadata, (metadata) => metadata.listContexts.get(2));

    expect(next.projection).toMatchObject({
      depth: 1,
      isListStart: true,
      marker: "-",
    });
    expect(next.metadata.listContexts.get(2)).toBe(next.projection);
  });
});
