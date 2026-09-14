import { Annotation, EditorSelection, EditorState, Prec, RangeSetBuilder, Transaction, type SelectionRange } from "@codemirror/state";
import { indentLess, indentMore } from "@codemirror/commands";
import { Decoration, EditorView, keymap } from "@codemirror/view";

import { collectListMetadata, listPrefixPattern, visibleLineNumbers } from "./metadata";

const taskListPrefixPattern = /^(\s*)([-*+])\s+\[[ xX]\]\s+/;
const allowListPrefixRawSelection = Annotation.define<boolean>();

export function toggleTaskCheckboxAt(view: EditorView, rawPos: string | undefined) {
  const pos = Number(rawPos);
  if (!Number.isInteger(pos) || pos < 0 || pos >= view.state.doc.length) {
    return false;
  }

  const currentChar = view.state.doc.sliceString(pos, pos + 1);
  const newChar = nextTaskCheckboxMarker(currentChar);
  if (newChar === null) {
    return false;
  }

  view.dispatch({
    changes: { from: pos, to: pos + 1, insert: newChar },
    userEvent: "input",
  });
  view.focus();
  return true;
}

function nextTaskCheckboxMarker(currentChar: string) {
  if (currentChar === " ") {
    return "x";
  }
  if (currentChar === "x" || currentChar === "X") {
    return " ";
  }
  return null;
}

export const listPrefixAtomicRanges = EditorView.atomicRanges.of((view) => {
  const builder = new RangeSetBuilder<Decoration>();

  for (const lineNumber of visibleLineNumbers(view.state.doc, view.visibleRanges)) {
    const line = view.state.doc.line(lineNumber);
    const match = line.text.match(listPrefixPattern);
    if (!match) {
      continue;
    }

    const taskMatch = line.text.match(taskListPrefixPattern);
    const marker = match[2] || "-";
    const markerStart = line.from + match[1].length;
    const markerEnd = markerStart + marker.length;
    // A task marker is one rendered unit. Keeping its full source prefix
    // atomic prevents native word-selection from carrying `[ ]` into text.
    const prefixEnd = line.from + (taskMatch?.[0].length ?? match[0].length);

    if (line.from < markerStart) {
      builder.add(line.from, markerStart, Decoration.replace({}));
    }
    if (markerEnd < prefixEnd) {
      builder.add(markerEnd, prefixEnd, Decoration.replace({}));
    }
  }

  return builder.finish();
});

export const listPrefixNavigationKeymap = Prec.highest(keymap.of([
  {
    key: "ArrowLeft",
    run: moveWithinListPrefix("left"),
  },
  {
    key: "ArrowRight",
    run: moveWithinListPrefix("right"),
  },
]));

export const listContinuationOutdentKeymap = Prec.highest(keymap.of([
  {
    key: "Enter",
    run: continueOrExitList,
  },
  {
    key: "Shift-Tab",
    run: (view) => outdentBlankListContinuation(view) || indentSelectedLines(view, "outdent"),
  },
  {
    key: "Tab",
    run: (view) => indentSelectedLines(view, "indent"),
  },
  {
    key: "Mod-[",
    run: (view) => outdentBlankListContinuation(view) || indentLess(view),
  },
]));

export const selectAllMarkdownKeymap = Prec.highest(keymap.of([
  {
    key: "Mod-a",
    run: selectAllMarkdown,
  },
]));

export function selectAllMarkdown(view: Pick<EditorView, "state" | "dispatch">): boolean {
  view.dispatch({
    selection: EditorSelection.range(0, view.state.doc.length),
    annotations: allowListPrefixRawSelection.of(true),
    scrollIntoView: true,
    userEvent: "select",
  });
  return true;
}

export const wikilinkExitKeymap = Prec.highest(keymap.of([
  {
    key: "Tab",
    run: (view) => expandSlashDateCommand(view) || exitWikilink(view),
  },
  {
    key: "Enter",
    run: (view) => expandSlashDateCommand(view) || exitWikilink(view),
  },
]));

