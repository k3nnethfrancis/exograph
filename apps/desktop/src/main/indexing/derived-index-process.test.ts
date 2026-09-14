import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createGraphTopology, type IndexStatus, type WorkspaceModel } from "@exograph/core";

import {
  UtilityDerivedIndexClient,
  type DerivedIndexProcessHandle,
} from "./derived-index-process";

vi.mock("electron", () => ({ utilityProcess: { fork: vi.fn() } }));

describe("UtilityDerivedIndexClient", () => {
  afterEach(() => vi.useRealTimers());

  it("resolves worker responses without running derived work in the caller", async () => {
    const worker = new FakeProcess();
    const client = new UtilityDerivedIndexClient({ spawn: () => worker, workerPath: "/app/derived-index-worker.js" });

    const promise = client.status(model(), "/workspace/.exograph");
    expect(worker.messages).toEqual([
      expect.objectContaining({ id: 1, operation: "status", context: expect.objectContaining({ runtimeRoot: "/workspace/.exograph" }) }),
    ]);

    worker.emit("message", { id: 1, ok: true, result: status() });
    await expect(promise).resolves.toMatchObject({ documentCount: 3 });
  });

  it("kills a stuck worker, rejects every in-flight request, and restarts on the next request", async () => {
    vi.useFakeTimers();
    const workers: FakeProcess[] = [];
    const client = new UtilityDerivedIndexClient({
      requestTimeoutMs: 50,
      workerPath: "/app/derived-index-worker.js",
      spawn: () => {
        const worker = new FakeProcess();
        workers.push(worker);
        return worker;
      },
    });

    const first = client.status(model(), "/workspace/.exograph");
    const second = client.search(model(), "/workspace/.exograph", "needle");
    const firstRejected = expect(first).rejects.toThrow("timed out after 50 ms");
    const secondRejected = expect(second).rejects.toThrow("timed out after 50 ms");
    await vi.advanceTimersByTimeAsync(50);
    await Promise.all([firstRejected, secondRejected]);
    expect(workers[0].killed).toBe(true);

    const restarted = client.status(model(), "/workspace/.exograph");
    expect(workers).toHaveLength(2);
    workers[1].emit("message", { id: 3, ok: true, result: status() });
    await expect(restarted).resolves.toMatchObject({ backend: "qmd" });
  });

  it("cancels an abandoned request without accepting its late response", async () => {
    const worker = new FakeProcess();
    const client = new UtilityDerivedIndexClient({ spawn: () => worker, workerPath: "/app/derived-index-worker.js" });
    const controller = new AbortController();

    const promise = client.search(model(), "/workspace/.exograph", "old query", {}, controller.signal);
    controller.abort();

    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
    expect(worker.messages.at(-1)).toEqual({ id: 1, operation: "cancel" });
    worker.emit("message", { id: 1, ok: true, result: { results: [] } });
  });

  it("carries traversal scope and cursor to the worker and cancels abandoned traversal", async () => {
    const worker = new FakeProcess();
    const client = new UtilityDerivedIndexClient({ spawn: () => worker, workerPath: "/app/derived-index-worker.js" });
    const controller = new AbortController();
    const request = { workspaceRoot: "/workspace", start: "note:notes:a.md", cursor: "opaque", limit: 10 };
    const pending = client.graphTraverse(model(), "/workspace/.exograph", request, controller.signal);
    expect(worker.messages.at(-1)).toMatchObject({ id: 1, operation: "graph-traverse", request, context: { runtimeRoot: "/workspace/.exograph" } });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(worker.messages.at(-1)).toEqual({ id: 1, operation: "cancel" });
    worker.emit("message", { id: 1, ok: true, result: { status: "ok" } });
    client.dispose();
  });

  it("routes graph context and incremental refresh through the isolated worker", async () => {
    const worker = new FakeProcess();
    const client = new UtilityDerivedIndexClient({ spawn: () => worker, workerPath: "/app/derived-index-worker.js" });

    const context = client.graphContext(model(), "/workspace/.exograph", "/workspace/notes/focus.md");
    expect(worker.messages.at(-1)).toMatchObject({ operation: "graph-context", filePath: "/workspace/notes/focus.md" });
    worker.emit("message", { id: 1, ok: true, result: null });
    await expect(context).resolves.toBeNull();

    const refresh = client.graphRefresh(model(), "/workspace/.exograph", "/workspace/notes/focus.md");
    expect(worker.messages.at(-1)).toMatchObject({ operation: "graph-refresh", filePath: "/workspace/notes/focus.md" });
    worker.emit("message", { id: 2, ok: true, result: null });
    await expect(refresh).resolves.toBeUndefined();
  });

  it("serializes Ontology preview, Keep, and Reject through the graph worker", async () => {
    const worker = new FakeProcess();
    const client = new UtilityDerivedIndexClient({ spawn: () => worker, workerPath: "/app/derived-index-worker.js" });
    const guard = {
      candidateSourcePath: "ontology.yaml",
      candidateRevision: "candidate",
      activationRevision: null,
      baseSnapshotId: "snapshot",
    };
    const review = {
      active: { state: "generic" as const },
      candidate: { state: "valid" as const, revision: "candidate", pending: true, rejected: false },
      guard,
      diagnostics: [],
      omittedDiagnostics: 0,
    };

    const preview = client.ontologyPreview(model(), "/workspace/.exograph");
    expect(worker.messages.at(-1)).toMatchObject({ operation: "ontology-preview" });
    worker.emit("message", { id: 1, ok: true, result: review });
    await expect(preview).resolves.toEqual(review);

    const keep = client.ontologyKeep(model(), "/workspace/.exograph", guard);
    expect(worker.messages.at(-1)).toMatchObject({ operation: "ontology-keep", guard });
    worker.emit("message", { id: 2, ok: true, result: { status: "applied", review } });
    await expect(keep).resolves.toMatchObject({ status: "applied" });

    const reject = client.ontologyReject(model(), "/workspace/.exograph", guard);
    expect(worker.messages.at(-1)).toMatchObject({ operation: "ontology-reject", guard });
    worker.emit("message", { id: 3, ok: true, result: { status: "rejected", review } });
    await expect(reject).resolves.toMatchObject({ status: "rejected" });
  });

  it("routes compact topology and epoch-qualified cold reads without detaching repeated buffers", async () => {
    const worker = new FakeProcess();
    const client = new UtilityDerivedIndexClient({ spawn: () => worker, workerPath: "/app/derived-index-worker.js" });
    const firstResult = topology();
    const first = client.graphTopology(model(), "/workspace/.exograph");
    expect(worker.messages.at(-1)).toMatchObject({ operation: "graph-topology" });
    expect(worker.messages.at(-1)).not.toHaveProperty("profileId");
    expect(worker.messages.at(-1)).not.toHaveProperty("formatId");
    worker.emit("message", { id: 1, ok: true, result: firstResult });
    const resolvedFirst = await first;
    expect(resolvedFirst.nodes.identityKeys.byteLength).toBe(16);

    const secondResult = topology();
    const second = client.graphTopology(model(), "/workspace/.exograph");
    worker.emit("message", { id: 2, ok: true, result: secondResult });
    await expect(second).resolves.toMatchObject({ transportHash: firstResult.transportHash });
    expect(resolvedFirst.nodes.identityKeys.byteLength).toBe(16);

    const summaries = client.graphConceptSummaries(model(), "/workspace/.exograph", [0, 1], "snapshot:fixture");
    expect(worker.messages.at(-1)).toMatchObject({ operation: "graph-concept-summaries", indexes: [0, 1], sourceSnapshotId: "snapshot:fixture" });
    worker.emit("message", { id: 3, ok: true, result: { status: "ok", sourceSnapshotId: "snapshot:fixture", summaries: [], payloadBytes: 100 } });
    await expect(summaries).resolves.toMatchObject({ status: "ok" });

    const lookup = client.graphConceptLookup(
      model(),
      "/workspace/.exograph",
      { filePath: "/workspace/notes/focus.md" },
      "snapshot:fixture",
    );
    expect(worker.messages.at(-1)).toMatchObject({
      operation: "graph-concept-lookup",
      reference: { filePath: "/workspace/notes/focus.md" },
      sourceSnapshotId: "snapshot:fixture",
    });
    worker.emit("message", {
      id: 4,
      ok: true,
      result: { status: "ok", sourceSnapshotId: "snapshot:fixture", summary: { index: 1, label: "Focus" }, payloadBytes: 130 },
    });
    await expect(lookup).resolves.toMatchObject({ status: "ok", summary: { index: 1 } });

    const detail = client.graphConceptDetailByIndex(model(), "/workspace/.exograph", 1, "snapshot:fixture");
    expect(worker.messages.at(-1)).toMatchObject({ operation: "graph-concept-detail-by-index", index: 1 });
    worker.emit("message", { id: 5, ok: true, result: { status: "missing", sourceSnapshotId: "snapshot:fixture", index: 1, payloadBytes: 100 } });
    await expect(detail).resolves.toMatchObject({ status: "missing" });
  });

  it("keeps foreground search responsive while a separate maintenance embed is held", async () => {
    const foregroundWorker = new FakeProcess();
    const maintenanceWorker = new FakeProcess();
    const foreground = new UtilityDerivedIndexClient({ spawn: () => foregroundWorker, workerPath: "/app/derived-index-worker.js" });
    const maintenance = new UtilityDerivedIndexClient({ spawn: () => maintenanceWorker, workerPath: "/app/derived-index-worker.js" });

    const embedding = maintenance.embed(model(), "/workspace/.exograph", {
      maxDocuments: 4,
      maxDocsPerBatch: 1,
      maxDurationMs: 15_000,
    });
    expect(maintenanceWorker.messages.at(-1)).toMatchObject({
      operation: "embed",
      options: { maxDocuments: 4, maxDocsPerBatch: 1, maxDurationMs: 15_000 },
    });

    const searching = foreground.search(model(), "/workspace/.exograph", "needle");
    foregroundWorker.emit("message", {
      id: 1,
      ok: true,
      result: { results: [], query: "needle", mode: "lexical", source: "filesystem", warnings: [] },
    });
    await expect(searching).resolves.toMatchObject({ query: "needle", source: "filesystem" });

    let embedSettled = false;
    void embedding.finally(() => { embedSettled = true; });
    await Promise.resolve();
    expect(embedSettled).toBe(false);
    maintenanceWorker.emit("message", { id: 1, ok: true, result: status() });
    await expect(embedding).resolves.toMatchObject({ backend: "qmd" });
  });

  it("keeps foreground search responsive while a separate graph process is held", async () => {
    const foregroundWorker = new FakeProcess();
    const graphWorker = new FakeProcess();
    const foreground = new UtilityDerivedIndexClient({ spawn: () => foregroundWorker, workerPath: "/app/derived-index-worker.js" });
    const graph = new UtilityDerivedIndexClient({ spawn: () => graphWorker, workerPath: "/app/derived-index-worker.js" });

    const context = graph.graphContext(model(), "/workspace/.exograph", "/workspace/notes/focus.md");
    expect(graphWorker.messages.at(-1)).toMatchObject({ operation: "graph-context" });

    const searching = foreground.search(model(), "/workspace/.exograph", "needle");
    foregroundWorker.emit("message", {
      id: 1,
      ok: true,
      result: { results: [], query: "needle", mode: "lexical", source: "filesystem", warnings: [] },
    });
    await expect(searching).resolves.toMatchObject({ query: "needle", source: "filesystem" });

    let graphSettled = false;
    void context.finally(() => { graphSettled = true; });
    await Promise.resolve();
    expect(graphSettled).toBe(false);
    graphWorker.emit("message", { id: 1, ok: true, result: null });
    await expect(context).resolves.toBeNull();
  });

  it("rejects requests when the worker exits and starts a fresh worker afterward", async () => {
    const workers: FakeProcess[] = [];
    const client = new UtilityDerivedIndexClient({
      workerPath: "/app/derived-index-worker.js",
      spawn: () => {
        const worker = new FakeProcess();
        workers.push(worker);
        return worker;
      },
    });

    const interrupted = client.status(model(), "/workspace/.exograph");
    workerAt(workers, 0).emit("exit", 9);
    await expect(interrupted).rejects.toThrow("exited with code 9");

    const restarted = client.status(model(), "/workspace/.exograph");
    workerAt(workers, 1).emit("message", { id: 2, ok: true, result: status() });
    await expect(restarted).resolves.toMatchObject({ documentCount: 3 });
  });
});

