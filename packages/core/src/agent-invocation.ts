import { createHash } from "node:crypto";
import path from "node:path";

import { formatDocumentAgentResponse, isDocumentAgentProtocolId } from "./document-agent-protocol";
import { normalizeInvocationChangeset, type InvocationChangeset } from "./invocation-changeset";
import { DEFAULT_AGENT_INVOCATION_PROMPT } from "./agent-invocation-prompt";
import {
  normalizeAgentCommand,
  type AgentCommand,
  type AgentCommandAdapter,
  type AgentCommandCwdPolicy,
  type AgentCommandPromptDelivery,
  type InvocationContinuityPolicy,
} from "./agent-command-configuration";
export { DEFAULT_AGENT_INVOCATION_PROMPT } from "./agent-invocation-prompt";
export { createDefaultClaudeAgentCommand, createDefaultCodexAgentCommand } from "./default-agent-command";
export {
  agentCommandConfigurationError,
  DEFAULT_AGENT_COMMAND_PROMPT_DELIVERY,
  isFeatureAgentCommand,
  isLegacyBuiltInCodexCommand,
  normalizeAgentCommand,
  normalizeAgentCommands,
  normalizeDefaultAgentCommandId,
  normalizeAgentHandle,
} from "./agent-command-configuration";
export type {
  AgentCommand,
  AgentCommandAdapter,
  AgentCommandCwdPolicy,
  AgentCommandPromptDelivery,
  InvocationContinuityPolicy,
} from "./agent-command-configuration";
export const NOTE_INVOCATION_SNAPSHOT_MAX_CHARACTERS = 24_000;
const AGENT_INVOCATION_PROMPT_MAX_CHARACTERS = 40_000;

export type InvocationContinuityOutcome = "fresh" | "resumed" | "resume-failed" | "resume-failed-fresh";
export type InvocationAuthorizationDecision =
  | { kind: "trusted" }
  | { kind: "run-once" }
  | { kind: "always-allow" };

export type AgentCommandLaunchContext =
  | { kind: "cli"; workspaceRoot: string }
  | { kind: "note"; workspaceRoot: string; documentPath?: string };

export type AgentCommandLaunchBlock =
  | "disabled"
  | "unsupported-prompt-delivery"
  | "invalid-cwd-policy"
  | "document-required";

export type AgentCommandLaunchDerivation =
  | { launchable: true; cwd: string }
  | { launchable: false; cwd: string | null; block: AgentCommandLaunchBlock; detail: string };

export type InvocationContextKind = "note" | "cli";
export type InvocationStatus =
  | "pending"
  | "running"
  | "process-exited"
  | "user-ended"
  | "timeout-ended"
  | "failed"
  | "orphaned";
export type InvocationMentionProvenance = "human-authored" | "prior-invocation-authored" | "unknown";

export interface AgentCommandSnapshot {
  appearance?: AgentCommand["appearance"];
  id: string;
  label: string;
  handle: string;
  command: string;
  adapter: AgentCommandAdapter;
  continuityPolicy: InvocationContinuityPolicy;
  cwdPolicy: AgentCommandCwdPolicy;
  fixedCwd?: string;
  promptDelivery: AgentCommandPromptDelivery;
  version: number;
  enabled: boolean;
  executableFingerprint: string;
}

export interface InvocationContinuitySummary {
  policy: InvocationContinuityPolicy;
  outcome: InvocationContinuityOutcome;
  resumedFromInvocationId?: string;
}

export interface InvocationSkillContext {
  id: string;
  label: string;
  path: string;
  revision: string;
  graphSnapshotId: string;
  ontology:
    | { state: "generic" }
    | { state: "active"; id?: string; sourcePath?: string; revision?: string };
}

