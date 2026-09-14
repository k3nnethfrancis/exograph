import type { EditorState } from "@codemirror/state";
import type { WorkspaceGraphContext } from "@exograph/core";

import type { MarkdownGraphReferences } from "./components/markdownLivePreview";

export const WIKILINK_COMPLETION_LIMIT = 3;

export interface WikilinkSuggestion {
  label: string;
  target: string;
  detail?: string;
}

export interface WikilinkCompletionContext {
  from: number;
  to: number;
  query: string;
}

export interface RendererGraphLink {
  label: string;
  target: string;
  kind: "wikilink" | "markdownLink";
  resolution: WorkspaceGraphContext["outgoing"][number]["resolution"];
  nodeKind: "note" | "external" | "unresolved" | "artifact";
}

export interface RendererGraphBacklink {
  label: string;
  target: string;
}

export interface RendererGraphNeighborhood {
  focusPath: string;
  nodes: Array<{ id: string; label: string; kind: "note" | "external" | "unresolved"; target: string }>;
  edges: Array<{ id: string; label: string; source: string; target: string; kind: "wikilink" | "markdownLink" | "ontology" }>;
}

export interface RendererNoteGraphContext {
  note: WorkspaceGraphContext["note"];
  outgoingLinks: RendererGraphLink[];
  backlinks: RendererGraphBacklink[];
  tags: string[];
  properties: Record<string, unknown>;
  unresolvedLinks: RendererGraphLink[];
  externalLinks: RendererGraphLink[];
  artifactLinks: RendererGraphLink[];
  neighborhood: RendererGraphNeighborhood;
}

export function getWikilinkCompletionContext(state: EditorState, pos: number): WikilinkCompletionContext | null {
  const line = state.doc.lineAt(pos);
  const offset = pos - line.from;
  const open = line.text.lastIndexOf("[[", Math.max(0, offset - 1));
  if (open < 0) {
    return null;
  }
  if (offset < open + 2) {
    return null;
  }

  const close = line.text.indexOf("]]", open + 2);
  if (close !== -1 && offset > close) {
    return null;
  }

  const queryEnd = close === -1 ? offset : close;
  const query = line.text.slice(open + 2, queryEnd);
  if (!query.trim() || /[\[\]\n]/.test(query)) {
    return null;
  }

  return {
    from: line.from + open,
    to: line.from + (close === -1 ? offset : close + 2),
    query,
  };
}

export function wikilinkSuggestionEdit(
  active: WikilinkCompletionContext,
  suggestion: WikilinkSuggestion,
): { insert: string; selection: number } {
  // Keep the filesystem-relative target canonical while rendering the note's
  // human title in the document. A completion must never turn a readable
  // sentence into its on-disk path.
  const insert = suggestion.label === suggestion.target
    ? `[[${suggestion.target}]]`
    : `[[${suggestion.target}|${suggestion.label}]]`;
  return {
    insert,
    selection: active.from + insert.length,
  };
}

