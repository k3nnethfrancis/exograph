import { createHash } from "node:crypto";
import { access, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import type { IndexReadOptions, IndexSearchOptions, IndexUpdateOptions, SearchProvider, SearchProviderMetadata } from "../search-provider";
import { readFilesystemDocument, searchFilesystem } from "./filesystem-provider";
import { WorkspaceFiles } from "../workspace-files";
import { normalizeWorkspaceContentPolicy } from "../workspace-content-policy";
import { WORKSPACE_RUNTIME_DIRECTORY } from "../workspace-runtime";
import type {
  IndexedRoot,
  IndexReadResponse,
  IndexSearchResponse,
  IndexSearchResult,
  IndexSyncResult,
  IndexStatus,
  WorkspaceModel,
} from "../types";

type QmdModule = typeof import("@tobilu/qmd");
type QmdStore = Awaited<ReturnType<QmdModule["createStore"]>>;

interface QmdEmbedOptions {
  maxDocuments?: number;
  maxDocsPerBatch?: number;
  maxDurationMs?: number;
}

interface QmdStream {
  fetch: (limit: number) => Promise<unknown[]>;
  /** Scan limit after which a short provider response terminates this adapter stream. Null keeps it ambiguous. */
  shortResultTerminalScanLimit: number | null;
}

interface QmdResultCandidate {
  identity: string;
  result: IndexSearchResult;
}

interface FilteredQmdStreamResults {
  results: QmdResultCandidate[];
  rejectedCount: number;
}

interface RefilledQmdResults extends FilteredQmdStreamResults {
  incomplete: boolean;
}

interface QmdStreamState {
  stream: QmdStream;
  scanLimit: number;
  maxScanLimit: number;
  rawResults: unknown[];
  boundaryScore: number | null;
  filtered: FilteredQmdStreamResults;
  exhausted: boolean;
  complete: boolean;
}

class QmdStreamQueryError extends Error {
  constructor(readonly reason: unknown) {
    super(errorMessage(reason));
    this.name = "QmdStreamQueryError";
  }
}

const DEFAULT_SEARCH_LIMIT = 10;
const DEFAULT_CONTENT_LINES = 80;
const MAX_QMD_REFILL_SLACK_PER_STREAM = 100;
const QMD_DIRECTORY_NAME = "qmd";
const QMD_PENDING_COLLECTION_REINDEX_FILE = "pending-collection-reindex";

class QmdCollectionConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QmdCollectionConfigurationError";
  }
}

const qmdSearchProviderMetadata: SearchProviderMetadata = {
  id: "qmd",
  label: "QMD search",
  description: "Bundled local Markdown search provider.",
  lifecycle: "built-in",
  backend: "qmd",
  capabilities: ["lexical", "semantic", "hybrid", "read", "update", "embed", "sync"],
};

export class QmdSearchProvider implements SearchProvider {
  readonly metadata = qmdSearchProviderMetadata;

  getStatus(model: WorkspaceModel, runtimeRoot: string): Promise<IndexStatus> {
    return getIndexStatus(model, runtimeRoot);
  }

  search(model: WorkspaceModel, runtimeRoot: string, query: string, options: IndexSearchOptions = {}): Promise<IndexSearchResponse> {
    return searchIndex(model, runtimeRoot, query, options);
  }

  read(model: WorkspaceModel, runtimeRoot: string, target: string, options: IndexReadOptions = {}): Promise<IndexReadResponse> {
    return readIndexDocument(model, runtimeRoot, target, options);
  }

  readAuthorized(
    model: WorkspaceModel,
    runtimeRoot: string,
    target: string,
    options: IndexReadOptions,
    authorizeResolvedPath: (filePath: string) => Promise<void>,
  ): Promise<IndexReadResponse> {
    return readIndexDocument(model, runtimeRoot, target, options, authorizeResolvedPath);
  }

  update(model: WorkspaceModel, runtimeRoot: string, options: IndexUpdateOptions = {}): Promise<IndexStatus> {
    return updateIndex(model, runtimeRoot, options);
  }

  embed(model: WorkspaceModel, runtimeRoot: string, options?: QmdEmbedOptions): Promise<IndexStatus> {
    return embedIndex(model, runtimeRoot, options);
  }

  sync(model: WorkspaceModel, runtimeRoot: string): Promise<IndexSyncResult> {
    return syncIndex(model, runtimeRoot);
  }
}

export const qmdSearchProvider = new QmdSearchProvider();

export function getQmdRuntimePath(runtimeRoot: string): string {
  return path.join(runtimeRoot, QMD_DIRECTORY_NAME);
}

export function getQmdDbPath(runtimeRoot: string): string {
  return path.join(getQmdRuntimePath(runtimeRoot), "index.sqlite");
}

