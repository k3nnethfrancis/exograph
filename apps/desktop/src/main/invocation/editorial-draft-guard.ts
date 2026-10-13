import { type InvocationRecord, type InvocationStore } from "@exograph/core";
import { InvocationReviewService } from "./invocation-review";

/** Validate immutable artifacts, then use ordinary journaled Reject for violations. */
export async function guardEditorialDraftSettlement(
  store: InvocationStore,
  record: InvocationRecord,
): Promise<InvocationRecord> {
  if (record.purpose !== "editorial-draft") return record;
  const reason = record.editorialGuardFailure ?? (record.changeset?.files.length ? "The agent changed author Markdown or another workspace file while drafting an annotation." : null);
  if (!reason) return record;
  const diagnostic = `Editorial drafting was rejected: ${reason}`;
  let failed: InvocationRecord = {
    ...record, status: "failed", editorialGuardFailure: diagnostic, failureReason: diagnostic,
  };
  // Persist the prohibition before any rollback: interrupted recovery must never
  // expose an illegal author rewrite as an ordinary Keep-current proposal.
  await store.writeRecord(failed);
  const pending = failed.changeset?.files.filter(change => change.decision.status === "pending") ?? [];
  try {
    if (pending.length) {
      if (!record.workspaceRoot) throw new Error("The immutable invocation Workspace is unavailable.");
      failed = await new InvocationReviewService(record.workspaceRoot).resolve(failed,
        pending.map(change => ({ changeId: change.id, action: "reject" as const })));
    }
    if (failed.changeset?.status === "conflict") {
      failed = { ...failed, failureReason: `${diagnostic} Newer file changes were preserved; review the rollback conflict.` };
    }
  } catch (error) {
    // The journal owns CAS and recovery. Do not replace current bytes to make a
    // failed rollback appear successful, and retain the scope failure durably.
    const current = await store.readRecord(record.id);
    failed = { ...(current ?? failed), status: "failed", editorialGuardFailure: diagnostic,
      failureReason: `${diagnostic} Safe rollback needs attention: ${error instanceof Error ? error.message : String(error)}` };
  }
  await store.writeRecord(failed);
  return failed;
}

