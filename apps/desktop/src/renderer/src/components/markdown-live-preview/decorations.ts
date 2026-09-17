import { Decoration, type DecorationSet, EditorView } from "@codemirror/view";
import { RangeSetBuilder, type Text } from "@codemirror/state";

import { LIST_GEOMETRY, listGeometryStyleVariables } from "../listGeometry";
import { listPrefixPattern, type ListContext, type MarkdownPreviewMetadata, visibleLineNumbers } from "./metadata";
import { FoldToggleWidget, ListPrefixWidget, MarkdownImageWidget, markdownImageTarget, TaskPrefixWidget, TableWidget, WikilinkWidget } from "./widgets";
import { wikilinkPresentation } from "./wikilinks";

export interface MarkdownLivePreviewOptions {
  onResolveImage: (target: string, options?: { lookupByFilename?: boolean }) => Promise<{ url: string }>;
  suppressedGeneratedTitle?: string | null;
  onToggleFold?: (view: EditorView, anchor: number) => void;
}

interface DecorationEntry {
  from: number;
  to: number;
  decoration: Decoration;
}

const concealDecoration = Decoration.mark({ class: "exograph-md-syntax-hidden" });
const boldDecoration = Decoration.mark({ class: "exograph-md-strong" });
const italicDecoration = Decoration.mark({ class: "exograph-md-emphasis" });
const strikeDecoration = Decoration.mark({ class: "exograph-md-strike" });
const codeDecoration = Decoration.mark({ class: "exograph-md-inline-code" });
function foldedListLineNumbers(doc: Text, listContexts: Map<number, ListContext>, anchors: ReadonlySet<number>) {
  const lines = new Set<number>();
  for (const anchor of anchors) {
    const line = doc.lineAt(anchor);
    if (line.from === anchor && listContexts.get(line.number)?.isListStart) {
      lines.add(line.number);
    }
  }
  return lines;
}