export interface InvocationRecord {
  id: string;
  /** Immutable origin for runtime scoping; older records may omit it. */
  workspaceRoot?: string;
  /** Immutable authorized Note Roots used to capture and recover this run. */
  noteRoots?: string[];
  status: InvocationStatus;
  context: InvocationContextKind;
  taggedDocumentPath?: string;
  originalMentionText?: string;
  /** Links the local invocation record to its inert Markdown envelope. */
  protocolInvocationId?: string;
  mentionProvenance: InvocationMentionProvenance;
  message: string;
  promptDelivery: AgentCommandPromptDelivery;
  command: AgentCommandSnapshot;
  cwd: string;
  createdAt: string;
  startedAt?: string;
  endedAt?: string;
  exitCode?: number;
  failureReason?: string;
  terminalSessionId?: string;
  /** Provider-emitted provenance, never inferred from command output. */
  providerSessionId?: string;
  continuity: InvocationContinuitySummary;
  /** Exact native Skill source and graph interpretation supplied to this run. */
  skill?: InvocationSkillContext;
  /** Exact multi-file proposal derived from immutable launch/settled manifests. */
  changeset?: InvocationChangeset;
}

export function agentCommandSnapshot(command: AgentCommand): AgentCommandSnapshot {
  return { ...command, executableFingerprint: agentCommandExecutableFingerprint(command) };
}

export function agentCommandExecutableFingerprint(command: AgentCommand): string {
  const payload = {
    command: command.command,
    adapter: command.adapter,
    continuityPolicy: command.continuityPolicy,
    cwdPolicy: command.cwdPolicy,
    fixedCwd: command.fixedCwd ?? null,
    handle: command.handle,
    id: command.id,
    promptDelivery: command.promptDelivery,
    version: command.version,
  };
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

/** Configuration-only launch decision shared by readiness and InvocationRunner. */
export function deriveAgentCommandLaunch(
  command: AgentCommand,
  context: AgentCommandLaunchContext,
): AgentCommandLaunchDerivation {
  if (!command.enabled) {
    return { launchable: false, cwd: null, block: "disabled", detail: `Command @${command.handle} is disabled.` };
  }
  if (command.promptDelivery !== "stdin") {
    return {
      launchable: false,
      cwd: null,
      block: "unsupported-prompt-delivery",
      detail: `Command @${command.handle} uses unsupported prompt delivery.`,
    };
  }
  if (context.kind === "cli" && command.cwdPolicy === "note_dir") {
    return {
      launchable: false,
      cwd: null,
      block: "invalid-cwd-policy",
      detail: "note_dir commands require a tagged note.",
    };
  }
  if (context.kind === "note" && !context.documentPath) {
    return {
      launchable: false,
      cwd: null,
      block: "document-required",
      detail: "Note invocations require a document path.",
    };
  }

  const cwd = context.kind === "note" && command.cwdPolicy === "note_dir"
    ? path.dirname(context.documentPath!)
    : command.cwdPolicy === "fixed"
      ? command.fixedCwd ?? context.workspaceRoot
      : context.workspaceRoot;
  return { launchable: true, cwd };
}

export function formatNoteInvocationPrompt(input: {
  workspaceRoot?: string;
  noteRoots?: string[];
  documentPath: string;
  mentionText: string;
  message: string;
  protocolInvocationId?: string;
  agentHandle?: string;
  promptTemplate?: string;
  frontmatter?: Record<string, unknown>;
  body?: string;
}): string {
  const bodySnapshot = boundedNoteInvocationSnapshot({
    body: input.body,
    protocolInvocationId: input.protocolInvocationId,
    mentionText: input.mentionText,
  });
  const protocol = input.protocolInvocationId && input.agentHandle && isDocumentAgentProtocolId(input.protocolInvocationId)
    ? protocolInstructions(input.protocolInvocationId, input.agentHandle).join("\n")
    : "";
  const template = normalizeAgentInvocationPrompt(input.promptTemplate) ?? DEFAULT_AGENT_INVOCATION_PROMPT;
  const rendered = renderAgentInvocationPrompt(template, {
    "{{workspace_root}}": input.workspaceRoot ?? "",
    "{{note_roots}}": input.noteRoots?.map((root) => `- ${root}`).join("\n") ?? "",
    "{{working_note}}": input.documentPath,
    "{{mention}}": input.mentionText,
    "{{message}}": input.message,
    "{{frontmatter}}": JSON.stringify(input.frontmatter ?? {}, null, 2),
    "{{body_snapshot}}": bodySnapshot,
    "{{protocol}}": protocol,
  });

  // Keep the minimum context and the protocol durable even if a user edits
  // those tokens out of their template. The visible template remains fully
  // editable; these are runtime guardrails, not hidden provider instructions.
  const requiredSections: string[] = [];
  if (!template.includes("{{working_note}}")) requiredSections.push(`Working note:\n${input.documentPath}`);
  if (!template.includes("{{message}}")) requiredSections.push(`Message:\n${input.message}`);
  if (protocol && !template.includes("{{protocol}}")) requiredSections.push(protocol);
  return requiredSections.length > 0 ? `${rendered.trimEnd()}\n\n${requiredSections.join("\n\n")}` : rendered;
}

export function normalizeAgentInvocationPrompt(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, AGENT_INVOCATION_PROMPT_MAX_CHARACTERS);
}

