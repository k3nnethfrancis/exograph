import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, link, lstat, mkdir, open, rename, rm } from "node:fs/promises";
import path from "node:path";

import {
  InvocationStore,
  resolveInvocationFileChange,
  type InvocationChangeset,
  type InvocationCleanBaseRef,
  type InvocationFileChange,
  type InvocationFileState,
  type InvocationRecord,
  type InvocationReviewAction,
  type InvocationReviewMutation,
} from "@exograph/core";

export interface InvocationFileReviewPayload {
  invocation: InvocationRecord;
  change: InvocationFileChange;
  beforeText: string | null;
  afterText: string | null;
  beforeTextOmitted?: boolean;
  afterTextOmitted?: boolean;
  canKeep: boolean;
  canReject: boolean;
}

export class InvocationReviewError extends Error {
  constructor(readonly code: "review-unavailable" | "review-drift", message: string) {
    super(message);
  }
}

interface ReviewResolution {
  changeId: string;
  action: InvocationReviewAction;
}

const IMPLICIT_TAGGED_CLEAN_BASE_CHANGE_ID = "implicit:tagged-clean-base";
const MAX_INLINE_REVIEW_TEXT_BYTES = 1_000_000;

interface ImplicitTaggedRestore {
  cleanBase: InvocationFileState;
  proposal: InvocationFileState;
}

interface FileProbe {
  exists: boolean;
  sha256: string | null;
  mode?: number;
}

interface ReviewPathAuthority {
  noteRoots: readonly string[];
}

type ReviewPreflight =
  | { state: "proposal" | "resolved" | "partial"; currentSha256: string | null }
  | { state: "conflict"; currentSha256: string | null; reason: string };

/** Owns exact, crash-recoverable changeset review over one InvocationStore. */
export class InvocationReviewService {
  private readonly store: InvocationStore;

  constructor(workspaceRoot: string) {
    this.store = new InvocationStore(workspaceRoot);
  }

  async getFilePayload(record: InvocationRecord, changeId: string): Promise<InvocationFileReviewPayload> {
    const change = record.changeset?.files.find((entry) => entry.id === changeId);
    if (!change) throw new InvocationReviewError("review-unavailable", `Invocation change ${changeId} was not found.`);
    const cleanBase = await this.store.readCleanBase(record.id);
    const authority = await this.reviewAuthority(record);
    await assertAuthorizedChange(authority, change);
    const reviewBefore = rejectionBeforeState(record, change, cleanBase);
    const [before, after] = await Promise.all([
      this.readInlineText(record.id, reviewBefore),
      this.readInlineText(record.id, change.after),
    ]);
    return {
      invocation: record,
      change,
      beforeText: before.text,
      afterText: after.text,
      ...(before.omitted ? { beforeTextOmitted: true } : {}),
      ...(after.omitted ? { afterTextOmitted: true } : {}),
      canKeep: !record.editorialGuardFailure && (change.decision.status === "pending" || change.decision.status === "conflict"),
      canReject: change.decision.status === "pending",
    };
  }

  private async readInlineText(
    invocationId: string,
    state: InvocationFileState | null | undefined,
  ): Promise<{ text: string | null; omitted: boolean }> {
    if (!state || state.mediaType !== "text") return { text: null, omitted: false };
    if (state.byteLength > MAX_INLINE_REVIEW_TEXT_BYTES) return { text: null, omitted: true };
    const bytes = await this.store.readSnapshot(invocationId, state);
    return { text: bytes?.toString("utf8") ?? null, omitted: false };
  }

