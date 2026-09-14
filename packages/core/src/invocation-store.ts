import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";

import { normalizeInvocationRecord, type InvocationRecord } from "./agent-invocation";
import {
  InvocationArtifactStore,
  type InvocationArtifactRecovery,
  type InvocationArtifactCompactionReport,
  type InvocationCleanBaseInput,
  type InvocationCleanBaseRef,
  type InvocationManifestCaptureOptions,
  type InvocationManifestPhase,
  type InvocationLaunchArtifactInput,
  type InvocationLaunchArtifacts,
  type InvocationProcessOwnership,
  type InvocationReviewJournal,
  type InvocationReviewJournalInput,
  type InvocationReviewMutation,
} from "./invocation-artifacts";
import {
  type InvocationChangeset,
  type InvocationFileState,
  type InvocationWorkspaceManifest,
} from "./invocation-changeset";
import { safeStoreSegment } from "./store-paths";
import { WORKSPACE_RUNTIME_DIRECTORY } from "./workspace-runtime";

export interface InvocationStoreLayout {
  workspaceRoot: string;
  runtimeRoot: string;
  invocationsDir: string;
}

export function resolveInvocationStoreLayout(workspaceRoot: string): InvocationStoreLayout {
  const runtimeRoot = path.join(workspaceRoot, WORKSPACE_RUNTIME_DIRECTORY);
  return {
    workspaceRoot,
    runtimeRoot,
    invocationsDir: path.join(runtimeRoot, "invocations"),
  };
}

export function invocationRecordPath(layout: InvocationStoreLayout, invocationId: string): string {
  return path.join(layout.invocationsDir, safeStoreSegment(invocationId), "record.json");
}

export class InvocationStore {
  readonly layout: InvocationStoreLayout;
  private readonly artifacts: InvocationArtifactStore;

  constructor(workspaceRoot: string) {
    this.layout = resolveInvocationStoreLayout(workspaceRoot);
    this.artifacts = new InvocationArtifactStore(this.layout.invocationsDir);
  }

  async writeRecord(record: InvocationRecord): Promise<string> {
    const normalized = normalizeInvocationRecord(record);
    if (!normalized) {
      throw new Error("Invocation record is incomplete.");
    }

    const target = invocationRecordPath(this.layout, normalized.id);
    await mkdir(path.dirname(target), { recursive: true });
    await writeJsonAtomically(target, normalized);
    return target;
  }

  async readRecord(invocationId: string): Promise<InvocationRecord | null> {
    const artifactId = safeStoreSegment(invocationId);
    const raw = await readJsonOrNull(invocationRecordPath(this.layout, invocationId));
    return this.normalizeStoredRecord(raw, artifactId);
  }

  async listRecords(): Promise<InvocationRecord[]> {
    const entries = await this.listInvocationIds();

    const records = await Promise.all(entries.map(async (entry) => {
      const raw = await readJsonOrNull(path.join(this.layout.invocationsDir, entry, "record.json"));
      return this.normalizeStoredRecord(raw, entry);
    }));
    return records
      .filter((record): record is InvocationRecord => Boolean(record))
      .sort((left, right) => {
        const byCreatedAt = left.createdAt.localeCompare(right.createdAt);
        return byCreatedAt === 0 ? left.id.localeCompare(right.id) : byCreatedAt;
      });
  }

  /** Enumerate the durable boundary, not just records that still normalize.
   * Recovery uses this so a missing or damaged record cannot hide process
   * ownership or other invocation artifacts. */
  async listInvocationIds(): Promise<string[]> {
    try {
      const dirents = await readdir(this.layout.invocationsDir, { withFileTypes: true });
      return dirents.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
    } catch (error) {
      if (isNodeErrorCode(error, "ENOENT")) return [];
      throw error;
    }
  }

  captureManifest(
    invocationId: string,
    phase: InvocationManifestPhase,
    noteRoots: readonly string[],
    options?: InvocationManifestCaptureOptions,
  ): Promise<InvocationWorkspaceManifest> {
    return this.artifacts.captureManifest(invocationId, phase, noteRoots, options);
  }

  captureSettledManifest(
    invocationId: string,
    noteRoots: readonly string[],
    launch: InvocationWorkspaceManifest,
    options?: InvocationManifestCaptureOptions,
  ): Promise<InvocationWorkspaceManifest> {
    return this.artifacts.captureSettledManifest(invocationId, noteRoots, launch, options);
  }

