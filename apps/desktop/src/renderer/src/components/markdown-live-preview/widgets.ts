import { WidgetType, type EditorView } from "@codemirror/view";

import { LIST_GEOMETRY } from "../listGeometry";
import type { TableContext } from "./metadata";
import { wikilinkPresentation } from "./wikilinks";

type ResolveImage = (target: string, options?: { lookupByFilename?: boolean }) => Promise<{ url: string }>;

interface MarkdownImageRetryOptions {
  attempts?: number;
  delayMs?: number;
}

/**
 * Workspace activation and filesystem watchers can briefly invalidate a read
 * while the editor is being opened. Keep that transient boundary from turning
 * a recoverable image into a permanent missing-image decoration.
 */
export async function resolveMarkdownImageWithRetry(
  resolveImage: ResolveImage,
  target: string,
  options?: { lookupByFilename?: boolean },
  retryOptions: MarkdownImageRetryOptions = {},
): Promise<{ url: string }> {
  const attempts = Math.max(1, retryOptions.attempts ?? 2);
  const delayMs = Math.max(0, retryOptions.delayMs ?? 120);
  let lastError: unknown;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await resolveImage(target, options);
    } catch (error) {
      lastError = error;
      if (attempt + 1 < attempts && delayMs > 0) {
        await new Promise<void>((resolve) => window.setTimeout(resolve, delayMs));
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error("Markdown image resolution failed.");
}

export interface MarkdownGraphReferenceItem {
  label: string;
  target: string;
}

export interface MarkdownGraphReferences {
  backlinks: MarkdownGraphReferenceItem[];
  references: MarkdownGraphReferenceItem[];
}

export type TableCellInlineContent =
  | { kind: "text"; value: string }
  | { kind: "wikilink"; label: string; target: string }
  | { kind: "markdown-link"; label: string; target: string }
  | { kind: "strong" | "emphasis" | "strike" | "code"; value: string }
  | { kind: "tag"; value: string; target: string };

const tableCellInlinePattern = /(?<wikilink>(?<!!)\[\[(?<wikilinkTarget>[^\]|]+)(?:\|(?<wikilinkAlias>[^\]]+))?\]\])|(?<markdownLink>\[(?<markdownLinkLabel>[^\]]+)\]\((?<markdownLinkTarget>[^)]+)\))|(?<strong>\*\*(?<strongValue>.+?)\*\*)|(?<emphasis>(?<!\*)\*(?<emphasisValue>[^*]+)\*(?!\*))|(?<strike>~~(?<strikeValue>.+?)~~)|(?<code>`(?<codeValue>[^`\n]+)`)|(?<tag>(?<tagPrefix>^|[\s(])#(?<tagTarget>[A-Za-z][\w/-]*))/g;

/**
 * Tables are replacement widgets, so their cells do not pass through the
 * line-level Markdown decorations. Parse wikilinks here to preserve the same
 * visible label and click contract as links in ordinary Markdown text.
 */
export function tableCellInlineContent(value: string): TableCellInlineContent[] {
  const content: TableCellInlineContent[] = [];
  const appendText = (text: string) => {
    if (!text) return;
    const previous = content.at(-1);
    if (previous?.kind === "text") previous.value += text;
    else content.push({ kind: "text", value: text });
  };
  let cursor = 0;
  for (const match of value.matchAll(tableCellInlinePattern)) {
    const start = match.index ?? 0;
    if (start > cursor) appendText(value.slice(cursor, start));
    const groups = match.groups ?? {};
    if (groups.wikilink) {
      const target = groups.wikilinkTarget?.trim() ?? "";
      const { label } = wikilinkPresentation(target, groups.wikilinkAlias);
      if (target && label) content.push({ kind: "wikilink", target, label });
      else appendText(match[0]);
    } else if (groups.markdownLink) {
      content.push({ kind: "markdown-link", label: groups.markdownLinkLabel ?? "", target: groups.markdownLinkTarget?.trim() ?? "" });
    } else if (groups.strong) {
      content.push({ kind: "strong", value: groups.strongValue ?? "" });
    } else if (groups.emphasis) {
      content.push({ kind: "emphasis", value: groups.emphasisValue ?? "" });
    } else if (groups.strike) {
      content.push({ kind: "strike", value: groups.strikeValue ?? "" });
    } else if (groups.code) {
      content.push({ kind: "code", value: groups.codeValue ?? "" });
    } else if (groups.tag) {
      const prefix = groups.tagPrefix ?? "";
      appendText(prefix);
      const target = groups.tagTarget ?? "";
      content.push({ kind: "tag", value: `#${target}`, target });
    }
    cursor = start + match[0].length;
  }
  if (cursor < value.length || content.length === 0) appendText(value.slice(cursor));
  return content;
}