  async resolve(record: InvocationRecord, resolutions: readonly ReviewResolution[]): Promise<InvocationRecord> {
    if (record.editorialGuardFailure && resolutions.some(item => item.action === "keep")) {
      throw new InvocationReviewError("review-unavailable", record.editorialGuardFailure);
    }
    if (!record.changeset || record.changeset.files.length === 0) {
      throw new InvocationReviewError("review-unavailable", "This invocation has no reviewable changes.");
    }
    const unique = new Map<string, InvocationReviewAction>();
    for (const resolution of resolutions) {
      if (unique.has(resolution.changeId)) throw new InvocationReviewError("review-unavailable", "A file cannot have two review decisions.");
      unique.set(resolution.changeId, resolution.action);
    }
    const plan = [...unique].map(([changeId, action]) => ({ changeId, action }));
    if (plan.length === 0) return record;
    const changes = plan.map(({ changeId, action }) => {
      const change = record.changeset!.files.find((entry) => entry.id === changeId);
      const reviewable = change?.decision.status === "pending" ||
        change?.decision.status === "conflict" && action === "keep";
      if (!change || !reviewable) {
        throw new InvocationReviewError("review-unavailable", `Invocation change ${changeId} is not pending.`);
      }
      return change;
    });

    const cleanBase = await this.store.readCleanBase(record.id);
    const authority = await this.reviewAuthority(record);
    await Promise.all(changes.map((change) => assertAuthorizedChange(authority, change)));
    const implicitTaggedRestore = willRejectEntireChangeset(record.changeset, plan)
      ? await this.getImplicitTaggedRestore(record, cleanBase)
      : null;
    assertTaggedCleanBase(
      record,
      changes.filter((_change, index) => plan[index]!.action === "reject"),
      cleanBase,
    );
    const existingJournal = await this.store.readReviewJournal(record.id);
    const resumedJournal = existingJournal !== null;
    const journal = await this.store.beginReviewJournal(record.id, implicitTaggedRestore
      ? [...plan, { changeId: IMPLICIT_TAGGED_CLEAN_BASE_CHANGE_ID, action: "reject" }]
      : plan);

    // A failed Reject can leave the proposal safely quarantined while the
    // public path is absent. Replay that durable transaction before ordinary
    // preflight; otherwise a same-process retry would misclassify Exograph's own
    // in-flight mutation as user drift and discard the only recovery locator.
    const replayed = await Promise.all(changes.map(async (change, index) => {
      const action = plan[index]!.action;
      const reviewBefore = rejectionBeforeState(record, change, cleanBase);
      const entry = journal.entries.find((candidate) => candidate.changeId === change.id);
      const transactionResolved = action === "reject" && entry?.status === "pending" && entry.mutation
        ? await recoverRejectTransaction(this.store, authority, record.id, change, reviewBefore, entry.mutation)
        : false;
      return {
        transactionResolved,
        check: transactionResolved
          ? { state: "resolved" as const, currentSha256: reviewBefore?.sha256 ?? null }
          : await preflightChange(authority, change, action, reviewBefore),
      };
    }));
    const checks = replayed.map((entry) => entry.check);
    const conflicts = checks.map((check, index) => ({ check, change: changes[index]! }))
      .filter(({ check }) => check.state === "conflict" || check.state === "partial" && !resumedJournal);
    if (conflicts.length > 0) {
      let changeset = record.changeset;
      const now = new Date().toISOString();
      // Recovery may have completed an earlier file before another batch item
      // drifted. Persist those exact completed decisions before clearing the
      // journal so disk and record cannot diverge.
      for (let index = 0; index < changes.length; index += 1) {
        const change = changes[index]!;
        const entry = journal.entries.find((candidate) => candidate.changeId === change.id);
        if (!replayed[index]!.transactionResolved && entry?.status !== "applied") continue;
        const action = plan[index]!.action;
        if (entry?.status !== "applied") {
          await this.store.updateReviewJournalEntry(record.id, change.id, { status: "applied", completedAt: now });
        }
        changeset = resolveInvocationFileChange(changeset, change.id, action === "keep"
          ? {
              status: "kept",
              reviewedAt: entry?.completedAt ?? now,
              acceptedSha256: entry?.acceptedSha256 !== undefined
                ? entry.acceptedSha256
                : checks[index]!.currentSha256,
            }
          : { status: "rejected", reviewedAt: entry?.completedAt ?? now });
      }
      for (const { check, change } of conflicts) {
        const reason = check.state === "conflict" ? check.reason : "The rename no longer has one exact current state.";
        const currentSha256 = check.currentSha256;
        changeset = resolveInvocationFileChange(changeset, change.id, { status: "conflict", reason, currentSha256 });
        await this.store.updateReviewJournalEntry(record.id, change.id, { status: "conflict", reason, completedAt: now });
      }
      const next: InvocationRecord = { ...record, changeset };
      await this.store.writeRecord(next);
      await this.store.clearReviewJournal(record.id);
      return next;
    }
    const implicitEntry = journal.entries.find((entry) => entry.changeId === IMPLICIT_TAGGED_CLEAN_BASE_CHANGE_ID);
    const implicitTransactionResolved = implicitTaggedRestore && implicitEntry?.status === "pending" && implicitEntry.mutation
      ? await recoverRejectTransaction(
          this.store,
          authority,
          record.id,
          implicitRestoreChange(implicitTaggedRestore),
          implicitTaggedRestore.cleanBase,
          implicitEntry.mutation,
        )
      : false;
    const implicitCheck = implicitTaggedRestore
      ? implicitTransactionResolved
        ? { state: "resolved" as const, currentSha256: implicitTaggedRestore.cleanBase.sha256 }
        : await preflightImplicitTaggedRestore(authority, implicitTaggedRestore)
      : null;
    if (implicitCheck?.state === "conflict") {
      const changeset = withImplicitTaggedConflict(record.changeset, implicitTaggedRestore!, implicitCheck);
      const next: InvocationRecord = { ...record, changeset };
      await this.store.writeRecord(next);
      await this.store.updateReviewJournalEntry(record.id, IMPLICIT_TAGGED_CLEAN_BASE_CHANGE_ID, {
        status: "conflict",
        reason: implicitCheck.reason,
      });
      await this.store.clearReviewJournal(record.id);
      return next;
    }

    let changeset: InvocationChangeset = record.changeset;
    const reviewedAt = new Date().toISOString();
    for (let index = 0; index < changes.length; index += 1) {
      const change = changes[index]!;
      const action = plan[index]!.action;
      const check = checks[index]!;
      if (action === "reject" && check.state !== "resolved") {
        await rejectChange(
          this.store,
          authority,
          record.id,
          change,
          rejectionBeforeState(record, change, cleanBase),
          check.state === "partial",
        );
      }
      const decision = action === "keep"
        ? {
            status: "kept" as const,
            reviewedAt,
            acceptedSha256: check.currentSha256,
          }
        : { status: "rejected" as const, reviewedAt };
      await this.store.updateReviewJournalEntry(record.id, change.id, {
        status: "applied",
        completedAt: reviewedAt,
        ...(decision.status === "kept" ? { acceptedSha256: decision.acceptedSha256 } : {}),
      });
      changeset = resolveInvocationFileChange(changeset, change.id, decision);
    }
    if (implicitTaggedRestore && implicitCheck) {
      try {
        if (implicitCheck.state === "proposal") {
          await restoreImplicitTaggedCleanBase(this.store, authority, record.id, implicitTaggedRestore);
        }
        await this.store.updateReviewJournalEntry(record.id, IMPLICIT_TAGGED_CLEAN_BASE_CHANGE_ID, {
          status: "applied",
          completedAt: reviewedAt,
        });
      } catch (error) {
        const check = await implicitConflictFromError(authority, implicitTaggedRestore, error);
        changeset = withImplicitTaggedConflict(changeset, implicitTaggedRestore, check);
        await this.store.updateReviewJournalEntry(record.id, IMPLICIT_TAGGED_CLEAN_BASE_CHANGE_ID, {
          status: "conflict",
          reason: check.reason,
          completedAt: reviewedAt,
        });
      }
    }
    const next: InvocationRecord = { ...record, changeset };
    await this.store.writeRecord(next);
    await this.store.clearReviewJournal(record.id);
    return next;
  }

