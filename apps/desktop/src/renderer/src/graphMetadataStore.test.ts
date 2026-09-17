import { describe, expect, it, vi } from "vitest";

import { GraphMetadataStore, type GraphMetadataPort } from "./graphMetadataStore";

function store(port: Partial<GraphMetadataPort>, snapshotId = "one") {
  const events = { pending: [] as number[], stale: [] as string[], status: [] as Array<string | null>, summaries: [] as unknown[] };
  const metadata = new GraphMetadataStore({
    port: port as GraphMetadataPort,
    currentSnapshot: () => ({ sourceSnapshotId: snapshotId, nodeCount: 4 }),
    onPendingChange: (pending) => events.pending.push(pending),
    onStale: (source) => events.stale.push(source),
    onStatus: (status) => events.status.push(status),
    onSummaries: (summaries) => events.summaries.push(summaries),
  });
  return { metadata, events };
}

describe("GraphMetadataStore", () => {
  it("deduplicates and bounds summary reads, then serves the snapshot cache", async () => {
    const getGraphConceptSummaries = vi.fn(async (indexes: readonly number[]) => ({
      status: "ok" as const,
      sourceSnapshotId: "one",
      summaries: indexes.map((index) => ({ index, label: `Note ${index}` })),
      payloadBytes: 1,
    }));
    const { metadata, events } = store({ getGraphConceptSummaries });
    await metadata.readSummaries([-1, 1, 1, 8], "one");
    await metadata.readSummaries([1], "one");
    expect(getGraphConceptSummaries).toHaveBeenCalledOnce();
    expect(getGraphConceptSummaries).toHaveBeenCalledWith([1], "one");
    expect(metadata.cacheEntryCount).toBe(1);
    expect(events.pending).toEqual([1, 0]);
  });

  it("rejects a late detail from an obsolete snapshot", async () => {
    let current = "one";
    const port = {
      getGraphConceptDetailByIndex: vi.fn(async () => {
        current = "two";
        return { status: "ok" as const, sourceSnapshotId: "one", index: 0, detail: { concept: { id: "one", label: "One", conceptTypes: [], resolution: "resolved", tags: [] }, properties: [], relations: [], findings: [], format: {} as never, ontology: {} as never, omitted: { properties: 0, relations: 0, findings: 0, evidence: 0 } }, payloadBytes: 1 };
      }),
    };
    const metadata = new GraphMetadataStore({
      port: port as unknown as GraphMetadataPort,
      currentSnapshot: () => ({ sourceSnapshotId: current, nodeCount: 1 }),
      onPendingChange: () => undefined,
      onStale: () => undefined,
      onStatus: () => undefined,
      onSummaries: () => undefined,
    });
    await expect(metadata.readDetail(0, "one")).resolves.toBeNull();
    expect(metadata.cacheEntryCount).toBe(0);
  });

  it("routes stale reads to one refresh boundary", async () => {
    const { metadata, events } = store({
      graphConceptLookup: vi.fn(async () => ({ status: "stale" as const, sourceSnapshotId: "two", payloadBytes: 1 })),
    });
    await expect(metadata.resolve({ filePath: "/notes/one.md" }, "one")).resolves.toBeNull();
    expect(events.stale).toEqual(["one"]);
    expect(events.pending).toEqual([1, 0]);
  });

  it("bounds all metadata caches to the accepted snapshot across repeated refreshes", async () => {
    let current = "snapshot-0";
    const detail = (index: number, sourceSnapshotId: string) => ({
      concept: { id: `${sourceSnapshotId}-${index}`, label: `Note ${index}`, conceptTypes: [], resolution: "resolved" as const, tags: [] },
      properties: [], relations: [], findings: [], format: {} as never, ontology: {} as never,
      omitted: { properties: 0, relations: 0, findings: 0, evidence: 0 },
    });
    const metadata = new GraphMetadataStore({
      port: {
        getGraphConceptSummaries: vi.fn(async (indexes: readonly number[], sourceSnapshotId: string) => ({
          status: "ok" as const,
          sourceSnapshotId,
          summaries: indexes.map((index) => ({ index, label: `Note ${index}` })),
          payloadBytes: 1,
        })),
        getGraphConceptDetailByIndex: vi.fn(async (index: number, sourceSnapshotId: string) => ({
          status: "ok" as const,
          sourceSnapshotId,
          index,
          detail: detail(index, sourceSnapshotId),
          payloadBytes: 1,
        })),
        graphConceptLookup: vi.fn(async (reference: { filePath: string }, sourceSnapshotId: string) => ({
          status: "ok" as const,
          sourceSnapshotId,
          summary: { index: 0, label: "Note 0", ...("filePath" in reference ? { filePath: reference.filePath } : {}) },
          payloadBytes: 1,
        })),
      },
      currentSnapshot: () => ({ sourceSnapshotId: current, nodeCount: 4 }),
      onPendingChange: () => undefined,
      onStale: () => undefined,
      onStatus: () => undefined,
      onSummaries: () => undefined,
    });
    for (let snapshot = 0; snapshot < 100; snapshot += 1) {
      current = `snapshot-${snapshot}`;
      await metadata.readSummaries([0], current);
      await metadata.readDetail(0, current);
      await metadata.resolve({ filePath: "/notes/one.md" }, current);
      metadata.prune(current);
      expect(metadata.cacheEntryCount).toBe(3);
    }
    expect(metadata.cacheEntryCount).toBe(3);
  });

  it("reports current snapshot source failures without retaining a detail", async () => {
    const { metadata, events } = store({
      getGraphConceptDetailByIndex: vi.fn(async () => { throw new Error("graph source unavailable"); }),
    });
    await expect(metadata.readDetail(0, "one")).resolves.toBeNull();
    expect(events.status).toEqual(["graph source unavailable"]);
    expect(metadata.cacheEntryCount).toBe(0);
  });
});
