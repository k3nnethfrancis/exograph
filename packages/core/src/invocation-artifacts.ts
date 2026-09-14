import { createHash, randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import path from "node:path";

import {
  INVOCATION_MANIFEST_VERSION,
  type InvocationChangeset,
  type InvocationFileState,
  type InvocationWorkspaceManifest,
} from "./invocation-changeset";
import { safeStoreSegment } from "./store-paths";

export type InvocationManifestPhase = "launch" | "settled";
export type InvocationReviewAction = "keep" | "reject";
export type InvocationReviewJournalEntryStatus = "pending" | "applied" | "conflict";
export type InvocationReviewMutationPhase = "planned" | "quarantined" | "replacement-installed";

export interface InvocationReviewMutation {
  quarantinePath?: string;
  phase: InvocationReviewMutationPhase;
}

export interface InvocationCleanBaseRef {
  version: 1;
  capturedAt: string;
  file: InvocationFileState;
}

export interface InvocationReviewJournalEntry {
  changeId: string;
  action: InvocationReviewAction;
  status: InvocationReviewJournalEntryStatus;
  completedAt?: string;
  reason?: string;
  acceptedSha256?: string | null;
  mutation?: InvocationReviewMutation;
}

export interface InvocationReviewJournal {
  version: 1;
  createdAt: string;
  updatedAt: string;
  entries: InvocationReviewJournalEntry[];
}

export interface InvocationArtifactRecovery {
  invocationId: string;
  cleanBase: InvocationCleanBaseRef | null;
  launchManifest: InvocationWorkspaceManifest | null;
  settledManifest: InvocationWorkspaceManifest | null;
  reviewJournal: InvocationReviewJournal | null;
}

/** Durable identity for a headless invocation process group. */
export interface InvocationProcessOwnership {
  version: 1;
  kind: "posix-process-group";
  pid: number;
  processGroupId: number;
  ownerToken: string;
  launchedAt: string;
}

export interface InvocationManifestCaptureOptions {
  capturedAt?: string;
  maxConcurrency?: number;
  maxAttempts?: number;
  maxFiles?: number;
  maxFileBytes?: number;
  maxTotalBytes?: number;
  maxElapsedMs?: number;
}

export type InvocationCaptureBudget = "file-count" | "file-bytes" | "total-bytes" | "elapsed-time";

export class InvocationCaptureBudgetError extends Error {
  readonly code = "invocation-capture-budget-exceeded";

  constructor(
    readonly budget: InvocationCaptureBudget,
    readonly limit: number,
    readonly observed: number,
  ) {
    super(`Invocation capture exceeded its ${budget} budget (${observed} > ${limit}).`);
    this.name = "InvocationCaptureBudgetError";
  }
}

export interface InvocationArtifactCompactionReport {
  beforeObjectCount: number;
  beforeBytes: number;
  retainedObjectCount: number;
  retainedBytes: number;
  removedObjectCount: number;
  removedBytes: number;
}

export class InvocationArtifactCompactionError extends Error {
  readonly code = "invocation-artifact-compaction-failed";

  constructor(
    readonly report: InvocationArtifactCompactionReport,
    readonly failures: readonly string[],
  ) {
    super(`Invocation artifact compaction retained all required snapshots but could not remove ${failures.length} stale artifact(s).`);
    this.name = "InvocationArtifactCompactionError";
  }
}

export interface InvocationCleanBaseInput {
  path: string;
  content: string | Uint8Array;
  capturedAt?: string;
  mode?: number;
}

export interface InvocationReviewJournalInput {
  changeId: string;
  action: InvocationReviewAction;
}

export interface InvocationLaunchArtifactInput {
  noteRoots: readonly string[];
  cleanBase: InvocationCleanBaseInput;
  capture?: InvocationManifestCaptureOptions;
}

export interface InvocationLaunchArtifacts {
  cleanBase: InvocationCleanBaseRef;
  launchManifest: InvocationWorkspaceManifest;
}

interface InvocationArtifactLayout {
  invocationDir: string;
  objectsDir: string;
  cleanBasePath: string;
  launchManifestPath: string;
  settledManifestPath: string;
  reviewJournalPath: string;
  processOwnershipPath: string;
}

interface CaptureCandidate {
  path: string;
}

interface CapturedObject {
  sha256: string;
  byteLength: number;
  snapshotRef: string;
  mediaType: "text" | "binary";
}

interface FileIdentity {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  mode: number;
}

interface CapturedFile {
  state: InvocationFileState;
  identity: FileIdentity;
}

interface CaptureBudgetState {
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
  startedAt: number;
  maxElapsedMs: number;
  deadline: number;
  totalBytes: number;
}

const DEFAULT_CAPTURE_CONCURRENCY = 4;
const MAX_CAPTURE_CONCURRENCY = 16;
const DEFAULT_CAPTURE_ATTEMPTS = 3;
const DEFAULT_MAX_CAPTURE_FILES = 100_000;
const DEFAULT_MAX_CAPTURE_FILE_BYTES = 512 * 1024 * 1024;
const DEFAULT_MAX_CAPTURE_TOTAL_BYTES = 20 * 1024 * 1024 * 1024;
const DEFAULT_MAX_CAPTURE_ELAPSED_MS = 120_000;
const TEXT_FILE_EXTENSIONS = new Set([
  ".css", ".csv", ".html", ".js", ".json", ".jsx", ".md", ".markdown",
  ".mjs", ".sh", ".toml", ".ts", ".tsx", ".txt", ".xml", ".yaml", ".yml",
]);
const IGNORED_CAPTURE_DIRECTORIES = new Set([
  ".exograph", ".exograph-dev", ".git", "node_modules",
]);

/** Durable, invocation-scoped snapshots and recovery artifacts. */
export class InvocationArtifactStore {
  constructor(private readonly invocationsDir: string) {}

  async captureLaunchArtifacts(
    invocationId: string,
    input: InvocationLaunchArtifactInput,
  ): Promise<InvocationLaunchArtifacts> {
    const roots = await canonicalNoteRoots(input.noteRoots);
    const cleanPath = await canonicalExistingFile(input.cleanBase.path);
    if (!roots.some((root) => isWithin(root, cleanPath))) {
      throw new Error(`Invocation document is outside the authorized Note Roots: ${cleanPath}`);
    }
    const cleanBase = await this.captureCleanBase(invocationId, { ...input.cleanBase, path: cleanPath });
    const launchManifest = await this.captureManifest(invocationId, "launch", roots, input.capture);
    return { cleanBase, launchManifest };
  }

  async captureManifest(
    invocationId: string,
    phase: InvocationManifestPhase,
    noteRoots: readonly string[],
    options: InvocationManifestCaptureOptions = {},
  ): Promise<InvocationWorkspaceManifest> {
    return this.captureManifestInternal(invocationId, phase, noteRoots, options);
  }

  /**
   * Capture an exact post-command manifest while reusing launch snapshots whose
   * content is unchanged. Every file is still hashed, so this remains agnostic
   * to which harness or filesystem tool made the changes.
   */
  async captureSettledManifest(
    invocationId: string,
    noteRoots: readonly string[],
    launch: InvocationWorkspaceManifest,
    options: InvocationManifestCaptureOptions = {},
  ): Promise<InvocationWorkspaceManifest> {
    return this.captureManifestInternal(invocationId, "settled", noteRoots, options, launch);
  }

  private async captureManifestInternal(
    invocationId: string,
    phase: InvocationManifestPhase,
    noteRoots: readonly string[],
    options: InvocationManifestCaptureOptions,
    reusable?: InvocationWorkspaceManifest,
  ): Promise<InvocationWorkspaceManifest> {
    const layout = this.layout(invocationId);
    const roots = await canonicalNoteRoots(noteRoots);
    if (reusable && !sameStrings(reusable.noteRoots, roots)) {
      throw new Error("Invocation launch and settled manifests must use the same Note Roots.");
    }
    const existing = await this.readManifest(invocationId, phase);
    if (existing) {
      if (!sameStrings(existing.noteRoots, roots)) {
        throw new Error(`Invocation ${phase} manifest already exists for different Note Roots.`);
      }
      return existing;
    }
    const maxAttempts = boundedInteger(options.maxAttempts, DEFAULT_CAPTURE_ATTEMPTS, 1, 8);
    const maxConcurrency = boundedInteger(options.maxConcurrency, DEFAULT_CAPTURE_CONCURRENCY, 1, MAX_CAPTURE_CONCURRENCY);
    const startedAt = Date.now();
    const maxElapsedMs = boundedInteger(options.maxElapsedMs, DEFAULT_MAX_CAPTURE_ELAPSED_MS, 1, Number.MAX_SAFE_INTEGER);
    const budget: CaptureBudgetState = {
      maxFiles: boundedInteger(options.maxFiles, DEFAULT_MAX_CAPTURE_FILES, 1, Number.MAX_SAFE_INTEGER),
      maxFileBytes: boundedInteger(options.maxFileBytes, DEFAULT_MAX_CAPTURE_FILE_BYTES, 1, Number.MAX_SAFE_INTEGER),
      maxTotalBytes: boundedInteger(options.maxTotalBytes, DEFAULT_MAX_CAPTURE_TOTAL_BYTES, 1, Number.MAX_SAFE_INTEGER),
      startedAt,
      maxElapsedMs,
      deadline: startedAt + maxElapsedMs,
      totalBytes: 0,
    };
    await mkdir(layout.objectsDir, { recursive: true });
    await cleanupTemporaryObjects(layout.objectsDir);
    const baselineObjects = new Set(await readdir(layout.objectsDir));

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      let completed = false;
      budget.totalBytes = 0;
      try {
        const before = await enumerateCaptureScope(roots, budget);
        let capturedFiles: Array<CapturedFile | null>;
        capturedFiles = await mapLimited(before.files, maxConcurrency, async (candidate) => {
          try {
            return reusable
              ? await this.captureFileForSettlement(layout, candidate, budget, reusable.files[candidate.path])
              : await this.captureFile(layout, candidate, budget);
          } catch (error) {
            if (isNodeErrorCode(error, "ENOENT")) return null;
            throw error;
          }
        });
        const after = await enumerateCaptureScope(roots, budget);
        if (!sameStrings(before.files.map((entry) => entry.path), after.files.map((entry) => entry.path))) continue;
        if (capturedFiles.some((entry) => entry === null)) continue;
        const captured = capturedFiles as CapturedFile[];
        ensureElapsedBudget(budget);
        const stillCurrent = await mapLimited(captured, maxConcurrency, validateCapturedFile);
        if (stillCurrent.some((entry) => !entry)) continue;

        const manifest: InvocationWorkspaceManifest = {
          version: INVOCATION_MANIFEST_VERSION,
          capturedAt: options.capturedAt ?? new Date().toISOString(),
          noteRoots: roots,
          files: Object.fromEntries(captured.map(({ state }) => [state.path, state])),
          directories: after.directories,
        };
        await writeJsonAtomically(this.manifestPath(layout, phase), manifest);
        completed = true;
        return manifest;
      } catch (error) {
        if (!isNodeErrorCode(error, "EAGAIN")) throw error;
      } finally {
        if (!completed) await cleanupNewObjects(layout.objectsDir, baselineObjects);
      }
    }

    throw new Error(`Invocation ${phase} capture did not reach a stable filesystem state after ${maxAttempts} attempts.`);
  }

  async readManifest(invocationId: string, phase: InvocationManifestPhase): Promise<InvocationWorkspaceManifest | null> {
    const layout = this.layout(invocationId);
    return normalizeManifest(await readJsonOrNull(this.manifestPath(layout, phase)));
  }

  async captureCleanBase(invocationId: string, input: InvocationCleanBaseInput): Promise<InvocationCleanBaseRef> {
    if (!path.isAbsolute(input.path)) throw new Error("Invocation clean-base path must be absolute.");
    const layout = this.layout(invocationId);
    await mkdir(layout.objectsDir, { recursive: true });
    const bytes = typeof input.content === "string" ? Buffer.from(input.content, "utf8") : Buffer.from(input.content);
    const canonicalPath = await canonicalExistingFile(input.path);
    const sourceInfo = await lstat(canonicalPath);
    const contentSha256 = sha256(bytes);
    const existing = await this.readCleanBase(invocationId);
    if (existing) {
      if (existing.file.path === canonicalPath && existing.file.sha256 === contentSha256 &&
        existing.file.byteLength === bytes.byteLength) return existing;
      throw new Error(`Invocation ${invocationId} already has a different clean base.`);
    }
    const captured = await this.captureBytes(layout, bytes, canonicalPath);
    const cleanBase: InvocationCleanBaseRef = {
      version: 1,
      capturedAt: input.capturedAt ?? new Date().toISOString(),
      file: {
        path: canonicalPath,
        ...captured,
        mode: (input.mode ?? sourceInfo.mode) & 0o777,
      },
    };
    await writeJsonAtomically(layout.cleanBasePath, cleanBase);
    return cleanBase;
  }

  async readCleanBase(invocationId: string): Promise<InvocationCleanBaseRef | null> {
    return normalizeCleanBase(await readJsonOrNull(this.layout(invocationId).cleanBasePath));
  }

  async readSnapshot(invocationId: string, state: InvocationFileState): Promise<Buffer | null> {
    if (!normalizeFileState(state)) throw new Error("Invocation snapshot reference is invalid.");
    const objectPath = this.objectPath(this.layout(invocationId), state.sha256);
    try {
      const bytes = await readFile(objectPath);
      const digest = sha256(bytes);
      if (digest !== state.sha256 || bytes.byteLength !== state.byteLength) {
        throw new Error(`Invocation snapshot ${state.sha256} failed integrity validation.`);
      }
      return bytes;
    } catch (error) {
      if (isNodeErrorCode(error, "ENOENT")) return null;
      throw error;
    }
  }

  async beginReviewJournal(
    invocationId: string,
    inputs: readonly InvocationReviewJournalInput[],
    createdAt = new Date().toISOString(),
  ): Promise<InvocationReviewJournal> {
    const seen = new Set<string>();
    const entries = inputs.map((input) => {
      if (!input.changeId.trim() || seen.has(input.changeId)) throw new Error("Review journal change ids must be unique and non-empty.");
      seen.add(input.changeId);
      return { changeId: input.changeId, action: input.action, status: "pending" as const };
    });
    const existing = await this.readReviewJournal(invocationId);
    if (existing) {
      const samePlan = existing.entries.length === entries.length && existing.entries.every((entry, index) =>
        entry.changeId === entries[index]?.changeId && entry.action === entries[index]?.action);
      if (samePlan) return existing;
      throw new Error(`Invocation ${invocationId} already has a different review journal.`);
    }
    const journal: InvocationReviewJournal = { version: 1, createdAt, updatedAt: createdAt, entries };
    await writeJsonAtomically(this.layout(invocationId).reviewJournalPath, journal);
    return journal;
  }

  async updateReviewJournalEntry(
    invocationId: string,
    changeId: string,
    outcome: { status: "applied"; completedAt?: string; acceptedSha256?: string | null } | { status: "conflict"; reason: string; completedAt?: string },
  ): Promise<InvocationReviewJournal> {
    if (outcome.status === "applied" && outcome.acceptedSha256 !== undefined && outcome.acceptedSha256 !== null &&
      !/^[a-f0-9]{64}$/.test(outcome.acceptedSha256)) {
      throw new Error("Review journal accepted hashes must be lowercase SHA-256 values or null.");
    }
    const current = await this.readReviewJournal(invocationId);
    if (!current) throw new Error(`Invocation ${invocationId} has no review journal.`);
    let found = false;
    const completedAt = outcome.completedAt ?? new Date().toISOString();
    const entries = current.entries.map((entry) => {
      if (entry.changeId !== changeId) return entry;
      found = true;
      if (entry.status !== "pending") {
        const sameOutcome = entry.status === outcome.status &&
          (outcome.status !== "conflict" || entry.reason === outcome.reason) &&
          (outcome.status !== "applied" || outcome.acceptedSha256 === undefined || entry.acceptedSha256 === outcome.acceptedSha256);
        if (sameOutcome) return entry;
        throw new Error(`Invocation review change ${changeId} is already ${entry.status}.`);
      }
      const { mutation: _mutation, ...terminalEntry } = entry;
      return {
        ...terminalEntry,
        status: outcome.status,
        completedAt,
        ...(outcome.status === "conflict" ? { reason: outcome.reason } : {}),
        ...(outcome.status === "applied" && outcome.acceptedSha256 !== undefined
          ? { acceptedSha256: outcome.acceptedSha256 }
          : {}),
      };
    });
    if (!found) throw new Error(`Invocation review change ${changeId} was not found.`);
    const journal = { ...current, updatedAt: completedAt, entries };
    await writeJsonAtomically(this.layout(invocationId).reviewJournalPath, journal);
    return journal;
  }

  async updateReviewJournalMutation(
    invocationId: string,
    changeId: string,
    mutation: InvocationReviewMutation,
    updatedAt = new Date().toISOString(),
  ): Promise<InvocationReviewJournal> {
    const current = await this.readReviewJournal(invocationId);
    if (!current) throw new Error(`Invocation ${invocationId} has no review journal.`);
    let found = false;
    const entries = current.entries.map((entry) => {
      if (entry.changeId !== changeId) return entry;
      found = true;
      if (entry.status !== "pending" || entry.action !== "reject") {
        throw new Error(`Invocation review change ${changeId} cannot record a rejection mutation.`);
      }
      if (entry.mutation?.quarantinePath !== undefined &&
        mutation.quarantinePath !== entry.mutation.quarantinePath) {
        throw new Error(`Invocation review change ${changeId} cannot change its quarantine path.`);
      }
      if (entry.mutation && mutationPhaseRank(mutation.phase) < mutationPhaseRank(entry.mutation.phase)) {
        throw new Error(`Invocation review change ${changeId} cannot regress its mutation phase.`);
      }
      return { ...entry, mutation };
    });
    if (!found) throw new Error(`Invocation review change ${changeId} was not found.`);
    const journal = { ...current, updatedAt, entries };
    await writeJsonAtomically(this.layout(invocationId).reviewJournalPath, journal);
    return journal;
  }

  async readReviewJournal(invocationId: string): Promise<InvocationReviewJournal | null> {
    return normalizeReviewJournal(await readJsonOrNull(this.layout(invocationId).reviewJournalPath));
  }

  async clearReviewJournal(invocationId: string): Promise<void> {
    await rm(this.layout(invocationId).reviewJournalPath, { force: true });
  }

  async writeProcessOwnership(invocationId: string, ownership: InvocationProcessOwnership): Promise<void> {
    const normalized = normalizeProcessOwnership(ownership);
    if (!normalized) throw new Error("Invocation process ownership is invalid.");
    await writeJsonAtomically(this.layout(invocationId).processOwnershipPath, normalized);
  }

  async readProcessOwnership(invocationId: string): Promise<InvocationProcessOwnership | null> {
    return normalizeProcessOwnership(await readJsonOrNull(this.layout(invocationId).processOwnershipPath));
  }

  async clearProcessOwnership(invocationId: string): Promise<void> {
    await rm(this.layout(invocationId).processOwnershipPath, { force: true });
  }

  async readRecovery(invocationId: string): Promise<InvocationArtifactRecovery> {
    const [cleanBase, launchManifest, settledManifest, reviewJournal] = await Promise.all([
      this.readCleanBase(invocationId),
      this.readManifest(invocationId, "launch"),
      this.readManifest(invocationId, "settled"),
      this.readReviewJournal(invocationId),
    ]);
    return { invocationId, cleanBase, launchManifest, settledManifest, reviewJournal };
  }

  async listRecoverable(): Promise<InvocationArtifactRecovery[]> {
    let entries;
    try {
      entries = await readdir(this.invocationsDir, { withFileTypes: true });
    } catch (error) {
      if (isNodeErrorCode(error, "ENOENT")) return [];
      throw error;
    }
    const invocationIds = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
    const recoveries = await Promise.all(invocationIds.map((invocationId) => this.readRecovery(invocationId)));
    return recoveries.filter((entry) => entry.launchManifest || entry.settledManifest || entry.reviewJournal || entry.cleanBase);
  }

  /**
   * Collapse full-root capture artifacts once an exact Changeset is durable.
   * History and unresolved review need only the clean base, every Changeset
   * before/after state, and the tagged document's launch/settled proposal.
   * Manifest roots remain immutable review authority; unrelated file snapshots
   * are never retained as an accidental second workspace history.
   */
  async compact(invocationId: string, changeset: InvocationChangeset): Promise<InvocationArtifactCompactionReport> {
    const layout = this.layout(invocationId);
    const [cleanBase, launch, settled] = await Promise.all([
      this.readCleanBase(invocationId),
      this.readManifest(invocationId, "launch"),
      this.readManifest(invocationId, "settled"),
    ]);
    if (!launch || !settled) {
      throw new Error(`Invocation ${invocationId} cannot compact before launch and settled manifests are durable.`);
    }

    const requiredStates = [
      ...(cleanBase ? [cleanBase.file] : []),
      ...changeset.files.flatMap((change) => [change.before, change.after].filter(
        (state): state is InvocationFileState => Boolean(state),
      )),
      ...(cleanBase?.file.path && launch.files[cleanBase.file.path] ? [launch.files[cleanBase.file.path]!] : []),
      ...(cleanBase?.file.path && settled.files[cleanBase.file.path] ? [settled.files[cleanBase.file.path]!] : []),
    ];
    const retainedHashes = new Set(requiredStates.map((state) => state.sha256));
    for (const state of requiredStates) {
      if (!await this.readSnapshot(invocationId, state)) {
        throw new Error(`Invocation snapshot ${state.sha256} is unavailable; artifacts were not compacted.`);
      }
    }

    const launchPaths = new Set(changeset.files.flatMap((change) => change.before ? [change.before.path] : []));
    const settledPaths = new Set(changeset.files.flatMap((change) => change.after ? [change.after.path] : []));
    if (cleanBase) {
      launchPaths.add(cleanBase.file.path);
      settledPaths.add(cleanBase.file.path);
    }
    const compactLaunch = compactManifest(launch, launchPaths);
    const compactSettled = compactManifest(settled, settledPaths);
    await writeJsonAtomically(layout.launchManifestPath, compactLaunch);
    await writeJsonAtomically(layout.settledManifestPath, compactSettled);

    let objectEntries: string[];
    try {
      objectEntries = await readdir(layout.objectsDir);
    } catch (error) {
      if (isNodeErrorCode(error, "ENOENT")) objectEntries = [];
      else throw error;
    }
    const measurements = await Promise.all(objectEntries.map(async (entry) => {
      const target = path.join(layout.objectsDir, entry);
      try {
        return { entry, target, bytes: (await lstat(target)).size };
      } catch (error) {
        if (isNodeErrorCode(error, "ENOENT")) return { entry, target, bytes: 0 };
        throw error;
      }
    }));
    const retained = measurements.filter(({ entry }) => retainedHashes.has(entry));
    const stale = measurements.filter(({ entry }) => !retainedHashes.has(entry));
    const removals = await mapLimited(stale, MAX_CAPTURE_CONCURRENCY, async (artifact) => {
      try {
        await rm(artifact.target, { force: true });
        return { removed: true as const, bytes: artifact.bytes, failure: null };
      } catch (error) {
        return {
          removed: false as const,
          bytes: 0,
          failure: `${artifact.entry}: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    });
    const removedObjectCount = removals.filter((entry) => entry.removed).length;
    const removedBytes = removals.reduce((total, entry) => total + entry.bytes, 0);
    const failures = removals.flatMap((entry) => entry.failure ? [entry.failure] : []);
    if (removedObjectCount > 0) await syncDirectory(layout.objectsDir);
    const report: InvocationArtifactCompactionReport = {
      beforeObjectCount: measurements.length,
      beforeBytes: measurements.reduce((total, entry) => total + entry.bytes, 0),
      retainedObjectCount: retained.length,
      retainedBytes: retained.reduce((total, entry) => total + entry.bytes, 0),
      removedObjectCount,
      removedBytes,
    };
    if (failures.length > 0) throw new InvocationArtifactCompactionError(report, failures);
    return report;
  }

  private layout(invocationId: string): InvocationArtifactLayout {
    const invocationDir = path.join(this.invocationsDir, safeStoreSegment(invocationId));
    return {
      invocationDir,
      objectsDir: path.join(invocationDir, "files", "objects"),
      cleanBasePath: path.join(invocationDir, "clean-base.json"),
      launchManifestPath: path.join(invocationDir, "launch-manifest.json"),
      settledManifestPath: path.join(invocationDir, "settled-manifest.json"),
      reviewJournalPath: path.join(invocationDir, "review-journal.json"),
      processOwnershipPath: path.join(invocationDir, "process-ownership.json"),
    };
  }

  private manifestPath(layout: InvocationArtifactLayout, phase: InvocationManifestPhase): string {
    return phase === "launch" ? layout.launchManifestPath : layout.settledManifestPath;
  }

  private objectPath(layout: InvocationArtifactLayout, digest: string): string {
    return path.join(layout.objectsDir, digest);
  }

  private async captureFile(
    layout: InvocationArtifactLayout,
    candidate: CaptureCandidate,
    budget: CaptureBudgetState,
  ): Promise<CapturedFile> {
    const captured = await captureFileAtomically(candidate.path, layout.objectsDir, budget);
    return {
      state: { path: candidate.path, ...captured.object, mode: captured.identity.mode & 0o777 },
      identity: captured.identity,
    };
  }

  private async captureFileForSettlement(
    layout: InvocationArtifactLayout,
    candidate: CaptureCandidate,
    budget: CaptureBudgetState,
    launchState?: InvocationFileState,
  ): Promise<CapturedFile> {
    if (launchState) {
      const current = await hashFileAtomically(candidate.path, budget);
      if (
        current.object.sha256 === launchState.sha256 &&
        current.object.byteLength === launchState.byteLength &&
        (current.identity.mode & 0o777) === launchState.mode
      ) {
        return { state: launchState, identity: current.identity };
      }
      // The settled budget describes the current workspace once. A changed
      // file must be read again to create its immutable snapshot, so transfer
      // the bytes charged by the comparison pass to the snapshot pass.
      budget.totalBytes -= current.object.byteLength;
    }
    return this.captureFile(layout, candidate, budget);
  }

  private async captureBytes(layout: InvocationArtifactLayout, bytes: Buffer, sourcePath: string): Promise<CapturedObject> {
    const digest = sha256(bytes);
    const objectPath = this.objectPath(layout, digest);
    await writeBufferObjectAtomically(objectPath, bytes);
    return {
      sha256: digest,
      byteLength: bytes.byteLength,
      snapshotRef: snapshotRef(digest),
      mediaType: classifyMediaType(sourcePath, bytes.subarray(0, 8192)),
    };
  }
}

async function canonicalNoteRoots(noteRoots: readonly string[]): Promise<string[]> {
  if (noteRoots.length === 0) throw new Error("Invocation capture requires at least one Note Root.");
  const roots = new Set<string>();
  for (const input of noteRoots) {
    const resolved = path.resolve(input);
    try {
      const canonical = await realpath(resolved);
      if (!(await lstat(canonical)).isDirectory()) throw new Error(`Note Root is not a directory: ${resolved}`);
      roots.add(canonical);
    } catch (error) {
      if (isNodeErrorCode(error, "ENOENT")) throw new Error(`Note Root is unavailable: ${resolved}`);
      throw error;
    }
  }
  return [...roots]
    .sort((left, right) => left.length - right.length || left.localeCompare(right))
    .filter((candidate, index, all) => !all.slice(0, index).some((parent) => isWithin(parent, candidate)))
    .sort();
}

async function canonicalExistingFile(filePath: string): Promise<string> {
  try {
    const canonical = await realpath(path.resolve(filePath));
    if (!(await lstat(canonical)).isFile()) throw new Error(`Invocation document is not a file: ${filePath}`);
    return canonical;
  } catch (error) {
    if (isNodeErrorCode(error, "ENOENT")) throw new Error(`Invocation document is unavailable: ${filePath}`);
    throw error;
  }
}

async function enumerateCaptureScope(
  noteRoots: readonly string[],
  budget: CaptureBudgetState,
): Promise<{ files: CaptureCandidate[]; directories: string[] }> {
  const files: CaptureCandidate[] = [];
  const directories: string[] = [];
  for (const root of noteRoots) await visit(root, root);
  files.sort((left, right) => left.path.localeCompare(right.path));
  directories.sort();
  return { files, directories };

  async function visit(root: string, directory: string): Promise<void> {
    ensureElapsedBudget(budget);
    const canonicalDirectory = await realpath(directory);
    if (!isWithin(root, canonicalDirectory)) throw new Error(`Capture escaped Note Root: ${directory}`);
    directories.push(canonicalDirectory);
    const entries = (await readdir(canonicalDirectory, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (entry.isDirectory() && IGNORED_CAPTURE_DIRECTORIES.has(entry.name)) continue;
      const entryPath = path.join(canonicalDirectory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        await visit(root, entryPath);
        continue;
      }
      if (!entry.isFile()) continue;
      files.push({ path: entryPath });
      if (files.length > budget.maxFiles) {
        throw new InvocationCaptureBudgetError("file-count", budget.maxFiles, files.length);
      }
    }
  }
}

async function captureFileAtomically(
  sourcePath: string,
  objectsDir: string,
  budget: CaptureBudgetState,
): Promise<{ object: CapturedObject; identity: FileIdentity }> {
  ensureElapsedBudget(budget);
  const temporaryPath = path.join(objectsDir, `.object-${process.pid}-${randomUUID()}.tmp`);
  const source = await open(sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  let before: Stats;
  try {
    before = await source.stat();
    if (before.size > budget.maxFileBytes) {
      throw new InvocationCaptureBudgetError("file-bytes", budget.maxFileBytes, before.size);
    }
  } catch (error) {
    await source.close();
    throw error;
  }
  const input = source.createReadStream({ autoClose: false });
  const digest = createHash("sha256");
  let byteLength = 0;
  let sample = Buffer.alloc(0);
  let output: Awaited<ReturnType<typeof open>> | undefined;
  try {
    output = await open(temporaryPath, "wx");
    for await (const rawChunk of input) {
      ensureElapsedBudget(budget);
      const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
      if (byteLength + chunk.byteLength > budget.maxFileBytes) {
        throw new InvocationCaptureBudgetError("file-bytes", budget.maxFileBytes, byteLength + chunk.byteLength);
      }
      if (budget.totalBytes + chunk.byteLength > budget.maxTotalBytes) {
        throw new InvocationCaptureBudgetError("total-bytes", budget.maxTotalBytes, budget.totalBytes + chunk.byteLength);
      }
      digest.update(chunk);
      byteLength += chunk.byteLength;
      budget.totalBytes += chunk.byteLength;
      if (sample.byteLength < 8192) sample = Buffer.concat([sample, chunk.subarray(0, 8192 - sample.byteLength)]);
      await writeAll(output, chunk);
    }
    await output.sync();
  } catch (error) {
    input.destroy();
    await source.close();
    await rm(temporaryPath, { force: true });
    throw error;
  } finally {
    await output?.close();
  }

  let after: Stats;
  let current: Stats;
  try {
    [after, current] = await Promise.all([source.stat(), stat(sourcePath)]);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  } finally {
    await source.close();
  }
  if (
    !sameIdentity(fileIdentity(before), fileIdentity(after)) ||
    !sameIdentity(fileIdentity(after), fileIdentity(current))
  ) {
    await rm(temporaryPath, { force: true });
    throw Object.assign(new Error(`File changed during invocation capture: ${sourcePath}`), { code: "EAGAIN" });
  }
  const sha256Value = digest.digest("hex");
  const objectPath = path.join(objectsDir, sha256Value);
  try {
    const existing = await stat(objectPath);
    if (!existing.isFile() || existing.size !== byteLength) {
      throw Object.assign(new Error("CAS object is invalid."), { code: "EINVALID" });
    }
    await rm(temporaryPath, { force: true });
  } catch {
    await rename(temporaryPath, objectPath);
    await syncDirectory(objectsDir);
  }
  return {
    object: {
      sha256: sha256Value,
      byteLength,
      snapshotRef: snapshotRef(sha256Value),
      mediaType: classifyMediaType(sourcePath, sample),
    },
    identity: fileIdentity(after),
  };
}

/** Read and validate a file without creating a second durable snapshot. */
async function hashFileAtomically(
  sourcePath: string,
  budget: CaptureBudgetState,
): Promise<{ object: CapturedObject; identity: FileIdentity }> {
  ensureElapsedBudget(budget);
  const source = await open(sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  let before: Stats;
  try {
    before = await source.stat();
    if (before.size > budget.maxFileBytes) {
      throw new InvocationCaptureBudgetError("file-bytes", budget.maxFileBytes, before.size);
    }
  } catch (error) {
    await source.close();
    throw error;
  }
  const input = source.createReadStream({ autoClose: false });
  const digest = createHash("sha256");
  let byteLength = 0;
  let sample = Buffer.alloc(0);
  try {
    for await (const rawChunk of input) {
      ensureElapsedBudget(budget);
      const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
      if (byteLength + chunk.byteLength > budget.maxFileBytes) {
        throw new InvocationCaptureBudgetError("file-bytes", budget.maxFileBytes, byteLength + chunk.byteLength);
      }
      if (budget.totalBytes + chunk.byteLength > budget.maxTotalBytes) {
        throw new InvocationCaptureBudgetError("total-bytes", budget.maxTotalBytes, budget.totalBytes + chunk.byteLength);
      }
      digest.update(chunk);
      byteLength += chunk.byteLength;
      budget.totalBytes += chunk.byteLength;
      if (sample.byteLength < 8192) sample = Buffer.concat([sample, chunk.subarray(0, 8192 - sample.byteLength)]);
    }
  } catch (error) {
    input.destroy();
    await source.close();
    throw error;
  }

  let after: Stats;
  let current: Stats;
  try {
    [after, current] = await Promise.all([source.stat(), stat(sourcePath)]);
  } finally {
    await source.close();
  }
  if (
    !sameIdentity(fileIdentity(before), fileIdentity(after)) ||
    !sameIdentity(fileIdentity(after), fileIdentity(current))
  ) {
    throw Object.assign(new Error(`File changed during invocation capture: ${sourcePath}`), { code: "EAGAIN" });
  }
  const sha256Value = digest.digest("hex");
  return {
    object: {
      sha256: sha256Value,
      byteLength,
      snapshotRef: snapshotRef(sha256Value),
      mediaType: classifyMediaType(sourcePath, sample),
    },
    identity: fileIdentity(after),
  };
}

async function writeAll(handle: Awaited<ReturnType<typeof open>>, bytes: Buffer): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const { bytesWritten } = await handle.write(bytes, offset, bytes.byteLength - offset, null);
    if (bytesWritten === 0) throw new Error("Invocation snapshot write made no progress.");
    offset += bytesWritten;
  }
}

async function validateCapturedFile(captured: CapturedFile): Promise<boolean> {
  try {
    const current = await lstat(captured.state.path);
    return current.isFile() && sameIdentity(captured.identity, fileIdentity(current));
  } catch (error) {
    if (isNodeErrorCode(error, "ENOENT")) return false;
    throw error;
  }
}

function fileIdentity(info: Stats): FileIdentity {
  return {
    dev: info.dev,
    ino: info.ino,
    size: info.size,
    mtimeMs: info.mtimeMs,
    ctimeMs: info.ctimeMs,
    mode: info.mode,
  };
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
    left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs && left.mode === right.mode;
}

async function writeBufferObjectAtomically(target: string, bytes: Buffer): Promise<void> {
  try {
    const existing = await stat(target);
    if (existing.isFile() && existing.size === bytes.byteLength) return;
  } catch (error) {
    if (!isNodeErrorCode(error, "ENOENT")) throw error;
  }
  await mkdir(path.dirname(target), { recursive: true });
  const temporaryPath = path.join(path.dirname(target), `.object-${process.pid}-${randomUUID()}.tmp`);
  try {
    const handle = await open(temporaryPath, "wx");
    try {
      await writeAll(handle, bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      const existing = await stat(target);
      if (!existing.isFile() || existing.size !== bytes.byteLength) {
        throw Object.assign(new Error("CAS object is invalid."), { code: "EINVALID" });
      }
      await rm(temporaryPath, { force: true });
    } catch {
      await rename(temporaryPath, target);
      await syncDirectory(path.dirname(target));
    }
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

async function writeJsonAtomically(target: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true });
  const temporaryPath = path.join(path.dirname(target), `.${path.basename(target)}-${process.pid}-${randomUUID()}.tmp`);
  try {
    const handle = await open(temporaryPath, "wx");
    try {
      await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporaryPath, target);
    await syncDirectory(path.dirname(target));
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } catch (error) {
    if (!isNodeErrorCode(error, "EINVAL") && !isNodeErrorCode(error, "ENOTSUP")) throw error;
  } finally {
    await handle.close();
  }
}

async function readJsonOrNull(target: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(target, "utf8")) as unknown;
  } catch (error) {
    if (isNodeErrorCode(error, "ENOENT")) return null;
    throw error;
  }
}

function normalizeProcessOwnership(value: unknown): InvocationProcessOwnership | null {
  if (value === null) return null;
  if (!value || typeof value !== "object") throw new Error("Invocation process ownership is invalid.");
  const candidate = value as Partial<InvocationProcessOwnership>;
  if (
    candidate.version !== 1 ||
    candidate.kind !== "posix-process-group" ||
    !Number.isSafeInteger(candidate.pid) || candidate.pid! <= 1 ||
    !Number.isSafeInteger(candidate.processGroupId) || candidate.processGroupId !== candidate.pid ||
    typeof candidate.ownerToken !== "string" || !/^[a-f0-9-]{36}$/.test(candidate.ownerToken) ||
    typeof candidate.launchedAt !== "string" || !Number.isFinite(Date.parse(candidate.launchedAt))
  ) {
    throw new Error("Invocation process ownership is invalid.");
  }
  return candidate as InvocationProcessOwnership;
}

function normalizeManifest(value: unknown): InvocationWorkspaceManifest | null {
  if (value === null) return null;
  if (!value || typeof value !== "object") throw new Error("Invocation manifest is invalid.");
  const candidate = value as Partial<InvocationWorkspaceManifest>;
  if (candidate.version !== INVOCATION_MANIFEST_VERSION || typeof candidate.capturedAt !== "string") {
    throw new Error("Invocation manifest is invalid.");
  }
  if (!Array.isArray(candidate.noteRoots) || candidate.noteRoots.length === 0 ||
    !candidate.noteRoots.every((entry) => typeof entry === "string" && path.isAbsolute(entry))) {
    throw new Error("Invocation manifest Note Roots are invalid.");
  }
  if (!candidate.files || typeof candidate.files !== "object" || Array.isArray(candidate.files)) {
    throw new Error("Invocation manifest files are invalid.");
  }
  const files: Record<string, InvocationFileState> = {};
  for (const [filePath, raw] of Object.entries(candidate.files)) {
    const state = normalizeFileState(raw);
    if (!state || state.path !== filePath || !candidate.noteRoots.some((root) => isWithin(root, filePath))) {
      throw new Error(`Invocation manifest file is invalid: ${filePath}`);
    }
    files[filePath] = state;
  }
  if (!Array.isArray(candidate.directories) || !candidate.directories.every((entry) =>
    typeof entry === "string" && candidate.noteRoots!.some((root) => isWithin(root, entry)))) {
    throw new Error("Invocation manifest directories are invalid.");
  }
  return {
    version: INVOCATION_MANIFEST_VERSION,
    capturedAt: candidate.capturedAt,
    noteRoots: [...candidate.noteRoots].sort(),
    files,
    directories: [...candidate.directories].sort(),
  };
}

function normalizeCleanBase(value: unknown): InvocationCleanBaseRef | null {
  if (value === null) return null;
  if (!value || typeof value !== "object") throw new Error("Invocation clean base is invalid.");
  const candidate = value as Partial<InvocationCleanBaseRef>;
  const file = normalizeFileState(candidate.file);
  if (candidate.version !== 1 || typeof candidate.capturedAt !== "string" || !file) {
    throw new Error("Invocation clean base is invalid.");
  }
  return { version: 1, capturedAt: candidate.capturedAt, file };
}

function normalizeFileState(value: unknown): InvocationFileState | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<InvocationFileState>;
  if (typeof candidate.path !== "string" || !path.isAbsolute(candidate.path)) return null;
  if (typeof candidate.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(candidate.sha256)) return null;
  if (candidate.snapshotRef !== snapshotRef(candidate.sha256)) return null;
  if (!Number.isSafeInteger(candidate.byteLength) || candidate.byteLength! < 0) return null;
  if (candidate.mediaType !== "text" && candidate.mediaType !== "binary") return null;
  if (candidate.mode !== undefined && (!Number.isInteger(candidate.mode) || candidate.mode < 0 || candidate.mode > 0o777)) return null;
  return {
    path: path.resolve(candidate.path),
    sha256: candidate.sha256,
    byteLength: candidate.byteLength!,
    snapshotRef: candidate.snapshotRef,
    mediaType: candidate.mediaType,
    ...(candidate.mode === undefined ? {} : { mode: candidate.mode }),
  };
}

function normalizeReviewJournal(value: unknown): InvocationReviewJournal | null {
  if (value === null) return null;
  if (!value || typeof value !== "object") throw new Error("Invocation review journal is invalid.");
  const candidate = value as Partial<InvocationReviewJournal>;
  if (candidate.version !== 1 || typeof candidate.createdAt !== "string" || typeof candidate.updatedAt !== "string" || !Array.isArray(candidate.entries)) {
    throw new Error("Invocation review journal is invalid.");
  }
  const seen = new Set<string>();
  const entries = candidate.entries.map((raw) => {
    if (!raw || typeof raw !== "object") throw new Error("Invocation review journal entry is invalid.");
    const entry = raw as Partial<InvocationReviewJournalEntry>;
    if (typeof entry.changeId !== "string" || !entry.changeId || seen.has(entry.changeId)) throw new Error("Invocation review journal change ids are invalid.");
    if (entry.action !== "keep" && entry.action !== "reject") throw new Error("Invocation review journal action is invalid.");
    if (entry.status !== "pending" && entry.status !== "applied" && entry.status !== "conflict") throw new Error("Invocation review journal status is invalid.");
    if (entry.status === "conflict" && typeof entry.reason !== "string") throw new Error("Invocation review conflict reason is invalid.");
    if (entry.status !== "applied" && entry.acceptedSha256 !== undefined) {
      throw new Error("Invocation review accepted hash is invalid.");
    }
    if (entry.acceptedSha256 !== undefined && entry.acceptedSha256 !== null &&
      (typeof entry.acceptedSha256 !== "string" || !/^[a-f0-9]{64}$/.test(entry.acceptedSha256))) {
      throw new Error("Invocation review accepted hash is invalid.");
    }
    const mutation = entry.mutation;
    if (mutation !== undefined && (
      entry.action !== "reject" || entry.status !== "pending" ||
      (mutation.phase !== "planned" && mutation.phase !== "quarantined" && mutation.phase !== "replacement-installed") ||
      (mutation.quarantinePath !== undefined &&
        (typeof mutation.quarantinePath !== "string" || !path.isAbsolute(mutation.quarantinePath)))
    )) {
      throw new Error("Invocation review mutation is invalid.");
    }
    seen.add(entry.changeId);
    return {
      changeId: entry.changeId,
      action: entry.action,
      status: entry.status,
      ...(typeof entry.completedAt === "string" ? { completedAt: entry.completedAt } : {}),
      ...(entry.status === "conflict" ? { reason: entry.reason } : {}),
      ...(entry.status === "applied" && (typeof entry.acceptedSha256 === "string" || entry.acceptedSha256 === null)
        ? { acceptedSha256: entry.acceptedSha256 }
        : {}),
      ...(mutation === undefined ? {} : { mutation: { ...mutation } }),
    } satisfies InvocationReviewJournalEntry;
  });
  return { version: 1, createdAt: candidate.createdAt, updatedAt: candidate.updatedAt, entries };
}

function snapshotRef(digest: string): string {
  return path.posix.join("files", "objects", digest);
}

function mutationPhaseRank(phase: InvocationReviewMutationPhase): number {
  return phase === "planned" ? 0 : phase === "quarantined" ? 1 : 2;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function classifyMediaType(filePath: string, sample: Uint8Array): "text" | "binary" {
  if (TEXT_FILE_EXTENSIONS.has(path.extname(filePath).toLowerCase())) return "text";
  return sample.includes(0) ? "binary" : "text";
}

function isWithin(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
}

function compactManifest(
  manifest: InvocationWorkspaceManifest,
  retainedPaths: ReadonlySet<string>,
): InvocationWorkspaceManifest {
  const files = Object.fromEntries(Object.entries(manifest.files).filter(([filePath]) => retainedPaths.has(filePath)));
  const filePaths = Object.keys(files);
  return {
    ...manifest,
    files,
    directories: manifest.directories.filter((directory) => filePaths.some((filePath) => isWithin(directory, filePath))),
  };
}

async function mapLimited<Input, Output>(
  values: readonly Input[],
  concurrency: number,
  operation: (value: Input) => Promise<Output>,
): Promise<Output[]> {
  const results = new Array<Output>(values.length);
  let cursor = 0;
  let failure: unknown;
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (cursor < values.length && failure === undefined) {
      const index = cursor++;
      try {
        results[index] = await operation(values[index]!);
      } catch (error) {
        failure ??= error;
      }
    }
  }));
  if (failure !== undefined) throw failure;
  return results;
}

function ensureElapsedBudget(budget: CaptureBudgetState): void {
  const elapsed = Date.now() - budget.startedAt;
  if (elapsed > budget.maxElapsedMs) {
    throw new InvocationCaptureBudgetError("elapsed-time", budget.maxElapsedMs, elapsed);
  }
}

async function cleanupTemporaryObjects(objectsDir: string): Promise<void> {
  const entries = await readdir(objectsDir);
  await Promise.all(entries
    .filter((entry) => entry.startsWith(".object-") && entry.endsWith(".tmp"))
    .map((entry) => rm(path.join(objectsDir, entry), { force: true })));
}

async function cleanupNewObjects(objectsDir: string, baseline: ReadonlySet<string>): Promise<void> {
  const entries = await readdir(objectsDir);
  await Promise.all(entries
    .filter((entry) => !baseline.has(entry))
    .map((entry) => rm(path.join(objectsDir, entry), { force: true })));
}

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  return value === undefined || !Number.isFinite(value)
    ? fallback
    : Math.max(minimum, Math.min(maximum, Math.floor(value)));
}

function isNodeErrorCode(error: unknown, code: string): error is NodeJS.ErrnoException {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === code);
}