async function getIndexStatus(model: WorkspaceModel, runtimeRoot: string): Promise<IndexStatus> {
  const base = baseStatus(model, runtimeRoot);
  const runtimeWarnings = await runtimeStateWarnings(runtimeRoot);
  if (!model.indexing.enabled || model.indexing.mode === "off" || model.indexedRoots.length === 0) {
    return {
      ...base,
      warnings: [
        ...(model.indexing.enabled && model.indexedRoots.length === 0 ? ["No indexed roots are configured."] : []),
        ...runtimeWarnings,
      ],
    };
  }

  let store: QmdStore | null = null;
  try {
    store = await openQmdStore(model, runtimeRoot);
    const qmdStatus = await store.getStatus();
    const lastUpdated = latestCollectionUpdate(qmdStatus.collections);
    const documentCount = Number(qmdStatus.totalDocuments ?? 0);
    const pendingEmbeddings = Number(qmdStatus.needsEmbedding ?? 0);
    const hasVectorIndex = Boolean(qmdStatus.hasVectorIndex);
    const readinessWarnings = model.indexing.mode !== "lexical"
      && documentCount > 0
      && pendingEmbeddings === 0
      && !hasVectorIndex
      ? ["Semantic vector index is unavailable even though no embeddings are pending. Build embeddings to repair it."]
      : [];
    return {
      ...base,
      documentCount,
      pendingEmbeddings,
      hasVectorIndex,
      lastUpdated,
      // Readiness is structured state. The caller that owns automatic/manual
      // policy decides how to present pending embeddings; provider warnings
      // remain reserved for degradation and repair facts.
      warnings: [...readinessWarnings, ...runtimeWarnings],
    };
  } catch (error) {
    const runtimeWarning = qmdRuntimeRecoveryWarning(error);
    return {
      ...base,
      warnings: runtimeWarning ? [...runtimeWarnings, runtimeWarning] : runtimeWarnings,
      errors: [errorMessage(error)],
    };
  } finally {
    await store?.close();
  }
}

async function runtimeStateWarnings(runtimeRoot: string): Promise<string[]> {
  // The packaged app intentionally puts derived state at <workspace>/.exograph. Do
  // not silently write a user's repository configuration, but make a tracked
  // runtime directory visible before indexes/invocation records surprise them.
  if (path.basename(runtimeRoot) !== WORKSPACE_RUNTIME_DIRECTORY) {
    return [];
  }
  const workspaceRoot = path.dirname(runtimeRoot);
  if (!(await pathExists(path.join(workspaceRoot, ".git")))) {
    return [];
  }
  try {
    const gitignore = await readFile(path.join(workspaceRoot, ".gitignore"), "utf8");
    if (gitignore.split(/\r?\n/).some(ignoresRuntimePath)) {
      return [];
    }
  } catch {
    // A missing or unreadable .gitignore leaves the warning intentionally visible.
  }
  return ["This Workspace is a Git repository and .exograph/ is not ignored. Add .exograph/ to .gitignore; Exograph will not modify repository files automatically."];
}

function ignoresRuntimePath(line: string): boolean {
  const rule = line.trim();
  return rule === ".exograph" || rule === ".exograph/" || rule === "/.exograph" || rule === "/.exograph/" || rule === "**/.exograph" || rule === "**/.exograph/";
}

async function pathExists(target: string): Promise<boolean> {
  return access(target).then(
    () => true,
    () => false,
  );
}

async function updateIndex(model: WorkspaceModel, runtimeRoot: string, options: IndexUpdateOptions = {}): Promise<IndexStatus> {
  ensureIndexEnabled(model);
  const selectedRoots = selectIndexedRoots(model.indexedRoots, options.rootIds);
  if (selectedRoots.length === 0) {
    return getIndexStatus(model, runtimeRoot);
  }

  let store: QmdStore | null = null;
  try {
    store = await openQmdStore(model, runtimeRoot);
    const collections = qmdCollectionIdentity(model.indexedRoots);
    await store.update({ collections: selectedRoots.map((root) => collections.nameFor(root)) });
  } finally {
    await store?.close();
  }
  return getIndexStatus(model, runtimeRoot);
}

async function embedIndex(model: WorkspaceModel, runtimeRoot: string, options?: QmdEmbedOptions): Promise<IndexStatus> {
  ensureIndexEnabled(model);
  if (model.indexing.mode === "lexical") {
    throw new Error("Embedding is disabled in lexical mode.");
  }

  let store: QmdStore | null = null;
  try {
    store = await openQmdStore(model, runtimeRoot);
    await store.embed(options);
  } finally {
    await store?.close();
  }
  return getIndexStatus(model, runtimeRoot);
}