class FakeProcess extends EventEmitter implements DerivedIndexProcessHandle {
  messages: unknown[] = [];
  killed = false;

  postMessage(message: unknown): void {
    this.messages.push(message);
  }

  kill(): boolean {
    this.killed = true;
    return true;
  }
}

function model(): WorkspaceModel {
  return {
    workspaceRoot: "/workspace",
    defaultTerminalCwd: "/workspace",
    noteRoots: [{ id: "notes", label: "notes", path: "/workspace/notes" }],
    indexedRoots: [{
      id: "index-notes",
      label: "notes",
      path: "/workspace/notes",
      kind: "notes",
      pattern: "**/*.md",
      ignore: [],
      backend: "qmd",
    }],
    indexing: { enabled: true, mode: "hybrid", backend: "qmd" },
  };
}

function status(): IndexStatus {
  return {
    enabled: true,
    mode: "hybrid",
    backend: "qmd",
    dbPath: "/workspace/.exograph/qmd/index.sqlite",
    runtimePath: "/workspace/.exograph/qmd",
    indexedRoots: model().indexedRoots,
    documentCount: 3,
    pendingEmbeddings: 0,
    hasVectorIndex: true,
    lastUpdated: null,
    warnings: [],
    errors: [],
  };
}

function workerAt(workers: FakeProcess[], index: number): FakeProcess {
  const worker = workers[index];
  if (!worker) throw new Error(`Missing fake worker ${index}.`);
  return worker;
}

function topology() {
  return createGraphTopology({
    sourceSnapshotId: "snapshot:fixture",
    activeFormat: { id: "generic-markdown", version: "1", label: "Generic Markdown", source: "built-in", state: "active" },
    activeOntology: { state: "generic" },
    seed: 9,
    nodes: {
      identityKeys: new Uint32Array([1, 0, 2, 0]),
      seeds: new Uint32Array([11, 12]),
      groups: new Uint32Array([1, 1]),
      degrees: new Uint32Array([1, 1]),
      visualClasses: new Uint8Array([0, 0]),
    },
    edges: { endpoints: new Uint32Array([0, 1]), visualClasses: new Uint8Array([0]) },
  });
}
