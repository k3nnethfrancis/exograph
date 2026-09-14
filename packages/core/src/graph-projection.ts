import { createHash } from "node:crypto";
import path from "node:path";

import type { ConceptNode, GraphFinding, KnowledgeGraphSnapshot, RelationEdge } from "./knowledge-graph";

export const GRAPH_LAYOUT_VERSION = "finite-force-0.1" as const;
export const GRAPH_TOPOLOGY_VERSION = "0.1" as const;
export const GRAPH_CONCEPT_SUMMARY_MAX_ITEMS = 64;
export const GRAPH_CONCEPT_SUMMARY_MAX_BYTES = 64 * 1024;
export const GRAPH_CONCEPT_DETAIL_MAX_BYTES = 256 * 1024;
export const GRAPH_CONCEPT_DETAIL_MAX_PROPERTIES = 64;
export const GRAPH_CONCEPT_DETAIL_MAX_RELATIONS = 128;
export const GRAPH_CONCEPT_DETAIL_MAX_FINDINGS = 64;
export const GRAPH_CONCEPT_DETAIL_MAX_EVIDENCE = 256;

/** Numeric projection-local classes. They are pixels/layout input, not ontology. */
export const GraphNodeVisualClass = {
  concept: 0,
  unresolved: 1,
  external: 2,
} as const;

/** Core resolves Relation meaning before the renderer receives this class. */
export const GraphEdgeVisualClass = {
  document: 0,
  ontology: 1,
  inferred: 2,
  unresolved: 3,
  ambiguous: 4,
  external: 5,
} as const;

export interface GraphTopologyNodeArrays {
  /** Interleaved low/high words of the stable 64-bit Concept identity key. */
  identityKeys: Uint32Array;
  /** Stable per-Concept input for deterministic layout seeding. */
  seeds: Uint32Array;
  /** Stable projection-local grouping input. Equal values share a group. */
  groups: Uint32Array;
  degrees: Uint32Array;
  visualClasses: Uint8Array;
}

export interface GraphTopologyEdgeArrays {
  /** Interleaved source/target node indices. */
  endpoints: Uint32Array;
  visualClasses: Uint8Array;
}

export interface GraphTopology {
  version: typeof GRAPH_TOPOLOGY_VERSION;
  layoutVersion: typeof GRAPH_LAYOUT_VERSION;
  sourceSnapshotId: string;
  formatHash: string;
  topologyHash: string;
  transportHash: string;
  layoutEpochId: string;
  seed: number;
  nodeCount: number;
  edgeCount: number;
  nodes: GraphTopologyNodeArrays;
  edges: GraphTopologyEdgeArrays;
  omitted: { tagConcepts: number; tagRelations: number };
  /** Exact contract bytes: UTF-8 metadata plus typed-buffer byte lengths. */
  payloadBytes: number;
}

export interface GraphTopologyCompilation {
  topology: GraphTopology;
  /** Cold server-side identity index. Never transport this with topology. */
  conceptIds: readonly string[];
  /** Cold server-side reverse indexes. Never transport these with topology. */
  conceptIndexById: ReadonlyMap<string, number>;
  conceptIndexByFilePath: ReadonlyMap<string, number>;
}

export interface GraphConceptSummary {
  index: number;
  label: string;
  filePath?: string;
  relativePath?: string;
}

export type GraphConceptLookupReference =
  | { conceptId: string; filePath?: never }
  | { filePath: string; conceptId?: never };

export interface GraphConceptLookupResult {
  status: "ok" | "stale" | "missing";
  sourceSnapshotId: string;
  summary?: GraphConceptSummary;
  payloadBytes: number;
}

export type GraphDetailReadStatus = "ok" | "stale" | "missing" | "too-large";

export interface GraphConceptSummaryResult {
  status: GraphDetailReadStatus;
  sourceSnapshotId: string;
  summaries: readonly GraphConceptSummary[];
  payloadBytes: number;
}

export interface GraphConceptRelationDetail {
  direction: "incoming" | "outgoing";
  relation: RelationEdge;
}