  async recoverJournal(record: InvocationRecord): Promise<InvocationRecord> {
    const journal = await this.store.readReviewJournal(record.id);
    if (!journal || !record.changeset) return record;
    const cleanBase = await this.store.readCleanBase(record.id);
    const authority = await this.reviewAuthority(record);
    await Promise.all(record.changeset.files.map((change) => assertAuthorizedChange(authority, change)));
    const implicitEntry = journal.entries.find((entry) => entry.changeId === IMPLICIT_TAGGED_CLEAN_BASE_CHANGE_ID);
    const implicitTaggedRestore = implicitEntry
      ? await this.getImplicitTaggedRestore(record, cleanBase)
      : null;
    const implicitTransactionResolved = implicitEntry?.status === "pending" && implicitEntry.mutation && implicitTaggedRestore
      ? await recoverRejectTransaction(
          this.store,
          authority,
          record.id,
          implicitRestoreChange(implicitTaggedRestore),
          implicitTaggedRestore.cleanBase,
          implicitEntry.mutation,
        )
      : false;
    const implicitCheck = implicitEntry?.status === "pending" && implicitTaggedRestore
      ? implicitTransactionResolved
        ? { state: "resolved" as const, currentSha256: implicitTaggedRestore.cleanBase.sha256 }
        : await preflightImplicitTaggedRestore(authority, implicitTaggedRestore)
      : null;
    const persistedImplicitConflict = implicitEntry?.status === "conflict" && implicitTaggedRestore
      ? await implicitConflict(
          authority,
          implicitTaggedRestore,
          implicitEntry.reason ?? "The invocation request could not be removed safely.",
        )
      : null;
    let changeset = record.changeset;
    const completedAt = journal.updatedAt;
    let changed = false;
    let hasConflict = false;
    for (const entry of journal.entries) {
      if (entry.changeId === IMPLICIT_TAGGED_CLEAN_BASE_CHANGE_ID) continue;
      const change = changeset.files.find((candidate) => candidate.id === entry.changeId);
      const reviewable = change?.decision.status === "pending" ||
        change?.decision.status === "conflict" && entry.action === "keep";
      if (!change || !reviewable) continue;
      if (entry.action === "keep" && entry.status === "applied" && entry.acceptedSha256 !== undefined) {
        changeset = resolveInvocationFileChange(changeset, change.id, {
          status: "kept",
          reviewedAt: entry.completedAt ?? completedAt,
          acceptedSha256: entry.acceptedSha256,
        });
        changed = true;
        continue;
      }
      const reviewBefore = rejectionBeforeState(record, change, cleanBase);
      const transactionResolved = entry.action === "reject" && entry.status === "pending" && entry.mutation
        ? await recoverRejectTransaction(
            this.store, authority, record.id, change, reviewBefore, entry.mutation,
          )
        : false;
      const check: ReviewPreflight = transactionResolved
        ? { state: "resolved", currentSha256: reviewBefore?.sha256 ?? null }
        : await preflightChange(authority, change, entry.action, reviewBefore);
      if (entry.status === "conflict") {
        changeset = resolveInvocationFileChange(changeset, change.id, {
          status: "conflict",
          reason: entry.reason ?? "The review encountered a file conflict before Exograph could persist it.",
          currentSha256: check.currentSha256,
        });
        changed = true;
        hasConflict = true;
        continue;
      }
      if (entry.action === "reject" && (check.state === "proposal" || check.state === "partial")) {
        await rejectChange(
          this.store,
          authority,
          record.id,
          change,
          reviewBefore,
          check.state === "partial",
        );
        await this.store.updateReviewJournalEntry(record.id, change.id, { status: "applied", completedAt });
        changeset = resolveInvocationFileChange(changeset, change.id, { status: "rejected", reviewedAt: completedAt });
        changed = true;
        continue;
      }
      if (check.state === "resolved" || entry.action === "keep" && check.state === "proposal") {
        if (entry.status !== "applied") {
          await this.store.updateReviewJournalEntry(record.id, change.id, {
            status: "applied",
            completedAt,
            ...(entry.action === "keep" ? { acceptedSha256: check.currentSha256 } : {}),
          });
        }
        changeset = resolveInvocationFileChange(changeset, change.id, entry.action === "keep"
          ? {
              status: "kept",
              reviewedAt: completedAt,
              acceptedSha256: entry.acceptedSha256 !== undefined ? entry.acceptedSha256 : check.currentSha256,
            }
          : { status: "rejected", reviewedAt: completedAt });
        changed = true;
        continue;
      }
      if (check.state === "conflict") {
        changeset = resolveInvocationFileChange(changeset, change.id, {
          status: "conflict",
          reason: check.reason,
          currentSha256: check.currentSha256,
        });
        changed = true;
        hasConflict = true;
      }
    }
    if (!hasConflict && implicitEntry?.status === "pending" && implicitTaggedRestore && implicitCheck) {
      if (implicitCheck.state === "conflict") {
        changeset = withImplicitTaggedConflict(changeset, implicitTaggedRestore, implicitCheck);
        await this.store.updateReviewJournalEntry(record.id, IMPLICIT_TAGGED_CLEAN_BASE_CHANGE_ID, {
          status: "conflict",
          reason: implicitCheck.reason,
          completedAt,
        });
        changed = true;
      } else {
        try {
          if (implicitCheck.state === "proposal") {
            await restoreImplicitTaggedCleanBase(this.store, authority, record.id, implicitTaggedRestore);
          }
          await this.store.updateReviewJournalEntry(record.id, IMPLICIT_TAGGED_CLEAN_BASE_CHANGE_ID, {
            status: "applied",
            completedAt,
          });
        } catch (error) {
          const check = await implicitConflictFromError(authority, implicitTaggedRestore, error);
          changeset = withImplicitTaggedConflict(changeset, implicitTaggedRestore, check);
          await this.store.updateReviewJournalEntry(record.id, IMPLICIT_TAGGED_CLEAN_BASE_CHANGE_ID, {
            status: "conflict",
            reason: check.reason,
            completedAt,
          });
          changed = true;
        }
      }
    }
    if (!hasConflict && persistedImplicitConflict && implicitTaggedRestore) {
      changeset = withImplicitTaggedConflict(changeset, implicitTaggedRestore, persistedImplicitConflict);
      changed = true;
    }
    if (!changed) {
      const unresolvedJournalConflict = journal.entries.some((entry) =>
        entry.status === "conflict" && !hasDurableConflict(record, entry.changeId));
      if (unresolvedJournalConflict) return record;
      await this.store.clearReviewJournal(record.id);
      return record;
    }
    const next: InvocationRecord = { ...record, changeset };
    await this.store.writeRecord(next);
    await this.store.clearReviewJournal(record.id);
    return next;
  }