export function buildDecorations(view: EditorView, options: MarkdownLivePreviewOptions, metadata: MarkdownPreviewMetadata, foldedParentAnchors: ReadonlySet<number>): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const currentLine = view.state.doc.lineAt(view.state.selection.main.head).number;
  const { listContexts, tableContexts, codeFenceContexts, outlineFoldContexts } = metadata;
  const foldedLines = foldedListLineNumbers(view.state.doc, listContexts, foldedParentAnchors);

  // Continuation text may sit between a parent marker and its nested list.
  const linesWithChildren = new Set<number>();
  for (const [lineNum, ctx] of listContexts) {
    if (!ctx.isListStart) continue;
    let nextLine = lineNum + 1;
    while (listContexts.get(nextLine)?.isListStart === false) nextLine += 1;
    const nextCtx = listContexts.get(nextLine);
    if (nextCtx && nextCtx.depth > ctx.depth) {
      linesWithChildren.add(lineNum);
    }
  }

  // Compute which lines are hidden due to folding
  const hiddenLines = new Set<number>();
  for (const foldedLine of foldedLines) {
    const foldedCtx = listContexts.get(foldedLine);
    if (!foldedCtx) continue;
    const foldDepth = foldedCtx.depth;
    for (let ln = foldedLine + 1; ln <= view.state.doc.lines; ln++) {
      const ctx = listContexts.get(ln);
      if (!ctx || (ctx.isListStart && ctx.depth <= foldDepth)) break;
      hiddenLines.add(ln);
    }
  }
  for (const [lineNumber, context] of outlineFoldContexts) {
    if (!foldedParentAnchors.has(view.state.doc.line(lineNumber).from)) continue;
    for (let hiddenLine = lineNumber + 1; hiddenLine <= context.endLine; hiddenLine += 1) {
      hiddenLines.add(hiddenLine);
    }
  }

  const lineDecorations: DecorationEntry[] = [];
  const inlineDecorations: DecorationEntry[] = [];

  const cursorPos = view.state.selection.main.head;

  const handledTableStarts = new Set<number>();

  const renderedLineNumbers = visibleLineNumbers(view.state.doc, view.visibleRanges);
  if (!renderedLineNumbers.includes(currentLine)) {
    renderedLineNumbers.push(currentLine);
    renderedLineNumbers.sort((left, right) => left - right);
  }
  for (const lineNumber of renderedLineNumbers) {
    const line = view.state.doc.line(lineNumber);
    const text = line.text;
    const codeFenceCtx = codeFenceContexts.get(lineNumber);

    if (lineNumber === 1 && shouldSuppressGeneratedTitleLine(text, options.suppressedGeneratedTitle ?? null)) {
      lineDecorations.push({
        from: line.from,
        to: line.from,
        decoration: Decoration.line({ class: "exograph-md-line--suppressed-title" }),
      });
      if (line.from < line.to) {
        lineDecorations.push({ from: line.from, to: line.to, decoration: Decoration.replace({}) });
      }
      continue;
    }

    if (hiddenLines.has(lineNumber)) {
      lineDecorations.push({
        from: line.from,
        to: line.from,
        decoration: Decoration.line({ class: "exograph-md-line--folded-hidden" }),
      });
      continue;
    }

    if (codeFenceCtx) {
      const isFenceLine = lineNumber === codeFenceCtx.startLine || lineNumber === codeFenceCtx.endLine;
      const isSingleUnclosedFence = codeFenceCtx.startLine === codeFenceCtx.endLine;
      const cursorOnLine = currentLine === lineNumber;

      if (isFenceLine) {
        lineDecorations.push({
          from: line.from,
          to: line.from,
          decoration: Decoration.line({
            attributes: {
              class: "exograph-md-line exograph-md-line--codefence",
              ...(codeFenceCtx.language ? { "data-exograph-code-language": codeFenceCtx.language } : {}),
            },
          }),
        });

        if (!cursorOnLine && line.from < line.to) {
          lineDecorations.push({ from: line.from, to: line.to, decoration: concealDecoration });
        }

        if (isSingleUnclosedFence || cursorOnLine) {
          continue;
        }
      }

      if (!isFenceLine) {
        const classes = [
          "exograph-md-line",
          "exograph-md-line--codeblock",
          lineNumber === codeFenceCtx.startLine + 1 ? "exograph-md-line--codeblock-start" : "",
          lineNumber === codeFenceCtx.endLine - 1 ? "exograph-md-line--codeblock-end" : "",
        ].filter(Boolean);
        lineDecorations.push({
          from: line.from,
          to: line.from,
          decoration: Decoration.line({
            attributes: {
              class: classes.join(" "),
              ...(codeFenceCtx.language ? { "data-exograph-code-language": codeFenceCtx.language } : {}),
            },
          }),
        });
        continue;
      }

      continue;
    }

    const tableCtx = tableContexts.get(lineNumber);
    if (tableCtx) {
      const cursorInTable = currentLine >= tableCtx.startLine && currentLine <= tableCtx.endLine;
      if (cursorInTable) {
        // Edit mode — show raw markdown, fall through to normal per-line decoration
      } else {
        if (lineNumber === tableCtx.startLine && !handledTableStarts.has(tableCtx.startLine)) {
          handledTableStarts.add(tableCtx.startLine);
          // Replace the start line's content with the table widget (single-line range — no block:true).
          // ViewPlugins cannot emit block decorations; this stays inline.
          if (line.from < line.to) {
            lineDecorations.push({
              from: line.from,
              to: line.to,
              decoration: Decoration.replace({ widget: new TableWidget(tableCtx) }),
            });
          } else {
            // Empty start line edge case — emit as a line decoration with the widget via mark
            lineDecorations.push({
              from: line.from,
              to: line.from,
              decoration: Decoration.widget({ widget: new TableWidget(tableCtx), side: 1 }),
            });
          }
        } else if (lineNumber !== tableCtx.startLine) {
          // Hide other table lines via line-level CSS class (display:none)
          lineDecorations.push({
            from: line.from,
            to: line.from,
            decoration: Decoration.line({ class: "exograph-md-line--folded-hidden" }),
          });
        }
        continue;
      }
    }

    const outlineFold = outlineFoldContexts.get(lineNumber);
    const hasChildren = linesWithChildren.has(lineNumber);
    const isFolded = foldedLines.has(lineNumber);
    let previousLine = lineNumber - 1;
    while (hiddenLines.has(previousLine)) previousLine -= 1;
    const previousList = listContexts.get(previousLine);
    const currentList = listContexts.get(lineNumber);
    const endsGuide = Boolean(currentList?.isListStart && previousList && previousList.depth > currentList.depth);
    decorateLine(line.from, line.number, text, cursorPos, listContexts, lineDecorations, hasChildren, isFolded, endsGuide, options.onToggleFold);
    if (outlineFold) {
      lineDecorations.push({
        from: line.from,
        to: line.from,
        decoration: Decoration.line({ class: "exograph-md-line--outline-parent" }),
      });
      const outlineIsFolded = foldedParentAnchors.has(line.from);
      lineDecorations.push({
        from: line.from,
        to: line.from,
        decoration: Decoration.widget({
          widget: new FoldToggleWidget(outlineFold.depth, outlineIsFolded, line.from, "outline", options.onToggleFold),
          side: -1,
        }),
      });
    }
    decorateInline(line.from, text, cursorPos, inlineDecorations, options);
  }

  // CodeMirror requires startSide ordering at shared positions: line styles
  // precede fold controls, which precede replacement prefixes.
  const all = [...lineDecorations, ...inlineDecorations];
  all.sort((a, b) => a.from - b.from || a.decoration.startSide - b.decoration.startSide || a.to - b.to);

  for (const entry of all) {
    builder.add(entry.from, entry.to, entry.decoration);
  }

  return builder.finish();
}

