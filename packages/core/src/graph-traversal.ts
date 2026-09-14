import { createHash, randomUUID } from "node:crypto";
import type { ConceptNode, KnowledgeGraphSnapshot, RelationEdge, RelationEvidence } from "./knowledge-graph";

export interface GraphTraversalRequest {
  workspaceRoot: string;
  start?: string;
  startPath?: string;
  direction?: "outgoing" | "incoming" | "both";
  predicate?: string;
  maxDepth?: number;
  maxResults?: number;
  limit?: number;
  cursor?: string;
}
export interface GraphTraversalQuery {
  start: string;
  direction: "outgoing" | "incoming" | "both";
  predicate?: string;
  maxDepth: number;
  maxResults: number;
  limit: number;
}
export type GraphTraversalEvent =
  | { type: "visit"; seq: number; nodeId: string; depth: number; fromNodeId?: string; viaEdgeId?: string }
  | { type: "follow"; seq: number; fromNodeId: string; nodeId: string; edgeId: string; depth: number; direction: "outgoing" | "incoming" };
export interface GraphTraversalEvidence {
  /** Snapshot-scoped occurrence handle; not a new durable graph identity. */
  id: string;
  edgeId: string;
  index: number;
  noteId?: string;
  rootId?: string;
  relativePath?: string;
  evidence: RelationEvidence;
}
interface GraphTraversalEnvelope {
  schemaVersion: "exograph.graph-traversal.v1";
  workspace: { root: string; noteRootIds: readonly string[] };
  snapshotId: string;
}
export type GraphTraversalResult = GraphTraversalEnvelope & (
  | { status: "error"; code: "scope-mismatch" | "stale-cursor" | "invalid-cursor" | "missing-start" | "invalid-graph" | "too-large"; message: string }
  | {
      status: "ok";
      request: GraphTraversalQuery;
      nodes: readonly ConceptNode[];
      edges: readonly RelationEdge[];
      evidence: readonly GraphTraversalEvidence[];
      traversalId: string;
      /** Every actual visit/follow in this invocation, including pagination replay. */
      events: readonly GraphTraversalEvent[];
      execution: { kind: "deterministic-replay"; visitedCount: number; returnedOffset: number };
      nextCursor: string | null;
      completion: { reason: "page-limit" | "max-results" | "edge-limit" | "complete-within-depth"; truncated: boolean };
    }
);
const MAX_BYTES = 1_048_576;
const allowedKeys = new Set(["workspaceRoot", "start", "startPath", "direction", "predicate", "maxDepth", "maxResults", "limit", "cursor"]);

/** Strict shared CLI/HTTP input boundary. No unknown flags or silent clamping. */
export function parseGraphTraversalRequest(value: unknown): GraphTraversalRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Traversal request must be an object.");
  const input = value as Record<string, unknown>;
  for (const key of Object.keys(input)) if (!allowedKeys.has(key)) throw new Error(`Unknown traversal field: ${key}`);
  for (const key of ["workspaceRoot", ...(input.start !== undefined ? ["start"] : ["startPath"])] as const) {
    if (typeof input[key] !== "string" || !input[key] || input[key].length > 4096) throw new Error(`Traversal ${key} is required (maximum 4096 characters).`);
  }
  if ((input.start === undefined) === (input.startPath === undefined)) throw new Error("Specify exactly one traversal start or startPath.");
  if (input.direction !== undefined && !["outgoing", "incoming", "both"].includes(input.direction as string)) throw new Error("Invalid traversal direction.");
  for (const [key, min, max] of [["maxDepth", 1, 3], ["maxResults", 1, 100], ["limit", 1, 100]] as const) {
    if (input[key] !== undefined && (!Number.isSafeInteger(input[key]) || (input[key] as number) < min || (input[key] as number) > max)) throw new Error(`Traversal ${key} must be an integer from ${min} through ${max}.`);
  }
  if (input.predicate !== undefined && (typeof input.predicate !== "string" || !input.predicate || input.predicate.length > 256)) throw new Error("Invalid traversal predicate.");
  if (input.cursor !== undefined && (typeof input.cursor !== "string" || !input.cursor || input.cursor.length > 2048)) throw new Error("Invalid traversal cursor.");
  return input as unknown as GraphTraversalRequest;
}

/** Bounded discovery-tree BFS over the canonical graph. Never guesses a target,
 * reverses a canonical edge, invents evidence, or retains hidden query sessions. */