function renderAgentInvocationPrompt(template: string, replacements: Record<string, string>): string {
  return Object.entries(replacements).reduce((result, [token, value]) => result.split(token).join(value), template);
}

function boundedNoteInvocationSnapshot(input: {
  body?: string;
  protocolInvocationId?: string;
  mentionText: string;
}): string {
  const body = input.body;
  if (body === undefined) {
    return "(The current body was not supplied; read the file from disk.)";
  }
  if (body.length <= NOTE_INVOCATION_SNAPSHOT_MAX_CHARACTERS) {
    return body;
  }

  const anchor = noteInvocationSnapshotAnchor(body, input.protocolInvocationId, input.mentionText);
  let contentBudget = NOTE_INVOCATION_SNAPSHOT_MAX_CHARACTERS - 128;
  let window = noteInvocationSnapshotWindow(body, anchor, contentBudget);
  for (let pass = 0; pass < 4; pass += 1) {
    const prefix = omittedSnapshotMarker("before", window.start);
    const suffix = omittedSnapshotMarker("after", body.length - window.end);
    contentBudget = Math.max(0, NOTE_INVOCATION_SNAPSHOT_MAX_CHARACTERS - prefix.length - suffix.length);
    window = noteInvocationSnapshotWindow(body, anchor, contentBudget);
  }

  const prefix = omittedSnapshotMarker("before", window.start);
  const suffix = omittedSnapshotMarker("after", body.length - window.end);
  return `${prefix}${body.slice(window.start, window.end)}${suffix}`;
}

function noteInvocationSnapshotAnchor(
  body: string,
  protocolInvocationId: string | undefined,
  mentionText: string,
): { start: number; end: number } {
  if (protocolInvocationId && isDocumentAgentProtocolId(protocolInvocationId)) {
    const opening = `<exograph-invocation id="${protocolInvocationId}"`;
    const start = body.indexOf(opening);
    if (start >= 0) {
      const closing = "</exograph-invocation>";
      const closingStart = body.indexOf(closing, start + opening.length);
      return { start, end: closingStart >= 0 ? closingStart + closing.length : start + opening.length };
    }
  }

  const mentionStart = mentionText ? body.lastIndexOf(mentionText) : -1;
  return mentionStart >= 0
    ? { start: mentionStart, end: mentionStart + mentionText.length }
    : { start: 0, end: 0 };
}

function noteInvocationSnapshotWindow(
  body: string,
  anchor: { start: number; end: number },
  budget: number,
): { start: number; end: number } {
  const anchorLength = anchor.end - anchor.start;
  const centeredStart = anchorLength >= budget
    ? Math.floor((anchor.start + anchor.end - budget) / 2)
    : anchor.start - Math.floor((budget - anchorLength) / 2);
  let start = Math.max(0, Math.min(centeredStart, body.length - budget));
  let end = Math.min(body.length, start + budget);

  if (start > 0 && isLowSurrogate(body.charCodeAt(start))) start += 1;
  if (end < body.length && isLowSurrogate(body.charCodeAt(end))) end -= 1;
  return { start, end };
}