export function shouldSuppressGeneratedTitleLine(lineText: string, suppressedGeneratedTitle: string | null): boolean {
  if (!suppressedGeneratedTitle) {
    return false;
  }
  return lineText.trim() === `# ${suppressedGeneratedTitle}`;
}

function cursorWithin(cursorPos: number, from: number, to: number): boolean {
  return cursorPos >= from && cursorPos <= to;
}

function decorateLine(
  lineFrom: number,
  lineNumber: number,
  text: string,
  cursorPos: number,
  listContexts: Map<number, ListContext>,
  out: DecorationEntry[],
  hasChildren = false,
  isFolded = false,
  endsGuide = false,
  onToggleFold?: (view: EditorView, anchor: number) => void,
) {
  const heading = text.match(/^(#{1,6})\s+/);
  if (heading) {
    out.push({ from: lineFrom, to: lineFrom, decoration: Decoration.line({ class: `exograph-md-line exograph-md-line--heading exograph-md-line--h${heading[1].length}` }) });
    const prefixEnd = lineFrom + heading[0].length;
    if (!cursorWithin(cursorPos, lineFrom, prefixEnd)) {
      out.push({ from: lineFrom, to: prefixEnd, decoration: concealDecoration });
    }
    return;
  }

  const task = text.match(/^(\s*[-*+]\s+)\[([ xX])\]\s+/);
  const listContext = listContexts.get(lineNumber);
  if (listContext) {
    const taskClass = task
      ? ` exograph-md-line--task${task[2].toLowerCase() === "x" ? " exograph-md-line--task-done" : ""}`
      : "";
    out.push({
      from: lineFrom,
      to: lineFrom,
      decoration: Decoration.line({
        attributes: {
          class: `exograph-md-line ${listContext.isListStart ? "exograph-md-line--list-start" : "exograph-md-line--list-continuation"}${taskClass}`,
          style: listLineStyle(listContext.depth, listContext.isListStart, hasChildren && !isFolded, endsGuide),
          "data-exograph-list-depth": String(listContext.depth),
        },
      }),
    });
  }

  if (listContext?.isListStart && hasChildren) {
    out.push({
      from: lineFrom,
      to: lineFrom,
      decoration: Decoration.widget({ widget: new FoldToggleWidget(listContext.depth, isFolded, lineFrom, "list", onToggleFold), side: -1 }),
    });
  }

  if (task) {
    const isChecked = task[2].toLowerCase() === "x";
    const checkboxCharPos = lineFrom + task[1].length + 1;
    const prefixEnd = lineFrom + task[0].length;
    if (!listContext) {
      out.push({
        from: lineFrom,
        to: lineFrom,
        decoration: Decoration.line({
          attributes: {
            class: `exograph-md-line exograph-md-line--task${isChecked ? " exograph-md-line--task-done" : ""}`,
            style: listLineStyle(0),
          },
        }),
      });
    }
    if (shouldRenderTaskPrefix(cursorPos, lineFrom, prefixEnd)) {
      out.push({
        from: lineFrom,
        to: prefixEnd,
        decoration: Decoration.replace({ widget: new TaskPrefixWidget(isChecked, listContext?.depth ?? 0, checkboxCharPos) }),
      });
    }
    return;
  }

  if (listContext) {
    if (listContext.isListStart) {
      const prefixEnd = lineFrom + listContext.prefixLength;
      const cursorInPrefix = cursorPos >= lineFrom && cursorPos < prefixEnd;
      const lineClass = [
        "exograph-md-line",
        "exograph-md-line--list",
        listContext.ordered ? "exograph-md-line--list-ordered" : "",
        hasChildren ? "exograph-md-line--list-has-children" : "",
        isFolded ? "exograph-md-line--list-folded" : "",
        cursorInPrefix ? "exograph-md-line--list-raw" : "",
      ].filter(Boolean).join(" ");
      out.push({
        from: lineFrom,
        to: lineFrom,
        decoration: Decoration.line({
          attributes: {
            class: lineClass,
            style: listLineStyle(listContext.depth, listContext.isListStart, hasChildren && !isFolded, endsGuide),
            "data-exograph-list-depth": String(listContext.depth),
            "data-exograph-list-marker": listContext.marker,
            ...(cursorInPrefix ? { "data-exograph-list-raw": listContext.marker } : {}),
          },
        }),
      });
      if (!cursorInPrefix) {
        // Normal mode: replace entire prefix invisibly, bullet shown via ::before.
        out.push({ from: lineFrom, to: prefixEnd, decoration: Decoration.replace({ widget: new ListPrefixWidget() }) });
      } else {
        const markerMatch = text.match(listPrefixPattern);
        const markerStart = lineFrom + (markerMatch?.[1].length ?? 0);
        const markerEnd = markerStart + listContext.marker.length;
        if (lineFrom < markerStart) {
          out.push({ from: lineFrom, to: markerStart, decoration: Decoration.replace({}) });
        }
        out.push({ from: markerStart, to: markerEnd, decoration: Decoration.mark({ class: "exograph-md-list-marker-raw" }) });
        if (markerEnd < prefixEnd) {
          out.push({ from: markerEnd, to: prefixEnd, decoration: Decoration.replace({}) });
        }
      }
    } else {
      out.push({
        from: lineFrom,
        to: lineFrom,
        decoration: Decoration.line({
          attributes: {
            class: "exograph-md-line exograph-md-line--list exograph-md-line--list-continuation",
            style: listLineStyle(listContext.depth, listContext.isListStart, hasChildren && !isFolded, endsGuide),
            "data-exograph-list-depth": String(listContext.depth),
          },
        }),
      });
    }
    return;
  }

  const quoteMatch = text.match(/^(>\s*)/);
  if (quoteMatch) {
    const prefixLen = quoteMatch[1].length;
    out.push({ from: lineFrom, to: lineFrom, decoration: Decoration.line({ class: "exograph-md-line exograph-md-line--quote" }) });
    if (!cursorWithin(cursorPos, lineFrom, lineFrom + prefixLen)) {
      out.push({ from: lineFrom, to: lineFrom + prefixLen, decoration: concealDecoration });
    }
    return;
  }

  if (isThematicBreak(text)) {
    out.push({ from: lineFrom, to: lineFrom, decoration: Decoration.line({ class: "exograph-md-line exograph-md-line--rule" }) });
    if (!cursorWithin(cursorPos, lineFrom, lineFrom + text.length)) {
      out.push({ from: lineFrom, to: lineFrom + text.length, decoration: concealDecoration });
    }
    return;
  }

  out.push({
    from: lineFrom,
    to: lineFrom,
    decoration: Decoration.line({ class: "exograph-md-line exograph-md-line--body" }),
  });
}

export function shouldRenderTaskPrefix(cursorPos: number, lineFrom: number, prefixEnd: number): boolean {
  return cursorPos < lineFrom || cursorPos >= prefixEnd;
}

function isThematicBreak(text: string) {
  const trimmed = text.trim();
  if (!/^[-*_][\s-*_]*$/.test(trimmed)) {
    return false;
  }

  const marker = trimmed[0];
  if (![...trimmed].every((char) => char === marker || /\s/.test(char))) {
    return false;
  }

  return [...trimmed].filter((char) => char === marker).length >= 3;
}

function decorateInline(
  lineFrom: number,
  text: string,
  cursorPos: number,
  out: DecorationEntry[],
  options: MarkdownLivePreviewOptions,
) {
  applyDelimited(text, lineFrom, /\*\*(.+?)\*\*/g, 2, boldDecoration, out, cursorPos);
  applyDelimited(text, lineFrom, /(?<!\*)\*([^*]+)\*(?!\*)/g, 1, italicDecoration, out, cursorPos);
  applyDelimited(text, lineFrom, /~~(.+?)~~/g, 2, strikeDecoration, out, cursorPos);
  applyObsidianImageEmbeds(text, lineFrom, out, cursorPos, options);
  applyWikilinks(text, lineFrom, out, cursorPos);
  applyMarkdownImages(text, lineFrom, out, cursorPos, options);
  applyMarkdownLinks(text, lineFrom, out, cursorPos);

  applyDelimited(text, lineFrom, /`([^`\n]+)`/g, 1, codeDecoration, out, cursorPos);
  applyInteractiveMarks(text, lineFrom, /(^|[\s(])#([A-Za-z][\w/-]*)\b/g, out, (match, start) => {
    const offset = match[1] ? match[1].length : 0;
    return [start + offset, start + offset + match[2].length + 1, { "data-exograph-tag": match[2] }];
  }, "exograph-md-tag");
}

/**
 * The Markdown source stays canonical. Outside the image's range it becomes a
 * widget; placing the caret in that range removes the widget and exposes the
 * exact source for ordinary CodeMirror editing.
 */
function applyMarkdownImages(
  text: string,
  lineFrom: number,
  out: DecorationEntry[],
  cursorPos: number,
  options: MarkdownLivePreviewOptions,
) {
  for (const match of text.matchAll(/!\[([^\]]*)\]\(\s*(?:<([^>]+)>|(.+?))\s*\)/g)) {
    const start = lineFrom + (match.index ?? 0);
    const end = start + match[0].length;
    if (cursorWithin(cursorPos, start, end)) {
      continue;
    }
    const target = markdownImageTarget(match[2] ?? match[3] ?? "");
    if (!target) {
      continue;
    }
    out.push({
      from: start,
      to: end,
      decoration: Decoration.replace({ widget: new MarkdownImageWidget(match[1], target, options.onResolveImage) }),
    });
  }
}

function applyObsidianImageEmbeds(
  text: string,
  lineFrom: number,
  out: DecorationEntry[],
  cursorPos: number,
  options: MarkdownLivePreviewOptions,
) {
  for (const match of text.matchAll(/!\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g)) {
    const start = lineFrom + (match.index ?? 0);
    const end = start + match[0].length;
    if (cursorWithin(cursorPos, start, end)) {
      continue;
    }
    const target = match[1].trim();
    if (!target) {
      continue;
    }
    out.push({
      from: start,
      to: end,
      decoration: Decoration.replace({ widget: new MarkdownImageWidget(target, target, options.onResolveImage, true) }),
    });
  }
}

function applyDelimited(
  text: string,
  lineFrom: number,
  pattern: RegExp,
  delimiterLength: number,
  decoration: Decoration,
  out: DecorationEntry[],
  cursorPos: number,
) {
  for (const match of text.matchAll(pattern)) {
    const start = lineFrom + (match.index ?? 0);
    const end = start + match[0].length;
    if (cursorWithin(cursorPos, start, end)) {
      // Cursor is inside this match — show raw delimiters, still apply style
      out.push({ from: start + delimiterLength, to: end - delimiterLength, decoration });
    } else {
      out.push({ from: start, to: start + delimiterLength, decoration: concealDecoration });
      out.push({ from: start + delimiterLength, to: end - delimiterLength, decoration });
      out.push({ from: end - delimiterLength, to: end, decoration: concealDecoration });
    }
  }
}

function applyInteractiveMarks(
  text: string,
  lineFrom: number,
  pattern: RegExp,
  out: DecorationEntry[],
  rangeResolver: (match: RegExpMatchArray, start: number) => [number, number, Record<string, string>?],
  className = "exograph-md-link",
) {
  for (const match of text.matchAll(pattern)) {
    const start = lineFrom + (match.index ?? 0);
    const [from, to, attrs] = rangeResolver(match, start);
    out.push({ from, to, decoration: Decoration.mark({ class: className, attributes: attrs }) });
  }
}

function applyWikilinks(text: string, lineFrom: number, out: DecorationEntry[], cursorPos: number) {
  for (const match of text.matchAll(/(?<!!)\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g)) {
    const start = lineFrom + (match.index ?? 0);
    const fullText = match[0];
    const end = start + fullText.length;
    const target = match[1].trim();
    const { label } = wikilinkPresentation(target, match[2]);
    const labelStartOffset = match[2] ? fullText.indexOf(match[2]) : 2;
    const labelStart = start + labelStartOffset;
    const labelEnd = labelStart + label.length;

    if (cursorWithin(cursorPos, start, end)) {
      // Cursor inside — show raw wikilink, still make the label clickable
      out.push({ from: labelStart, to: labelEnd, decoration: Decoration.mark({ class: "exograph-md-link", attributes: { "data-exograph-link-target": target, "data-exograph-link-kind": "wikilink" } }) });
    } else {
      out.push({ from: start, to: end, decoration: Decoration.replace({ widget: new WikilinkWidget(target, label) }) });
    }
  }
}

function applyMarkdownLinks(text: string, lineFrom: number, out: DecorationEntry[], cursorPos: number) {
  for (const match of text.matchAll(/\[([^\]]+)\]\(([^)]+)\)/g)) {
    const start = lineFrom + (match.index ?? 0);
    // Images are handled by their own replacement widget. Without this guard,
    // the link parser would also decorate the nested `[alt](target)` range.
    if (start > lineFrom && text[start - lineFrom - 1] === "!") {
      continue;
    }
    const end = start + match[0].length;
    const label = match[1];
    const labelStart = start + 1;
    const labelEnd = labelStart + label.length;

    if (cursorWithin(cursorPos, start, end)) {
      // Cursor inside — show raw markdown link, still make label clickable
      out.push({ from: labelStart, to: labelEnd, decoration: Decoration.mark({ class: "exograph-md-link", attributes: { "data-exograph-link-target": match[2].trim() } }) });
    } else {
      out.push({ from: start, to: start + 1, decoration: concealDecoration });
      out.push({ from: labelStart, to: labelEnd, decoration: Decoration.mark({ class: "exograph-md-link", attributes: { "data-exograph-link-target": match[2].trim() } }) });
      out.push({ from: labelEnd, to: end, decoration: concealDecoration });
    }
  }
}

function listLineStyle(depth: number, isListStart = true, expandedParent = false, endsGuide = false) {
  const padLeft = LIST_GEOMETRY.baseIndent + depth * LIST_GEOMETRY.indentStep;
  const guides: string[] = [];
  // Each descendant carries its ancestors' guides, including wrapped lines.
  // The parent starts its own guide below the marker; folding removes it.
  for (let ancestor = 0; ancestor < depth + Number(!isListStart || expandedParent || endsGuide); ancestor += 1) {
    // Center the one-pixel rule beneath the four-pixel bullet.
    const left = LIST_GEOMETRY.baseIndent + ancestor * LIST_GEOMETRY.indentStep - LIST_GEOMETRY.markerTextGap - 2.5;
    const ownGuide = ancestor === depth && isListStart;
    const above = "calc(0.5lh - var(--exograph-list-marker-clearance, 8px))";
    const below = "calc(0.5lh + var(--exograph-list-marker-clearance, 8px))";
    const gradient = ownGuide
      ? `${endsGuide ? "var(--exograph-list-guide)" : "transparent"} ${above}, transparent ${above}, transparent ${below}, ${expandedParent ? "var(--exograph-list-guide)" : "transparent"} ${below}`
      : "var(--exograph-list-guide), var(--exograph-list-guide)";
    guides.push(`linear-gradient(to bottom, ${gradient}) ${left}px 0 / 1px 100% no-repeat`);
  }
  return `${listGeometryStyleVariables()};--exograph-list-depth:${depth};padding-left:${padLeft}px;background:${guides.join(",") || "none"};`;
}
