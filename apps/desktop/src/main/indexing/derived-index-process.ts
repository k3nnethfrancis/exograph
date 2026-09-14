import type { GraphTraversalRequest, GraphTraversalResult } from "@exograph/core";
import { utilityProcess, type UtilityProcess } from "electron";
import { fileURLToPath } from "node:url";

import type {
  IndexSearchOptions,
  IndexStatus,
  IndexSyncResult,
  GraphConceptDetailByIndexResult,
  GraphConceptLookupReference,
  GraphConceptLookupResult,
  GraphConceptSummaryResult,
  GraphTopology,
  OntologyKeepResult,
  OntologyRejectResult,
  OntologyReviewGuard,
  OntologyReviewState,
  WorkspaceGraphContext,
  WorkspaceIndexSearchResponse,
  WorkspaceModel,
} from "@exograph/core";

import {
  isDerivedIndexResponse,
  type DerivedIndexEmbedOptions,
  type DerivedIndexRequest,
  type DerivedIndexRequestInput,
} from "./derived-index-protocol";

export interface DerivedIndexClient {
  graphTraverse(model: WorkspaceModel, runtimeRoot: string, request: GraphTraversalRequest, signal?: AbortSignal): Promise<GraphTraversalResult>;
  status(model: WorkspaceModel, runtimeRoot: string, signal?: AbortSignal): Promise<IndexStatus>;
  search(
    model: WorkspaceModel,
    runtimeRoot: string,
    query: string,
    options?: IndexSearchOptions,
    signal?: AbortSignal,
  ): Promise<WorkspaceIndexSearchResponse>;
  update(model: WorkspaceModel, runtimeRoot: string, rootIds?: string[], signal?: AbortSignal): Promise<IndexStatus>;
  embed(
    model: WorkspaceModel,
    runtimeRoot: string,
    options?: DerivedIndexEmbedOptions,
    signal?: AbortSignal,
  ): Promise<IndexStatus>;
  sync(model: WorkspaceModel, runtimeRoot: string, signal?: AbortSignal): Promise<IndexSyncResult>;
  graphContext(model: WorkspaceModel, runtimeRoot: string, filePath: string, signal?: AbortSignal): Promise<WorkspaceGraphContext | null>;
  graphTopology(model: WorkspaceModel, runtimeRoot: string, signal?: AbortSignal): Promise<GraphTopology>;
  graphConceptSummaries(model: WorkspaceModel, runtimeRoot: string, indexes: number[], sourceSnapshotId: string, signal?: AbortSignal): Promise<GraphConceptSummaryResult>;
  graphConceptLookup(model: WorkspaceModel, runtimeRoot: string, reference: GraphConceptLookupReference, sourceSnapshotId: string, signal?: AbortSignal): Promise<GraphConceptLookupResult>;
  graphConceptDetailByIndex(model: WorkspaceModel, runtimeRoot: string, index: number, sourceSnapshotId: string, signal?: AbortSignal): Promise<GraphConceptDetailByIndexResult>;
  graphRefresh(model: WorkspaceModel, runtimeRoot: string, filePath: string, signal?: AbortSignal): Promise<void>;
  graphInvalidate(model: WorkspaceModel, runtimeRoot: string, signal?: AbortSignal): Promise<void>;
  ontologyPreview(
    model: WorkspaceModel,
    runtimeRoot: string,
    sourcePath?: string | null,
    signal?: AbortSignal,
  ): Promise<OntologyReviewState>;
  ontologyKeep(model: WorkspaceModel, runtimeRoot: string, guard: OntologyReviewGuard, signal?: AbortSignal): Promise<OntologyKeepResult>;
  ontologyReject(model: WorkspaceModel, runtimeRoot: string, guard: OntologyReviewGuard, signal?: AbortSignal): Promise<OntologyRejectResult>;
  dispose(): void;
}

export interface DerivedIndexProcessHandle {
  on(event: "message", listener: (message: unknown) => void): this;
  on(event: "exit", listener: (code: number) => void): this;
  postMessage(message: unknown): void;
  kill(): boolean;
}

export interface DerivedIndexProcessOptions {
  requestTimeoutMs?: number;
  workerPath?: string;
  spawn?: (workerPath: string) => DerivedIndexProcessHandle;
}