async function syncIndex(model: WorkspaceModel, runtimeRoot: string): Promise<IndexSyncResult> {
  const phases: IndexSyncResult["phases"] = [];
  const warnings: string[] = [];

  let status = await updateIndex(model, runtimeRoot);
  phases.push({
    name: "update",
    status: "completed",
    message: "Indexed documents refreshed.",
  });

  if (model.indexing.mode === "lexical") {
    phases.push({
      name: "embed",
      status: "skipped",
      message: "Embeddings are not needed in lexical mode.",
    });
    return { status, phases, warnings };
  }

  try {
    status = await embedIndex(model, runtimeRoot);
    phases.push({
      name: "embed",
      status: "completed",
      message: "Embeddings built.",
    });
  } catch (error) {
    const warning = `Embedding failed (${errorMessage(error)}); lexical search remains available.`;
    warnings.push(warning);
    status = await getIndexStatus(model, runtimeRoot);
    status = {
      ...status,
      warnings: [...status.warnings, warning],
    };
    phases.push({
      name: "embed",
      status: "failed",
      message: warning,
    });
  }

  return { status, phases, warnings };
}

async function searchIndex(
  model: WorkspaceModel,
  runtimeRoot: string,
  query: string,
  options: IndexSearchOptions = {},
): Promise<IndexSearchResponse> {
  const trimmedQuery = query.trim();
  if (!trimmedQuery) {
    return {
      query,
      mode: model.indexing.mode,
      source: "filesystem",
      warnings: ["Search query is empty."],
      results: [],
    };
  }

  const selectedRoots = selectIndexedRoots(model.indexedRoots, options.rootIds);
  const filesystemFallbackModel = scopedFilesystemFallbackModel(model, selectedRoots, options.rootIds);
  if (!shouldUseQmd(model)) {
    return searchFilesystem(filesystemFallbackModel, trimmedQuery, options, "QMD is unavailable; showing Simple search results.");
  }

  let store: QmdStore | null = null;
  try {
    const qmdStore = await openQmdStore(model, runtimeRoot);
    store = qmdStore;
    const qmdCollections = qmdCollectionIdentity(model.indexedRoots);
    const collections = selectedRoots.map((root) => qmdCollections.nameFor(root));
    const indexedRootFiles = new WorkspaceFiles(selectedRoots.map((root) => root.path));
    const limit = options.limit ?? DEFAULT_SEARCH_LIMIT;
    const offset = Math.max(0, options.offset ?? 0);
    const targetResultCount = offset + limit + 1;
    const warnings: string[] = [];
    const effectiveMode = options.forceMode ?? model.indexing.mode;
    let actualMode = effectiveMode;
    let lexicalExhaustionScanLimit: number | null = null;
    try {
      const qmdStatus = await qmdStore.getStatus();
      const totalDocuments = Number(qmdStatus.totalDocuments ?? 0);
      if (Number.isSafeInteger(totalDocuments) && totalDocuments >= 0) {
        // QMD collection FTS scans 10× the requested limit globally before applying
        // its collection filter. Once that window covers every indexed document,
        // a short collection result is a truthful exhaustion signal.
        lexicalExhaustionScanLimit = Math.ceil(totalDocuments / 10);
      }
      const pendingEmbeddings = Number(qmdStatus.needsEmbedding ?? 0);
      if (
        effectiveMode !== "lexical"
        && (!Boolean(qmdStatus.hasVectorIndex) || pendingEmbeddings > 0)
      ) {
        warnings.push("Embeddings are not ready; Exograph will use lexical fallback if semantic/hybrid search is unavailable.");
      }
    } catch {
      // Status warnings and lexical exhaustion bounds are best-effort. A stream
      // without proof keeps refilling until its relative budget fails closed.
    }
    const lexicalStreams = (): QmdStream[] => collections.map(
      (collection) => ({
        fetch: (scanLimit) => qmdStore.searchLex(trimmedQuery, { limit: scanLimit, collection }),
        shortResultTerminalScanLimit: lexicalExhaustionScanLimit,
      }),
    );

    let filteredResults: RefilledQmdResults;
    if (effectiveMode === "lexical") {
      filteredResults = await refillQmdStreams(
        lexicalStreams(),
        targetResultCount,
        qmdCollections,
        indexedRootFiles,
        options,
      );
    } else if (effectiveMode === "semantic") {
      try {
        filteredResults = await refillQmdStreams(
          [
            ...lexicalStreams(),
            ...collections.map(
              (collection): QmdStream => ({
                fetch: (scanLimit) => qmdStore.searchVector(trimmedQuery, { limit: scanLimit, collection }),
                // QMD vector search exposes an approximate, collection-filtered
                // candidate horizon rather than an exact cursor. A short response
                // is terminal for that provider query; semantic pagination is
                // therefore best-effort over QMD's shipped ranked set.
                shortResultTerminalScanLimit: 0,
              }),
            ),
          ],
          targetResultCount,
          qmdCollections,
          indexedRootFiles,
          options,
        );
      } catch (error) {
        if (!(error instanceof QmdStreamQueryError)) {
          throw error;
        }
        // Preserve search as an orientation surface even when embeddings are stale or unavailable.
        // The warning keeps the degraded provider visible instead of silently pretending this was semantic.
        warnings.push(`Semantic search is not ready (${errorMessage(error.reason)}); using lexical search.`);
        filteredResults = await refillQmdStreams(
          lexicalStreams(),
          targetResultCount,
          qmdCollections,
          indexedRootFiles,
          options,
        );
        actualMode = "lexical";
      }
    } else {
      try {
        filteredResults = await refillQmdStreams(
          collections.map(
            (collection): QmdStream => ({
              fetch: (scanLimit) => qmdStore.search({
                query: trimmedQuery,
                collections: [collection],
                limit: scanLimit,
                intent: options.intent,
                rerank: true,
              }),
              shortResultTerminalScanLimit: 0,
            }),
          ),
          targetResultCount,
          qmdCollections,
          indexedRootFiles,
          options,
        );
      } catch (error) {
        if (!(error instanceof QmdStreamQueryError)) {
          throw error;
        }
        // Hybrid depends on the same vector path as semantic search. Fall back to lexical results,
        // but keep a provider warning so index repair remains discoverable.
        warnings.push(`Hybrid search is not ready (${errorMessage(error.reason)}); using lexical search.`);
        filteredResults = await refillQmdStreams(
          lexicalStreams(),
          targetResultCount,
          qmdCollections,
          indexedRootFiles,
          options,
        );
        actualMode = "lexical";
      }
    }

    const pageableResults = deduplicateQmdCandidates(filteredResults.results);
    const results = pageableResults
      .slice(offset, offset + limit)
      .map((candidate) => candidate.result);

    if (filteredResults.rejectedCount > 0) {
      warnings.push(droppedQmdResultWarning(filteredResults.rejectedCount));
    }
    if (filteredResults.incomplete) {
      warnings.push("QMD reached its authorization scan limit; returning the authorized results found so far.");
    }

    return {
      query: trimmedQuery,
      mode: actualMode,
      source: "qmd",
      warnings,
      results,
      hasMore: pageableResults.length > offset + results.length || filteredResults.incomplete,
      incomplete: filteredResults.incomplete
        ? {
            reason: "authorization_refill_limit",
            requested: limit,
            returned: results.length,
          }
        : undefined,
    };
  } catch (error) {
    if (error instanceof QmdCollectionConfigurationError) {
      throw error;
    }
    // If QMD cannot open at all, keep basic workspace search usable. This fallback is intentionally
    // degraded and warning-bearing; admin/status paths should still surface the underlying QMD issue.
    return searchFilesystem(filesystemFallbackModel, trimmedQuery, options, qmdFallbackWarning(error));
  } finally {
    await store?.close();
  }
}