  private async getImplicitTaggedRestore(
    record: InvocationRecord,
    cleanBase: InvocationCleanBaseRef | null,
  ): Promise<ImplicitTaggedRestore | null> {
    if (!record.taggedDocumentPath) return null;
    if (!cleanBase) {
      throw new InvocationReviewError("review-unavailable", "The exact clean invocation base is unavailable.");
    }
    const taggedIsVisibleChange = record.changeset?.files.some((change) =>
      change.before?.path === cleanBase.file.path || change.after?.path === cleanBase.file.path ||
      change.before?.path === record.taggedDocumentPath || change.after?.path === record.taggedDocumentPath);
    if (taggedIsVisibleChange) return null;
    const settled = await this.store.readManifest(record.id, "settled");
    const proposal = settled?.files[cleanBase.file.path];
    if (!proposal) {
      throw new InvocationReviewError("review-unavailable", "The settled invocation document snapshot is unavailable.");
    }
    return { cleanBase: cleanBase.file, proposal };
  }

  private async reviewAuthority(record: InvocationRecord): Promise<ReviewPathAuthority> {
    const launch = await this.store.readManifest(record.id, "launch");
    if (!launch) {
      throw new InvocationReviewError("review-unavailable", "The immutable launch Note Roots are unavailable.");
    }
    return { noteRoots: launch.noteRoots };
  }
}

