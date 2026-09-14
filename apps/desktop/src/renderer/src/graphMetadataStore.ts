import {
  type BoundedGraphConceptDetail,
  type GraphConceptLookupReference,
  type GraphConceptSummary,
} from "@exograph/core";

export interface GraphMetadataSnapshot {
  sourceSnapshotId: string;
  nodeCount: number;
}

export interface GraphMetadataPort {
  getGraphConceptSummaries(indexes: readonly number[], sourceSnapshotId: string): ReturnType<Window["exograph"]["notes"]["getGraphConceptSummaries"]>;
  getGraphConceptDetailByIndex(index: number, sourceSnapshotId: string): ReturnType<Window["exograph"]["notes"]["getGraphConceptDetailByIndex"]>;
  graphConceptLookup(reference: GraphConceptLookupReference, sourceSnapshotId: string): ReturnType<Window["exograph"]["notes"]["graphConceptLookup"]>;
}

export interface GraphMetadataStoreOptions {
  port: GraphMetadataPort;
  currentSnapshot: () => GraphMetadataSnapshot | null;
  onPendingChange: (pending: number) => void;
  onStale: (sourceSnapshotId: string) => void;
  onStatus: (status: string | null) => void;
  onSummaries: (summaries: readonly GraphConceptSummary[]) => void;
}

/** Owns bounded cold graph reads and keeps every cache scoped to one snapshot. */
export class GraphMetadataStore {
  private readonly summaries = new Map<string, GraphConceptSummary>();
  private readonly details = new Map<string, BoundedGraphConceptDetail>();
  private readonly lookups = new Map<string, GraphConceptSummary>();
  private pending = 0;

  constructor(private readonly options: GraphMetadataStoreOptions) {}

  get pendingCount(): number { return this.pending; }
  get cacheEntryCount(): number { return this.summaries.size + this.details.size + this.lookups.size; }

  hasSummary(index: number, sourceSnapshotId: string): boolean {
    return this.summaries.has(cacheKey(sourceSnapshotId, index));
  }

  cachedSummaries(sourceSnapshotId: string): readonly GraphConceptSummary[] {
    const prefix = `${sourceSnapshotId}:`;
    return [...this.summaries.entries()].filter(([key]) => key.startsWith(prefix)).map(([, summary]) => summary);
  }

  prune(sourceSnapshotId: string): void {
    pruneCache(this.summaries, sourceSnapshotId);
    pruneCache(this.details, sourceSnapshotId);
    pruneCache(this.lookups, sourceSnapshotId);
  }

  async readSummaries(indexes: readonly number[], sourceSnapshotId: string): Promise<void> {
    const snapshot = this.options.currentSnapshot();
    const unique = [...new Set(indexes)]
      .filter((index) => Number.isSafeInteger(index) && index >= 0 && index < (snapshot?.nodeCount ?? 0))
      .filter((index) => !this.hasSummary(index, sourceSnapshotId))
      .slice(0, 64);
    if (!unique.length) return;
    this.beginRead();
    try {
      const result = await this.options.port.getGraphConceptSummaries(unique, sourceSnapshotId);
      if (result.status === "stale") return this.options.onStale(sourceSnapshotId);
      if (result.status === "too-large") return this.options.onStatus("Graph labels exceeded the bounded read limit.");
      if (result.status !== "ok" || !this.isCurrent(sourceSnapshotId)) return;
      for (const summary of result.summaries) this.summaries.set(cacheKey(sourceSnapshotId, summary.index), summary);
      this.options.onSummaries(result.summaries);
    } catch (reason) {
      this.reportFailure(reason, sourceSnapshotId);
    } finally {
      this.endRead();
    }
  }

  async readDetail(index: number, sourceSnapshotId: string): Promise<BoundedGraphConceptDetail | null> {
    const key = cacheKey(sourceSnapshotId, index);
    const cached = this.details.get(key);
    if (cached) return cached;
    this.beginRead();
    try {
      const result = await this.options.port.getGraphConceptDetailByIndex(index, sourceSnapshotId);
      if (result.status === "stale") {
        this.options.onStale(sourceSnapshotId);
        return null;
      }
      if (result.status === "too-large") {
        this.options.onStatus("Concept detail exceeded the bounded read limit.");
        return null;
      }
      if (result.status === "missing") {
        this.options.onStatus("Concept is no longer present in this graph.");
        return null;
      }
      if (!result.detail || !this.isCurrent(sourceSnapshotId)) return null;
      this.details.set(key, result.detail);
      return result.detail;
    } catch (reason) {
      this.reportFailure(reason, sourceSnapshotId);
      return null;
    } finally {
      this.endRead();
    }
  }

  async resolve(reference: GraphConceptLookupReference, sourceSnapshotId: string): Promise<GraphConceptSummary | null> {
    const key = lookupKey(sourceSnapshotId, reference);
    const cached = this.lookups.get(key);
    if (cached) return cached;
    this.beginRead();
    try {
      const result = await this.options.port.graphConceptLookup(reference, sourceSnapshotId);
      if (result.status === "stale") {
        this.options.onStale(sourceSnapshotId);
        return null;
      }
      if (result.status === "missing") {
        this.options.onStatus("Concept is no longer present in this graph.");
        return null;
      }
      if (result.status !== "ok" || !result.summary || !this.isCurrent(sourceSnapshotId)) return null;
      this.lookups.set(key, result.summary);
      this.summaries.set(cacheKey(sourceSnapshotId, result.summary.index), result.summary);
      this.options.onSummaries([result.summary]);
      return result.summary;
    } catch (reason) {
      this.reportFailure(reason, sourceSnapshotId);
      return null;
    } finally {
      this.endRead();
    }
  }

  private isCurrent(sourceSnapshotId: string): boolean {
    return this.options.currentSnapshot()?.sourceSnapshotId === sourceSnapshotId;
  }

  private beginRead(): void {
    this.pending += 1;
    this.options.onPendingChange(this.pending);
  }

  private endRead(): void {
    this.pending = Math.max(0, this.pending - 1);
    this.options.onPendingChange(this.pending);
  }

  private reportFailure(reason: unknown, sourceSnapshotId: string): void {
    if (this.isCurrent(sourceSnapshotId)) this.options.onStatus(reason instanceof Error ? reason.message : String(reason));
  }
}

function cacheKey(sourceSnapshotId: string, index: number): string {
  return `${sourceSnapshotId}:${index}`;
}

function lookupKey(sourceSnapshotId: string, reference: GraphConceptLookupReference): string {
  return "conceptId" in reference
    ? `${sourceSnapshotId}:id:${reference.conceptId}`
    : `${sourceSnapshotId}:path:${reference.filePath}`;
}

function pruneCache<T>(cache: Map<string, T>, sourceSnapshotId: string): void {
  const prefix = `${sourceSnapshotId}:`;
  for (const key of cache.keys()) if (!key.startsWith(prefix)) cache.delete(key);
}