function expandSlashDateCommand(view: EditorView): boolean {
  const range = view.state.selection.main;
  if (!range.empty) {
    return false;
  }
  const edit = slashDateCommandEdit(view.state, range.head);
  if (!edit) {
    return false;
  }
  view.dispatch({
    changes: { from: edit.from, to: edit.to, insert: edit.insert },
    selection: EditorSelection.cursor(edit.selection),
    scrollIntoView: true,
    userEvent: "input.complete",
  });
  return true;
}

export function slashDateCommandEdit(
  state: EditorState,
  pos: number,
  now = new Date(),
): { from: number; to: number; insert: string; selection: number } | null {
  const line = state.doc.lineAt(pos);
  const beforeCursor = state.doc.sliceString(line.from, pos);
  const match = beforeCursor.match(/(^|\s)\/(today|tomorrow)$/i);
  if (!match) {
    return null;
  }

  const day = new Date(now);
  if (match[2].toLowerCase() === "tomorrow") {
    day.setDate(day.getDate() + 1);
  }
  const target = localIsoDate(day);
  const insert = `[[${target}]]`;
  const from = pos - match[0].length + match[1].length;
  return { from, to: pos, insert, selection: from + insert.length };
}

function localIsoDate(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export const listPrefixSelectionFilter = EditorState.transactionFilter.of((tr) => {
  if (!tr.selection || !tr.changes.empty) {
    return tr;
  }
  if (tr.annotation(allowListPrefixRawSelection)) {
    return tr;
  }

  const range = tr.selection.main;
  if (!range.empty) {
    const adjusted = clampSelectionToRenderedListText(tr.state, range.anchor, range.head);
    if (!adjusted) {
      return tr;
    }
    return {
      selection: adjusted,
      scrollIntoView: true,
      annotations: Transaction.userEvent.of("select"),
    };
  }

  const positions = listPrefixPositionsAt(tr.state, range.head);
  if (!positions) {
    return tr;
  }

  const markerStart = range.head === positions.markerStart;
  const markerInterior = range.head > positions.markerStart && range.head < positions.markerEnd;
  const hiddenLineStart = range.head === positions.lineFrom && positions.lineFrom < positions.markerStart;
  const hiddenBeforeMarker = range.head > positions.lineFrom && range.head < positions.markerStart;
  const hiddenAfterMarker = range.head > positions.markerEnd && range.head < positions.prefixEnd;
  if (!markerStart && !markerInterior && !hiddenLineStart && !hiddenBeforeMarker && !hiddenAfterMarker) {
    return tr;
  }

  return {
    selection: EditorSelection.cursor(positions.prefixEnd),
    scrollIntoView: true,
    annotations: Transaction.userEvent.of("select"),
  };
});

export function clampSelectionToRenderedListText(state: EditorState, anchor: number, head: number): SelectionRange | null {
  if (anchor === head) {
    return null;
  }
  const positions = listPrefixPositionsAt(state, head);
  if (!positions || head >= positions.prefixEnd) {
    return null;
  }

  const anchorLine = state.doc.lineAt(anchor);
  if (anchorLine.number !== positions.lineNumber || anchor < positions.prefixEnd) {
    return null;
  }

  return EditorSelection.range(anchor, positions.prefixEnd);
}

function moveWithinListPrefix(direction: "left" | "right") {
  return (view: EditorView): boolean => moveListPrefixSelection(view, direction);
}

function moveListPrefixSelection(view: EditorView, direction: "left" | "right"): boolean {
  const range = view.state.selection.main;
  if (!range.empty) {
    return false;
  }

  const positions = listPrefixPositionsAt(view.state, range.head);
  if (!positions) {
    return false;
  }

  const nextPos = direction === "left" ? listPrefixArrowLeftTarget(view.state, positions, range.head) : listPrefixArrowRightTarget(positions, range.head);
  if (nextPos === null) {
    return false;
  }

  view.dispatch({
    selection: EditorSelection.cursor(nextPos),
    scrollIntoView: true,
    annotations: [Transaction.userEvent.of("select"), allowListPrefixRawSelection.of(true)],
  });
  return true;
}

function outdentBlankListContinuation(view: EditorView): boolean {
  const range = view.state.selection.main;
  if (!range.empty) {
    return false;
  }

  const line = view.state.doc.lineAt(range.head);
  if (!isBlankListContinuationLine(view.state, line.number)) {
    return false;
  }

  view.dispatch({
    changes: { from: line.from, to: line.to, insert: "" },
    selection: EditorSelection.cursor(line.from),
    scrollIntoView: true,
    userEvent: "delete.dedent",
  });
  return true;
}

function indentSelectedLines(view: EditorView, direction: "indent" | "outdent"): boolean {
  if (view.state.selection.ranges.every((range) => range.empty)) {
    return false;
  }

  const expandedSelection = expandSelectionToLineBoundary(view);
  if (expandedSelection) {
    view.dispatch({ selection: expandedSelection });
  }

  return direction === "indent" ? indentMore(view) : indentLess(view);
}

function expandSelectionToLineBoundary(view: EditorView): EditorSelection | null {
  // CodeMirror's line commands treat a range ending exactly at a line start as
  // excluding that line. Rendered list gutters make that boundary easy to hit,
  // so include the terminal line before applying the grouped indent operation.
  const { doc, selection } = view.state;
  let changed = false;
  const ranges = selection.ranges.map((range) => {
    if (range.empty) {
      return range;
    }

    const endLine = doc.lineAt(range.to);
    if (range.to !== endLine.from) {
      return range;
    }

    changed = true;
    if (range.head >= range.anchor) {
      return EditorSelection.range(range.anchor, endLine.to);
    }
    return EditorSelection.range(endLine.to, range.head);
  });

  return changed ? EditorSelection.create(ranges, selection.mainIndex) : null;
}

function exitWikilink(view: EditorView): boolean {
  const range = view.state.selection.main;
  if (!range.empty) {
    return false;
  }

  const edit = wikilinkExitEdit(view.state, range.head);
  if (!edit) {
    return false;
  }

  view.dispatch({
    changes: edit.insert ? { from: edit.insertAt, to: edit.insertAt, insert: edit.insert } : undefined,
    selection: EditorSelection.cursor(edit.selection),
    scrollIntoView: true,
    userEvent: "select",
  });
  return true;
}

export function wikilinkExitEdit(state: EditorState, pos: number): { insertAt: number; insert: string; selection: number } | null {
  const line = state.doc.lineAt(pos);
  for (const match of line.text.matchAll(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g)) {
    const start = line.from + (match.index ?? 0);
    const end = start + match[0].length;
    if (pos < start + 2 || pos > end - 2) {
      continue;
    }

    return { insertAt: end, insert: "", selection: end };
  }
  return null;
}

function continueOrExitList(view: EditorView): boolean {
  const range = view.state.selection.main;
  if (!range.empty) {
    return false;
  }

  const edit = listEnterEdit(view.state, range.head);
  if (!edit) {
    return outdentBlankListContinuation(view);
  }

  view.dispatch({
    changes: { from: edit.from, to: edit.to, insert: edit.insert },
    selection: EditorSelection.cursor(edit.selection),
    scrollIntoView: true,
    userEvent: edit.exitList ? "delete.dedent" : "input",
  });
  return true;
}

export function listEnterEdit(state: EditorState, pos: number): { from: number; to: number; insert: string; selection: number; exitList: boolean } | null {
  const line = state.doc.lineAt(pos);
  const match = line.text.match(listPrefixPattern);
  if (!match) {
    return null;
  }

  const taskMatch = line.text.match(taskListPrefixPattern);
  if (taskMatch) {
    const prefix = taskMatch[0];
    const content = line.text.slice(prefix.length);
    if (content.trim().length === 0) {
      return {
        from: line.from,
        to: line.to,
        insert: "",
        selection: line.from,
        exitList: true,
      };
    }
    const nextPrefix = `${taskMatch[1]}${taskMatch[2]} [ ] `;
    return {
      from: pos,
      to: pos,
      insert: `\n${nextPrefix}`,
      selection: pos + nextPrefix.length + 1,
      exitList: false,
    };
  }

  const prefix = match[0];
  const marker = match[2] || "-";
  const content = line.text.slice(prefix.length);
  if (content.trim().length === 0) {
    return {
      from: line.from,
      to: line.to,
      insert: "",
      selection: line.from,
      exitList: true,
    };
  }

  const nextPrefix = `${match[1]}${nextListMarker(marker)} `;
  return {
    from: pos,
    to: pos,
    insert: `\n${nextPrefix}`,
    selection: pos + nextPrefix.length + 1,
    exitList: false,
  };
}

function nextListMarker(marker: string): string {
  const ordered = marker.match(/^(\d+)([.)])$/);
  if (!ordered) {
    return marker;
  }
  return `${Number(ordered[1]) + 1}${ordered[2]}`;
}

