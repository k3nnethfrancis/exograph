import { describe, expect, it } from "vitest";
import { createDefaultClaudeAgentCommand, type InvocationRecord } from "@exograph/core";
import type { InvocationActivityEvent } from "@exograph/core/invocation-activity";

import {
  invocationCommandPresentation,
  acknowledgeInvocationActivity,
  applyInvocationActivityEvent,
  applyInvocationRecord,
  bindInvocationActivity,
  bufferEarlyInvocationActivityEvent,
  beginInvocationActivity,
  boundedInvocationErrorDetail,
  failActiveInvocationActivity,
  failInvocationActivity,
  resolveInvocationActivityPaneId,
  takeEarlyInvocationActivityEvents,
} from "./invocationActivityState";

const command = { handle: "claude", label: "Claude" };

function record(status: InvocationRecord["status"]): InvocationRecord {
  return {
    id: "invocation-1",
    status,
    context: "note",
    mentionProvenance: "human-authored",
    message: "Review this",
    promptDelivery: "stdin",
    command: {
      id: "claude",
      handle: "claude",
      label: "Claude",
      command: "claude -p",
      adapter: "claude-code",
      continuityPolicy: "continuous",
      cwdPolicy: "workspace_root",
      promptDelivery: "stdin",
      version: 1,
      enabled: true,
      executableFingerprint: "sha256:test",
    },
    cwd: "/private/wiki",
    createdAt: "2026-07-20T00:00:00.000Z",
    continuity: { policy: "continuous", outcome: "fresh" },
  };
}

