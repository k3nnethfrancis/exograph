import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";

import { clampSelectionToRenderedListText, listEnterEdit, listPrefixSelectionFilter, selectAllMarkdown, slashDateCommandEdit, wikilinkExitEdit } from "./commands";

describe("markdown editor list behavior", () => {
  it("continues unordered lists on Enter", () => {
    const state = EditorState.create({ doc: "- account strategy" });
    expect(listEnterEdit(state, state.doc.length)).toEqual({ from: state.doc.length, to: state.doc.length, insert: "\n- ", selection: state.doc.length + 3, exitList: false });
  });

  it("increments ordered lists on Enter", () => {
    const state = EditorState.create({ doc: "  9. account strategy" });
    expect(listEnterEdit(state, state.doc.length)).toEqual({ from: state.doc.length, to: state.doc.length, insert: "\n  10. ", selection: state.doc.length + 7, exitList: false });
  });

  it("continues task lists as unchecked task items on Enter", () => {
    const state = EditorState.create({ doc: "- [x] follow up" });
    expect(listEnterEdit(state, state.doc.length)).toEqual({ from: state.doc.length, to: state.doc.length, insert: "\n- [ ] ", selection: state.doc.length + 7, exitList: false });
  });

  it("exits empty list items on Enter", () => {
    const state = EditorState.create({ doc: "  - " });
    expect(listEnterEdit(state, state.doc.length)).toEqual({ from: 0, to: state.doc.length, insert: "", selection: 0, exitList: true });
  });

  it("exits empty task list items on Enter", () => {
    const state = EditorState.create({ doc: "  - [ ] " });
    expect(listEnterEdit(state, state.doc.length)).toEqual({ from: 0, to: state.doc.length, insert: "", selection: 0, exitList: true });
  });

  it.each([
    { doc: "- parent\n  - child\n    - grandchild\n  - child two\n- after", parent: 1, end: 4, prefix: "- " },
    { doc: "- outer\n  - parent\n    continuation\n    - child\n      child continuation\n  - after", parent: 2, end: 5, prefix: "  - " },
    { doc: "- outer\n  - [x] parent\n    - [ ] child", parent: 2, end: 3, prefix: "  - [ ] " },
    { doc: "9. parent\n   - child\n10. after", parent: 1, end: 2, prefix: "10. " },
    { doc: "- parent\n  - child\n\nParagraph", parent: 1, end: 2, prefix: "- " },
  ])("continues a folded item after its entire hidden subtree: $doc", ({ doc, parent, end, prefix }) => {
    const state = EditorState.create({ doc });
    const line = state.doc.line(parent);
    const insertAt = state.doc.line(end).to;
    const edit = listEnterEdit(state, line.to, new Set([line.from]));
    expect(edit).toEqual({ from: insertAt, to: insertAt, insert: `\n${prefix}`, selection: insertAt + prefix.length + 1, exitList: false });
    const next = state.update({ changes: edit! }).state;
    expect(next.doc.sliceString(0, insertAt)).toBe(state.doc.sliceString(0, insertAt));
    expect(next.doc.line(end + 1).text).toBe(prefix);
  });

  it("preserves Enter at an expanded parent and in the middle of folded text", () => {
    const state = EditorState.create({ doc: "- parent\n  - child" });
    const end = state.doc.line(1).to;
    expect(listEnterEdit(state, end)?.from).toBe(end);
    expect(listEnterEdit(state, 5, new Set([0]))).toMatchObject({ from: 5, to: 5, insert: "\n- " });
  });

  it("clamps shortcut selections to rendered list text", () => {
    const state = EditorState.create({ doc: "- some important text" });
    const anchor = state.doc.length;
    const selection = clampSelectionToRenderedListText(state, anchor, 0);
    expect(selection?.anchor).toBe(anchor);
    expect(selection?.head).toBe("- ".length);
  });

  it("keeps the whole task marker out of shortcut selections", () => {
    const state = EditorState.create({ doc: "- [ ] follow up" });
    const anchor = state.doc.length;
    const selection = clampSelectionToRenderedListText(state, anchor, "- ".length);
    expect(selection?.anchor).toBe(anchor);
    expect(selection?.head).toBe("- [ ] ".length);
  });

  it("keeps ordered markers out of shortcut selections", () => {
    const state = EditorState.create({ doc: "100. deeply nested finding" });
    const anchor = state.doc.length;
    const selection = clampSelectionToRenderedListText(state, anchor, 0);
    expect(selection?.anchor).toBe(anchor);
    expect(selection?.head).toBe("100. ".length);
  });

  it("selects the complete source when the document begins with a rendered list", () => {
    let state = EditorState.create({ doc: "- first\n- second", extensions: [listPrefixSelectionFilter] });
    const view = {
      get state() { return state; },
      dispatch(spec: Parameters<typeof state.update>[0]) { state = state.update(spec).state; },
    };

    expect(selectAllMarkdown(view)).toBe(true);
    expect(state.selection.main).toMatchObject({ from: 0, to: state.doc.length });
  });
});

describe("markdown editor slash date commands", () => {
  const now = new Date(2026, 6, 21, 23, 30);

  it("turns /today into a normal date wikilink", () => {
    const state = EditorState.create({ doc: "Plan /today" });
    expect(slashDateCommandEdit(state, state.doc.length, now)).toEqual({ from: "Plan ".length, to: state.doc.length, insert: "[[2026-07-21]]", selection: "Plan [[2026-07-21]]".length });
  });

  it("uses calendar-day arithmetic for /tomorrow", () => {
    const state = EditorState.create({ doc: "/tomorrow" });
    expect(slashDateCommandEdit(state, state.doc.length, now)).toEqual({ from: 0, to: state.doc.length, insert: "[[2026-07-22]]", selection: "[[2026-07-22]]".length });
  });

  it("does not expand partial commands or commands inside words", () => {
    expect(slashDateCommandEdit(EditorState.create({ doc: "/tod" }), 4, now)).toBeNull();
    expect(slashDateCommandEdit(EditorState.create({ doc: "not/today" }), 9, now)).toBeNull();
  });
});

describe("markdown editor wikilink behavior", () => {
  it("exits a wikilink without inserting trailing whitespace", () => {
    const state = EditorState.create({ doc: "Discuss [[customer-name]]today" });
    const pos = "Discuss [[customer-name".length;
    expect(wikilinkExitEdit(state, pos)).toEqual({ insertAt: "Discuss [[customer-name]]".length, insert: "", selection: "Discuss [[customer-name]]".length });
  });

  it("does not treat the closing edge of a wikilink as editable interior", () => {
    const state = EditorState.create({ doc: "Discuss [[customer-name]] today" });
    expect(wikilinkExitEdit(state, "Discuss [[customer-name]]".length)).toBeNull();
  });

  it("does not handle Tab or Enter outside wikilinks", () => {
    const state = EditorState.create({ doc: "Discuss customer-name" });
    expect(wikilinkExitEdit(state, state.doc.length)).toBeNull();
  });
});