export function traverseKnowledgeGraph(snapshot: KnowledgeGraphSnapshot, input: GraphTraversalRequest): GraphTraversalResult {
  const request = parseGraphTraversalRequest(input);
  const envelope: GraphTraversalEnvelope = { schemaVersion: "exograph.graph-traversal.v1", workspace: { root: snapshot.scope.workspaceRoot ?? "", noteRootIds: snapshot.scope.noteRootIds }, snapshotId: snapshot.snapshotId };
  const fail = (code: Extract<GraphTraversalResult, { status: "error" }>["code"], message: string): GraphTraversalResult => ({ ...envelope, status: "error", code, message });
  if (request.workspaceRoot !== snapshot.scope.workspaceRoot) return fail("scope-mismatch", "Traversal Workspace does not match this graph snapshot.");
  const start = request.start ?? snapshot.concepts.find((node) => node.filePath === request.startPath)?.id;
  if (!start) return fail("missing-start", "Traversal start path is not a Note in this Workspace snapshot.");
  const query: GraphTraversalQuery = { start, direction: request.direction ?? "both", ...(request.predicate === undefined ? {} : { predicate: request.predicate }), maxDepth: request.maxDepth ?? 1, maxResults: request.maxResults ?? 100, limit: request.limit ?? 25 };
  const queryHash = createHash("sha256").update(JSON.stringify({ workspace: envelope.workspace, query })).digest("hex");
  let offset = 0;
  if (request.cursor) {
    let cursor: Record<string, unknown>;
    try { cursor = JSON.parse(Buffer.from(request.cursor, "base64url").toString("utf8")); }
    catch { return fail("invalid-cursor", "Traversal cursor cannot be decoded."); }
    if (!cursor || typeof cursor !== "object" || Object.keys(cursor).sort().join(",") !== "offset,queryHash,snapshotId,v" || cursor.v !== 1 || cursor.queryHash !== queryHash || !Number.isSafeInteger(cursor.offset) || (cursor.offset as number) <= 0 || (cursor.offset as number) >= query.maxResults || (cursor.offset as number) % query.limit !== 0) return fail("invalid-cursor", "Traversal cursor does not match this Workspace and request.");
    if (cursor.snapshotId !== snapshot.snapshotId) return fail("stale-cursor", "Graph snapshot changed; restart traversal without the cursor.");
    offset = cursor.offset as number;
  }
  const nodes = new Map(snapshot.concepts.map((node) => [node.id, node]));
  if (nodes.size !== snapshot.concepts.length || new Set(snapshot.relations.map((edge) => edge.id)).size !== snapshot.relations.length) return fail("invalid-graph", "Graph identities are not unique.");
  if (nodes.get(query.start)?.resolution !== "resolved") return fail("missing-start", "Traversal start must identify a resolved Concept in this Workspace.");
  type Step = { nodeId: string; edge: RelationEdge; direction: "incoming" | "outgoing" };
  const adjacency = new Map<string, Step[]>();
  const add = (from: string, step: Step) => { const list = adjacency.get(from) ?? []; list.push(step); adjacency.set(from, list); };
  for (const edge of snapshot.relations) {
    if (edge.resolution !== "resolved" || nodes.get(edge.source)?.resolution !== "resolved" || nodes.get(edge.target)?.resolution !== "resolved" || (query.predicate !== undefined && edge.predicate !== query.predicate)) continue;
    if (query.direction !== "incoming" || !edge.directed) add(edge.source, { nodeId: edge.target, edge, direction: "outgoing" });
    if (query.direction !== "outgoing" || !edge.directed) add(edge.target, { nodeId: edge.source, edge, direction: "incoming" });
  }
  const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
  for (const steps of adjacency.values()) steps.sort((a, b) => compare(a.edge.id, b.edge.id) || compare(a.nodeId, b.nodeId) || compare(a.direction, b.direction));
  const visits: Array<{ nodeId: string; depth: number; fromNodeId?: string; edge?: RelationEdge }> = [{ nodeId: query.start, depth: 0 }];
  const seen = new Set([query.start]);
  const events: GraphTraversalEvent[] = [{ type: "visit", seq: 0, nodeId: query.start, depth: 0 }];
  let capped: "max-results" | "edge-limit" | null = null;
  const followedEdges = new Map<string, RelationEdge>();
  let follows = 0;
  outer: for (let index = 0; index < visits.length; index += 1) {
    const visit = visits[index];
    if (visit.depth === query.maxDepth) continue;
    for (const step of adjacency.get(visit.nodeId) ?? []) {
      const discovered = !seen.has(step.nodeId);
      if (discovered && visits.length === query.maxResults) { capped = "max-results"; break outer; }
      if (follows === 1000) { capped = "edge-limit"; break outer; }
      follows += 1;
      followedEdges.set(step.edge.id, step.edge);
      const depth = visit.depth + 1;
      events.push({ type: "follow", seq: events.length, fromNodeId: visit.nodeId, nodeId: step.nodeId, edgeId: step.edge.id, depth, direction: step.direction });
      if (!discovered) continue;
      seen.add(step.nodeId);
      events.push({ type: "visit", seq: events.length, fromNodeId: visit.nodeId, nodeId: step.nodeId, viaEdgeId: step.edge.id, depth });
      visits.push({ nodeId: step.nodeId, depth, fromNodeId: visit.nodeId, edge: step.edge });
    }
  }
  if (offset >= visits.length) return fail("invalid-cursor", "Traversal cursor is beyond the bounded result.");
  const page = visits.slice(offset, offset + query.limit);
  const edges = [...followedEdges.values()];
  const byNote = new Map(snapshot.concepts.flatMap((node) => node.noteId ? [[node.noteId, node] as const] : []));
  const evidence = edges.flatMap((edge) => edge.evidence.map((item, index) => {
    const note = item.noteId ? byNote.get(item.noteId) : undefined;
    return { id: `${snapshot.snapshotId}:${encodeURIComponent(edge.id)}:${index}`, edgeId: edge.id, index, ...(item.noteId ? { noteId: item.noteId } : {}), ...(note?.rootId ? { rootId: note.rootId } : {}), ...(note?.relativePath ? { relativePath: note.relativePath } : {}), evidence: item };
  }));
  const nextOffset = offset + page.length;
  const hasNext = nextOffset < visits.length;
  const result: GraphTraversalResult = { ...envelope, status: "ok", request: query, nodes: page.map((visit) => nodes.get(visit.nodeId)!), edges, evidence, traversalId: randomUUID(), events, execution: { kind: "deterministic-replay", visitedCount: visits.length, returnedOffset: offset }, nextCursor: hasNext ? Buffer.from(JSON.stringify({ v: 1, snapshotId: snapshot.snapshotId, queryHash, offset: nextOffset })).toString("base64url") : null, completion: { reason: hasNext ? "page-limit" : capped ?? "complete-within-depth", truncated: hasNext || capped !== null } };
  return Buffer.byteLength(JSON.stringify(result)) > MAX_BYTES ? fail("too-large", "Traversal response exceeds 1 MiB; lower maxResults/limit.") : result;
}