function isBlankListContinuationLine(state: EditorState, lineNumber: number): boolean {
  const line = state.doc.line(lineNumber);
  if (line.text.length === 0 || line.text.trim().length > 0) {
    return false;
  }

  const contexts = collectListMetadata(state.doc);
  for (let previousLine = lineNumber - 1; previousLine >= 1; previousLine -= 1) {
    const text = state.doc.line(previousLine).text;
    if (text.trim().length === 0) {
      continue;
    }
    return contexts.has(previousLine);
  }
  return false;
}

interface ListPrefixPositions {
  lineFrom: number;
  lineNumber: number;
  markerStart: number;
  markerEnd: number;
  prefixEnd: number;
}

function listPrefixPositionsAt(state: EditorState, pos: number): ListPrefixPositions | null {
  const line = state.doc.lineAt(pos);
  const match = line.text.match(listPrefixPattern);
  if (!match) {
    return null;
  }

  const taskMatch = line.text.match(taskListPrefixPattern);
  const marker = match[2] || "-";
  const markerStart = line.from + match[1].length;
  const markerEnd = markerStart + marker.length;
  const prefixEnd = line.from + (taskMatch?.[0].length ?? match[0].length);
  if (pos < line.from || pos > prefixEnd) {
    return null;
  }

  return {
    lineFrom: line.from,
    lineNumber: line.number,
    markerStart,
    markerEnd,
    prefixEnd,
  };
}