function hasDurableConflict(record: InvocationRecord, changeId: string): boolean {
  if (changeId === IMPLICIT_TAGGED_CLEAN_BASE_CHANGE_ID) {
    return Boolean(record.changeset?.files.some((change) =>
      change.id.startsWith(`${IMPLICIT_TAGGED_CLEAN_BASE_CHANGE_ID}:`) && change.decision.status === "conflict"));
  }
  return record.changeset?.files.find((change) => change.id === changeId)?.decision.status === "conflict";
}

function willRejectEntireChangeset(
  changeset: InvocationChangeset,
  plan: readonly ReviewResolution[],
): boolean {
  const planned = new Map(plan.map((entry) => [entry.changeId, entry.action]));
  return changeset.files.every((change) =>
    change.decision.status === "rejected" ||
    change.decision.status === "pending" && planned.get(change.id) === "reject");
}

async function preflightImplicitTaggedRestore(
  authority: ReviewPathAuthority,
  restore: ImplicitTaggedRestore,
): Promise<ReviewPreflight> {
  const current = await probeFile(authority, restore.proposal.path);
  if (matchesState(current, restore.cleanBase)) return { state: "resolved", currentSha256: current.sha256 };
  if (matchesState(current, restore.proposal)) return { state: "proposal", currentSha256: current.sha256 };
  return drift(current.sha256);
}

async function restoreImplicitTaggedCleanBase(
  store: InvocationStore,
  authority: ReviewPathAuthority,
  invocationId: string,
  restore: ImplicitTaggedRestore,
): Promise<void> {
  const bytes = await requiredSnapshot(store, invocationId, restore.cleanBase);
  await replaceProposalTransaction(
    store,
    authority,
    invocationId,
    IMPLICIT_TAGGED_CLEAN_BASE_CHANGE_ID,
    restore.proposal,
    restore.cleanBase,
    bytes,
  );
}

async function implicitConflictFromError(
  authority: ReviewPathAuthority,
  restore: ImplicitTaggedRestore,
  error: unknown,
): Promise<Extract<ReviewPreflight, { state: "conflict" }>> {
  const detail = error instanceof Error ? error.message : String(error);
  return implicitConflict(authority, restore, `The invocation request could not be removed safely. ${detail}`);
}

async function implicitConflict(
  authority: ReviewPathAuthority,
  restore: ImplicitTaggedRestore,
  reason: string,
): Promise<Extract<ReviewPreflight, { state: "conflict" }>> {
  let currentSha256: string | null = null;
  try {
    currentSha256 = (await probeFile(authority, restore.proposal.path)).sha256;
  } catch {
    // The conflict remains reachable even when probing the current file is
    // itself what failed; Keep-current can probe again at decision time.
  }
  return {
    state: "conflict",
    currentSha256,
    reason,
  };
}

function withImplicitTaggedConflict(
  changeset: InvocationChangeset,
  restore: ImplicitTaggedRestore,
  conflict: Extract<ReviewPreflight, { state: "conflict" }>,
): InvocationChangeset {
  const id = `${IMPLICIT_TAGGED_CLEAN_BASE_CHANGE_ID}:${restore.proposal.path}`;
  const synthetic: InvocationFileChange = {
    id,
    operation: "modified",
    before: restore.cleanBase,
    after: restore.proposal,
    decision: {
      status: "conflict",
      reason: conflict.reason,
      currentSha256: conflict.currentSha256,
    },
  };
  const { resolvedAt: _resolvedAt, ...unresolved } = changeset;
  return {
    ...unresolved,
    status: "conflict",
    files: [...changeset.files.filter((change) => change.id !== id), synthetic],
  };
}

function implicitRestoreChange(restore: ImplicitTaggedRestore): InvocationFileChange {
  return {
    id: IMPLICIT_TAGGED_CLEAN_BASE_CHANGE_ID,
    operation: "modified",
    before: restore.cleanBase,
    after: restore.proposal,
    decision: { status: "pending" },
  };
}

async function preflightChange(
  authority: ReviewPathAuthority,
  change: InvocationFileChange,
  action: InvocationReviewAction,
  rejectionBefore: InvocationFileState | undefined,
): Promise<ReviewPreflight> {
  const beforePath = change.before?.path;
  const afterPath = change.after?.path;
  const beforeCurrent = beforePath ? await probeFile(authority, beforePath) : absentProbe();
  const afterCurrent = afterPath && afterPath !== beforePath ? await probeFile(authority, afterPath) : beforeCurrent;
  if (action === "keep") {
    // Keep-current is the explicit escape hatch after a conflict. A pending
    // Keep, however, may only accept the exact proposal that was captured.
    if (change.decision.status === "conflict" || matchesProposal(change, beforeCurrent, afterCurrent)) {
      return { state: "proposal", currentSha256: afterCurrent.sha256 ?? beforeCurrent.sha256 };
    }
    return drift(afterCurrent.sha256 ?? beforeCurrent.sha256);
  }
  const proposal = matchesProposal(change, beforeCurrent, afterCurrent);
  const resolved = matchesRejected(change, beforeCurrent, afterCurrent, rejectionBefore);
  if (resolved) return { state: "resolved", currentSha256: beforeCurrent.sha256 };
  if (proposal) return { state: "proposal", currentSha256: afterCurrent.sha256 };
  if (change.operation === "renamed" && matchesState(beforeCurrent, rejectionBefore) && matchesState(afterCurrent, change.after)) {
    return { state: "partial", currentSha256: afterCurrent.sha256 };
  }
  return drift(afterCurrent.sha256 ?? beforeCurrent.sha256);
}