export interface BoundedGraphConceptDetail {
  concept: Omit<ConceptNode, "properties">;
  properties: readonly Readonly<{ key: string; value: ConceptNode["properties"][string] }>[];
  relations: readonly GraphConceptRelationDetail[];
  findings: readonly GraphFinding[];
  format: KnowledgeGraphSnapshot["activeFormat"];
  ontology: KnowledgeGraphSnapshot["activeOntology"];
  omitted: {
    properties: number;
    relations: number;
    findings: number;
    evidence: number;
  };
}

export interface GraphConceptDetailByIndexResult {
  status: GraphDetailReadStatus;
  sourceSnapshotId: string;
  index: number;
  detail?: BoundedGraphConceptDetail;
  payloadBytes: number;
}

/**
 * Compiles semantic graph facts into a string-free hot topology. Cold labels,
 * paths, Properties, Findings, and Evidence stay behind epoch-qualified reads.
 */
export function compileGraphTopology(snapshot: KnowledgeGraphSnapshot): GraphTopologyCompilation {
  const tagConceptIds = new Set(snapshot.concepts.filter((concept) => concept.id.startsWith("tag:")).map((concept) => concept.id));
  const concepts = snapshot.concepts
    .filter((concept) => !tagConceptIds.has(concept.id))
    .sort((left, right) => left.id.localeCompare(right.id));
  const indexById = new Map(concepts.map((concept, index) => [concept.id, index]));
  const visibleRelations = snapshot.relations
    .filter((relation) => relation.family !== "tag-membership" && !tagConceptIds.has(relation.source) && !tagConceptIds.has(relation.target))
    .sort((left, right) => left.id.localeCompare(right.id));
  const seed = projectionSeed(snapshot);
  const identityKeys = new Uint32Array(concepts.length * 2);
  const nodeSeeds = new Uint32Array(concepts.length);
  const groups = new Uint32Array(concepts.length);
  const degrees = new Uint32Array(concepts.length);
  const nodeVisualClasses = new Uint8Array(concepts.length);
  const endpoints = new Uint32Array(visibleRelations.length * 2);
  const edgeVisualClasses = new Uint8Array(visibleRelations.length);
  let edgeCount = 0;

  concepts.forEach((concept, index) => {
    const group = concept.conceptTypes[0]
      ?? graphGeography(concept.relativePath)
      ?? concept.tags[0]
      ?? concept.rootId
      ?? "notes";
    const identityKey = stableIdentityKey(concept.id);
    identityKeys[index * 2] = identityKey[0];
    identityKeys[index * 2 + 1] = identityKey[1];
    nodeSeeds[index] = hash32(`${seed}:${concept.id}`);
    groups[index] = hash32(group);
    nodeVisualClasses[index] = nodeVisualClass(concept);
  });

  for (const relation of visibleRelations) {
    const source = indexById.get(relation.source);
    const target = indexById.get(relation.target);
    if (source === undefined || target === undefined || source === target) continue;
    endpoints[edgeCount * 2] = source;
    endpoints[edgeCount * 2 + 1] = target;
    edgeVisualClasses[edgeCount] = edgeVisualClass(relation);
    degrees[source] += 1;
    degrees[target] += 1;
    edgeCount += 1;
  }

  const topology = createGraphTopology({
    sourceSnapshotId: snapshot.snapshotId,
    activeFormat: snapshot.activeFormat,
    activeOntology: snapshot.activeOntology,
    seed,
    nodes: { identityKeys, seeds: nodeSeeds, groups, degrees, visualClasses: nodeVisualClasses },
    edges: {
      endpoints: edgeCount === visibleRelations.length ? endpoints : endpoints.slice(0, edgeCount * 2),
      visualClasses: edgeCount === visibleRelations.length ? edgeVisualClasses : edgeVisualClasses.slice(0, edgeCount),
    },
    omitted: {
      tagConcepts: tagConceptIds.size,
      tagRelations: snapshot.relations.length - visibleRelations.length,
    },
  });
  const conceptIds = concepts.map((concept) => concept.id);
  const conceptIndexByFilePath = new Map<string, number>();
  concepts.forEach((concept, index) => {
    if (concept.filePath) conceptIndexByFilePath.set(normalizeGraphConceptFilePath(concept.filePath), index);
  });
  return {
    topology,
    conceptIds,
    conceptIndexById: new Map(conceptIds.map((conceptId, index) => [conceptId, index])),
    conceptIndexByFilePath,
  };
}