function listPrefixArrowLeftTarget(state: EditorState, positions: ListPrefixPositions, pos: number): number | null {
  if (pos === positions.prefixEnd) {
    return positions.markerEnd;
  }
  if (pos > positions.markerEnd && pos < positions.prefixEnd) {
    return positions.markerEnd;
  }
  if (pos === positions.markerEnd) {
    return positions.markerStart;
  }
  if (pos > positions.markerStart && pos < positions.markerEnd) {
    return positions.markerStart;
  }
  if (pos === positions.markerStart || (pos >= positions.lineFrom && pos < positions.markerStart)) {
    if (positions.lineNumber <= 1) {
      return positions.lineFrom;
    }
    return state.doc.line(positions.lineNumber - 1).to;
  }
  return null;
}

function listPrefixArrowRightTarget(positions: ListPrefixPositions, pos: number): number | null {
  if (pos < positions.markerStart) {
    return positions.markerStart;
  }
  if (pos === positions.markerStart) {
    return positions.markerEnd;
  }
  if (pos > positions.markerStart && pos < positions.markerEnd) {
    return positions.markerEnd;
  }
  if (pos === positions.markerEnd || (pos > positions.markerEnd && pos < positions.prefixEnd)) {
    return positions.prefixEnd;
  }
  return null;
}
