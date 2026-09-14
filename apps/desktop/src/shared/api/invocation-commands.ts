import type {
  AgentCommand,
  InvocationActivityEvent,
  InvocationAuthorizationDecision,
  InvocationFileChange,
  InvocationRecord,
  InvocationSkillContext,
  OntologyReviewState,
} from "@exograph/core";

import type { TerminalSessionInfo } from "./terminal";

export interface LaunchAgentInvocationInput {
  handle: string;
  /** UUID stored in the inert <exograph-invocation> document envelope. */
  protocolInvocationId: string;
  documentPath: string;
  mentionText: string;
  message: string;
  documentFrontmatter?: Record<string, unknown>;
  documentBody?: string;
  skill?: InvocationSkillContext;
  authorization: InvocationAuthorizationDecision;
  expectedFingerprint: string;
}

export interface LaunchAgentInvocationResponse {
  ok: true;
  invocation: InvocationRecord;
  /** Present only for the explicit, visible command test flow. */
  terminal?: TerminalSessionInfo;
}

export interface InvocationFileReviewPayload {
  invocation: InvocationRecord;
  change: InvocationFileChange;
  beforeText: string | null;
  afterText: string | null;
  /** The artifact is valid but deliberately too large to move across IPC. */
  beforeTextOmitted?: boolean;
  afterTextOmitted?: boolean;
  canKeep: boolean;
  canReject: boolean;
}

export interface InvocationReviewListItem {
  invocationId: string;
  createdAt: string;
  endedAt?: string;
  command: Pick<InvocationRecord["command"], "handle" | "label" | "appearance">;
  changedFileCount: number;
  pendingFileCount: number;
  /** Opaque review keys in deterministic changeset order. */
  pendingChangeIds: string[];
  status: InvocationRecord["status"];
}

export interface InvocationHistoryItem {
  invocationId: string;
  protocolInvocationId?: string;
  createdAt: string;
  endedAt?: string;
  command: Pick<InvocationRecord["command"], "handle" | "label" | "appearance">;
  outcome: "kept" | "rejected" | "pending" | "failed";
  changedFileCount: number;
  /** Opaque review keys in deterministic changeset order. */
  changeIds: string[];
  providerSessionId?: string;
}

export interface AgentCommandLaunchFacts {
  commandId: string;
  handle: string;
  label: string;
  fingerprint: string;
  cwd: string | null;
  cwdReady: boolean;
  executable: string;
  executablePath: string | null;
  executableReady: boolean;
  launchable: boolean;
  block?: "disabled" | "unsupported-prompt-delivery" | "invalid-cwd-policy" | "document-required" | "cwd-missing" | "executable-missing" | "workspace-not-git";
  detail: string;
}

export interface AgentInvocationAuthorizationFacts extends AgentCommandLaunchFacts {
  command: AgentCommand;
  trusted: boolean;
}

export interface PreparedGraphMaintenanceSkill {
  message: string;
  skill: InvocationSkillContext;
}

export interface OntologyDiscoveryResult {
  status: "staged" | "abstained" | "question";
  summary: string;
  question?: string;
  review: OntologyReviewState;
  command: { id: string; handle: string; label: string };
  skill: { id: string; label: string; path: string; revision: string };
  graphSnapshotId: string;
}

export interface AgentCommandContinuityStatus {
  commandId: string;
  supported: boolean;
  policy: "continuous" | "fresh";
  hasHead: boolean;
  active: boolean;
}

/** An explicit installation of Exograph's read-only MCP server into provider-owned config. */
export interface ProviderMcpSetupInput {
  providers: Array<"claude" | "codex">;
}

export interface ProviderMcpSetupResult {
  provider: "claude" | "codex";
  ok: boolean;
  detail: string;
}

/** A read-only diagnosis of the `exograph` command the desktop app can see. */
export interface CliInstallationStatus {
  state: "current" | "legacy-exograph" | "missing" | "non-exograph" | "unavailable";
  /** The command found on PATH, when one is present. */
  commandPath?: string;
  /** Whether the unmodified user-shell PATH can resolve this exact command. */
  shellPathAvailable: boolean;
  /** A shell command that exposes the installed CLI without changing shell files. */
  shellPathCommand?: string;
  /** The checkout command it should point to, when this app can identify one. */
  sourcePath?: string;
  /** A command the user may run from a known checkout. Never run by the app. */
  installCommand?: string;
}

/** A content-free renderer fault record, retained only in Exograph's local main log. */
export interface RendererEditorDiagnostic {
  kind: "editor-render-fault";
  occurredAt: string;
  notePath: string | null;
  mode: "markdown-live" | "markdown-raw" | "code" | "empty";
  selection: { anchor: number; head: number } | null;
  agentHandle: string | null;
  errorSignature: string;
}

export interface WorkspaceInvocationApi {
  launchAgentInvocation: (input: LaunchAgentInvocationInput) => Promise<LaunchAgentInvocationResponse>;
  getAgentInvocationAuthorization: (input: { handle: string; documentPath: string }) => Promise<AgentInvocationAuthorizationFacts>;
  prepareGraphMaintenanceSkill: (input: {
    documentPath: string;
    commandId: string;
  }) => Promise<PreparedGraphMaintenanceSkill>;
  discoverOntology: () => Promise<OntologyDiscoveryResult>;
  getAgentCommandContinuity: (commandId: string) => Promise<AgentCommandContinuityStatus>;
  resetAgentCommandContinuity: (commandId: string) => Promise<{ cleared: number }>;
  configureProviderMcp: (input: ProviderMcpSetupInput) => Promise<ProviderMcpSetupResult[]>;
  getCliInstallationStatus: () => Promise<CliInstallationStatus>;
  /** Install the CLI bundled with this desktop app into the user's local bin. */
  installCli: () => Promise<CliInstallationStatus>;
  recordRendererDiagnostic: (diagnostic: RendererEditorDiagnostic) => Promise<void>;
  endAgentInvocation: (invocationId: string) => Promise<InvocationRecord | null>;
  listPendingInvocationReviews: () => Promise<InvocationReviewListItem[]>;
  listInvocationHistory: (notePath: string) => Promise<InvocationHistoryItem[]>;
  getInvocationFileReview: (input: { invocationId: string; changeId: string }) => Promise<InvocationFileReviewPayload>;
  reviewInvocationFile: (input: { invocationId: string; changeId: string; action: "keep" | "reject" }) => Promise<InvocationRecord>;
  reviewInvocationAll: (input: { invocationId: string; action: "keep" | "reject" }) => Promise<InvocationRecord>;
  resumeInvocationInTerminal: (invocationId: string) => Promise<TerminalSessionInfo>;
  onInvocationUpdated: (callback: (record: InvocationRecord) => void) => () => void;
  onInvocationActivity: (callback: (event: InvocationActivityEvent) => void) => () => void;
}