/** Canonical logical path key used by the cold topology indexes. */
export function normalizeGraphConceptFilePath(filePath: string): string {
  return path.normalize(path.resolve(filePath));
}

export function createGraphTopology(input: {
  sourceSnapshotId: string;
  activeFormat: KnowledgeGraphSnapshot["activeFormat"];
  activeOntology: KnowledgeGraphSnapshot["activeOntology"];
  seed: number;
  nodes: GraphTopologyNodeArrays;
  edges: GraphTopologyEdgeArrays;
  omitted?: { tagConcepts: number; tagRelations: number };
}): GraphTopology {
  validateTopologyArrays(input.nodes, input.edges);
  const formatHash = digest("graph-format", {
    id: input.activeFormat.id,
    version: input.activeFormat.version,
    source: input.activeFormat.source,
    state: input.activeFormat.state,
    ontology: input.activeOntology,
  });
  const topologyHash = digestTopology("graph-topology", {
    version: GRAPH_TOPOLOGY_VERSION,
    formatHash,
    nodes: input.nodes,
    edges: input.edges,
  });
  const layoutEpochId = digest("graph-layout", {
    layoutVersion: GRAPH_LAYOUT_VERSION,
    topologyHash,
    seed: input.seed >>> 0,
  });
  const transportHash = digestTopology("graph-transport", {
    version: GRAPH_TOPOLOGY_VERSION,
    sourceSnapshotId: input.sourceSnapshotId,
    formatHash,
    topologyHash,
    layoutEpochId,
    seed: input.seed >>> 0,
    nodes: input.nodes,
    edges: input.edges,
  });
  const topology: GraphTopology = {
    version: GRAPH_TOPOLOGY_VERSION,
    layoutVersion: GRAPH_LAYOUT_VERSION,
    sourceSnapshotId: input.sourceSnapshotId,
    formatHash,
    topologyHash,
    transportHash,
    layoutEpochId,
    seed: input.seed >>> 0,
    nodeCount: input.nodes.seeds.length,
    edgeCount: input.edges.visualClasses.length,
    nodes: input.nodes,
    edges: input.edges,
    omitted: input.omitted ?? { tagConcepts: 0, tagRelations: 0 },
    payloadBytes: 0,
  };
  topology.payloadBytes = graphTopologyPayloadBytes(topology);
  return topology;
}

export function graphTopologyPayloadBytes(topology: GraphTopology): number {
  const metadata = {
    ...topology,
    nodes: { identityKeys: null, seeds: null, groups: null, degrees: null, visualClasses: null },
    edges: { endpoints: null, visualClasses: null },
    payloadBytes: 0,
  };
  const arrayBytes = topology.nodes.identityKeys.byteLength
    + topology.nodes.seeds.byteLength
    + topology.nodes.groups.byteLength
    + topology.nodes.degrees.byteLength
    + topology.nodes.visualClasses.byteLength
    + topology.edges.endpoints.byteLength
    + topology.edges.visualClasses.byteLength;
  let payloadBytes = arrayBytes + Buffer.byteLength(JSON.stringify(metadata), "utf8");
  // Account for the decimal payloadBytes value in its own metadata field.
  for (let iteration = 0; iteration < 3; iteration += 1) {
    metadata.payloadBytes = payloadBytes;
    const next = arrayBytes + Buffer.byteLength(JSON.stringify(metadata), "utf8");
    if (next === payloadBytes) break;
    payloadBytes = next;
  }
  return payloadBytes;
}

function graphGeography(relativePath?: string): string | undefined {
  if (!relativePath) return undefined;
  const normalized = relativePath.replaceAll("\\", "/");
  const separator = normalized.indexOf("/");
  return separator > 0 ? normalized.slice(0, separator) : "root";
}

function projectionSeed(snapshot: KnowledgeGraphSnapshot): number {
  // Content edits must not reseed the whole scene. The layout seed describes
  // the stable workspace/Format/view algorithm, not one generated snapshot.
  const identity = JSON.stringify({
    version: GRAPH_TOPOLOGY_VERSION,
    layoutVersion: GRAPH_LAYOUT_VERSION,
    roots: [...snapshot.scope.noteRootIds].sort(),
    format: snapshot.activeFormat.id,
    formatVersion: snapshot.activeFormat.version,
    ontology: snapshot.activeOntology,
  });
  return createHash("sha256").update(identity).digest().readUInt32LE(0);
}

