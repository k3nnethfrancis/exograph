import type { ChangeSet, Text } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";

export const listPrefixPattern = /^(\s*)((?:[-*+]|\d+[.)]))\s+/;
const leadingWhitespacePattern = /^(\s*)/;

export function visibleLineNumbers(
  doc: { lineAt(position: number): { number: number }; lines: number },
  ranges: readonly { from: number; to: number }[],
): number[] {
  const visible = new Set<number>();
  for (const range of ranges) {
    const first = doc.lineAt(range.from).number;
    const last = doc.lineAt(range.to).number;
    for (let line = first; line <= last; line += 1) visible.add(line);
  }
  return [...visible].sort((left, right) => left - right);
}

export interface ListContext {
  depth: number;
  marker: string;
  ordered: boolean;
  isListStart: boolean;
  prefixLength: number;
}

export interface CodeFenceContext {
  startLine: number;
  endLine: number;
  language: string;
}

export interface OutlineFoldContext {
  kind: "heading" | "tag";
  startLine: number;
  endLine: number;
  depth: number;
}

export interface MarkdownPreviewMetadata {
  listContexts: Map<number, ListContext>;
  tableContexts: Map<number, TableContext>;
  codeFenceContexts: Map<number, CodeFenceContext>;
  outlineFoldContexts: Map<number, OutlineFoldContext>;
}

export function markdownPreviewMetadata(doc: Text): MarkdownPreviewMetadata {
  return {
    listContexts: collectListMetadata(doc),
    tableContexts: collectTableMetadata(doc),
    codeFenceContexts: collectCodeFenceMetadata(doc),
    outlineFoldContexts: collectOutlineFoldMetadata(doc),
  };
}

/** Keep structural metadata out of the keystroke critical path. The three
 * metadata families are independent: a local list edit must not rescan every
 * table and code fence in a large note. List metadata is sparse and can be
 * repaired inside the affected blank-line-bounded block; complex changes fall
 * back to the full collector for correctness. */