describe("invocation activity state", () => {
  it("keeps configured appearance while checking and after launch failure", () => {
    const styled = { ...createDefaultClaudeAgentCommand(), appearance: { color: "#112233" } };
    const presentation = invocationCommandPresentation(styled.handle, [styled]);
    expect(acknowledgeInvocationActivity(presentation).commandAppearance).toEqual(styled.appearance);
    expect(failInvocationActivity(presentation, "failure").commandAppearance).toEqual(styled.appearance);
  });
  it("acknowledges a send synchronously without claiming provider work began", () => {
    expect(acknowledgeInvocationActivity(command, "pane-a")).toEqual({
      invocationId: null,
      paneId: "pane-a",
      kind: "checking",
      commandHandle: "claude",
      commandLabel: "Claude",
    });
  });

  it("keeps one origin pane until it closes, then falls back deterministically", () => {
    expect(resolveInvocationActivityPaneId("pane-a", ["pane-a", "pane-b"], "pane-b")).toBe("pane-a");
    expect(resolveInvocationActivityPaneId("pane-a", ["pane-b", "pane-c"], "pane-c")).toBe("pane-c");
    expect(resolveInvocationActivityPaneId("pane-a", ["pane-b", "pane-c"], "utility-pane")).toBe("pane-b");
    expect(resolveInvocationActivityPaneId("pane-a", [], "pane-b")).toBeNull();
  });

  it("moves through bounded activity and terminal states", () => {
    const started = applyInvocationRecord(beginInvocationActivity(command), record("running"));
    const reading = applyInvocationActivityEvent(started, {
      invocationId: "invocation-1",
      kind: "reading",
      label: "/private/wiki/essay.md",
      emittedAt: "2026-07-20T00:00:01.000Z",
    });

    expect(reading).toMatchObject({ invocationId: "invocation-1", kind: "working", label: "Reading essay.md" });
    expect(applyInvocationRecord(reading, record("running"))).toMatchObject({ kind: "working", label: "Reading essay.md" });
    expect(applyInvocationRecord(reading, record("process-exited"))).toMatchObject({ kind: "done" });
    expect(applyInvocationRecord(reading, record("failed"))).toMatchObject({ kind: "failed" });
  });

  it("yields working activity to review as soon as an exact proposal exists", () => {
    const running = {
      ...record("running"),
      protocolInvocationId: "11111111-1111-4111-8111-111111111111",
      providerSessionId: "22222222-2222-4222-8222-222222222222",
      changeset: {
        version: 1 as const,
        status: "pending-review" as const,
        settledAt: "2026-07-20T00:00:02.000Z",
        files: [{
          id: "change-1",
          operation: "modified" as const,
          decision: { status: "pending" as const },
        }],
      },
    };
    const review = applyInvocationRecord(beginInvocationActivity(command), running);
    expect(review).toMatchObject({
      kind: "review",
      protocolInvocationId: running.protocolInvocationId,
      providerSessionId: running.providerSessionId,
    });
    expect(applyInvocationActivityEvent(review, {
      invocationId: running.id,
      kind: "done",
      emittedAt: "2026-07-20T00:00:03.000Z",
    })).toBe(review);
  });

  it("does not restart the spinner after a running proposal is resolved", () => {
    const resolved = {
      ...record("running"),
      changeset: {
        version: 1 as const,
        status: "kept" as const,
        settledAt: "2026-07-20T00:00:02.000Z",
        resolvedAt: "2026-07-20T00:00:03.000Z",
        files: [{
          id: "change-1",
          operation: "modified" as const,
          decision: { status: "kept" as const, reviewedAt: "2026-07-20T00:00:03.000Z", acceptedSha256: null },
        }],
      },
    };
    expect(applyInvocationRecord(beginInvocationActivity(command), resolved)).toMatchObject({ kind: "done" });
  });

  it("ignores unrelated invocation events", () => {
    const current = applyInvocationRecord(beginInvocationActivity(command), record("running"));
    expect(applyInvocationActivityEvent(current, {
      invocationId: "other",
      kind: "editing",
      label: "other.md",
      emittedAt: "2026-07-20T00:00:01.000Z",
    })).toBe(current);
    expect(applyInvocationRecord(current, { ...record("process-exited"), id: "other" })).toBe(current);
  });

  it("does not let a delayed old event claim a new launch before its record returns", () => {
    const waiting = beginInvocationActivity(command);
    const oldEvent: InvocationActivityEvent = {
      invocationId: "old-invocation",
      kind: "editing",
      label: "old.md",
      emittedAt: "2026-07-20T00:00:01.000Z",
    };
    const nextEvent: InvocationActivityEvent = {
      invocationId: "invocation-1",
      kind: "working",
      label: "Reading new.md",
      emittedAt: "2026-07-20T00:00:02.000Z",
    };
    const buffered = new Map<string, InvocationActivityEvent[]>();
    bufferEarlyInvocationActivityEvent(buffered, oldEvent);
    bufferEarlyInvocationActivityEvent(buffered, nextEvent);

    expect(applyInvocationActivityEvent(waiting, oldEvent)).toBe(waiting);
    expect(bindInvocationActivity(
      waiting,
      record("running"),
      takeEarlyInvocationActivityEvents(buffered, "invocation-1"),
    )).toMatchObject({
      invocationId: "invocation-1",
      kind: "working",
      label: "Reading new.md",
    });
    expect(buffered.size).toBe(0);
  });

  it("never retains raw provider output, reasoning, or full paths", () => {
    const untrustedEvent = {
      invocationId: "invocation-1",
      kind: "editing",
      label: "/private/wiki/secret.md",
      emittedAt: "2026-07-20T00:00:01.000Z",
      rawOutput: "chain of thought",
      reasoning: "private reasoning",
    } as InvocationActivityEvent & { rawOutput: string; reasoning: string };
    const next = applyInvocationActivityEvent(
      applyInvocationRecord(beginInvocationActivity(command), record("running")),
      untrustedEvent,
    );

    expect(next).toEqual({
      invocationId: "invocation-1",
      kind: "working",
      commandHandle: "claude",
      commandLabel: "Claude",
      label: "Editing secret.md",
    });
    expect(JSON.stringify(next)).not.toContain("chain of thought");
    expect(JSON.stringify(next)).not.toContain("private/wiki");
  });

  it.each(["done", "stopped", "failed"] as const)("lets process exit publish %s before review preparation completes", (kind) => {
    const current = applyInvocationRecord(beginInvocationActivity(command), record("running"));
    expect(applyInvocationActivityEvent(current, {
      invocationId: "invocation-1",
      kind,
      emittedAt: "2026-07-20T00:00:02.000Z",
    })).toMatchObject({ kind, label: undefined });
  });

  it("presents a user-ended command as stopped", () => {
    expect(applyInvocationRecord(beginInvocationActivity(command), record("user-ended"))).toMatchObject({ kind: "stopped" });
  });

  it("keeps actionable failures bounded and removes local paths", () => {
    expect(failInvocationActivity(command, new Error("Executable was not found: claude"))).toMatchObject({
      kind: "failed",
      errorDetail: "Executable was not found: claude",
    });
    expect(failInvocationActivity(command, "The configured working directory /Users/kenneth/private/wiki is unavailable.")).toMatchObject({
      errorDetail: "The configured working directory this folder is unavailable.",
    });
    expect(failInvocationActivity(command, "Command fingerprint changed. Review and authorize Claude again.")).toMatchObject({
      errorDetail: "Command fingerprint changed. Review and authorize Claude again.",
    });
    expect(boundedInvocationErrorDetail(`Failed ${"x".repeat(300)}`)).toHaveLength(180);
  });

  it("preserves invocation identity when an active stop or resume fails", () => {
    const current = applyInvocationRecord(beginInvocationActivity(command), record("running"));
    expect(failActiveInvocationActivity(current, "Unable to stop the process.")).toMatchObject({
      invocationId: "invocation-1",
      commandHandle: "claude",
      kind: "failed",
      errorDetail: "Unable to stop the process.",
    });
  });

  it("retains Resume for failed invocations without reviewable file changes", () => {
    const failed = { ...record("failed"), providerSessionId: "session-1", failureReason: "Provider exited." };
    expect(applyInvocationRecord(beginInvocationActivity(command), failed)).toMatchObject({
      invocationId: "invocation-1",
      kind: "failed",
      providerSessionId: "session-1",
    });
  });
});