function matchesProposal(change: InvocationFileChange, before: FileProbe, after: FileProbe): boolean {
  if (change.operation === "created" || change.operation === "modified") return matchesState(after, change.after);
  if (change.operation === "deleted") return !before.exists;
  return !before.exists && matchesState(after, change.after);
}

function matchesRejected(
  change: InvocationFileChange,
  before: FileProbe,
  after: FileProbe,
  rejectionBefore: InvocationFileState | undefined,
): boolean {
  if (change.operation === "created") return !after.exists;
  if (change.operation === "modified" || change.operation === "deleted") return matchesState(before, rejectionBefore);
  return matchesState(before, rejectionBefore) && !after.exists;
}

function matchesState(current: FileProbe, expected: InvocationFileState | undefined): boolean {
  return Boolean(expected && current.exists && current.sha256 === expected.sha256 &&
    (expected.mode === undefined || current.mode === expected.mode));
}

function drift(currentSha256: string | null): ReviewPreflight {
  return {
    state: "conflict",
    currentSha256,
    reason: "The file changed after this proposal. Exograph did not overwrite newer work.",
  };
}

async function rejectChange(
  store: InvocationStore,
  authority: ReviewPathAuthority,
  invocationId: string,
  change: InvocationFileChange,
  rejectionBefore: InvocationFileState | undefined,
  finishPartialRename: boolean,
): Promise<void> {
  if (change.operation === "created") {
    await removeProposalTransaction(store, authority, invocationId, change.id, change.after!);
    return;
  }
  if (change.operation === "modified" || change.operation === "deleted") {
    if (!rejectionBefore) throw new InvocationReviewError("review-unavailable", "The rejection base is unavailable.");
    const bytes = await requiredSnapshot(store, invocationId, rejectionBefore);
    if (change.operation === "modified") {
      await replaceProposalTransaction(
        store, authority, invocationId, change.id, change.after!, rejectionBefore, bytes,
      );
    } else {
      await store.updateReviewJournalMutation(invocationId, change.id, { phase: "planned" });
      await installSnapshotNoClobber(authority, rejectionBefore, bytes);
      await store.updateReviewJournalMutation(invocationId, change.id, { phase: "replacement-installed" });
    }
    return;
  }
  if (!finishPartialRename) {
    if (!rejectionBefore) throw new InvocationReviewError("review-unavailable", "The rejection base is unavailable.");
    const bytes = await requiredSnapshot(store, invocationId, rejectionBefore);
    await replaceProposalTransaction(
      store, authority, invocationId, change.id, change.after!, rejectionBefore, bytes,
    );
    return;
  }
  await removeProposalTransaction(store, authority, invocationId, change.id, change.after!);
}

async function recoverRejectTransaction(
  store: InvocationStore,
  authority: ReviewPathAuthority,
  invocationId: string,
  change: InvocationFileChange,
  rejectionBefore: InvocationFileState | undefined,
  mutation: InvocationReviewMutation,
): Promise<boolean> {
  const expectedQuarantine = change.after
    ? deterministicQuarantinePath(invocationId, change.id, change.after.path)
    : undefined;
  if (mutation.quarantinePath !== expectedQuarantine) {
    throw new InvocationReviewError("review-unavailable", "The review quarantine does not match its durable transaction.");
  }
  if (expectedQuarantine) await assertAuthorizedPath(authority, expectedQuarantine);
  const beforePath = change.before?.path;
  const afterPath = change.after?.path;
  const beforeCurrent = beforePath ? await probeFile(authority, beforePath) : absentProbe();
  const afterCurrent = afterPath && afterPath !== beforePath
    ? await probeFile(authority, afterPath)
    : beforeCurrent;
  const quarantineCurrent = expectedQuarantine
    ? await probeFile(authority, expectedQuarantine)
    : absentProbe();

  if (matchesRejected(change, beforeCurrent, afterCurrent, rejectionBefore)) {
    if (quarantineCurrent.exists) {
      if (!matchesState(quarantineCurrent, change.after)) return false;
      await removeQuarantine(authority, expectedQuarantine!);
    }
    return true;
  }
  if (!quarantineCurrent.exists) {
    return false;
  }
  if (!matchesState(quarantineCurrent, change.after)) {
    if (afterPath && !afterCurrent.exists) {
      await restoreQuarantine(authority, expectedQuarantine!, afterPath);
      return false;
    }
    throw new InvocationReviewError(
      "review-unavailable",
      "The durable review quarantine no longer contains the exact proposal. Exograph preserved it for inspection.",
    );
  }
  if (afterCurrent.exists) {
    // A newer file won the public path while Exograph held the exact proposal in
    // quarantine. The proposal remains durable in the invocation CAS, so the
    // hidden working copy can be removed before surfacing ordinary drift.
    await removeQuarantine(authority, expectedQuarantine!);
    return false;
  }

  if (change.operation === "created") {
    await removeQuarantine(authority, expectedQuarantine!);
    return true;
  }
  if (change.operation === "modified" || change.operation === "renamed") {
    if (!rejectionBefore) {
      throw new InvocationReviewError("review-unavailable", "The rejection base is unavailable.");
    }
    const bytes = await requiredSnapshot(store, invocationId, rejectionBefore);
    await installSnapshotNoClobber(authority, rejectionBefore, bytes);
    await store.updateReviewJournalMutation(invocationId, change.id, {
      phase: "replacement-installed",
      quarantinePath: expectedQuarantine,
    });
    await removeQuarantine(authority, expectedQuarantine!);
    return true;
  }
  return false;
}