async function refillQmdStreams(
  streams: readonly QmdStream[],
  targetResultCount: number,
  collections: QmdCollectionIdentity,
  indexedRootFiles: WorkspaceFiles,
  options: IndexSearchOptions,
): Promise<RefilledQmdResults> {
  if (streams.length === 0) {
    return { results: [], rejectedCount: 0, incomplete: false };
  }

  const roundedTarget = Math.ceil(targetResultCount);
  const requiredResultCount = Number.isSafeInteger(roundedTarget)
    ? Math.max(1, roundedTarget)
    : Number.MAX_SAFE_INTEGER;
  const maxScanLimit = safeAdd(requiredResultCount, MAX_QMD_REFILL_SLACK_PER_STREAM);
  const initialScanLimit = safeAdd(requiredResultCount, 1);
  const states: QmdStreamState[] = streams.map((stream) => ({
    stream,
    scanLimit: initialScanLimit,
    maxScanLimit,
    rawResults: [],
    boundaryScore: null,
    filtered: { results: [], rejectedCount: 0 },
    exhausted: false,
    complete: false,
  }));

  let incomplete = false;
  while (states.some((state) => !state.complete)) {
    const activeStates = states.filter((state) => !state.complete);
    const queryResults = await Promise.allSettled(
      activeStates.map((state) => state.stream.fetch(state.scanLimit)),
    );
    const queryFailure = queryResults.find((result) => result.status === "rejected");
    if (queryFailure?.status === "rejected") {
      throw new QmdStreamQueryError(queryFailure.reason);
    }

    for (let index = 0; index < activeStates.length; index += 1) {
      const queryResult = queryResults[index];
      if (queryResult.status !== "fulfilled") {
        continue;
      }
      const state = activeStates[index];
      state.rawResults = queryResult.value.slice(0, state.scanLimit);
      state.boundaryScore = qmdRawResultScore(state.rawResults.at(-1));
      state.exhausted = queryResult.value.length < state.scanLimit
        && state.stream.shortResultTerminalScanLimit !== null
        && state.scanLimit >= state.stream.shortResultTerminalScanLimit;
    }

    const filteredResults = await Promise.all(
      activeStates.map((state) =>
        filterQmdStreamResults(state.rawResults, collections, indexedRootFiles, options)),
    );
    let reachedIncompleteCap = false;
    for (let index = 0; index < activeStates.length; index += 1) {
      const state = activeStates[index];
      state.filtered = filteredResults[index];
      if (state.exhausted || hasCompleteOrderedPrefix(state, requiredResultCount)) {
        state.complete = true;
      } else if (state.scanLimit >= state.maxScanLimit) {
        reachedIncompleteCap = true;
      } else {
        state.scanLimit = Math.min(safeAdd(state.scanLimit, state.scanLimit), state.maxScanLimit);
      }
    }
    if (reachedIncompleteCap) {
      incomplete = true;
      break;
    }
  }

  return {
    results: states.flatMap((state) => state.filtered.results),
    rejectedCount: states.reduce((total, state) => total + state.filtered.rejectedCount, 0),
    incomplete,
  };
}