interface PendingRequest {
  operation: DerivedIndexRequest["operation"];
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
  signal?: AbortSignal;
  onAbort?: () => void;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 5 * 60_000;

/** Keeps QMD and fallback filesystem scans outside Electron's main event loop. */
export class UtilityDerivedIndexClient implements DerivedIndexClient {
  private readonly requestTimeoutMs: number;
  private readonly workerPath: string;
  private readonly spawnProcess: (workerPath: string) => DerivedIndexProcessHandle;
  private worker: DerivedIndexProcessHandle | null = null;
  private requestSequence = 0;
  private readonly pending = new Map<number, PendingRequest>();
  private disposed = false;

  constructor(options: DerivedIndexProcessOptions = {}) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.workerPath = options.workerPath ?? fileURLToPath(new URL("./derived-index-worker.js", import.meta.url));
    this.spawnProcess = options.spawn ?? ((workerPath) => utilityProcess.fork(workerPath, [], {
      serviceName: "Exograph Derived Index",
      stdio: "ignore",
    }) as UtilityProcess);
  }

  status(model: WorkspaceModel, runtimeRoot: string, signal?: AbortSignal): Promise<IndexStatus> {
    return this.request({ operation: "status", context: { model, runtimeRoot } }, signal);
  }

  search(
    model: WorkspaceModel,
    runtimeRoot: string,
    query: string,
    options: IndexSearchOptions = {},
    signal?: AbortSignal,
  ): Promise<WorkspaceIndexSearchResponse> {
    return this.request({ operation: "search", context: { model, runtimeRoot }, query, options }, signal);
  }

  update(model: WorkspaceModel, runtimeRoot: string, rootIds?: string[], signal?: AbortSignal): Promise<IndexStatus> {
    return this.request({ operation: "update", context: { model, runtimeRoot }, rootIds }, signal);
  }

  embed(
    model: WorkspaceModel,
    runtimeRoot: string,
    options?: DerivedIndexEmbedOptions,
    signal?: AbortSignal,
  ): Promise<IndexStatus> {
    return this.request({ operation: "embed", context: { model, runtimeRoot }, options }, signal);
  }

  sync(model: WorkspaceModel, runtimeRoot: string, signal?: AbortSignal): Promise<IndexSyncResult> {
    return this.request({ operation: "sync", context: { model, runtimeRoot } }, signal);
  }

  graphTraverse(model: WorkspaceModel, runtimeRoot: string, request: GraphTraversalRequest, signal?: AbortSignal): Promise<GraphTraversalResult> {
    return this.request({ operation: "graph-traverse", context: { model, runtimeRoot }, request }, signal);
  }

  graphContext(
    model: WorkspaceModel,
    runtimeRoot: string,
    filePath: string,
    signal?: AbortSignal,
  ): Promise<WorkspaceGraphContext | null> {
    return this.request({ operation: "graph-context", context: { model, runtimeRoot }, filePath }, signal);
  }

  graphTopology(
    model: WorkspaceModel,
    runtimeRoot: string,
    signal?: AbortSignal,
  ): Promise<GraphTopology> {
    return this.request({ operation: "graph-topology", context: { model, runtimeRoot } }, signal);
  }

  graphConceptSummaries(
    model: WorkspaceModel,
    runtimeRoot: string,
    indexes: number[],
    sourceSnapshotId: string,
    signal?: AbortSignal,
  ): Promise<GraphConceptSummaryResult> {
    return this.request({ operation: "graph-concept-summaries", context: { model, runtimeRoot }, indexes, sourceSnapshotId }, signal);
  }

  graphConceptLookup(
    model: WorkspaceModel,
    runtimeRoot: string,
    reference: GraphConceptLookupReference,
    sourceSnapshotId: string,
    signal?: AbortSignal,
  ): Promise<GraphConceptLookupResult> {
    return this.request({ operation: "graph-concept-lookup", context: { model, runtimeRoot }, reference, sourceSnapshotId }, signal);
  }

  graphConceptDetailByIndex(
    model: WorkspaceModel,
    runtimeRoot: string,
    index: number,
    sourceSnapshotId: string,
    signal?: AbortSignal,
  ): Promise<GraphConceptDetailByIndexResult> {
    return this.request({ operation: "graph-concept-detail-by-index", context: { model, runtimeRoot }, index, sourceSnapshotId }, signal);
  }

  async graphRefresh(model: WorkspaceModel, runtimeRoot: string, filePath: string, signal?: AbortSignal): Promise<void> {
    await this.request({ operation: "graph-refresh", context: { model, runtimeRoot }, filePath }, signal);
  }