  captureLaunchArtifacts(invocationId: string, input: InvocationLaunchArtifactInput): Promise<InvocationLaunchArtifacts> {
    return this.artifacts.captureLaunchArtifacts(invocationId, input);
  }

  readManifest(invocationId: string, phase: InvocationManifestPhase): Promise<InvocationWorkspaceManifest | null> {
    return this.artifacts.readManifest(invocationId, phase);
  }

  captureCleanBase(invocationId: string, input: InvocationCleanBaseInput): Promise<InvocationCleanBaseRef> {
    return this.artifacts.captureCleanBase(invocationId, input);
  }

  readCleanBase(invocationId: string): Promise<InvocationCleanBaseRef | null> {
    return this.artifacts.readCleanBase(invocationId);
  }

  readSnapshot(invocationId: string, state: InvocationFileState): Promise<Buffer | null> {
    return this.artifacts.readSnapshot(invocationId, state);
  }

  beginReviewJournal(
    invocationId: string,
    inputs: readonly InvocationReviewJournalInput[],
    createdAt?: string,
  ): Promise<InvocationReviewJournal> {
    return this.artifacts.beginReviewJournal(invocationId, inputs, createdAt);
  }

  updateReviewJournalEntry(
    invocationId: string,
    changeId: string,
    outcome: { status: "applied"; completedAt?: string; acceptedSha256?: string | null } | { status: "conflict"; reason: string; completedAt?: string },
  ): Promise<InvocationReviewJournal> {
    return this.artifacts.updateReviewJournalEntry(invocationId, changeId, outcome);
  }

  updateReviewJournalMutation(
    invocationId: string,
    changeId: string,
    mutation: InvocationReviewMutation,
    updatedAt?: string,
  ): Promise<InvocationReviewJournal> {
    return this.artifacts.updateReviewJournalMutation(invocationId, changeId, mutation, updatedAt);
  }

  readReviewJournal(invocationId: string): Promise<InvocationReviewJournal | null> {
    return this.artifacts.readReviewJournal(invocationId);
  }

  clearReviewJournal(invocationId: string): Promise<void> {
    return this.artifacts.clearReviewJournal(invocationId);
  }

  writeProcessOwnership(invocationId: string, ownership: InvocationProcessOwnership): Promise<void> {
    return this.artifacts.writeProcessOwnership(invocationId, ownership);
  }

  readProcessOwnership(invocationId: string): Promise<InvocationProcessOwnership | null> {
    return this.artifacts.readProcessOwnership(invocationId);
  }

  clearProcessOwnership(invocationId: string): Promise<void> {
    return this.artifacts.clearProcessOwnership(invocationId);
  }

  readArtifactRecovery(invocationId: string): Promise<InvocationArtifactRecovery> {
    return this.artifacts.readRecovery(invocationId);
  }

  listArtifactRecoveries(): Promise<InvocationArtifactRecovery[]> {
    return this.artifacts.listRecoverable();
  }

  compactArtifacts(invocationId: string, changeset: InvocationChangeset): Promise<InvocationArtifactCompactionReport> {
    return this.artifacts.compact(invocationId, changeset);
  }

  private async normalizeStoredRecord(raw: unknown, artifactId: string): Promise<InvocationRecord | null> {
    if (hasOwn(raw, "review")) {
      throw new Error(
        `Invocation ${artifactId} uses the unsupported pre-Changeset review format.`,
      );
    }
    const normalized = normalizeInvocationRecord(raw);
    if (!normalized) return null;
    if (hasOwn(raw, "changeset") && !normalized.changeset) {
      throw new Error(`Invocation ${artifactId} has an invalid Changeset.`);
    }
    if (safeStoreSegment(normalized.id) !== artifactId) {
      throw new Error(`Invocation ${artifactId} record.json names a different invocation.`);
    }
    return normalized;
  }
}

function hasOwn(value: unknown, key: string): boolean {
  return Boolean(value && typeof value === "object" && Object.prototype.hasOwnProperty.call(value, key));
}

async function writeJsonAtomically(target: string, value: unknown): Promise<void> {
  const temporaryPath = path.join(path.dirname(target), `.record-${process.pid}-${randomUUID()}.tmp`);
  try {
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await rename(temporaryPath, target);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

async function readJsonOrNull(pathname: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(pathname, "utf8")) as unknown;
  } catch (error) {
    if (isNodeErrorCode(error, "ENOENT")) {
      return null;
    }
    throw error;
  }
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === code);
}