function hasCompleteOrderedPrefix(state: QmdStreamState, requiredResultCount: number): boolean {
  if (state.filtered.results.length < requiredResultCount || state.boundaryScore === null) {
    return false;
  }
  const cutoffScore = state.filtered.results[requiredResultCount - 1]?.result.score;
  return cutoffScore !== undefined && state.boundaryScore < cutoffScore;
}

function safeAdd(left: number, right: number): number {
  return left > Number.MAX_SAFE_INTEGER - right
    ? Number.MAX_SAFE_INTEGER
    : left + right;
}

async function filterQmdStreamResults(
  rawResults: unknown[],
  collections: QmdCollectionIdentity,
  indexedRootFiles: WorkspaceFiles,
  options: IndexSearchOptions,
): Promise<FilteredQmdStreamResults> {
  const mappedResults = rawResults
    .map((result) => mapQmdResult(result, collections))
    .filter((result): result is IndexSearchResult => result !== null);
  const authorizedResults = await Promise.all(
    mappedResults.map(async (result) => {
      const identity = await authorizedIndexedRootIdentity(indexedRootFiles, result.filePath);
      return identity ? { identity, result } : null;
    }),
  );
  let rejectedCount = rawResults.length
    - mappedResults.length
    + authorizedResults.filter((result) => result === null).length;
  let results = authorizedResults.filter((result): result is QmdResultCandidate => result !== null);

  if (options.includeContent) {
    const hydratedResults = await Promise.all(
      results.map(async (candidate) => ({
        candidate,
        content: await readAuthorizedBoundedContent(
          candidate.result.filePath,
          indexedRootFiles,
          options.maxLinesPerResult ?? DEFAULT_CONTENT_LINES,
        ),
      })),
    );
    rejectedCount += hydratedResults.filter(({ content }) => content === null).length;
    results = hydratedResults
      .filter((entry): entry is {
        candidate: QmdResultCandidate;
        content: { body: string; identity: string };
      } => entry.content !== null)
      .map(({ candidate, content }) => ({
        identity: content.identity,
        result: { ...candidate.result, content: content.body },
      }));
  }

  return { results: deduplicateQmdCandidates(results), rejectedCount };
}

async function readIndexDocument(
  model: WorkspaceModel,
  runtimeRoot: string,
  target: string,
  options: IndexReadOptions = {},
  authorizeResolvedPath?: (filePath: string) => Promise<void>,
): Promise<IndexReadResponse> {
  if (isDocid(target) && shouldUseQmd(model)) {
    let store: QmdStore | null = null;
    try {
      store = await openQmdStore(model, runtimeRoot);
      const indexedRootFiles = new WorkspaceFiles(model.indexedRoots.map((root) => root.path));
      const doc = await store.get(target, { includeBody: false });
      if ("error" in doc) {
        throw new Error(`Document not found: ${target}`);
      }
      const filePath = resolveQmdPath(doc.filepath, qmdCollectionIdentity(model.indexedRoots));
      if (!filePath || !(await isAuthorizedIndexedRootPath(indexedRootFiles, filePath))) {
        throw new Error("Refusing to read a QMD document outside configured indexed roots.");
      }
      await authorizeResolvedPath?.(filePath);
      if (!(await isAuthorizedIndexedRootPath(indexedRootFiles, filePath))) {
        throw new Error("Refusing to read a QMD document outside configured indexed roots.");
      }
      const body = await store.getDocumentBody(target, {
        fromLine: options.fromLine,
        maxLines: options.maxLines,
      });
      return {
        target,
        filePath,
        title: doc.title,
        body: body ?? "",
        fromLine: options.fromLine,
        maxLines: options.maxLines,
        source: "qmd",
      };
    } finally {
      await store?.close();
    }
  }

  return readFilesystemDocument(model, target, options, authorizeResolvedPath);
}