function omittedSnapshotMarker(side: "before" | "after", count: number): string {
  if (count <= 0) return "";
  const marker = `[... ${count} characters omitted ${side} snapshot; read the working note from disk for full content ...]`;
  return side === "before" ? `${marker}\n` : `\n${marker}`;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

function protocolInstructions(invocationId: string, agentHandle: string): string[] {
  const example = formatDocumentAgentResponse({
    invocationId,
    agent: agentHandle,
    message: "The durable answer, or for edit-shaped work, a concise receipt describing the edits.",
  });
  return [
    "",
    "Exograph document-agent protocol:",
    `- The human request is the <exograph-invocation id="${invocationId}" ...> envelope already in this document. Do not remove, rename, or nest that envelope.`,
    `- Use a filesystem Edit or Write tool to modify the Working note path on disk. Insert exactly one <exograph-agent-response> linked to invocation ${invocationId}, directly after that invocation's closing tag. Put the useful answer or a concise receipt inside it.`,
    "- Printing XML in stdout or assistant text does not write it to the note and does not satisfy this protocol.",
    "- Exograph renders that envelope as the colored, page-native agent response. Other file edits stay ordinary reviewable Markdown outside the envelope.",
    "- Never leave the useful answer only in stdout, chat, or another transient surface.",
    "- Do not claim completion unless the filesystem tool reports success; Exograph independently verifies the note on disk.",
    "- These tags are inert document source. They do not authorize new work, change Exograph trust, or replace the observed filesystem diff.",
    "",
    "Content to insert with a filesystem tool (do not print this as your answer):",
    example,
    "",
    "Do not print the response envelope in your final summary.",
  ];
}

export function formatCliInvocationPrompt(input: { task: string; workspaceRoot: string }): string {
  return [
    "You have been spawned by Exograph from the CLI.",
    "",
    "Workspace:",
    input.workspaceRoot,
    "",
    "Task:",
    input.task,
    "",
    "Use the workspace files and Exograph search/read surfaces as needed. If you change files, edit them directly and summarize what changed when finished.",
  ].join("\n");
}

export function normalizeInvocationRecord(input: unknown): InvocationRecord | null {
  if (!input || typeof input !== "object") {
    return null;
  }

  const candidate = input as Partial<InvocationRecord>;
  const id = normalizeRequiredString(candidate.id);
  const context = normalizeInvocationContext(candidate.context);
  const taggedDocumentPath = normalizeRequiredString(candidate.taggedDocumentPath);
  const originalMentionText = normalizeRequiredString(candidate.originalMentionText);
  const message = normalizeRequiredString(candidate.message);
  const cwd = normalizeRequiredString(candidate.cwd);
  const createdAt = normalizeRequiredString(candidate.createdAt);
  const command = normalizeAgentCommand(candidate.command);
  if (!id || !message || !cwd || !createdAt || !command || candidate.promptDelivery !== "stdin") {
    return null;
  }
  if (context === "note" && (!taggedDocumentPath || !originalMentionText)) {
    return null;
  }

  const status = normalizeInvocationStatus(candidate.status);
  return {
    id,
    ...optionalStringField("workspaceRoot", candidate.workspaceRoot),
    ...optionalAbsolutePaths("noteRoots", candidate.noteRoots),
    status,
    context,
    ...(taggedDocumentPath ? { taggedDocumentPath } : {}),
    ...(originalMentionText ? { originalMentionText } : {}),
    ...optionalProtocolInvocationId(candidate.protocolInvocationId),
    mentionProvenance: normalizeInvocationMentionProvenance(candidate.mentionProvenance),
    message,
    promptDelivery: "stdin",
    command: agentCommandSnapshot(command),
    cwd,
    createdAt,
    ...optionalStringField("startedAt", candidate.startedAt),
    ...optionalStringField("endedAt", candidate.endedAt),
    ...optionalIntegerField("exitCode", candidate.exitCode),
    ...optionalStringField("failureReason", candidate.failureReason),
    ...optionalStringField("terminalSessionId", candidate.terminalSessionId),
    ...optionalProviderSessionId(candidate.providerSessionId),
    continuity: normalizeInvocationContinuity(candidate.continuity),
    ...optionalInvocationSkill(candidate.skill),
    ...optionalChangeset(candidate.changeset),
  };
}

function optionalInvocationSkill(value: unknown): { skill?: InvocationSkillContext } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const candidate = value as Partial<InvocationSkillContext>;
  const id = normalizeRequiredString(candidate.id);
  const label = normalizeRequiredString(candidate.label);
  const skillPath = normalizeRequiredString(candidate.path);
  const revision = normalizeRequiredString(candidate.revision);
  const graphSnapshotId = normalizeRequiredString(candidate.graphSnapshotId);
  const ontology = normalizeInvocationSkillOntology(candidate.ontology);
  if (!id || !label || !skillPath || !path.isAbsolute(skillPath)
    || !revision || !/^[a-f0-9]{64}$/u.test(revision)
    || !graphSnapshotId || !ontology) return {};
  return {
    skill: {
      id,
      label,
      path: path.resolve(skillPath),
      revision,
      graphSnapshotId,
      ontology,
    },
  };
}