export function updateMarkdownPreviewMetadataForChanges(
  previousDoc: Text,
  nextDoc: Text,
  changes: ChangeSet,
  metadata: MarkdownPreviewMetadata,
): MarkdownPreviewMetadata {
  let listChanged = false;
  let tableStructureTouched = false;
  let tableContentTouched = false;
  let codeFenceStructureTouched = false;
  let outlineStructureTouched = false;
  changes.iterChanges((fromA, toA, fromB, toB, inserted) => {
    const before = previousDoc.sliceString(fromA, toA);
    const after = inserted.toString();
    const changedText = `${before}${after}`;
    const previousLine = previousDoc.lineAt(fromA);
    const previousEndLine = previousDoc.lineAt(toA);
    const nextLine = nextDoc.lineAt(fromB);
    const nextEndLine = nextDoc.lineAt(toB);
    const lineBoundaryChanged = changedText.includes("\n");

    listChanged ||= lineBoundaryChanged
      || listStructureSignature(previousLine.text) !== listStructureSignature(nextLine.text);
    const tableRangeTouched = metadataIntersectsRange(metadata.tableContexts, previousLine.number, previousEndLine.number);
    tableContentTouched ||= tableRangeTouched;
    tableStructureTouched ||= changedText.includes("|")
      || tableStructureSignature(previousLine.text) !== tableStructureSignature(nextLine.text)
      || tableStructureSignature(previousEndLine.text) !== tableStructureSignature(nextEndLine.text)
      || (lineBoundaryChanged && (
        tableRangeTouched
        || linesAroundRangeContain(previousDoc, previousLine.number, previousEndLine.number, "|")
        || linesAroundRangeContain(nextDoc, nextLine.number, nextEndLine.number, "|")
      ));
    codeFenceStructureTouched ||= /[`~]/.test(changedText)
      || openingFenceSignature(previousLine.text) !== openingFenceSignature(nextLine.text)
      || openingFenceSignature(previousEndLine.text) !== openingFenceSignature(nextEndLine.text);
    outlineStructureTouched ||= lineBoundaryChanged
      || outlineStructureSignature(previousLine.text) !== outlineStructureSignature(nextLine.text)
      || outlineStructureSignature(previousEndLine.text) !== outlineStructureSignature(nextEndLine.text);
  });

  return {
    listContexts: listChanged
      ? updateListMetadataForChanges(previousDoc, nextDoc, changes, metadata.listContexts)
      : metadata.listContexts,
    tableContexts: tableStructureTouched
      ? collectTableMetadata(nextDoc)
      : tableContentTouched
        ? refreshTableMetadataForChanges(nextDoc, changes, remapTableMetadata(nextDoc, changes, metadata.tableContexts))
        : remapTableMetadata(nextDoc, changes, metadata.tableContexts),
    codeFenceContexts: codeFenceStructureTouched
      ? collectCodeFenceMetadata(nextDoc)
      : remapCodeFenceMetadata(previousDoc, nextDoc, changes, metadata.codeFenceContexts),
    outlineFoldContexts: outlineStructureTouched
      ? collectOutlineFoldMetadata(nextDoc)
      : metadata.outlineFoldContexts,
  };
}

function outlineStructureSignature(text: string): string {
  const heading = text.match(/^(#{1,6})\s+/);
  if (heading) return `heading:${heading[1].length}`;
  const tag = text.match(/^(\s*)#([A-Za-z][\w/-]*)\b/);
  if (tag) return `tag:${indentationColumns(tag[1])}`;
  return `${text.trim().length === 0 ? "blank" : "text"}:${indentationColumns(text.match(leadingWhitespacePattern)?.[1] ?? "")}`;
}

export function collectOutlineFoldMetadata(doc: Text): Map<number, OutlineFoldContext> {
  const contexts = new Map<number, OutlineFoldContext>();
  const headings: Array<{ line: number; level: number }> = [];

  for (let lineNumber = 1; lineNumber <= doc.lines; lineNumber += 1) {
    const text = doc.line(lineNumber).text;
    const heading = text.match(/^(#{1,6})\s+/);
    if (heading) headings.push({ line: lineNumber, level: heading[1].length });

    const tag = text.match(/^(\s*)#([A-Za-z][\w/-]*)\b/);
    if (!tag) continue;
    const indent = indentationColumns(tag[1]);
    let endLine = lineNumber;
    for (let candidate = lineNumber + 1; candidate <= doc.lines; candidate += 1) {
      const candidateText = doc.line(candidate).text;
      if (candidateText.trim().length === 0) {
        endLine = candidate;
        continue;
      }
      const candidateIndent = indentationColumns(candidateText.match(leadingWhitespacePattern)?.[1] ?? "");
      if (candidateIndent <= indent) break;
      endLine = candidate;
    }
    if (endLine > lineNumber) {
      contexts.set(lineNumber, { kind: "tag", startLine: lineNumber, endLine, depth: indent });
    }
  }

  for (let index = 0; index < headings.length; index += 1) {
    const current = headings[index];
    let endLine = doc.lines;
    for (let candidate = index + 1; candidate < headings.length; candidate += 1) {
      if (headings[candidate].level <= current.level) {
        endLine = headings[candidate].line - 1;
        break;
      }
    }
    if (endLine > current.line) {
      contexts.set(current.line, { kind: "heading", startLine: current.line, endLine, depth: current.level - 1 });
    }
  }

  return contexts;
}

function linesAroundRangeContain(doc: Text, startLine: number, endLine: number, token: string): boolean {
  const from = Math.max(1, startLine - 1);
  const to = Math.min(doc.lines, endLine + 1);
  for (let lineNumber = from; lineNumber <= to; lineNumber += 1) {
    if (doc.line(lineNumber).text.includes(token)) return true;
  }
  return false;
}

function metadataIntersectsRange<T>(contexts: ReadonlyMap<number, T>, startLine: number, endLine: number): boolean {
  for (let lineNumber = Math.max(1, startLine - 1); lineNumber <= endLine + 1; lineNumber += 1) {
    if (contexts.has(lineNumber)) return true;
  }
  return false;
}

function listStructureSignature(text: string): string {
  const prefix = text.match(listPrefixPattern)?.[0] ?? "";
  const indentation = text.match(leadingWhitespacePattern)?.[1] ?? "";
  return `${text.trim().length === 0 ? "blank" : "text"}\u0000${indentation}\u0000${prefix}`;
}

function openingFenceSignature(text: string): string {
  const fence = parseOpeningCodeFence(text);
  return fence ? `${fence.markerChar}${fence.markerLength}:${fence.language}` : "";
}

function tableStructureSignature(text: string): string {
  return `${tableLinePattern.test(text) ? "row" : "text"}:${tableSeparatorPattern.test(text) ? "separator" : "content"}`;
}

function indentationColumns(whitespace: string, tabSize = 4) {
  let columns = 0;
  for (const ch of whitespace) {
    if (ch === "\t") {
      columns += tabSize - (columns % tabSize);
    } else {
      columns += 1;
    }
  }
  return columns;
}

export function updateListMetadataForChanges(
  previousDoc: Text,
  nextDoc: Text,
  changes: ChangeSet,
  previousContexts: ReadonlyMap<number, ListContext>,
): Map<number, ListContext> {
  const changedRanges: Array<{ fromA: number; toA: number; fromB: number; toB: number }> = [];
  changes.iterChanges((fromA, toA, fromB, toB) => {
    changedRanges.push({ fromA, toA, fromB, toB });
  });
  if (changedRanges.length !== 1) {
    return collectListMetadata(nextDoc);
  }

  const [change] = changedRanges;
  const previousRange = listMetadataBlockRange(previousDoc, change.fromA, change.toA);
  const nextRange = listMetadataBlockRange(nextDoc, change.fromB, change.toB);
  const lineDelta = nextDoc.lines - previousDoc.lines;
  const nextContexts = new Map<number, ListContext>();

  for (const [lineNumber, context] of previousContexts) {
    if (lineNumber < previousRange.startLine) {
      nextContexts.set(lineNumber, context);
    } else if (lineNumber > previousRange.endLine) {
      nextContexts.set(lineNumber + lineDelta, context);
    }
  }
  collectListMetadata(nextDoc, nextRange.startLine, nextRange.endLine, nextContexts);
  return nextContexts;
}

function listMetadataBlockRange(doc: Text, from: number, to: number): { startLine: number; endLine: number } {
  let startLine = doc.lineAt(Math.min(from, doc.length)).number;
  let endLine = doc.lineAt(Math.min(to, doc.length)).number;

  // Include both neighbours when the edit sits on a blank line. Joining or
  // splitting at that boundary can merge two independently parsed blocks.
  while (startLine > 1 && doc.line(startLine - 1).text.trim().length > 0) {
    startLine -= 1;
  }
  while (endLine < doc.lines && doc.line(endLine + 1).text.trim().length > 0) {
    endLine += 1;
  }
  return { startLine, endLine };
}

/** Last line concealed when a list parent is collapsed. */
export function listSubtreeEndLine(contexts: ReadonlyMap<number, ListContext>, parentLine: number): number {
  const parent = contexts.get(parentLine);
  if (!parent?.isListStart) return parentLine;
  let endLine = parentLine;
  for (let line = parentLine + 1; ; line += 1) {
    const context = contexts.get(line);
    if (!context || (context.isListStart && context.depth <= parent.depth)) return endLine;
    endLine = line;
  }
}

export function collectListMetadata(
  doc: Text,
  startLine = 1,
  endLine = doc.lines,
  listContexts = new Map<number, ListContext>(),
) {
  const stack: Array<{
    indent: number;
    depth: number;
    marker: string;
    ordered: boolean;
  }> = [];

  for (let lineNumber = startLine; lineNumber <= endLine; lineNumber += 1) {
    const line = doc.line(lineNumber);
    const text = line.text;
    const isBlank = text.trim().length === 0;
    const leadingWhitespace = text.match(leadingWhitespacePattern);
    const indent = indentationColumns(leadingWhitespace ? leadingWhitespace[1] : "");
    const match = text.match(listPrefixPattern);

    if (isBlank) {
      stack.length = 0;
      continue;
    }

    if (match) {
      while (stack.length > 0 && indent < stack[stack.length - 1].indent) {
        stack.pop();
      }
      if (stack.length > 0 && indent === stack[stack.length - 1].indent) {
        stack.pop();
      }

      const depth = stack.length;
      const marker = match[2] || "-";
      const ordered = /^\d+[.)]$/.test(marker);
      stack.push({
        indent,
        depth,
        marker,
        ordered,
      });

      listContexts.set(lineNumber, {
        depth,
        marker,
        ordered,
        isListStart: true,
        prefixLength: match[0].length,
      });
      continue;
    }

    if (!isBlank) {
      while (stack.length > 0 && indent <= stack[stack.length - 1].indent) {
        stack.pop();
      }
    }

    if (stack.length > 0) {
      const current = stack[stack.length - 1];
      listContexts.set(lineNumber, {
        depth: current.depth,
        marker: current.marker,
        ordered: current.ordered,
        isListStart: false,
        prefixLength: 0,
      });
    }
  }

  return listContexts;
}

// ---------------------------------------------------------------------------
// Code fences
// ---------------------------------------------------------------------------

function collectCodeFenceMetadata(doc: EditorView["state"]["doc"]) {
  const contexts = new Map<number, CodeFenceContext>();
  let openFence:
    | {
        startLine: number;
        markerChar: "`" | "~";
        markerLength: number;
        language: string;
      }
    | null = null;

  for (let lineNumber = 1; lineNumber <= doc.lines; lineNumber += 1) {
    const text = doc.line(lineNumber).text;

    if (openFence) {
      if (isClosingCodeFence(text, openFence.markerChar, openFence.markerLength)) {
        addCodeFenceContext(contexts, openFence.startLine, lineNumber, openFence.language);
        openFence = null;
      }
      continue;
    }

    const opening = parseOpeningCodeFence(text);
    if (opening) {
      openFence = { startLine: lineNumber, ...opening };
    }
  }

  if (openFence) {
    addCodeFenceContext(contexts, openFence.startLine, doc.lines, openFence.language);
  }

  return contexts;
}

function addCodeFenceContext(contexts: Map<number, CodeFenceContext>, startLine: number, endLine: number, language: string) {
  const context = { startLine, endLine, language };
  for (let lineNumber = startLine; lineNumber <= endLine; lineNumber += 1) {
    contexts.set(lineNumber, context);
  }
}

function remapCodeFenceMetadata(
  previousDoc: Text,
  nextDoc: Text,
  changes: ChangeSet,
  contexts: Map<number, CodeFenceContext>,
): Map<number, CodeFenceContext> {
  if (contexts.size === 0 || previousDoc.lines === nextDoc.lines) return contexts;
  const remapped = new Map<number, CodeFenceContext>();
  for (const context of new Set(contexts.values())) {
    const mappedStart = changes.mapPos(previousDoc.line(context.startLine).from, 1);
    const mappedEnd = changes.mapPos(previousDoc.line(context.endLine).to, -1);
    addCodeFenceContext(
      remapped,
      nextDoc.lineAt(Math.min(mappedStart, nextDoc.length)).number,
      nextDoc.lineAt(Math.min(mappedEnd, nextDoc.length)).number,
      context.language,
    );
  }
  return remapped;
}

function parseOpeningCodeFence(text: string) {
  const match = text.match(/^( {0,3})(`{3,}|~{3,})(.*)$/);
  if (!match) {
    return null;
  }

  const marker = match[2];
  const markerChar = marker[0] as "`" | "~";
  const info = match[3].trim();

  if (markerChar === "`" && info.includes("`")) {
    return null;
  }

  return {
    markerChar,
    markerLength: marker.length,
    language: info.split(/\s+/, 1)[0] ?? "",
  };
}

function isClosingCodeFence(text: string, markerChar: "`" | "~", markerLength: number) {
  const match = text.match(/^( {0,3})(`{3,}|~{3,})\s*$/);
  return Boolean(match && match[2][0] === markerChar && match[2].length >= markerLength);
}

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

type ColumnAlign = "left" | "center" | "right";

export interface TableContext {
  /** First line of the table block (the header row), 1-indexed */
  startLine: number;
  /** Last line of the table block (inclusive) */
  endLine: number;
  /** Document offset of the start of the first table line */
  startOffset: number;
  /** Document offset of the end of the last table line */
  endOffset: number;
  /** Header cells, parsed */
  headers: string[];
  /** Body rows (separator excluded), each is an array of cells */
  rows: string[][];
  /** Per-column alignment derived from the separator row */
  alignments: ColumnAlign[];
}

const tableLinePattern = /^\s*\|.*\|\s*$/;
const tableSeparatorPattern = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/;

function parseTableRow(text: string): string[] {
  const trimmed = text.trim().replace(/^\|/, "").replace(/\|$/, "");
  const cells: string[] = [];
  let cell = "";
  let wikilinkDepth = 0;
  for (let index = 0; index < trimmed.length; index += 1) {
    const character = trimmed[index]!;
    const next = trimmed[index + 1];
    if (character === "[" && next === "[") {
      wikilinkDepth += 1;
      cell += "[[";
      index += 1;
      continue;
    }
    if (character === "]" && next === "]" && wikilinkDepth > 0) {
      wikilinkDepth -= 1;
      cell += "]]";
      index += 1;
      continue;
    }
    if (character === "|" && wikilinkDepth === 0) {
      cells.push(cell.trim());
      cell = "";
      continue;
    }
    cell += character;
  }
  cells.push(cell.trim());
  return cells;
}

function parseAlignments(separatorText: string): ColumnAlign[] {
  return parseTableRow(separatorText).map((cell) => {
    const left = cell.startsWith(":");
    const right = cell.endsWith(":");
    if (left && right) return "center";
    if (right) return "right";
    return "left";
  });
}

function collectTableMetadata(doc: import("@codemirror/state").Text): Map<number, TableContext> {
  const result = new Map<number, TableContext>();
  let i = 1;
  while (i <= doc.lines) {
    const context = tableContextAtLine(doc, i);
    if (context) {
      addTableContext(result, context);
      i = context.endLine + 1;
      continue;
    }
    i += 1;
  }
  return result;
}

function tableContextAtLine(doc: Text, startLine: number): TableContext | null {
  const line = doc.line(startLine);
  if (!tableLinePattern.test(line.text)) return null;
  const separator = startLine + 1 <= doc.lines ? doc.line(startLine + 1) : null;
  if (!separator || !tableSeparatorPattern.test(separator.text)) return null;

  const rows: string[][] = [];
  let endLine = startLine + 1;
  let endOffset = separator.to;
  for (let lineNumber = startLine + 2; lineNumber <= doc.lines; lineNumber += 1) {
    const bodyLine = doc.line(lineNumber);
    if (!tableLinePattern.test(bodyLine.text)) break;
    rows.push(parseTableRow(bodyLine.text));
    endLine = lineNumber;
    endOffset = bodyLine.to;
  }
  return {
    startLine,
    endLine,
    startOffset: line.from,
    endOffset,
    headers: parseTableRow(line.text),
    rows,
    alignments: parseAlignments(separator.text),
  };
}

function addTableContext(contexts: Map<number, TableContext>, context: TableContext): void {
  for (let lineNumber = context.startLine; lineNumber <= context.endLine; lineNumber += 1) {
    contexts.set(lineNumber, context);
  }
}

function remapTableMetadata(
  nextDoc: Text,
  changes: ChangeSet,
  contexts: Map<number, TableContext>,
): Map<number, TableContext> {
  if (contexts.size === 0) return contexts;
  const remapped = new Map<number, TableContext>();
  for (const context of new Set(contexts.values())) {
    const startOffset = changes.mapPos(context.startOffset, 1);
    const endOffset = changes.mapPos(context.endOffset, -1);
    const startLine = nextDoc.lineAt(Math.min(startOffset, nextDoc.length)).number;
    const endLine = nextDoc.lineAt(Math.min(endOffset, nextDoc.length)).number;
    const nextContext: TableContext = { ...context, startLine, endLine, startOffset, endOffset };
    addTableContext(remapped, nextContext);
  }
  return remapped;
}

function refreshTableMetadataForChanges(
  nextDoc: Text,
  changes: ChangeSet,
  contexts: Map<number, TableContext>,
): Map<number, TableContext> {
  const starts = new Set<number>();
  changes.iterChanges((_fromA, _toA, fromB, toB) => {
    const firstLine = nextDoc.lineAt(fromB).number;
    const lastLine = nextDoc.lineAt(toB).number;
    for (let lineNumber = firstLine; lineNumber <= lastLine; lineNumber += 1) {
      const context = contexts.get(lineNumber);
      if (context) starts.add(context.startLine);
    }
  });
  if (starts.size === 0) return contexts;

  const refreshed = new Map(contexts);
  for (const startLine of starts) {
    const previous = refreshed.get(startLine);
    if (!previous) continue;
    for (let lineNumber = previous.startLine; lineNumber <= previous.endLine; lineNumber += 1) {
      refreshed.delete(lineNumber);
    }
    const next = tableContextAtLine(nextDoc, startLine);
    if (next) addTableContext(refreshed, next);
  }
  return refreshed;
}