function appendTableCellContent(cell: HTMLElement, value: string) {
  for (const part of tableCellInlineContent(value)) {
    if (part.kind === "text") {
      cell.append(document.createTextNode(part.value));
      continue;
    }
    if (part.kind === "wikilink" || part.kind === "markdown-link") {
      const link = document.createElement("span");
      link.className = "exograph-md-link";
      link.dataset.exographLinkTarget = part.target;
      if (part.kind === "wikilink") link.dataset.exographLinkKind = "wikilink";
      link.textContent = part.label;
      cell.append(link);
      continue;
    }
    if (part.kind === "tag") {
      const tag = document.createElement("span");
      tag.className = "exograph-md-tag";
      tag.dataset.exographTag = part.target;
      tag.textContent = part.value;
      cell.append(tag);
      continue;
    }
    const element = document.createElement(part.kind === "strong" ? "strong" : part.kind === "emphasis" ? "em" : part.kind === "strike" ? "s" : "code");
    element.className = `exograph-md-${part.kind === "strong" ? "strong" : part.kind === "emphasis" ? "emphasis" : part.kind === "strike" ? "strike" : "inline-code"}`;
    element.textContent = part.value;
    cell.append(element);
  }
}

export class WikilinkWidget extends WidgetType {
  constructor(
    private readonly target: string,
    private readonly label: string,
  ) {
    super();
  }

  toDOM() {
    const link = document.createElement("span");
    link.className = "exograph-md-link";
    link.dataset.exographLinkTarget = this.target;
    link.dataset.exographLinkKind = "wikilink";
    link.textContent = this.label;
    return link;
  }

  eq(other: WikilinkWidget) {
    return other.target === this.target && other.label === this.label;
  }

  ignoreEvent(event: Event) {
    return event.type !== "click" && event.type !== "mousedown";
  }
}

export class GraphReferencesWidget extends WidgetType {
  constructor(private readonly references: MarkdownGraphReferences) {
    super();
  }

  toDOM() {
    const wrap = document.createElement("section");
    wrap.className = "markdown-graph-references";
    wrap.dataset.testid = "markdown-graph-references";
    wrap.contentEditable = "false";
    wrap.setAttribute("aria-label", "Graph references");

    if (this.references.backlinks.length > 0) {
      wrap.appendChild(this.renderGroup("Backlinks", this.references.backlinks, "backlinks"));
    }
    if (this.references.references.length > 0) {
      wrap.appendChild(this.renderGroup("References", this.references.references, "references"));
    }

    return wrap;
  }

  eq(other: GraphReferencesWidget) {
    return JSON.stringify(other.references) === JSON.stringify(this.references);
  }

  ignoreEvent(event: Event) {
    return event.type !== "click" && event.type !== "mousedown";
  }