async function requiredSnapshot(store: InvocationStore, invocationId: string, state: InvocationFileState): Promise<Buffer> {
  const bytes = await store.readSnapshot(invocationId, state);
  if (!bytes) throw new InvocationReviewError("review-unavailable", `Snapshot ${state.sha256} is unavailable.`);
  return bytes;
}

async function installSnapshotNoClobber(
  authority: ReviewPathAuthority,
  state: InvocationFileState,
  bytes: Buffer,
): Promise<void> {
  await assertAuthorizedPath(authority, state.path);
  await mkdir(path.dirname(state.path), { recursive: true });
  await assertAuthorizedPath(authority, state.path);
  const temporaryPath = path.join(path.dirname(state.path), `.${path.basename(state.path)}.exograph-review-${randomUUID()}.tmp`);
  const handle = await open(temporaryPath, "wx", state.mode ?? 0o666);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(temporaryPath, { force: true });
    throw error;
  }
  await handle.close();
  if (state.mode !== undefined) await chmod(temporaryPath, state.mode);
  try {
    await assertAuthorizedPath(authority, state.path);
    await link(temporaryPath, state.path);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    if (isNodeErrorCode(error, "EEXIST")) {
      throw new InvocationReviewError("review-drift", "The file changed during review. Exograph did not overwrite it.");
    }
    throw error;
  }
  await rm(temporaryPath);
  await syncDirectory(path.dirname(state.path));
}

async function replaceProposalTransaction(
  store: InvocationStore,
  authority: ReviewPathAuthority,
  invocationId: string,
  changeId: string,
  proposal: InvocationFileState,
  replacement: InvocationFileState,
  replacementBytes: Buffer,
): Promise<void> {
  const quarantine = deterministicQuarantinePath(invocationId, changeId, proposal.path);
  await store.updateReviewJournalMutation(invocationId, changeId, { phase: "planned", quarantinePath: quarantine });
  await quarantineVerifiedProposal(authority, proposal, quarantine);
  await store.updateReviewJournalMutation(invocationId, changeId, { phase: "quarantined", quarantinePath: quarantine });
  await installSnapshotNoClobber(authority, replacement, replacementBytes);
  await store.updateReviewJournalMutation(invocationId, changeId, {
    phase: "replacement-installed",
    quarantinePath: quarantine,
  });
  await removeQuarantine(authority, quarantine);
}

async function removeProposalTransaction(
  store: InvocationStore,
  authority: ReviewPathAuthority,
  invocationId: string,
  changeId: string,
  proposal: InvocationFileState,
): Promise<void> {
  const quarantine = deterministicQuarantinePath(invocationId, changeId, proposal.path);
  await store.updateReviewJournalMutation(invocationId, changeId, { phase: "planned", quarantinePath: quarantine });
  await quarantineVerifiedProposal(authority, proposal, quarantine);
  await store.updateReviewJournalMutation(invocationId, changeId, { phase: "quarantined", quarantinePath: quarantine });
  await removeQuarantine(authority, quarantine);
}

async function quarantineVerifiedProposal(
  authority: ReviewPathAuthority,
  proposal: InvocationFileState,
  quarantine: string,
): Promise<void> {
  await assertAuthorizedPath(authority, proposal.path);
  await assertAuthorizedPath(authority, quarantine);
  if ((await probeFile(authority, quarantine)).exists) {
    throw new InvocationReviewError("review-unavailable", "The deterministic review quarantine is already occupied.");
  }
  try {
    await assertAuthorizedPath(authority, proposal.path);
    await assertAuthorizedPath(authority, quarantine);
    await rename(proposal.path, quarantine);
    await syncDirectory(path.dirname(quarantine));
  } catch (error) {
    if (isNodeErrorCode(error, "ENOENT")) {
      throw new InvocationReviewError("review-drift", "The file changed during review. Exograph did not delete it.");
    }
    throw error;
  }
  const moved = await probeFile(authority, quarantine);
  if (!matchesState(moved, proposal)) {
    await restoreQuarantine(authority, quarantine, proposal.path);
    throw new InvocationReviewError("review-drift", "The file changed during review. Exograph restored it without applying Reject.");
  }
}