async function openQmdStore(model: WorkspaceModel, runtimeRoot: string): Promise<QmdStore> {
  await mkdir(getQmdRuntimePath(runtimeRoot), { recursive: true });
  const qmd = await import("@tobilu/qmd");
  const collections = qmdCollectionIdentity(model.indexedRoots);
  await assertDistinctQmdPhysicalOwners(model.indexedRoots);
  const collectionConfig = qmdCollectionConfig(
    model.indexedRoots,
    collections,
    normalizeWorkspaceContentPolicy(model.contentPolicy).excludedPaths,
  );
  const rootsNeedingReindex = await rootsNeedingQmdCollectionReindex(qmd, runtimeRoot, model.indexedRoots, collections);
  const hasPendingReindex = await hasPendingQmdCollectionReindex(runtimeRoot);
  if (rootsNeedingReindex.length > 0 && !hasPendingReindex) {
    // Publish recovery state before QMD applies the new collection config. If
    // this process stops after that sync, the next open conservatively rebuilds
    // every current root rather than trusting partially reconfigured derived
    // state.
    await writePendingQmdCollectionReindex(runtimeRoot);
  }
  const store = await qmd.createStore({
    dbPath: getQmdDbPath(runtimeRoot),
    config: {
      global_context: "Exograph-managed QMD search provider. Indexed roots are explicitly selected by the user.",
      collections: collectionConfig,
    },
  });
  if (rootsNeedingReindex.length > 0 || hasPendingReindex) {
    // QMD 2.5.3 syncs inline collection configuration but does not transfer
    // document collection names. A pending marker is deliberately only a
    // presence bit: after interrupted work, rebuild every *current* root so
    // root additions/removals cannot leave a shadow registry to reconcile.
    try {
      await store.update({ collections: model.indexedRoots.map((root) => collections.nameFor(root)) });
      await clearPendingQmdCollectionReindex(runtimeRoot);
    } catch (error) {
      await store.close();
      throw error;
    }
  }
  return store;
}

function baseStatus(model: WorkspaceModel, runtimeRoot: string): IndexStatus {
  return {
    enabled: model.indexing.enabled && model.indexing.mode !== "off",
    mode: model.indexing.mode,
    backend: "qmd",
    dbPath: getQmdDbPath(runtimeRoot),
    runtimePath: getQmdRuntimePath(runtimeRoot),
    indexedRoots: model.indexedRoots,
    documentCount: 0,
    pendingEmbeddings: 0,
    hasVectorIndex: false,
    lastUpdated: null,
    warnings: [],
    errors: [],
  };
}

function ensureIndexEnabled(model: WorkspaceModel): void {
  if (!shouldUseQmd(model)) {
    throw new Error("The Exograph index is off or has no indexed roots.");
  }
}

function shouldUseQmd(model: WorkspaceModel): boolean {
  return model.indexing.enabled && model.indexing.mode !== "off" && model.indexedRoots.length > 0;
}

function selectIndexedRoots(roots: IndexedRoot[], rootIds: string[] | undefined): IndexedRoot[] {
  if (rootIds === undefined) {
    return roots;
  }
  const selectedIds = new Set(rootIds);
  return roots.filter((root) => selectedIds.has(root.id));
}

function scopedFilesystemFallbackModel(
  model: WorkspaceModel,
  selectedRoots: IndexedRoot[],
  rootIds: string[] | undefined,
): WorkspaceModel {
  if (rootIds === undefined && model.indexedRoots.length === 0) {
    return model;
  }
  return {
    ...model,
    noteRoots: selectedRoots.map((root) => ({
      id: root.id,
      label: root.label,
      path: root.path,
    })),
    indexedRoots: selectedRoots,
  };
}

interface QmdCollectionIdentity {
  nameFor(root: IndexedRoot): string;
  rootFor(name: string): IndexedRoot | null;
}

/**
 * QMD collections are owned by their resolved filesystem root, not the
 * mutable sibling set or a user-facing label/ID. QMD 2.5.3 accepts the
 * resulting bounded alphanumeric/hyphen name.
 */
function qmdCollectionIdentity(roots: IndexedRoot[]): QmdCollectionIdentity {
  return {
    nameFor: qmdCollectionName,
    rootFor: (name) => roots.find((root) => qmdCollectionName(root) === name) ?? null,
  };
}

function qmdCollectionName(root: IndexedRoot): string {
  return `exograph-root-${createHash("sha256")
    .update(path.resolve(root.path))
    .digest("hex")}`;
}

function qmdCollectionConfig(
  roots: IndexedRoot[],
  collections: QmdCollectionIdentity,
  contentExclusions: readonly string[] = [],
): Record<string, { path: string; pattern: string; ignore: string[]; context: Record<string, string> }> {
  const entries: Array<[string, { path: string; pattern: string; ignore: string[]; context: Record<string, string> }]> = roots.map((root) => [
    collections.nameFor(root),
    {
      path: root.path,
      pattern: root.pattern,
      ignore: [...new Set([...root.ignore, ...contentExclusions])],
      context: { "/": `${root.kind} root: ${root.label}` },
    },
  ]);
  const rootsByName = new Map<string, IndexedRoot[]>();
  for (const [name, root] of entries.map(([name], index) => [name, roots[index]] as const)) {
    const group = rootsByName.get(name) ?? [];
    group.push(root);
    rootsByName.set(name, group);
  }
  for (const [name, group] of rootsByName) {
    if (group.length > 1) {
      throw new QmdCollectionConfigurationError(
        `QMD collection identity ${name} is shared by configured Indexed Roots ${group.map((root) => `${root.id} (${root.path})`).join(", ")}. Configure one policy per root path.`,
      );
    }
  }
  return Object.fromEntries(entries);
}