export function buildNoteGraphContext(
  graph: WorkspaceGraphContext | null,
): RendererNoteGraphContext | null {
  if (!graph) {
    return null;
  }
  const note = graph.note;
  const toLink = (link: WorkspaceGraphContext["outgoing"][number]): RendererGraphLink => ({
    label: link.label,
    target: link.target,
    kind: link.target.startsWith("http") ? "markdownLink" : "wikilink",
    resolution: link.resolution,
    nodeKind: link.note ? "note" : link.resolution === "external" ? "external" : link.resolution === "artifact" ? "artifact" : "unresolved",
  });
  const outgoingLinks = graph.outgoing.map(toLink);
  const backlinks = graph.backlinks.map((link) => ({ label: link.label, target: link.target }));
  const neighborhoodNodes = [graph.note, ...graph.neighborhood.filter((item) => item.id !== graph.note.id)].map((item) => ({ id: item.id, label: item.title, kind: "note" as const, target: item.filePath }));
  const edgeForLink = (link: WorkspaceGraphContext["outgoing"][number], index: number, source: string) => ({
    id: `${source}:${index}:${link.target}`,
    label: link.label,
    source,
    target: link.note?.id ?? `${link.resolution}:${link.target}`,
    kind: link.target.startsWith("http") ? "markdownLink" as const : "wikilink" as const,
  });
  const outgoingEdges = graph.outgoing
    .filter((link) => link.resolution !== "artifact")
    .map((link, index) => edgeForLink(link, index, note.id));
  const backlinkEdges = graph.backlinks.map((link, index) => ({
    id: `back:${index}:${link.source}`,
    label: link.label,
    source: link.source,
    target: note.id,
    kind: "wikilink" as const,
  }));
  const ontologyEdges = graph.neighborhoodRelations.map((relation, index) => ({
    id: `ontology:${index}:${relation.source}:${relation.target}:${relation.predicate}`,
    label: relation.label,
    source: relation.source,
    target: relation.target,
    kind: "ontology" as const,
  }));

  return {
    note,
    outgoingLinks,
    backlinks,
    tags: [...graph.note.tags].sort(),
    properties: graph.note.frontmatter,
    unresolvedLinks: outgoingLinks.filter((item) => item.resolution === "unresolved" || item.resolution === "ambiguous"),
    externalLinks: outgoingLinks.filter((item) => item.resolution === "external"),
    artifactLinks: outgoingLinks.filter((item) => item.resolution === "artifact"),
    neighborhood: {
      focusPath: note.filePath,
      nodes: neighborhoodNodes,
      edges: [...outgoingEdges, ...backlinkEdges, ...ontologyEdges],
    },
  };
}

export function buildGraphReferences(graphContext: RendererNoteGraphContext | null): MarkdownGraphReferences | null {
  if (!graphContext) {
    return null;
  }
  return {
    backlinks: uniqueGraphReferenceTargets(graphContext.backlinks),
    references: uniqueGraphReferenceTargets(graphContext.outgoingLinks
      .filter((item) => item.resolution !== "external" && item.resolution !== "artifact")
      .map((item) => ({ label: item.label, target: item.target }))),
  };
}

function uniqueGraphReferenceTargets<T extends { label: string; target: string }>(items: readonly T[]): MarkdownGraphReferences["references"] {
  // The editor footer is a navigation surface over connected Notes, not an
  // occurrence list. Preserve authored order and the first label for each
  // target; repeated mentions remain available in the graph's edge evidence.
  const seen = new Set<string>();
  const references: MarkdownGraphReferences["references"] = [];
  for (const item of items) {
    if (seen.has(item.target)) continue;
    seen.add(item.target);
    references.push({ label: item.label, target: item.target });
  }
  return references;
}

export function graphReferencesForMarkdownMode(
  useMarkdownEditing: boolean,
  rawMarkdownMode: boolean,
  graphContext: RendererNoteGraphContext | null,
): MarkdownGraphReferences | null {
  if (!useMarkdownEditing || rawMarkdownMode) {
    return null;
  }
  return buildGraphReferences(graphContext);
}

export function getPreviewTitle(filePath: string): string {
  const basename = filePath.split("/").pop() ?? filePath;
  return basename.replace(/\.[^.]+$/, "");
}

export function markdownPreviewExcerpt(markdownBody: string): string {
  const excerpt = markdownBody
    .replace(/^---[\s\S]*?---\s*/u, "")
    .replace(/```[\s\S]*?```/gu, " ")
    .replace(/`([^`]+)`/gu, "$1")
    .replace(/!\[([^\]]*)\]\([^)]+\)/gu, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/gu, "$1")
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/gu, "$2")
    .replace(/\[\[([^\]]+)\]\]/gu, "$1")
    .replace(/^#{1,6}\s+/gmu, "")
    .replace(/^[>\-*+\d.)\s]+/gmu, "")
    .replace(/[*_~>#]/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
  return excerpt.length > 180 ? `${excerpt.slice(0, 177).trimEnd()}...` : excerpt || "Empty note";
}
