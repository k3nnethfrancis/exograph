import type { AgentCommand, InvocationConversationHead } from "@exograph/core";

import type { InvocationProcessExit } from "./invocation-process";

export interface InvocationAdapterResult {
  providerSessionId: string | null;
  failureReason: string | null;
  staleResumeRejected: boolean;
}

export function supportsAutomaticContinuity(command: AgentCommand): boolean {
  return command.adapter === "claude-code" && command.continuityPolicy === "continuous";
}

export function commandForHeadlessInvocation(
  command: AgentCommand,
  head: InvocationConversationHead | null = null,
): string {
  if (command.adapter === "codex-cli") {
    if (hasFlag(command.command, "--json")) return command.command;
    return /\s-\s*$/.test(command.command)
      ? command.command.replace(/\s-\s*$/, " --json -")
      : `${command.command} --json`;
  }
  if (command.adapter !== "claude-code") {
    return command.command;
  }
  const structured = hasFlag(command.command, "--output-format")
    ? command.command
    : `${command.command} --output-format stream-json --verbose`;
  return head ? `${structured} --resume ${shellArgument(head.providerSessionId)}` : structured;
}

export function inspectInvocationAdapterResult(
  command: AgentCommand,
  event: InvocationProcessExit,
  attemptedHead: InvocationConversationHead | null,
): InvocationAdapterResult {
  if (command.adapter !== "claude-code") {
    return { providerSessionId: null, failureReason: processFailure(event), staleResumeRejected: false };
  }
  const providerSessionId = extractClaudeSessionId(event.stdout);
  const permissionFailure = claudePermissionFailure(event.stdout);
  const failureReason = event.spawnError ?? permissionFailure ?? processFailure(event);
  const staleResumeRejected = Boolean(
    attemptedHead &&
    event.exitCode === 1 &&
    !event.spawnError &&
    `${event.stdout}${event.stderr}`.trim() === `No conversation found with session ID: ${attemptedHead.providerSessionId}`,
  );
  return { providerSessionId, failureReason, staleResumeRejected };
}

/** Claude's print JSON is untrusted process output; accept only a real UUID. */
export function extractClaudeSessionId(stdout: string): string | null {
  for (const event of claudeOutputEvents(stdout).reverse()) {
    const sessionId = event.session_id;
    if (typeof sessionId === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(sessionId)) {
      return sessionId;
    }
  }
  return null;
}

function claudePermissionFailure(stdout: string): string | null {
  const result = claudeOutputEvents(stdout).reverse().find((event) => event.type === "result");
  return Array.isArray(result?.permission_denials) && result.permission_denials.length > 0
    ? "Claude could not edit the document because its write permission was denied."
    : null;
}

function processFailure(event: InvocationProcessExit): string | null {
  if (event.exitCode === 0 && !event.spawnError) {
    return null;
  }
  if (event.spawnError) return event.spawnError;
  const diagnostic = boundedProcessDiagnostic(event.stderr);
  if (/not inside a trusted directory|skip-git-repo-check/i.test(diagnostic)) {
    return "Codex could not run in this non-Git working folder. Restore the recommended Codex command or add --skip-git-repo-check.";
  }
  return diagnostic
    ? `Command exited with code ${event.exitCode ?? "unknown"}: ${diagnostic}`
    : `Command exited with code ${event.exitCode ?? "unknown"}.`;
}

function boundedProcessDiagnostic(stderr: string): string {
  return stderr
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .trim()
    .slice(-600);
}

function claudeOutputEvents(stdout: string): Array<Record<string, unknown>> {
  const parsed: unknown[] = [];
  try {
    parsed.push(JSON.parse(stdout.trim()));
  } catch {
    for (const line of stdout.split(/\r?\n/)) {
      try { parsed.push(JSON.parse(line)); } catch { /* Ignore unstructured output. */ }
    }
  }
  return parsed.flatMap((value) => Array.isArray(value) ? value : [value])
    .filter((value): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value));
}

function hasFlag(command: string, flag: string): boolean {
  return new RegExp(`(?:^|\\s)${flag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\\s|=)`).test(command);
}

function shellArgument(value: string): string {
  return `'${value.replace(/'/g, "'\"'\"'")}'`;
}