  private renderGroup(title: string, items: MarkdownGraphReferenceItem[], testId: string) {
    const group = document.createElement("div");
    group.className = "markdown-graph-references__group";
    group.dataset.testid = `markdown-graph-${testId}`;

    const heading = document.createElement("div");
    heading.className = "markdown-graph-references__title";
    heading.textContent = title;
    group.appendChild(heading);

    const list = document.createElement("div");
    list.className = "markdown-graph-references__items";
    for (const item of items) {
      const button = document.createElement("button");
      button.className = "markdown-graph-references__item";
      button.type = "button";
      button.dataset.exographLinkTarget = item.target;
      button.dataset.exographLinkKind = "wikilink";
      button.textContent = item.label;
      list.appendChild(button);
    }
    group.appendChild(list);
    return group;
  }
}
export function markdownImageTarget(rawTarget: string): string {
  // Optional Markdown titles follow a target in quotes or parentheses. Keep
  // ordinary spaces in local filenames intact.
  return rawTarget.trim().replace(/\s+(?:"[^"]*"|'[^']*'|\([^)]*\))$/, "").trim();
}

export class MarkdownImageWidget extends WidgetType {
  constructor(
    private readonly alt: string,
    private readonly target: string,
    private readonly resolveImage: ResolveImage,
    private readonly lookupByFilename = false,
  ) {
    super();
  }

  toDOM() {
    const wrap = document.createElement("span");
    wrap.className = "exograph-md-image exograph-md-image--loading";
    wrap.contentEditable = "false";
    wrap.dataset.testid = "markdown-image";
    wrap.setAttribute("aria-label", this.alt || "Markdown image");

    const fallback = document.createElement("span");
    fallback.className = "exograph-md-image__fallback";
    fallback.textContent = this.alt || "Image";
    wrap.appendChild(fallback);

    const appendImage = (url: string) => {
      const image = document.createElement("img");
      image.className = "exograph-md-image__asset";
      image.src = url;
      image.alt = this.alt;
      image.loading = "lazy";
      image.decoding = "async";
      image.addEventListener("load", () => {
        wrap.classList.remove("exograph-md-image--loading", "exograph-md-image--missing");
        fallback.remove();
      }, { once: true });
      image.addEventListener("error", () => {
        wrap.classList.remove("exograph-md-image--loading");
        wrap.classList.add("exograph-md-image--missing");
        image.remove();
      }, { once: true });
      wrap.appendChild(image);
    };

    const remoteUrl = remoteMarkdownImageUrl(this.target);
    if (remoteUrl) {
      appendImage(remoteUrl);
      return wrap;
    }

    void resolveMarkdownImageWithRetry(this.resolveImage, this.target, { lookupByFilename: this.lookupByFilename }).then(({ url }) => {
      appendImage(url);
    }).catch(() => {
      wrap.classList.remove("exograph-md-image--loading");
      wrap.classList.add("exograph-md-image--missing");
    });
    return wrap;
  }

  eq(other: MarkdownImageWidget) {
    return other.alt === this.alt && other.target === this.target;
  }

  ignoreEvent() {
    return false;
  }
}

/**
 * HTTP(S) images are public references in the Markdown document, so the
 * renderer loads them directly. Local paths still use the main-process
 * resolver, which enforces Note Root containment before returning a file URL.
 */
export function remoteMarkdownImageUrl(target: string): string | null {
  try {
    const url = new URL(target);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}
// A typographic zero-width anchor gives CodeMirror text-sized caret geometry
// even when the prefix is the only content on a newly created list line.
export class ListPrefixWidget extends WidgetType {
  toDOM() {
    const span = document.createElement("span");
    span.textContent = "\u200b";
    return span;
  }

  eq(other: WidgetType) {
    return other instanceof ListPrefixWidget;
  }
}

export class TaskPrefixWidget extends WidgetType {
  constructor(
    private readonly checked: boolean,
    private readonly depth: number,
    private readonly checkboxPos: number,
  ) {
    super();
  }

  toDOM() {
    const span = document.createElement("span");
    span.className = "exograph-md-list-prefix exograph-md-list-prefix--task";
    const bulletLeft = LIST_GEOMETRY.baseIndent + this.depth * LIST_GEOMETRY.indentStep - LIST_GEOMETRY.markerLaneWidth;
    span.style.left = `${bulletLeft}px`;
    const checkbox = document.createElement("span");
    checkbox.className = `exograph-md-checkbox ${this.checked ? "exograph-md-checkbox--checked" : ""}`;
    checkbox.dataset.exographCheckboxPos = String(this.checkboxPos);
    span.appendChild(checkbox);
    const anchor = document.createElement("span");
    anchor.textContent = "\u200b";
    anchor.appendChild(span);
    return anchor;
  }

  eq(other: TaskPrefixWidget) {
    return other.checked === this.checked && other.depth === this.depth && other.checkboxPos === this.checkboxPos;
  }

  ignoreEvent(event: Event) {
    return event.type !== "mousedown";
  }
}

export class FoldToggleWidget extends WidgetType {
  constructor(
    private readonly depth: number,
    private readonly isFolded: boolean,
    private readonly parentAnchor: number,
    private readonly placement: "list" | "outline",
    private readonly onToggle?: (view: EditorView, anchor: number) => void,
  ) {
    super();
  }

  toDOM(view: EditorView) {
    const span = document.createElement("span");
    span.className = this.placement === "list"
      ? "exograph-md-list-prefix exograph-md-list-prefix--fold"
      : "exograph-md-outline-fold";
    if (this.placement === "list") {
      const bulletLeft = LIST_GEOMETRY.baseIndent + this.depth * LIST_GEOMETRY.indentStep - LIST_GEOMETRY.markerLaneWidth;
      span.style.left = `${bulletLeft - 14}px`;
      span.style.width = "14px";
    }

    const fold = document.createElement("button");
    fold.type = "button";
    fold.className = `exograph-md-fold-toggle ${this.isFolded ? "exograph-md-fold-toggle--folded" : ""}`;
    fold.dataset.exographFoldAnchor = String(this.parentAnchor);
    fold.setAttribute("aria-expanded", String(!this.isFolded));
    fold.setAttribute("aria-label", this.isFolded ? "Expand section" : "Collapse section");
    fold.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      this.onToggle?.(view, this.parentAnchor);
      event.preventDefault();
      event.stopPropagation();
    });
    span.appendChild(fold);
    return span;
  }

  eq(other: FoldToggleWidget) {
    return other.depth === this.depth && other.isFolded === this.isFolded && other.parentAnchor === this.parentAnchor && other.placement === this.placement;
  }

  ignoreEvent(event: Event) {
    return event.type === "mousedown";
  }
}
export class TableWidget extends WidgetType {
  constructor(private readonly ctx: TableContext) {
    super();
  }

