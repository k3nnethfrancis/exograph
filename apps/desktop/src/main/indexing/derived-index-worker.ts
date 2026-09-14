import path from "node:path";

import {
  qmdSearchProvider,
  assertOntologyReviewGuard,
  assertWorkspaceOntologySelection,
  WorkspaceIndex,
  WorkspaceGraph,
  type WorkspaceModel,
} from "@exograph/core";

import type {
  DerivedIndexRequest,
  DerivedIndexResult,
  DerivedIndexResponse,
  DerivedIndexWorkerRequest,
} from "./derived-index-protocol";
import {
  derivedIndexResponseBytes,
  MAX_DERIVED_RESPONSE_BYTES,
} from "./derived-index-response";

const MAX_ERROR_CHARS = 8_192;
const cancelledRequests = new Set<number>();
const liveRequests = new Set<number>();
let operationQueue = Promise.resolve();
let workspaceGraph: WorkspaceGraph | null = null;
let workspaceGraphKey: string | null = null;

process.parentPort.on("message", (event) => {
  const message = event.data as DerivedIndexWorkerRequest;
  if (message?.operation === "cancel" && Number.isSafeInteger(message.id)) {
    if (liveRequests.has(message.id)) cancelledRequests.add(message.id);
    return;
  }
  if (!isRequest(message)) return;
  liveRequests.add(message.id);
  operationQueue = operationQueue.then(() => execute(message), () => execute(message));
});

async function execute(request: DerivedIndexRequest): Promise<void> {
  if (cancelledRequests.delete(request.id)) {
    liveRequests.delete(request.id);
    return;
  }
  try {
    const result = await run(request);
    if (cancelledRequests.delete(request.id)) return;
    postBounded({ id: request.id, ok: true, result });
  } catch (error) {
    if (cancelledRequests.delete(request.id)) return;
    postBounded({ id: request.id, ok: false, error: errorMessage(error) });
  } finally {
    liveRequests.delete(request.id);
  }
}

function run(request: DerivedIndexRequest): Promise<DerivedIndexResult> {
  const { model, runtimeRoot } = request.context;
  const index = new WorkspaceIndex({ context: { model, runtimeRoot } });
  switch (request.operation) {
    case "status":
      return index.status();
    case "search":
      return index.search(request.query, request.options);
    case "update":
      return qmdSearchProvider.update(model, runtimeRoot, { rootIds: request.rootIds });
    case "embed":
      return qmdSearchProvider.embed(model, runtimeRoot, request.options);
    case "sync":
      return index.rebuild();
    case "graph-traverse":
      return graphFor(model, runtimeRoot).traverse(request.request);
    case "graph-context":
      return graphFor(model, runtimeRoot).contextForNote(request.filePath);
    case "graph-topology":
      return graphFor(model, runtimeRoot).graphTopology();
    case "graph-concept-summaries":
      return graphFor(model, runtimeRoot).graphConceptSummaries(request.indexes, request.sourceSnapshotId);
    case "graph-concept-lookup":
      return graphFor(model, runtimeRoot).graphConceptLookup(request.reference, request.sourceSnapshotId);
    case "graph-concept-detail-by-index":
      return graphFor(model, runtimeRoot).graphConceptDetailByIndex(request.index, request.sourceSnapshotId);
    case "graph-refresh":
      return graphFor(model, runtimeRoot).refreshFile(request.filePath).then(() => null);
    case "graph-invalidate":
      graphFor(model, runtimeRoot).invalidate();
      return Promise.resolve(null);
    case "ontology-preview":
      return graphFor(model, runtimeRoot).previewOntology(request.sourcePath);
    case "ontology-keep":
      return graphFor(model, runtimeRoot).keepOntology(assertOntologyReviewGuard(request.guard));
    case "ontology-reject":
      return graphFor(model, runtimeRoot).rejectOntology(assertOntologyReviewGuard(request.guard));
  }
}

function graphFor(model: WorkspaceModel, runtimeRoot: string): WorkspaceGraph {
  const key = [path.resolve(model.workspaceRoot), path.resolve(runtimeRoot), ...model.noteRoots
    .map((root) => `${root.id}:${root.path}`)
    .sort()]
    .join("\n");
  if (!workspaceGraph || workspaceGraphKey !== key) {
    workspaceGraph = new WorkspaceGraph(model, { runtimeRoot });
    workspaceGraphKey = key;
  }
  return workspaceGraph;
}

function postBounded(response: DerivedIndexResponse): void {
  const size = derivedIndexResponseBytes(response);
  if (size > MAX_DERIVED_RESPONSE_BYTES) {
    process.parentPort.postMessage({
      id: response.id,
      ok: false,
      error: `Derived index response exceeded the ${MAX_DERIVED_RESPONSE_BYTES}-byte limit.`,
    } satisfies DerivedIndexResponse);
    return;
  }
  // Electron's utility-process ParentPort exposes structured clone but no
  // transfer-list parameter. Keeping cached buffers attached makes repeated
  // topology reads safe; the byte gate still measures the compact typed form.
  process.parentPort.postMessage(response);
}

function isRequest(value: unknown): value is DerivedIndexRequest {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<DerivedIndexRequest>;
  const common = Number.isSafeInteger(candidate.id)
    && ["graph-traverse", "status", "search", "update", "embed", "sync", "graph-context", "graph-topology", "graph-concept-summaries", "graph-concept-lookup", "graph-concept-detail-by-index", "graph-refresh", "graph-invalidate", "ontology-preview", "ontology-keep", "ontology-reject"].includes(String(candidate.operation))
    && Boolean(candidate.context?.model)
    && typeof candidate.context?.runtimeRoot === "string";
  if (!common) return false;
  if (candidate.operation !== "ontology-preview") return true;
  try {
    assertWorkspaceOntologySelection(candidate.sourcePath);
    return true;
  } catch {
    return false;
  }
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, MAX_ERROR_CHARS);
}
