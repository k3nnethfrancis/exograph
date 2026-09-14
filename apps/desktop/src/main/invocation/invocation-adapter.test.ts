import { describe, expect, it } from "vitest";

import { createDefaultClaudeAgentCommand, createDefaultCodexAgentCommand, type InvocationConversationHead } from "@exograph/core";

import { commandForHeadlessInvocation, extractClaudeSessionId, inspectInvocationAdapterResult, supportsAutomaticContinuity } from "./invocation-adapter";

const SESSION_ID = "ce4b9e26-2574-4433-a054-1110cd403792";
const HEAD: InvocationConversationHead = {
  version: 1,
  workspaceFingerprint: "a".repeat(64),
  commandId: "claude",
  commandFingerprint: "b".repeat(64),
  adapter: "claude-code",
  cwd: "/workspace",
  providerSessionId: SESSION_ID,
  sourceInvocationId: "invocation-1",
  updatedAt: "2026-07-13T00:00:00.000Z",
};

describe("invocation adapter", () => {
  it("builds separate structured Claude fresh and resume commands", () => {
    const command = createDefaultClaudeAgentCommand();
    expect(commandForHeadlessInvocation(command))
      .toBe('claude -p --permission-mode acceptEdits --allowedTools "Read,Edit,Write,Glob,Grep" --output-format stream-json --verbose');
    expect(commandForHeadlessInvocation(command, HEAD))
      .toBe(`claude -p --permission-mode acceptEdits --allowedTools "Read,Edit,Write,Glob,Grep" --output-format stream-json --verbose --resume '${SESSION_ID}'`);
    expect(commandForHeadlessInvocation({ ...command, command: "claude -p --output-format stream-json" }, HEAD))
      .toBe(`claude -p --output-format stream-json --resume '${SESSION_ID}'`);
  });

  it("requests Codex JSONL without changing generic Commands", () => {
    const codex = createDefaultCodexAgentCommand();
    expect(commandForHeadlessInvocation(codex)).toBe("codex exec --sandbox workspace-write --skip-git-repo-check --json -");
    expect(commandForHeadlessInvocation({ ...codex, command: "codex exec --json -" })).toBe("codex exec --json -");
    expect(commandForHeadlessInvocation({ ...codex, adapter: "generic", command: "agent -" })).toBe("agent -");
  });

  it("does not give Codex or generic Commands unproven continuity", () => {
    const codex = createDefaultCodexAgentCommand();
    expect(codex.continuityPolicy).toBe("fresh");
    expect(supportsAutomaticContinuity(codex)).toBe(false);
    expect(commandForHeadlessInvocation(codex, HEAD)).toBe("codex exec --sandbox workspace-write --skip-git-repo-check --json -");
    expect(supportsAutomaticContinuity({ ...createDefaultClaudeAgentCommand(), adapter: "generic", continuityPolicy: "fresh" })).toBe(false);
  });

  it("preserves a bounded actionable Codex failure diagnostic", () => {
    expect(inspectInvocationAdapterResult(createDefaultCodexAgentCommand(), {
      exitCode: 1,
      stdout: "",
      stderr: "Not inside a trusted directory and --skip-git-repo-check was not specified.\n",
    }, null).failureReason).toBe(
      "Codex could not run in this non-Git working folder. Restore the recommended Codex command or add --skip-git-repo-check.",
    );
  });

  it("extracts only a real structured Claude session id", () => {
    expect(extractClaudeSessionId(`ordinary output\n{"session_id":"${SESSION_ID}"}`)).toBe(SESSION_ID);
    expect(extractClaudeSessionId('{"session_id":"not-a-session"}')).toBeNull();
  });

  it("classifies only the exact proven stale-resume signature for the attempted id", () => {
    expect(inspectInvocationAdapterResult(createDefaultClaudeAgentCommand(), {
      exitCode: 1,
      stdout: "",
      stderr: `No conversation found with session ID: ${SESSION_ID}\n`,
    }, HEAD)).toMatchObject({ staleResumeRejected: true });
    expect(inspectInvocationAdapterResult(createDefaultClaudeAgentCommand(), {
      exitCode: 1,
      stdout: "",
      stderr: "No conversation found with session ID: another-id\n",
    }, HEAD)).toMatchObject({ staleResumeRejected: false });
    expect(inspectInvocationAdapterResult(createDefaultClaudeAgentCommand(), {
      exitCode: 2,
      stdout: "",
      stderr: `No conversation found with session ID: ${SESSION_ID}\n`,
    }, HEAD)).toMatchObject({ staleResumeRejected: false });
  });
});