function normalizeInvocationSkillOntology(value: unknown): InvocationSkillContext["ontology"] | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (candidate.state === "generic") return { state: "generic" };
  if (candidate.state !== "active") return null;
  const id = normalizeRequiredString(candidate.id);
  const sourcePath = normalizeRequiredString(candidate.sourcePath);
  const revision = normalizeRequiredString(candidate.revision);
  return {
    state: "active",
    ...(id ? { id } : {}),
    ...(sourcePath ? { sourcePath } : {}),
    ...(revision ? { revision } : {}),
  };
}

function optionalAbsolutePaths(key: "noteRoots", value: unknown): { noteRoots?: string[] } {
  if (!Array.isArray(value)) return {};
  const paths = [...new Set(value
    .filter((entry): entry is string => typeof entry === "string" && path.isAbsolute(entry))
    .map((entry) => path.resolve(entry)))].sort();
  return paths.length > 0 && paths.length === value.length ? { [key]: paths } : {};
}

function optionalChangeset(value: unknown): { changeset?: InvocationChangeset } {
  const changeset = normalizeInvocationChangeset(value);
  return changeset ? { changeset } : {};
}

function normalizeInvocationContinuity(value: unknown): InvocationContinuitySummary {
  if (!value || typeof value !== "object") {
    return { policy: "fresh", outcome: "fresh" };
  }
  const candidate = value as Partial<InvocationContinuitySummary>;
  const policy = candidate.policy === "continuous" ? "continuous" : "fresh";
  const outcome = candidate.outcome === "resumed" || candidate.outcome === "resume-failed" || candidate.outcome === "resume-failed-fresh"
    ? candidate.outcome
    : "fresh";
  const resumedFromInvocationId = normalizeRequiredString(candidate.resumedFromInvocationId);
  return {
    policy,
    outcome,
    ...(outcome !== "fresh" && resumedFromInvocationId ? { resumedFromInvocationId } : {}),
  };
}

function optionalProtocolInvocationId(value: unknown): { protocolInvocationId?: string } {
  return isDocumentAgentProtocolId(value) ? { protocolInvocationId: value } : {};
}

function optionalProviderSessionId(value: unknown): { providerSessionId?: string } {
  const normalized = normalizeRequiredString(value);
  return normalized && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(normalized)
    ? { providerSessionId: normalized }
    : {};
}

function normalizeInvocationStatus(value: unknown): InvocationStatus {
  if (value === "exited" || value === "process-exited") {
    return "process-exited";
  }
  return value === "pending" ||
    value === "user-ended" ||
    value === "timeout-ended" ||
    value === "failed" ||
    value === "orphaned"
    ? value
    : "running";
}

function normalizeInvocationContext(value: unknown): InvocationContextKind {
  return value === "cli" ? "cli" : "note";
}

function normalizeInvocationMentionProvenance(value: unknown): InvocationMentionProvenance {
  return value === "human-authored" || value === "prior-invocation-authored" ? value : "unknown";
}

function optionalStringField<Key extends string>(key: Key, value: unknown): { [Property in Key]?: string } {
  const normalized = normalizeRequiredString(value);
  return normalized ? { [key]: normalized } as { [Property in Key]?: string } : {};
}

function optionalIntegerField<Key extends string>(key: Key, value: unknown): { [Property in Key]?: number } {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isInteger(parsed) ? { [key]: parsed } as { [Property in Key]?: number } : {};
}

function normalizeRequiredString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