async function assertDistinctQmdPhysicalOwners(roots: IndexedRoot[]): Promise<void> {
  const files = new WorkspaceFiles(roots.map((root) => root.path));
  const identities = await Promise.all(roots.map(async (root) => {
    try {
      return { root, identity: await files.existingIdentity(root.path) };
    } catch (error) {
      if (isMissingFilesystemPath(error)) {
        // Missing paths have no truthful physical identity. Exact lexical
        // duplicates remain caught by qmdCollectionConfig below.
        return { root, identity: null };
      }
      throw error;
    }
  }));
  const rootsByIdentity = new Map<string, IndexedRoot[]>();
  for (const { root, identity } of identities) {
    if (!identity) {
      continue;
    }
    const group = rootsByIdentity.get(identity) ?? [];
    group.push(root);
    rootsByIdentity.set(identity, group);
  }
  for (const [identity, group] of rootsByIdentity) {
    if (group.length > 1) {
      throw new QmdCollectionConfigurationError(
        `QMD physical root identity ${identity} is shared by configured Indexed Roots ${group.map((root) => `${root.id} (${root.path})`).join(", ")}. Configure one policy per physical root.`,
      );
    }
  }
}

async function rootsNeedingQmdCollectionReindex(
  qmd: QmdModule,
  runtimeRoot: string,
  roots: IndexedRoot[],
  collections: QmdCollectionIdentity,
): Promise<IndexedRoot[]> {
  if (!(await pathExists(getQmdDbPath(runtimeRoot)))) {
    return [];
  }
  let store: QmdStore | null = null;
  try {
    store = await qmd.createStore({ dbPath: getQmdDbPath(runtimeRoot) });
    const existing = await store.listCollections();
    const reindex = await Promise.all(roots.map(async (root) => {
      const matches = await Promise.all(existing
        .filter((collection) => collection.name !== collections.nameFor(root))
        .map((collection) => existingQmdCollectionMatchesRoot(collection.pwd, root)));
      return matches.some(Boolean) ? root : null;
    }));
    return reindex.filter((root): root is IndexedRoot => root !== null);
  } finally {
    await store?.close();
  }
}

async function existingQmdCollectionMatchesRoot(storedPath: string, root: IndexedRoot): Promise<boolean> {
  if (path.resolve(storedPath) === path.resolve(root.path)) {
    return true;
  }
  // WorkspaceFiles owns the canonical realpath containment policy. Comparing
  // each candidate as a configured root keeps this repair check from
  // inventing a second filesystem-identity rule.
  const files = new WorkspaceFiles([root.path, storedPath]);
  try {
    const [rootIdentity, storedIdentity] = await Promise.all([
      files.existingIdentity(root.path),
      files.existingIdentity(storedPath),
    ]);
    return rootIdentity === storedIdentity;
  } catch (error) {
    if (isMissingFilesystemPath(error)) {
      // A missing stale path cannot truthfully prove a physical alias. The
      // equal-lexical-path case returned above remains the narrow fallback.
      return false;
    }
    throw error;
  }
}

function pendingQmdCollectionReindexPath(runtimeRoot: string): string {
  return path.join(getQmdRuntimePath(runtimeRoot), QMD_PENDING_COLLECTION_REINDEX_FILE);
}

async function hasPendingQmdCollectionReindex(runtimeRoot: string): Promise<boolean> {
  return pathExists(pendingQmdCollectionReindexPath(runtimeRoot));
}

async function writePendingQmdCollectionReindex(runtimeRoot: string): Promise<void> {
  const markerPath = pendingQmdCollectionReindexPath(runtimeRoot);
  const temporaryPath = `${markerPath}.tmp`;
  await writeFile(temporaryPath, "", "utf8");
  await rename(temporaryPath, markerPath);
}

async function clearPendingQmdCollectionReindex(runtimeRoot: string): Promise<void> {
  await rm(pendingQmdCollectionReindexPath(runtimeRoot), { force: true });
}

function isMissingFilesystemPath(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ENOTDIR");
}

function mapQmdResult(rawResult: unknown, collections: QmdCollectionIdentity): IndexSearchResult | null {
  if (!rawResult || typeof rawResult !== "object") {
    return null;
  }
  const result = rawResult as Record<string, unknown>;
  const displayPath = stringValue(result.displayPath) ?? stringValue(result.file) ?? stringValue(result.filepath);
  const filePath = resolveQmdPath(displayPath, collections) ?? stringValue(result.filepath);
  if (!filePath) {
    return null;
  }

  const title = stringValue(result.title) ?? path.basename(filePath, path.extname(filePath));
  const snippet = stringValue(result.snippet) ?? stringValue(result.bestChunk) ?? "";
  return {
    filePath,
    title,
    snippet: snippet.slice(0, 800),
    score: numberValue(result.score) ?? 0,
    docid: stringValue(result.docid) ? `#${String(result.docid).replace(/^#/, "")}` : undefined,
    source: "qmd",
  };
}