  toDOM() {
    const wrap = document.createElement("div");
    wrap.className = "exograph-md-table-wrap";

    const table = document.createElement("table");
    table.className = "exograph-md-table";

    const thead = document.createElement("thead");
    const headerRow = document.createElement("tr");
    this.ctx.headers.forEach((cell, idx) => {
      const th = document.createElement("th");
      appendTableCellContent(th, cell);
      const align = this.ctx.alignments[idx] ?? "left";
      th.style.textAlign = align;
      headerRow.appendChild(th);
    });
    thead.appendChild(headerRow);
    table.appendChild(thead);

    const tbody = document.createElement("tbody");
    for (const row of this.ctx.rows) {
      const tr = document.createElement("tr");
      row.forEach((cell, idx) => {
        const td = document.createElement("td");
        appendTableCellContent(td, cell);
        const align = this.ctx.alignments[idx] ?? "left";
        td.style.textAlign = align;
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);

    wrap.appendChild(table);
    return wrap;
  }

  eq(other: TableWidget) {
    if (other.ctx.headers.length !== this.ctx.headers.length) return false;
    if (other.ctx.rows.length !== this.ctx.rows.length) return false;
    if (other.ctx.headers.some((h, i) => h !== this.ctx.headers[i])) return false;
    if (other.ctx.alignments.some((a, i) => a !== this.ctx.alignments[i])) return false;
    for (let r = 0; r < this.ctx.rows.length; r += 1) {
      const a = this.ctx.rows[r];
      const b = other.ctx.rows[r];
      if (a.length !== b.length) return false;
      if (a.some((c, i) => c !== b[i])) return false;
    }
    return true;
  }

  ignoreEvent() {
    return false;
  }
}