function deterministicQuarantinePath(invocationId: string, changeId: string, target: string): string {
  const transaction = createHash("sha256").update(`${invocationId}\0${changeId}`).digest("hex").slice(0, 20);
  return path.join(path.dirname(target), `.${path.basename(target)}.exograph-review-${transaction}.quarantine`);
}

async function restoreQuarantine(authority: ReviewPathAuthority, quarantine: string, target: string): Promise<void> {
  await assertAuthorizedPath(authority, quarantine);
  await assertAuthorizedPath(authority, target);
  try {
    await assertAuthorizedPath(authority, quarantine);
    await assertAuthorizedPath(authority, target);
    await link(quarantine, target);
    await assertAuthorizedPath(authority, quarantine);
    await rm(quarantine);
    await syncDirectory(path.dirname(target));
  } catch (error) {
    if (isNodeErrorCode(error, "EEXIST")) {
      throw new InvocationReviewError(
        "review-drift",
        `The file changed during review. The newer file was preserved and the proposal remains at ${quarantine}.`,
      );
    }
    throw error;
  }
}

async function removeQuarantine(authority: ReviewPathAuthority, quarantine: string): Promise<void> {
  await assertAuthorizedPath(authority, quarantine);
  await rm(quarantine);
  await syncDirectory(path.dirname(quarantine));
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

function rejectionBeforeState(
  record: InvocationRecord,
  change: InvocationFileChange,
  cleanBase: InvocationCleanBaseRef | null,
): InvocationFileState | undefined {
  return record.taggedDocumentPath && cleanBase?.file.path === change.before?.path
    ? cleanBase?.file
    : change.before;
}

function assertTaggedCleanBase(
  record: InvocationRecord,
  changes: readonly InvocationFileChange[],
  cleanBase: InvocationCleanBaseRef | null,
): void {
  if (!record.taggedDocumentPath) return;
  const tagged = changes.find((change) =>
    cleanBase?.file.path === change.before?.path || change.before?.path === record.taggedDocumentPath || change.after?.path === record.taggedDocumentPath);
  if (!tagged) return;
  if (tagged.operation === "created" || !cleanBase || tagged.before?.path !== cleanBase.file.path) {
    throw new InvocationReviewError("review-unavailable", "The exact clean invocation base is unavailable.");
  }
}

async function assertAuthorizedChange(
  authority: ReviewPathAuthority,
  change: InvocationFileChange,
): Promise<void> {
  if (change.before) await assertAuthorizedPath(authority, change.before.path);
  if (change.after && change.after.path !== change.before?.path) {
    await assertAuthorizedPath(authority, change.after.path);
  }
}

async function assertAuthorizedPath(authority: ReviewPathAuthority, filePath: string): Promise<void> {
  if (!path.isAbsolute(filePath) || path.normalize(filePath) !== filePath) {
    throw new InvocationReviewError("review-unavailable", "The review path is not an absolute canonical path.");
  }
  const root = authority.noteRoots.find((candidate) => isWithin(candidate, filePath));
  if (!root) {
    throw new InvocationReviewError("review-unavailable", "The review path is outside the immutable launch Note Roots.");
  }
  // Node's macOS filesystem API does not expose openat/renameat-style dirfd
  // mutations, so this is defense-in-depth rather than an atomic sandbox
  // boundary. Exograph revalidates every observed ancestor immediately around each
  // mutation; the explicitly authorized native Command already runs with the
  // same user's direct filesystem authority. Immutable launch roots still
  // prevent accidental or stale review records from naming a different root.
  const relative = path.relative(root, path.dirname(filePath));
  const segments = relative === "" ? [] : relative.split(path.sep);
  let current = root;
  for (const segment of ["", ...segments]) {
    if (segment) current = path.join(current, segment);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) {
        throw new InvocationReviewError("review-unavailable", "A review path ancestor is a symbolic link.");
      }
      if (!info.isDirectory()) {
        throw new InvocationReviewError("review-unavailable", "A review path ancestor is not a directory.");
      }
    } catch (error) {
      if (isNodeErrorCode(error, "ENOENT")) return;
      throw error;
    }
  }
}

async function probeFile(authority: ReviewPathAuthority, filePath: string): Promise<FileProbe> {
  await assertAuthorizedPath(authority, filePath);
  let handle;
  try {
    handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (isNodeErrorCode(error, "ENOENT")) return absentProbe();
    throw error;
  }
  try {
    const before = await handle.stat();
    if (!before.isFile()) return { exists: true, sha256: null, mode: before.mode & 0o777 };
    const digest = createHash("sha256");
    for await (const chunk of handle.createReadStream({ autoClose: false })) digest.update(chunk);
    const after = await handle.stat();
    const current = await lstat(filePath);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs ||
      after.dev !== current.dev || after.ino !== current.ino || after.size !== current.size || after.mtimeMs !== current.mtimeMs) {
      return { exists: true, sha256: null, mode: current.mode & 0o777 };
    }
    return { exists: true, sha256: digest.digest("hex"), mode: after.mode & 0o777 };
  } finally {
    await handle.close();
  }
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function absentProbe(): FileProbe {
  return { exists: false, sha256: null };
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === code);
}
