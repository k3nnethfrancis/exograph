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