  async graphInvalidate(model: WorkspaceModel, runtimeRoot: string, signal?: AbortSignal): Promise<void> {
    await this.request({ operation: "graph-invalidate", context: { model, runtimeRoot } }, signal);
  }

  ontologyPreview(
    model: WorkspaceModel,
    runtimeRoot: string,
    sourcePath?: string | null,
    signal?: AbortSignal,
  ): Promise<OntologyReviewState> {
    return this.request({ operation: "ontology-preview", context: { model, runtimeRoot }, sourcePath }, signal);
  }

  ontologyKeep(
    model: WorkspaceModel,
    runtimeRoot: string,
    guard: OntologyReviewGuard,
    signal?: AbortSignal,
  ): Promise<OntologyKeepResult> {
    return this.request({ operation: "ontology-keep", context: { model, runtimeRoot }, guard }, signal);
  }

  ontologyReject(
    model: WorkspaceModel,
    runtimeRoot: string,
    guard: OntologyReviewGuard,
    signal?: AbortSignal,
  ): Promise<OntologyRejectResult> {
    return this.request({ operation: "ontology-reject", context: { model, runtimeRoot }, guard }, signal);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopWorker(new Error("Derived index worker was stopped."));
  }

  private request<Result>(
    input: DerivedIndexRequestInput,
    signal?: AbortSignal,
  ): Promise<Result> {
    if (this.disposed) {
      return Promise.reject(new Error("Derived index worker has been disposed."));
    }
    if (signal?.aborted) {
      return Promise.reject(abortError());
    }

    const id = ++this.requestSequence;
    const request = { ...input, id } as DerivedIndexRequest;
    let worker: DerivedIndexProcessHandle;
    try {
      worker = this.ensureWorker();
    } catch (error) {
      return Promise.reject(asError(error));
    }
    return new Promise<Result>((resolve, reject) => {
      const timeout = setTimeout(() => {
        const pending = this.takePending(id);
        if (!pending) return;
        const error = new Error(`Derived index ${request.operation} timed out after ${this.requestTimeoutMs} ms.`);
        pending.reject(error);
        // A timed-out native operation cannot be interrupted cooperatively, so
        // recycle the utility process before accepting more index work.
        this.stopWorker(error);
      }, this.requestTimeoutMs);
      const pending: PendingRequest = {
        operation: request.operation,
        resolve: resolve as (value: unknown) => void,
        reject,
        timeout,
        signal,
      };
      if (signal) {
        pending.onAbort = () => {
          const aborted = this.takePending(id);
          if (!aborted) return;
          aborted.reject(abortError());
          try {
            worker.postMessage({ id, operation: "cancel" });
          } catch {
            // The exit handler owns worker recovery if it died during cancellation.
          }
        };
        signal.addEventListener("abort", pending.onAbort, { once: true });
      }
      this.pending.set(id, pending);
      try {
        worker.postMessage(request);
      } catch (error) {
        this.takePending(id)?.reject(asError(error));
        this.stopWorker(asError(error));
      }
    });
  }

  private ensureWorker(): DerivedIndexProcessHandle {
    if (this.worker) return this.worker;
    const worker = this.spawnProcess(this.workerPath);
    this.worker = worker;
    worker.on("message", (message) => this.handleMessage(message));
    worker.on("exit", (code) => {
      if (this.worker !== worker) return;
      this.worker = null;
      this.rejectAll(new Error(`Derived index worker exited with code ${code}.`));
    });
    return worker;
  }

  private handleMessage(message: unknown): void {
    if (!isDerivedIndexResponse(message)) return;
    const pending = this.takePending(message.id);
    if (!pending) return;
    if (message.ok) {
      pending.resolve(message.result);
    } else {
      pending.reject(new Error(`Derived index ${pending.operation} failed: ${message.error}`));
    }
  }

  private takePending(id: number): PendingRequest | undefined {
    const pending = this.pending.get(id);
    if (!pending) return undefined;
    this.pending.delete(id);
    clearTimeout(pending.timeout);
    if (pending.signal && pending.onAbort) {
      pending.signal.removeEventListener("abort", pending.onAbort);
    }
    return pending;
  }

  private stopWorker(error: Error): void {
    const worker = this.worker;
    this.worker = null;
    this.rejectAll(error);
    worker?.kill();
  }

  private rejectAll(error: Error): void {
    for (const id of Array.from(this.pending.keys())) {
      this.takePending(id)?.reject(error);
    }
  }
}

function abortError(): Error {
  const error = new Error("Derived index request was cancelled.");
  error.name = "AbortError";
  return error;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