function nodeVisualClass(concept: ConceptNode): number {
  if (concept.resolution === "external") return GraphNodeVisualClass.external;
  if (concept.resolution === "unresolved" || concept.resolution === "ambiguous") return GraphNodeVisualClass.unresolved;
  return GraphNodeVisualClass.concept;
}

function edgeVisualClass(relation: RelationEdge): number {
  if (relation.resolution === "external") return GraphEdgeVisualClass.external;
  if (relation.resolution === "ambiguous") return GraphEdgeVisualClass.ambiguous;
  if (relation.resolution === "unresolved") return GraphEdgeVisualClass.unresolved;
  if (relation.origin === "inferred") return GraphEdgeVisualClass.inferred;
  if (relation.origin === "ontology") return GraphEdgeVisualClass.ontology;
  return GraphEdgeVisualClass.document;
}

function validateTopologyArrays(nodes: GraphTopologyNodeArrays, edges: GraphTopologyEdgeArrays): void {
  const nodeCount = nodes.seeds.length;
  if (nodes.identityKeys.length !== nodeCount * 2) {
    throw new Error("Graph topology identity keys must contain one low/high word pair per node.");
  }
  if (nodes.groups.length !== nodeCount || nodes.degrees.length !== nodeCount || nodes.visualClasses.length !== nodeCount) {
    throw new Error("Graph topology node arrays must have equal lengths.");
  }
  if (edges.endpoints.length !== edges.visualClasses.length * 2) {
    throw new Error("Graph topology endpoints must contain one source/target pair per edge.");
  }
  const arrays = [
    nodes.identityKeys,
    nodes.seeds,
    nodes.groups,
    nodes.degrees,
    nodes.visualClasses,
    edges.endpoints,
    edges.visualClasses,
  ];
  for (const values of arrays) {
    if (!(values.buffer instanceof ArrayBuffer) || values.byteOffset !== 0 || values.buffer.byteLength !== values.byteLength) {
      throw new Error("Graph topology arrays must own exact ArrayBuffer storage for bounded transport measurement.");
    }
  }
  if (new Set(arrays.map((values) => values.buffer)).size !== arrays.length) {
    throw new Error("Graph topology arrays must not share backing buffers.");
  }
  for (const endpoint of edges.endpoints) {
    if (endpoint >= nodeCount) throw new Error("Graph topology endpoint is outside the node array.");
  }
}

function digest(prefix: string, value: unknown): string {
  return `${prefix}:${GRAPH_TOPOLOGY_VERSION}:${createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16)}`;
}

function digestTopology(prefix: string, value: Record<string, unknown> & {
  nodes: GraphTopologyNodeArrays;
  edges: GraphTopologyEdgeArrays;
}): string {
  const { nodes, edges, ...metadata } = value;
  const hash = createHash("sha256").update(JSON.stringify(metadata));
  updateUint32Array(hash, nodes.identityKeys);
  updateUint32Array(hash, nodes.seeds);
  updateUint32Array(hash, nodes.groups);
  updateUint32Array(hash, nodes.degrees);
  hash.update(nodes.visualClasses);
  updateUint32Array(hash, edges.endpoints);
  hash.update(edges.visualClasses);
  return `${prefix}:${GRAPH_TOPOLOGY_VERSION}:${hash.digest("hex").slice(0, 16)}`;
}

function updateUint32Array(hash: ReturnType<typeof createHash>, values: Uint32Array): void {
  const chunkSize = 16_384;
  const bytes = Buffer.allocUnsafe(Math.min(chunkSize, Math.max(1, values.length)) * 4);
  for (let offset = 0; offset < values.length; offset += chunkSize) {
    const count = Math.min(chunkSize, values.length - offset);
    for (let index = 0; index < count; index += 1) bytes.writeUInt32LE(values[offset + index] ?? 0, index * 4);
    hash.update(bytes.subarray(0, count * 4));
  }
}

function hash32(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function stableIdentityKey(value: string): readonly [number, number] {
  const bytes = createHash("sha256").update(value).digest();
  return [bytes.readUInt32LE(0), bytes.readUInt32LE(4)];
}
