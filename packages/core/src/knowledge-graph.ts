import { createHash } from "node:crypto";

import type { NoteRootFormatStatus } from "./note-root-format";

export const KNOWLEDGE_GRAPH_VERSION = "0.4" as const;

export type KnowledgeGraphVersion = typeof KNOWLEDGE_GRAPH_VERSION;
export type GraphPropertyValue = null | boolean | number | string | readonly GraphPropertyValue[] | GraphPropertyObject;
export interface GraphPropertyObject { readonly [key: string]: GraphPropertyValue }

export type ConceptResolution = "resolved" | "unresolved" | "ambiguous" | "external";
export type RelationOrigin = "document" | "ontology" | "inferred";
export type RelationResolution = "resolved" | "unresolved" | "ambiguous" | "external";
export type RelationFamily = "link" | "property-reference" | "tag-membership" | "hierarchy" | "semantic";
export type ArtifactKind = "source-file" | "attachment";

/**
 * A durable Markdown reference to something that is not an included Note.
 * Artifacts preserve the authored relationship without inventing a Concept,
 * making a code file searchable as a Note, or inflating graph topology.
 */
export interface ArtifactReference {
  id: string;
  source: string;
  target: string;
  label: string;
  kind: ArtifactKind;
  evidence: readonly RelationEvidence[];
}

export interface GraphProducer {
  id: string;
  version: string;
}

export interface GraphSourceRange {
  /** Body-relative UTF-16 code-unit offset, inclusive. */
  from: number;
  /** Body-relative UTF-16 code-unit offset, exclusive. */
  to: number;
}

export interface RelationEvidence {
  kind: "source-span" | "property" | "path" | "ontology-rule" | "model";
  noteId?: string;
  property?: string;
  sourceRange?: GraphSourceRange;
  producer?: GraphProducer;
  detail?: string;
}

export interface ConceptNode {
  id: string;
  noteId?: string;
  label: string;
  conceptTypes: readonly string[];
  properties: Readonly<Record<string, GraphPropertyValue>>;
  resolution: ConceptResolution;
  filePath?: string;
  rootId?: string;
  relativePath?: string;
  tags: readonly string[];
}

export interface RelationEdge {
  id: string;
  source: string;
  target: string;
  family: RelationFamily;
  predicate?: string;
  origin: RelationOrigin;
  resolution: RelationResolution;
  directed: boolean;
  confidence?: number;
  evidence: readonly RelationEvidence[];
  label?: string;
}

export interface KnowledgeGraphScope {
  workspaceRoot?: string;
  noteRootIds: readonly string[];
  paths: readonly string[];
}

export interface KnowledgeGraphSnapshot {
  version: KnowledgeGraphVersion;
  snapshotId: string;
  generatedAt: string;
  scope: KnowledgeGraphScope;
  concepts: readonly ConceptNode[];
  relations: readonly RelationEdge[];
  artifactReferences: readonly ArtifactReference[];
  findings: readonly GraphFinding[];
  activeFormat: NoteRootFormatStatus;
  activeOntology: ActiveOntologyStatus;
}

export interface ActiveOntologyStatus {
  state: "generic" | "active" | "invalid-state";
  id?: string;
  version?: string;
  revision?: string;
}

export interface GraphFinding {
  id: string;
  severity: "info" | "warning" | "error";
  code: string;
  message: string;
  conceptIds: readonly string[];
  relationIds: readonly string[];
  evidence: readonly RelationEvidence[];
}

export function graphPropertyRecord(value: Record<string, unknown>): Record<string, GraphPropertyValue> {
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, graphPropertyValue(item)]),
  );
}

export function graphPropertyValue(value: unknown): GraphPropertyValue {
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") {
    return value;
  }
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(graphPropertyValue);
  if (value && typeof value === "object") return graphPropertyRecord(value as Record<string, unknown>);
  // YAML cannot faithfully express undefined, bigint, symbols, or functions.
  // Preserve their visible value rather than silently deleting the property.
  return String(value);
}

export function knowledgeGraphSnapshotId(
  scope: KnowledgeGraphScope,
  concepts: readonly ConceptNode[],
  relations: readonly RelationEdge[],
  artifactReferences: readonly ArtifactReference[],
  findings: readonly GraphFinding[],
  format: NoteRootFormatStatus,
  ontology: ActiveOntologyStatus,
): string {
  const digest = createHash("sha256")
    .update(JSON.stringify({ version: KNOWLEDGE_GRAPH_VERSION, scope, concepts, relations, artifactReferences, findings, format, ontology }))
    .digest("hex")
    .slice(0, 16);
  return `knowledge-graph:${KNOWLEDGE_GRAPH_VERSION}:${digest}`;
}