function qmdRawResultScore(rawResult: unknown): number | null {
  if (!rawResult || typeof rawResult !== "object") {
    return null;
  }
  return numberValue((rawResult as Record<string, unknown>).score);
}

function deduplicateQmdCandidates(candidates: QmdResultCandidate[]): QmdResultCandidate[] {
  const byIdentity = new Map<string, QmdResultCandidate>();
  for (const candidate of candidates) {
    const existing = byIdentity.get(candidate.identity);
    if (!existing || compareQmdCandidates(candidate, existing) < 0) {
      byIdentity.set(candidate.identity, candidate);
    }
  }
  return [...byIdentity.values()].sort(compareQmdCandidates);
}

function compareQmdCandidates(left: QmdResultCandidate, right: QmdResultCandidate): number {
  return right.result.score - left.result.score
    || compareText(left.identity, right.identity)
    || compareText(left.result.filePath, right.result.filePath)
    || compareText(left.result.docid ?? "", right.result.docid ?? "");
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function resolveQmdPath(displayPath: string | null, collections: QmdCollectionIdentity): string | null {
  if (!displayPath) {
    return null;
  }
  const withoutScheme = displayPath.replace(/^qmd:\/\//, "");
  const [collection, ...segments] = withoutScheme.split("/");
  if (!collection || segments.length === 0) {
    return path.isAbsolute(withoutScheme) ? withoutScheme : null;
  }
  if (segments.includes("..")) {
    return null;
  }
  const root = collections.rootFor(collection);
  return root ? path.join(root.path, ...segments) : null;
}

function latestCollectionUpdate(collections: Array<{ lastUpdated?: unknown; lastUpdatedAt?: unknown; last_updated?: unknown }>): string | null {
  const values = collections
    .map((collection) => stringValue(collection.lastUpdated) ?? stringValue(collection.lastUpdatedAt) ?? stringValue(collection.last_updated))
    .filter((value): value is string => Boolean(value))
    .sort();
  return values.at(-1) ?? null;
}

async function isAuthorizedIndexedRootPath(indexedRootFiles: WorkspaceFiles, targetPath: string): Promise<boolean> {
  try {
    await indexedRootFiles.existing(targetPath);
    return true;
  } catch {
    // A stale, unreadable, or escaping QMD path is not an authorized result.
    return false;
  }
}

async function authorizedIndexedRootIdentity(
  indexedRootFiles: WorkspaceFiles,
  targetPath: string,
): Promise<string | null> {
  try {
    return await indexedRootFiles.existingIdentity(targetPath);
  } catch {
    return null;
  }
}

function isDocid(value: string): boolean {
  return /^#[a-zA-Z0-9]+$/.test(value.trim());
}

async function readAuthorizedBoundedContent(
  filePath: string,
  indexedRootFiles: WorkspaceFiles,
  maxLines: number,
): Promise<{ body: string; identity: string } | null> {
  const identity = await authorizedIndexedRootIdentity(indexedRootFiles, filePath);
  if (!identity) {
    return null;
  }
  return {
    body: sliceLines(await readFile(filePath, "utf8"), undefined, maxLines),
    identity,
  };
}

function droppedQmdResultWarning(count: number): string {
  return `Dropped ${count} invalid or stale QMD ${count === 1 ? "result" : "results"}.`;
}

function sliceLines(text: string, fromLine?: number, maxLines?: number): string {
  const lines = text.split("\n");
  const startIndex = Math.max((fromLine ?? 1) - 1, 0);
  const endIndex = maxLines ? startIndex + maxLines : undefined;
  return lines.slice(startIndex, endIndex).join("\n");
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function qmdFallbackWarning(error: unknown): string {
  const message = errorMessage(error);
  if (isNativeAbiMismatch(message)) {
    return `QMD native ABI mismatch (${message}); using degraded filesystem search.`;
  }
  const lowerMessage = message.toLowerCase();
  if (
    lowerMessage.includes("vec0") ||
    lowerMessage.includes("sqlite-vec") ||
    lowerMessage.includes("no such module")
  ) {
    return `QMD vec0 extension is unavailable (${message}); using degraded filesystem search.`;
  }
  return `QMD search failed (${message}); using degraded filesystem search.`;
}

function qmdRuntimeRecoveryWarning(error: unknown): string | null {
  const message = errorMessage(error);
  if (!isNativeAbiMismatch(message)) return null;
  return "QMD native ABI mismatch. Reinstall the packaged app from a checkout with `./scripts/install-mac-app --with-cli`; Exograph runs QMD in its managed desktop runtime.";
}

function isNativeAbiMismatch(message: string): boolean {
  const lowerMessage = message.toLowerCase();
  return lowerMessage.includes("node_module_version")
    || lowerMessage.includes("was compiled against")
    || lowerMessage.includes("abi")
    || lowerMessage.includes("dlopen");
}
