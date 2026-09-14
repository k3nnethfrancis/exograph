import { randomUUID, createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { EventEmitter } from "node:events";

import {
  AgentCommandTrustStore,
  InvocationContinuityStore,
  buildInvocationChangeset,
  agentCommandSnapshot,
  agentCommandExecutableFingerprint,
  deriveAgentCommandLaunch,
  formatCliInvocationPrompt,
  formatNoteInvocationPrompt,
  findDocumentAgentEnvelopes,
  InvocationStore,
  readWorkspaceDocument,
  removeDocumentAgentInvocation,
  safeStoreSegment,
  normalizeAgentHandle,
  type AgentCommand,
  type InvocationRecord,
  type InvocationContinuityLane,
  type InvocationConversationHead,
  type InvocationAuthorizationDecision,
  type WorkspaceSettings,
  isDocumentAgentProtocolId,
  type InvocationActivityEvent,
  type InvocationActivityKind,
  type InvocationLaunchArtifacts,
  type InvocationWorkspaceManifest,
  WORKSPACE_RUNTIME_DIRECTORY,
} from "@exograph/core";
import {
  commandForClaudeResume as buildClaudeResumeCommand,
  commandForCodexResume as buildCodexResumeCommand,
} from "@exograph/core/provider-session";

import type { TerminalSessionInfo } from "../../shared/api";
import type { AgentCommandContinuityStatus, AgentCommandLaunchFacts, AgentInvocationAuthorizationFacts } from "../../shared/api";
import { bindResolvedExecutable, inspectAgentCommandLaunchFacts } from "./agent-command-launch-facts";
import {
  DirectInvocationProcessFactory,
  terminateOwnedInvocationProcessGroup,
  type InvocationProcess,
  type InvocationProcessFactory,
} from "./invocation-process";
import {
  commandForHeadlessInvocation as buildHeadlessInvocationCommand,
  extractClaudeSessionId as extractStructuredClaudeSessionId,
  inspectInvocationAdapterResult,
  supportsAutomaticContinuity,
} from "./invocation-adapter";
import type { AgentTerminalWorkspaceContext, TerminalManager } from "../terminal/terminal-manager";
import type { WorkspaceChangeEvent, WorkspaceWatcherService } from "../workspace/workspace-watchers";
import { InvocationActivityAdapter } from "./invocation-activity-adapter";
import {
  InvocationReviewError,
  InvocationReviewService,
  type InvocationFileReviewPayload,
} from "./invocation-review";

export interface InvocationRequest {
  context: "cli" | "note";
  handle: string;
  task?: string;
  documentPath?: string;
  protocolInvocationId?: string;
  mentionText?: string;
  documentFrontmatter?: Record<string, unknown>;
  documentBody?: string;
  skill?: import("@exograph/core").InvocationSkillContext;
  message: string;
}

export interface InvocationAuthorization {
  decision: InvocationAuthorizationDecision;
  expectedFingerprint: string;
}

export interface PreparedInvocation {
  id: string;
  request: InvocationRequest;
  command: AgentCommand;
  executablePath: string;
  cwd: string;
  workspaceRoot: string;
  noteRoots: string[];
  terminalWorkspace: AgentTerminalWorkspaceContext;
  promptTemplate?: string;
  continuityLane?: InvocationContinuityLane;
  before?: FileSnapshot;
  cleanBaseContent?: string;
  pending: InvocationRecord;
}

export interface InvocationResult {
  ok: true;
  invocation: InvocationRecord;
  terminal: TerminalSessionInfo;
}

export interface HeadlessInvocationResult {
  ok: true;
  invocation: InvocationRecord;
  terminal?: never;
}

export type InvocationStartResult = InvocationResult | HeadlessInvocationResult;

export interface InvocationReviewListItem {
  invocationId: string;
  createdAt: string;
  endedAt?: string;
  command: Pick<InvocationRecord["command"], "handle" | "label" | "appearance">;
  changedFileCount: number;
  pendingFileCount: number;
  pendingChangeIds: string[];
  status: InvocationRecord["status"];
}

export interface InvocationHistoryItem {
  invocationId: string;
  createdAt: string;
  endedAt?: string;
  command: Pick<InvocationRecord["command"], "handle" | "label" | "appearance">;
  outcome: "kept" | "rejected" | "pending" | "failed";
  changedFileCount: number;
  changeIds: string[];
  providerSessionId?: string;
}

export class InvocationRunnerError extends Error {
  constructor(readonly code: string, message: string, readonly details: Record<string, unknown> = {}) {
    super(message);
  }
}

class InvocationProcessStopError extends Error {
  constructor(message: string, readonly cause: unknown) { super(message); }
}

interface ActiveObservation {
  record: InvocationRecord;
  before: FileSnapshot;
  workspaceRoot: string;
  noteRoots: string[];
  continuityLockKey?: string;
  observedPaths: Set<string>;
  process?: InvocationProcess;
  requestedStatus?: "user-ended" | "failed";
  terminalActivityEmitted: boolean;
  lastWorkspaceChangeAtMs: number;
  settlementPromise?: Promise<InvocationRecord | null>;
  proposalTimer?: NodeJS.Timeout;
  proposalPromise?: Promise<void>;
}

interface FileSnapshot {
  path: string;
  exists: boolean;
  content: string;
  sha256: string | null;
  mode: number | null;
}

const DEFAULT_SETTLEMENT_QUIET_MS = 240;
const DEFAULT_SETTLEMENT_MAX_WAIT_MS = 2_000;

/** The single lifecycle boundary for agent processes and their review records. */
export class InvocationRunner extends EventEmitter {
  private readonly active = new Map<string, ActiveObservation>();
  private readonly byTerminal = new Map<string, string>();
  private readonly continuityLocks = new Map<string, { invocationId: string; workspaceRoot: string; commandId: string }>();
  private readonly changesetLocks = new Map<string, { invocationId: string; noteRoots: string[] }>();
  private readonly recoveryBlocks = new Map<string, { noteRoots: string[]; reason: string }>();
  private readonly invocationScopes = new Map<string, { workspaceRoot: string; noteRoots: string[] }>();
  private readonly reviewDecisionTails = new Map<string, Promise<void>>();
  private readonly activityState = new Map<string, {
    lastKey: string;
    emittedAtMs: number;
    pending?: { kind: InvocationActivityKind; label?: string };
    timer?: NodeJS.Timeout;
  }>();

  constructor(private readonly options: {
    getWorkspaceSettings: () => WorkspaceSettings;
    trustStateRoot: string;
    terminalManager: TerminalManager;
    workspaceWatcherService: WorkspaceWatcherService;
    invocationProcessFactory?: InvocationProcessFactory;
    settlementQuietMs?: number;
    settlementMaxWaitMs?: number;
  }) {
    super();
    options.workspaceWatcherService.subscribe((event) => this.onWorkspaceChange(event));
    options.terminalManager.on("exit", (event: { id: string; exitCode?: number }) => {
      const id = this.byTerminal.get(event.id);
      if (id) this.settleFromEvent(id, "process-exited", event.exitCode);
    });
  }

  async prepare(request: InvocationRequest): Promise<PreparedInvocation> {
    const settings = this.options.getWorkspaceSettings();
    const command = { ...this.resolveCommand(settings, request.handle) };
    const context = request.context === "note"
      ? { kind: "note" as const, workspaceRoot: settings.workspaceRoot, documentPath: request.documentPath }
      : { kind: "cli" as const, workspaceRoot: settings.workspaceRoot };
    const derived = deriveAgentCommandLaunch(command, context);
    if (!derived.launchable) {
      throw new InvocationRunnerError(derived.block, derived.detail, { handle: command.handle });
    }
    const facts = await inspectAgentCommandLaunchFacts(command, context);
    if (!facts.launchable) {
      throw new InvocationRunnerError(facts.block ?? "not-launchable", facts.detail, { handle: command.handle });
    }
    const cwd = derived.cwd;
    const now = new Date().toISOString();
    const id = randomUUID();
    const pending: InvocationRecord = {
      id, workspaceRoot: settings.workspaceRoot, noteRoots: [...settings.noteRoots], status: "pending", context: request.context,
      ...(request.context === "note" ? { taggedDocumentPath: request.documentPath, originalMentionText: request.mentionText, mentionProvenance: "human-authored" as const } : { mentionProvenance: "unknown" as const }),
      ...(request.protocolInvocationId ? { protocolInvocationId: request.protocolInvocationId } : {}),
      ...(request.skill ? { skill: request.skill } : {}),
      message: request.message,
      continuity: { policy: command.continuityPolicy, outcome: "fresh" },
      promptDelivery: command.promptDelivery,
      command: { ...agentCommandSnapshot(command), executableFingerprint: facts.fingerprint }, cwd, createdAt: now,
    };
    let before = request.context === "note" ? await snapshotTextFile(request.documentPath!) : undefined;
    let cleanBaseContent: string | undefined;
    if (request.context === "note" && request.documentBody !== undefined) {
      const persisted = await readWorkspaceDocument(request.documentPath!);
      const verified = await snapshotTextFile(request.documentPath!);
      const frontmatterMatches = request.documentFrontmatter === undefined ||
        JSON.stringify(persisted.frontmatter) === JSON.stringify(request.documentFrontmatter);
      if (before?.sha256 !== verified.sha256 || persisted.body !== request.documentBody || !frontmatterMatches) {
        throw new InvocationRunnerError(
          "document-drift",
          "The editor and saved document changed before invocation. Save the current note and try again.",
        );
      }
      if (!request.protocolInvocationId || !isDocumentAgentProtocolId(request.protocolInvocationId)) {
        throw new InvocationRunnerError("protocol-invalid", "This invocation is missing its document protocol identity. Recompose the request and try again.");
      }
      const envelope = findDocumentAgentEnvelopes(persisted.body).find((candidate) =>
        candidate.kind === "invocation" &&
        candidate.id === request.protocolInvocationId &&
        candidate.agent === command.handle,
      );
      if (!envelope) {
        throw new InvocationRunnerError("protocol-invalid", "The saved document no longer contains this invocation envelope. Recompose the request and try again.");
      }
      const cleanBody = removeDocumentAgentInvocation(persisted.body, request.protocolInvocationId, command.handle);
      const bodyOffset = before.content.length - persisted.body.length;
      if (cleanBody === null || bodyOffset < 0 || before.content.slice(bodyOffset) !== persisted.body) {
        throw new InvocationRunnerError("protocol-invalid", "Exograph could not derive the exact saved document before this invocation.");
      }
      cleanBaseContent = `${before.content.slice(0, bodyOffset)}${cleanBody}`;
      before = verified;
    }
    const continuityLane = request.context === "note" && supportsAutomaticContinuity(command)
      ? {
          workspaceRoot: settings.workspaceRoot,
          commandId: command.id,
          commandFingerprint: agentCommandExecutableFingerprint(command),
          adapter: "claude-code" as const,
          cwd,
        }
      : undefined;
    this.invocationScopes.set(id, { workspaceRoot: settings.workspaceRoot, noteRoots: [...settings.noteRoots] });
    const terminalWorkspace: AgentTerminalWorkspaceContext = {
      workspaceRoot: settings.workspaceRoot,
      noteRoots: [...settings.noteRoots],
      defaultTerminalCwd: settings.defaultTerminalCwd,
      runtimeRoot: runtimeRootForWorkspace(settings.workspaceRoot),
    };
    return {
      id,
      request,
      command,
      executablePath: facts.executablePath!,
      cwd,
      workspaceRoot: settings.workspaceRoot,
      noteRoots: [...settings.noteRoots],
      terminalWorkspace,
      ...(settings.agentInvocationPrompt ? { promptTemplate: settings.agentInvocationPrompt } : {}),
      ...(continuityLane ? { continuityLane } : {}),
      before,
      ...(cleanBaseContent === undefined ? {} : { cleanBaseContent }),
      pending,
    };
  }

  async authorizeAndStart(
    prepared: PreparedInvocation,
    authorization: InvocationAuthorization,
  ): Promise<InvocationStartResult> {
    const store = new InvocationStore(prepared.workspaceRoot);
    const launchFacts = await this.assertAuthorizationCurrent(prepared, authorization.expectedFingerprint);
    if (authorization.decision.kind === "always-allow") {
      await new AgentCommandTrustStore(this.options.trustStateRoot, prepared.workspaceRoot).trust(prepared.command, undefined, launchFacts.fingerprint);
    } else if (authorization.decision.kind === "trusted") {
      const trust = await new AgentCommandTrustStore(this.options.trustStateRoot, prepared.workspaceRoot).status(prepared.command, launchFacts.fingerprint);
      if (!trust.trusted) throw new InvocationRunnerError("untrusted", `AgentCommand @${prepared.command.handle} must be trusted before launch.`, { handle: prepared.command.handle });
    }
    const continuityLockKey = prepared.continuityLane
      ? new InvocationContinuityStore(prepared.workspaceRoot).headPath(prepared.continuityLane)
      : undefined;
    if (continuityLockKey && this.continuityLocks.has(continuityLockKey)) {
      throw new InvocationRunnerError(
        "continuity-busy",
        `${prepared.command.label} is already working in this context.`,
        { commandId: prepared.command.id },
      );
    }
    if (continuityLockKey) {
      this.continuityLocks.set(continuityLockKey, { invocationId: prepared.id, workspaceRoot: prepared.workspaceRoot, commandId: prepared.command.id });
    }
    let terminal: TerminalSessionInfo | undefined;
    let invocationProcess: InvocationProcess | undefined;
    let launchArtifacts: InvocationLaunchArtifacts | undefined;
    let continuityHead: InvocationConversationHead | null = null;
    let startCommitted = false;
    const queuedExitRef: { current: { event: Parameters<typeof inspectInvocationAdapterResult>[1]; attemptedHead: InvocationConversationHead | null; fallback: boolean } | null } = { current: null };
    const settleHeadlessProcess = (exitCode: number | null, failureReason: string | null) => {
      const status = exitCode !== 0 || failureReason ? "failed" : "process-exited";
      const requested = this.active.get(prepared.id)?.requestedStatus;
      const settledStatus = requested ?? status;
      const activity = settledStatus === "failed"
        ? "failed"
        : settledStatus === "user-ended"
          ? "stopped"
          : "done";
      this.emitTerminalActivity(prepared.id, activity);
      this.settleFromEvent(prepared.id, settledStatus, exitCode ?? undefined, failureReason ?? undefined);
    };
    const handleHeadlessControlError = async (error: unknown, exitCode: number | null): Promise<void> => {
      if (!(error instanceof InvocationProcessStopError)) {
        settleHeadlessProcess(exitCode, error instanceof Error ? error.message : String(error));
        return;
      }
      const observation = this.active.get(prepared.id);
      if (observation) {
        const recoverable: InvocationRecord = {
          ...observation.record,
          status: "orphaned",
          endedAt: new Date().toISOString(),
          failureReason: error.message,
        };
        await store.writeRecord(recoverable);
        observation.record = recoverable;
        this.emitTerminalActivity(prepared.id, "failed");
        this.emit("updated", recoverable);
      }
      this.emit("settlement-error", { invocationId: prepared.id, error });
    };
    try {
      if (prepared.before) {
        await this.acquireChangesetLock(prepared, store);
        if (prepared.cleanBaseContent === undefined) {
          throw new InvocationRunnerError("protocol-invalid", "The exact clean invocation base is unavailable.");
        }
        launchArtifacts = await store.captureLaunchArtifacts(prepared.id, {
          noteRoots: prepared.noteRoots,
          cleanBase: { path: prepared.before.path, content: prepared.cleanBaseContent },
        });
      }
      continuityHead = prepared.continuityLane
        ? await new InvocationContinuityStore(prepared.workspaceRoot).readHead(prepared.continuityLane)
        : null;
      await store.writeRecord(prepared.pending);
      if (prepared.before) {
        this.observe(prepared.pending, prepared.before, prepared.workspaceRoot, prepared.noteRoots, continuityLockKey);
      }
      const prompt = prepared.request.context === "note"
        ? formatNoteInvocationPrompt({
            documentPath: prepared.request.documentPath!,
            mentionText: prepared.request.mentionText ?? "",
            message: prepared.request.message,
            protocolInvocationId: prepared.request.protocolInvocationId,
            agentHandle: prepared.command.handle,
            frontmatter: prepared.request.documentFrontmatter,
            body: prepared.request.documentBody,
            workspaceRoot: prepared.workspaceRoot,
            noteRoots: prepared.noteRoots,
            promptTemplate: prepared.promptTemplate,
          })
        : formatCliInvocationPrompt({ task: prepared.request.task ?? prepared.request.message, workspaceRoot: prepared.workspaceRoot });
      const handleHeadlessExit = async (
        event: Parameters<typeof inspectInvocationAdapterResult>[1],
        attemptedHead: InvocationConversationHead | null,
        fallback: boolean,
      ): Promise<void> => {
        const result = inspectInvocationAdapterResult(prepared.command, event, attemptedHead);
        const observation = this.active.get(prepared.id);
        if (result.staleResumeRejected && attemptedHead && !fallback && prepared.continuityLane && observation && !observation.requestedStatus) {
          const current = await snapshotTextFile(observation.before.path);
          if (current.sha256 === observation.before.sha256 && observation.observedPaths.size === 0) {
            await new InvocationContinuityStore(prepared.workspaceRoot).clearHead(prepared.continuityLane);
            if (observation.requestedStatus) {
              settleHeadlessProcess(event.exitCode, result.failureReason);
              return;
            }
            try {
              await launchHeadless(null, true);
              return;
            } catch (error) {
              if (error instanceof InvocationProcessStopError) throw error;
              const reason = error instanceof Error ? error.message : String(error);
              settleHeadlessProcess(null, reason);
              return;
            }
          }
        }
        if (observation) {
          const outcome = fallback
            ? "resume-failed-fresh"
            : attemptedHead
              ? result.failureReason ? "resume-failed" : "resumed"
              : "fresh";
          observation.record = {
            ...observation.record,
            ...(result.providerSessionId ? { providerSessionId: result.providerSessionId } : {}),
            continuity: {
              policy: prepared.command.continuityPolicy,
              outcome,
              ...((attemptedHead || fallback && continuityHead)
                ? { resumedFromInvocationId: (attemptedHead ?? continuityHead)!.sourceInvocationId }
                : {}),
            },
          };
          if (!result.failureReason && result.providerSessionId && prepared.continuityLane) {
            await new InvocationContinuityStore(prepared.workspaceRoot).writeHead(prepared.continuityLane, {
              providerSessionId: result.providerSessionId,
              sourceInvocationId: prepared.id,
            });
          }
        }
        settleHeadlessProcess(event.exitCode, result.failureReason);
      };
      const launchHeadless = async (head: InvocationConversationHead | null, fallback: boolean): Promise<void> => {
        const activityAdapter = new InvocationActivityAdapter(prepared.command.adapter);
        invocationProcess = (this.options.invocationProcessFactory ?? new DirectInvocationProcessFactory()).launch({
          command: bindResolvedExecutable(buildHeadlessInvocationCommand(prepared.command, head), launchFacts.executablePath!),
          cwd: prepared.cwd,
          env: globalThis.process.env,
        });
        const observation = this.active.get(prepared.id);
        if (observation) observation.process = invocationProcess;
        this.emitActivity(prepared.id, { kind: "working" });
        invocationProcess.onOutput?.((output) => {
          for (const activity of activityAdapter.push(output.channel, output.chunk)) {
            this.emitActivity(prepared.id, activity);
          }
          const providerSessionId = activityAdapter.providerSessionId();
          if (providerSessionId) {
            void this.recordProviderSession(prepared.id, providerSessionId).catch((error) => {
              this.emit("settlement-error", { invocationId: prepared.id, error });
            });
          }
        });
        invocationProcess.onExit((event) => {
          for (const activity of activityAdapter.finish()) this.emitActivity(prepared.id, activity, true);
          if (!startCommitted) {
            queuedExitRef.current = { event, attemptedHead: head, fallback };
            return;
          }
          void handleHeadlessExit(event, head, fallback).catch((error) => {
            void handleHeadlessControlError(error, event.exitCode).catch((controlError) => {
              this.emit("settlement-error", { invocationId: prepared.id, error: controlError });
            });
          });
        });
        try {
          // The command remains behind its fd3 launch gate until this identity
          // is durable. Recovery can therefore always stop or block before it
          // captures a settled workspace.
          await store.writeProcessOwnership(prepared.id, invocationProcess.ownership);
          if (prepared.before && launchArtifacts) {
            await assertLaunchDocumentStillCurrent(prepared, launchArtifacts);
          }
          await invocationProcess.release();
          await invocationProcess.send(prompt);
        } catch (error) {
          try {
            await invocationProcess.stop();
          } catch (stopError) {
            throw new InvocationProcessStopError(
              "Invocation prompt delivery failed and its process could not be stopped safely.",
              new AggregateError([error, stopError]),
            );
          }
          throw error;
        }
      };
      if (prepared.request.context === "note") {
        await launchHeadless(continuityHead, false);
      } else {
        terminal = await this.options.terminalManager.createAgentCommand({
          ...prepared.command,
          command: bindResolvedExecutable(prepared.command.command, launchFacts.executablePath!),
        }, prepared.cwd, prepared.terminalWorkspace);
        const delivered = await this.options.terminalManager.sendMessage(terminal.id, prompt, true);
        if (!delivered.ok) throw new InvocationRunnerError("prompt-delivery-failed", "Agent prompt could not be delivered.");
      }
      const startedAt = new Date().toISOString();
      const running = {
        ...(this.active.get(prepared.id)?.record ?? prepared.pending),
        status: "running" as const,
        startedAt,
        ...(terminal ? { terminalSessionId: terminal.id } : {}),
      };
      await store.writeRecord(running);
      const observation = this.active.get(prepared.id);
      if (observation) {
        observation.record = running;
        if (terminal) this.byTerminal.set(terminal.id, prepared.id);
      }
      if (invocationProcess && prepared.before) {
        startCommitted = true;
        const exit = queuedExitRef.current;
        if (exit) {
          queuedExitRef.current = null;
          void handleHeadlessExit(exit.event, exit.attemptedHead, exit.fallback).catch((error) => {
            void handleHeadlessControlError(error, exit.event.exitCode).catch((controlError) => {
              this.emit("settlement-error", { invocationId: prepared.id, error: controlError });
            });
          });
        }
      }
      return { ok: true, invocation: running, ...(terminal ? { terminal } : {}) };
    } catch (error) {
      if (terminal) await this.options.terminalManager.kill(terminal.id).catch(() => undefined);
      const observation = this.active.get(prepared.id);
      if (observation) observation.requestedStatus = "failed";
      if (invocationProcess) {
        try {
          await invocationProcess.stop();
        } catch (stopError) {
          const recoverable: InvocationRecord = {
            ...(observation?.record ?? prepared.pending),
            status: "orphaned",
            endedAt: new Date().toISOString(),
            failureReason: "Invocation launch failed and its process could not be stopped safely.",
          };
          await store.writeRecord(recoverable);
          if (observation) observation.record = recoverable;
          throw new AggregateError([error, stopError], "Invocation launch failed and its process could not be stopped safely.");
        }
      }
      this.clearActivity(prepared.id);
      const failureReason = error instanceof Error ? error.message : String(error);
      if (observation) {
        if (error instanceof InvocationRunnerError && error.code === "document-drift" && !observation.record.startedAt) {
          const failed: InvocationRecord = {
            ...observation.record,
            status: "failed",
            endedAt: new Date().toISOString(),
            failureReason,
          };
          await store.writeRecord(failed);
          await store.clearProcessOwnership(prepared.id);
          observation.record = failed;
          this.emit("updated", failed);
          this.releaseObservation(observation);
          throw error;
        }
        try {
          await this.settle(prepared.id, "failed", undefined, failureReason);
        } catch (settlementError) {
          throw new AggregateError([error, settlementError], "Invocation launch and settlement both failed.");
        }
      } else {
        if (continuityLockKey) this.continuityLocks.delete(continuityLockKey);
        this.releaseChangesetLock(prepared.id);
        const failed: InvocationRecord = { ...prepared.pending, status: "failed", endedAt: new Date().toISOString(), failureReason };
        await store.writeRecord(failed).catch(() => undefined);
      }
      throw error;
    }
  }

  async getCommandLaunchFacts(commandId: string): Promise<AgentCommandLaunchFacts> {
    const settings = this.options.getWorkspaceSettings();
    const command = settings.agentCommands?.find((entry) => entry.id === commandId);
    if (!command) {
      throw new InvocationRunnerError("not-found", `No saved Command has id ${commandId}.`, { commandId });
    }
    return inspectAgentCommandLaunchFacts(command, { kind: "cli", workspaceRoot: settings.workspaceRoot });
  }

  async getInvocationAuthorization(handleInput: string, documentPath: string): Promise<AgentInvocationAuthorizationFacts> {
    const settings = this.options.getWorkspaceSettings();
    const command = { ...this.resolveCommand(settings, handleInput) };
    const facts = await inspectAgentCommandLaunchFacts(command, {
      kind: "note",
      workspaceRoot: settings.workspaceRoot,
      documentPath,
    });
    const trust = await new AgentCommandTrustStore(this.options.trustStateRoot, settings.workspaceRoot).status(command, facts.fingerprint);
    return { ...facts, command, trusted: trust.trusted };
  }

  async getCommandContinuityStatus(commandId: string): Promise<AgentCommandContinuityStatus> {
    const settings = this.options.getWorkspaceSettings();
    const command = settings.agentCommands?.find((entry) => entry.id === commandId);
    if (!command) throw new InvocationRunnerError("not-found", `No saved Command has id ${commandId}.`, { commandId });
    const supported = command.adapter === "claude-code";
    const store = new InvocationContinuityStore(settings.workspaceRoot);
    return {
      commandId,
      supported,
      policy: supported ? command.continuityPolicy : "fresh",
      hasHead: supported ? await store.hasCommandHead(commandId) : false,
      active: [...this.continuityLocks.values()].some((lock) => lock.workspaceRoot === settings.workspaceRoot && lock.commandId === commandId),
    };
  }

  async resetCommandContinuity(commandId: string): Promise<{ cleared: number }> {
    const settings = this.options.getWorkspaceSettings();
    const status = await this.getCommandContinuityStatus(commandId);
    if (!status.supported) throw new InvocationRunnerError("continuity-unavailable", "Context is unavailable for this Command.", { commandId });
    if (status.active) throw new InvocationRunnerError("continuity-busy", "This Command is still working.", { commandId });
    return { cleared: await new InvocationContinuityStore(settings.workspaceRoot).clearCommandHeads(commandId) };
  }

  async testCommand(commandId: string, expectedFingerprint: string): Promise<InvocationResult> {
    const facts = await this.getCommandLaunchFacts(commandId);
    if (facts.fingerprint !== expectedFingerprint) {
      throw new InvocationRunnerError("fingerprint-drift", `Command @${facts.handle} changed after confirmation. Review it and try again.`);
    }
    const prepared = await this.prepare({
      context: "cli",
      handle: facts.handle,
      task: `Verify that @${facts.handle} can launch from Exograph. Respond briefly, then remain available in this terminal.`,
      message: `Test @${facts.handle} in terminal`,
    });
    if (prepared.pending.command.executableFingerprint !== expectedFingerprint) {
      throw new InvocationRunnerError("fingerprint-drift", `Command @${facts.handle} changed after confirmation. Review it and try again.`);
    }
    const result = await this.authorizeAndStart(prepared, {
      decision: { kind: "run-once" },
      expectedFingerprint,
    });
    if (!result.terminal) {
      throw new InvocationRunnerError("not-launchable", `Command @${facts.handle} did not open its visible test terminal.`);
    }
    return result;
  }

  async getCommandTrust(handleInput: string) {
    const settings = this.options.getWorkspaceSettings();
    const command = this.resolveCommand(settings, handleInput);
    const facts = await inspectAgentCommandLaunchFacts(command, { kind: "cli", workspaceRoot: settings.workspaceRoot });
    const trust = await new AgentCommandTrustStore(this.options.trustStateRoot, settings.workspaceRoot).status(command, facts.fingerprint);
    return facts.launchable ? trust : { ...trust, trusted: false };
  }

  async resetCommandTrust(handleInput: string): Promise<{ revoked: boolean }> {
    const settings = this.options.getWorkspaceSettings();
    const command = this.resolveCommand(settings, handleInput);
    const revoked = await new AgentCommandTrustStore(this.options.trustStateRoot, settings.workspaceRoot).revoke(command);
    return { revoked };
  }

  async endObservation(id: string): Promise<InvocationRecord | null> {
    const observation = this.active.get(id);
    if (!observation) return null;
    observation.requestedStatus = "user-ended";
    await observation.process?.stop();
    this.emitTerminalActivity(id, "stopped");
    return this.settle(id, "user-ended");
  }

  async stopAll(): Promise<void> {
    const observations = [...this.active.values()];
    for (const observation of observations) observation.requestedStatus = "user-ended";
    const failures: unknown[] = [];
    const stopped: ActiveObservation[] = [];
    await Promise.all(observations.map(async (observation) => {
      try {
        await observation.process?.stop();
        stopped.push(observation);
      } catch (error) {
        failures.push(error);
      }
    }));
    await Promise.all(stopped.map((observation) => {
      this.emitTerminalActivity(observation.record.id, "stopped");
      return this.settle(observation.record.id, "user-ended");
    }));
    if (failures.length > 0) {
      throw new AggregateError(failures, `Failed to stop ${failures.length} invocation process${failures.length === 1 ? "" : "es"}.`);
    }
  }

  async get(id: string): Promise<InvocationRecord | null> {
    return new InvocationStore(this.scopeForInvocation(id).workspaceRoot).readRecord(id);
  }

  /** Origin lookup for renderer routing; never falls back to ambient Workspace state. */
  workspaceRootForInvocation(id: string): string | null {
    return this.invocationScopes.get(id)?.workspaceRoot ?? this.active.get(id)?.workspaceRoot ?? null;
  }

  async getInvocationFileReview(id: string, changeId: string): Promise<InvocationFileReviewPayload> {
    const scope = this.scopeForInvocation(id);
    const record = await requiredInvocation(new InvocationStore(scope.workspaceRoot), id);
    return this.reviewService(scope.workspaceRoot).getFilePayload(record, changeId);
  }

  async reviewInvocationFile(id: string, changeId: string, action: "keep" | "reject"): Promise<InvocationRecord> {
    return this.resolveReview(id, [{ changeId, action }]);
  }

  async reviewInvocationAll(id: string, action: "keep" | "reject"): Promise<InvocationRecord> {
    return this.resolveReview(id, [], action);
  }

  async listPendingReviews(): Promise<InvocationReviewListItem[]> {
    const settings = this.options.getWorkspaceSettings();
    return (await new InvocationStore(settings.workspaceRoot).listRecords())
      .filter((record) => record.changeset?.files.some((change) => isUnresolvedReviewDecision(change.decision.status)))
      .sort(newestRecordFirst)
      .map(reviewListItem);
  }

  async listHistoryForNote(notePath: string): Promise<InvocationHistoryItem[]> {
    const settings = this.options.getWorkspaceSettings();
    const exactPath = await canonicalPathOrResolved(notePath);
    const records = await new InvocationStore(settings.workspaceRoot).listRecords();
    const taggedPaths = await Promise.all(records.map((record) => record.taggedDocumentPath
      ? canonicalPathOrResolved(record.taggedDocumentPath)
      : null));
    return records
      .filter((record, index) => taggedPaths[index] === exactPath || record.changeset?.files.some((change) =>
        change.before?.path === exactPath || change.after?.path === exactPath))
      .sort(newestRecordFirst)
      .map((record) => ({
        invocationId: record.id,
        ...(record.protocolInvocationId ? { protocolInvocationId: record.protocolInvocationId } : {}),
        createdAt: record.createdAt,
        ...(record.endedAt ? { endedAt: record.endedAt } : {}),
        command: { handle: record.command.handle, label: record.command.label, ...(record.command.appearance ? { appearance: record.command.appearance } : {}) },
        outcome: invocationHistoryOutcome(record),
        changedFileCount: record.changeset?.files.length ?? 0,
        changeIds: record.changeset?.files.map((change) => change.id) ?? [],
        ...(record.providerSessionId ? { providerSessionId: record.providerSessionId } : {}),
      }));
  }

  async resumeInTerminal(id: string): Promise<TerminalSessionInfo> {
    const record = await this.get(id);
    if (!record?.providerSessionId || (record.command.adapter !== "claude-code" && record.command.adapter !== "codex-cli")) {
      throw new InvocationRunnerError("resume-unavailable", "This invocation does not have resumable session provenance.");
    }
    const fallbackSettings = this.options.getWorkspaceSettings();
    const workspaceRoot = record.workspaceRoot ?? fallbackSettings.workspaceRoot;
    const noteRoots = record.noteRoots ?? fallbackSettings.noteRoots;
    return this.options.terminalManager.createAgentCommand(
      {
        ...record.command,
        command: record.command.adapter === "claude-code"
          ? commandForClaudeResume(record.command, record.providerSessionId)
          : buildCodexResumeCommand(record.command, record.providerSessionId),
      },
      record.cwd,
      {
        workspaceRoot,
        noteRoots: [...noteRoots],
        defaultTerminalCwd: record.cwd,
        runtimeRoot: runtimeRootForWorkspace(workspaceRoot),
      },
    );
  }

  async markOrphanedRunningInvocations(): Promise<void> {
    await this.recoverWorkspace(this.options.getWorkspaceSettings());
  }

  /** Recover a workspace completely before callers expose it as active. */
  async recoverWorkspace(settings: WorkspaceSettings): Promise<void> {
    const store = new InvocationStore(settings.workspaceRoot);
    let invocationIds: string[];
    try {
      invocationIds = await store.listInvocationIds();
      this.recoveryBlocks.delete(settings.workspaceRoot);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.recoveryBlocks.set(settings.workspaceRoot, {
        noteRoots: settings.noteRoots.map((root) => path.resolve(root)),
        reason: `Invocation recovery could not enumerate durable records: ${reason}`,
      });
      console.error("[exograph] invocation workspace recovery remains blocked", { workspaceRoot: settings.workspaceRoot, error });
      return;
    }
    const workspaceBlockReasons: string[] = [];
    for (const artifactId of invocationIds) {
      const activeObservation = this.active.get(artifactId);
      if (activeObservation?.workspaceRoot === settings.workspaceRoot) {
        // A Workspace can be switched away from and back to while its command
        // is still active in this runner. Its in-memory observation and locks
        // remain authoritative; recovery must not kill or settle it twice.
        this.invocationScopes.set(artifactId, {
          workspaceRoot: activeObservation.workspaceRoot,
          noteRoots: [...activeObservation.noteRoots],
        });
        continue;
      }

      let record: InvocationRecord | null = null;
      let recordStore = store;
      let noteRoots = [...settings.noteRoots];
      let workspaceRoot = settings.workspaceRoot;
      let recovered: InvocationRecord | null = null;
      try {
        // Ownership is inspected before record parsing. A missing or damaged
        // record must never hide a still-running writer.
        const ownership = await store.readProcessOwnership(artifactId);
        if (ownership) await terminateOwnedInvocationProcessGroup(ownership);

        record = await store.readRecord(artifactId);
        if (!record) {
          throw new Error("Invocation record is missing or semantically invalid.");
        }
        if (safeStoreSegment(record.id) !== artifactId) {
          throw new Error("Invocation record id does not match its artifact directory.");
        }
        workspaceRoot = record.workspaceRoot ?? settings.workspaceRoot;
        if (path.resolve(workspaceRoot) !== path.resolve(settings.workspaceRoot)) {
          throw new Error("Invocation record Workspace does not match its artifact directory.");
        }
        noteRoots = record.noteRoots?.length ? [...record.noteRoots] : [...settings.noteRoots];
        this.invocationScopes.set(record.id, { workspaceRoot, noteRoots });
        recordStore = store;
        recovered = record;

        const requiresFromRecord = record.status === "pending" || record.status === "running" ||
          record.status === "orphaned" && !record.changeset;
        let existingSettled = null as InvocationWorkspaceManifest | null;
        if (!ownership && requiresFromRecord) {
          existingSettled = await recordStore.readManifest(record.id, "settled");
          if (!existingSettled) {
            throw new Error("Durable invocation process ownership is missing; Exograph cannot prove the writer is dead.");
          }
        }
        recovered = await this.reviewService(workspaceRoot).recoverJournal(record);
        const launch = await recordStore.readManifest(record.id, "launch");
        const failedBeforeExecution = recovered.status === "failed" && !recovered.startedAt;
        const requiresExactRecovery = recovered.status === "pending" || recovered.status === "running" ||
          (recovered.status === "orphaned" && !recovered.changeset) ||
          Boolean(launch && !recovered.changeset && !failedBeforeExecution);
        if (!requiresExactRecovery) {
          if (recovered.changeset) await this.compactArtifacts(recordStore, recovered.id, recovered.changeset);
          if (ownership) await recordStore.clearProcessOwnership(record.id);
          continue;
        }
        if (!launch) throw new Error("Invocation launch manifest is missing; exact recovery cannot continue.");
        existingSettled ??= await recordStore.readManifest(record.id, "settled");
        const settled = existingSettled ?? await recordStore.captureSettledManifest(record.id, noteRoots, launch);
        const changeset = buildInvocationChangeset(launch, settled);
        const next: InvocationRecord = {
          ...recovered,
          status: "orphaned",
          endedAt: new Date().toISOString(),
          changeset,
        };
        await recordStore.writeRecord(next);
        await this.compactArtifacts(recordStore, next.id, changeset);
        await recordStore.clearProcessOwnership(record.id);
        this.emit("updated", next);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        workspaceBlockReasons.push(`Invocation ${record?.id ?? artifactId}: ${reason}`);
        if (!record) {
          console.error("[exograph] invocation artifact recovery remains blocked", {
            workspaceRoot: settings.workspaceRoot,
            invocationId: artifactId,
            error,
          });
          continue;
        }
        const blocked: InvocationRecord = {
          ...(recovered ?? record),
          status: "orphaned",
          endedAt: new Date().toISOString(),
          failureReason: `Invocation recovery remains unresolved: ${reason}`,
        };
        try {
          await recordStore.writeRecord(blocked);
          this.emit("updated", blocked);
        } catch (persistenceError) {
          console.error("[exograph] invocation recovery state could not be persisted", {
            invocationId: record.id,
            error,
            persistenceError,
          });
        }
      }
    }
    if (workspaceBlockReasons.length > 0) {
      this.recoveryBlocks.set(settings.workspaceRoot, {
        noteRoots: settings.noteRoots.map((root) => path.resolve(root)),
        reason: `Invocation recovery remains blocked. ${workspaceBlockReasons.join(" ")}`,
      });
    }
  }

  private scopeForInvocation(id: string): { workspaceRoot: string; noteRoots: string[] } {
    return this.invocationScopes.get(id) ?? (() => {
      const settings = this.options.getWorkspaceSettings();
      return { workspaceRoot: settings.workspaceRoot, noteRoots: [...settings.noteRoots] };
    })();
  }

  private observe(
    record: InvocationRecord,
    before: FileSnapshot,
    workspaceRoot: string,
    noteRoots: string[],
    continuityLockKey?: string,
  ): void {
    if (!record.taggedDocumentPath) return;
    this.active.set(record.id, {
      record,
      before,
      workspaceRoot,
      noteRoots,
      ...(continuityLockKey ? { continuityLockKey } : {}),
      observedPaths: new Set(),
      terminalActivityEmitted: false,
      lastWorkspaceChangeAtMs: Date.now(),
    });
  }

  private onWorkspaceChange(event: WorkspaceChangeEvent): void {
    if (!event.filePath) return;
    const changedPath = path.resolve(event.filePath);
    for (const observation of this.active.values()) {
      if (!observation.noteRoots.some((root) => isWithinPath(root, changedPath))) continue;
      observation.observedPaths.add(changedPath);
      observation.lastWorkspaceChangeAtMs = Date.now();
      // The linked response proves that a proposal exists; the quiet window
      // must include every authorized Note Root change, not just the response
      // document. Commands commonly write the receipt before finishing edits
      // in other notes.
      this.scheduleProposalCheckpoint(observation);
    }
  }

  private scheduleProposalCheckpoint(observation: ActiveObservation): void {
    if (observation.record.changeset || observation.settlementPromise) return;
    if (observation.proposalTimer) clearTimeout(observation.proposalTimer);
    const quietMs = this.options.settlementQuietMs ?? DEFAULT_SETTLEMENT_QUIET_MS;
    observation.proposalTimer = setTimeout(() => {
      observation.proposalTimer = undefined;
      if (observation.record.changeset || observation.settlementPromise || observation.proposalPromise) return;
      const checkpoint = this.captureProposalCheckpoint(observation).finally(() => {
        if (observation.proposalPromise === checkpoint) observation.proposalPromise = undefined;
      });
      observation.proposalPromise = checkpoint;
    }, quietMs);
  }

  private async recordProviderSession(id: string, providerSessionId: string): Promise<void> {
    const observation = this.active.get(id);
    if (!observation || observation.record.providerSessionId === providerSessionId) return;
    const next = { ...observation.record, providerSessionId };
    // Claim the identity synchronously so repeated JSONL chunks cannot enqueue
    // duplicate writes before the first durable write completes.
    observation.record = next;
    await new InvocationStore(observation.workspaceRoot).writeRecord(next);
    this.emit("updated", next);
  }

  /**
   * The linked response envelope is the provider-neutral proposal boundary.
   * Once it is durably present and the filesystem is quiet, review can begin
   * even while the harness finishes its own terminal response.
   */
  private async captureProposalCheckpoint(observation: ActiveObservation): Promise<void> {
    const id = observation.record.id;
    const protocolId = observation.record.protocolInvocationId;
    if (!isDocumentAgentProtocolId(protocolId)) return;
    const current = await readWorkspaceDocument(observation.record.taggedDocumentPath!);
    const hasResponse = findDocumentAgentEnvelopes(current.body).some((envelope) =>
      envelope.kind === "response" &&
      envelope.invocationId === protocolId &&
      envelope.agent === observation.record.command.handle,
    );
    if (!hasResponse) return;
    const store = new InvocationStore(observation.workspaceRoot);
    const launch = await store.readManifest(id, "launch");
    if (!launch) return;
    const settled = await store.captureSettledManifest(id, observation.noteRoots, launch);
    const changeset = buildInvocationChangeset(launch, settled);
    const next = { ...observation.record, changeset };
    await store.writeRecord(next);
    observation.record = next;
    this.emit("updated", next);
  }

  private settle(id: string, status: "process-exited" | "user-ended" | "failed", exitCode?: number, failureReason?: string): Promise<InvocationRecord | null> {
    const observation = this.active.get(id);
    if (!observation) return Promise.resolve(null);
    if (observation.settlementPromise) return observation.settlementPromise;
    const settlement = this.captureSettlement(observation, status, exitCode, failureReason);
    observation.settlementPromise = settlement;
    return settlement;
  }

  private async captureSettlement(
    observation: ActiveObservation,
    status: "process-exited" | "user-ended" | "failed",
    exitCode?: number,
    failureReason?: string,
  ): Promise<InvocationRecord | null> {
    const id = observation.record.id;
    try {
      const store = new InvocationStore(observation.workspaceRoot);
      await this.waitForSettlementQuiet(observation);
      const launch = await store.readManifest(id, "launch");
      if (!launch) throw new InvocationRunnerError("review-unavailable", "The invocation launch manifest is unavailable.");
      const settled = await store.captureSettledManifest(id, observation.noteRoots, launch);
      const changeset = observation.record.changeset ?? buildInvocationChangeset(launch, settled);
      const missingDurableResponse = status === "process-exited" &&
        isDocumentAgentProtocolId(observation.record.protocolInvocationId) &&
        !await hasDurableResponse(
          store,
          id,
          settled,
          observation.record.taggedDocumentPath,
          observation.record.protocolInvocationId,
          observation.record.command.handle,
        );
      const settledStatus = missingDurableResponse ? "failed" : status;
      const settledFailureReason = missingDurableResponse
        ? `@${observation.record.command.handle} finished without writing its linked response into the note.`
        : failureReason;
      const next: InvocationRecord = {
        ...observation.record,
        status: settledStatus,
        endedAt: new Date().toISOString(),
        ...(exitCode === undefined ? {} : { exitCode }),
        ...(settledStatus === "failed" ? { failureReason: settledFailureReason ?? `Command exited with code ${exitCode ?? "unknown"}.` } : {}),
        changeset,
      };
      await store.writeRecord(next);
      await store.clearProcessOwnership(id);
      // Retire redundant snapshots before releasing the invocation scope. The
      // compactor is bounded and concurrent; process completion was already
      // reported independently through the activity channel.
      await this.compactArtifacts(store, id, changeset);
      this.emit("updated", next);
      this.releaseObservation(observation);
      return next;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const recoverable: InvocationRecord = {
        ...observation.record,
        status: "orphaned",
        endedAt: new Date().toISOString(),
        failureReason: `Invocation settlement failed: ${reason}`,
      };
      let settlementError = error;
      try {
        await new InvocationStore(observation.workspaceRoot).writeRecord(recoverable);
        observation.record = recoverable;
        this.emit("updated", recoverable);
      } catch (recoveryError) {
        settlementError = new AggregateError(
          [error, recoveryError],
          "Invocation settlement failed and its recoverable record could not be persisted.",
        );
      } finally {
        observation.settlementPromise = undefined;
      }
      throw settlementError;
    }
  }

  private settleFromEvent(
    id: string,
    status: "process-exited" | "user-ended" | "failed",
    exitCode?: number,
    failureReason?: string,
  ): void {
    void this.settle(id, status, exitCode, failureReason).catch((error) => {
      this.emit("settlement-error", { invocationId: id, error });
    });
  }

  private releaseObservation(observation: ActiveObservation): void {
    const id = observation.record.id;
    if (observation.proposalTimer) clearTimeout(observation.proposalTimer);
    this.clearActivity(id);
    this.active.delete(id);
    if (observation.record.terminalSessionId) this.byTerminal.delete(observation.record.terminalSessionId);
    if (observation.continuityLockKey) this.continuityLocks.delete(observation.continuityLockKey);
    this.releaseChangesetLock(id);
  }

  private async waitForSettlementQuiet(observation: ActiveObservation): Promise<void> {
    const quietMs = this.options.settlementQuietMs ?? DEFAULT_SETTLEMENT_QUIET_MS;
    const maxWaitMs = this.options.settlementMaxWaitMs ?? DEFAULT_SETTLEMENT_MAX_WAIT_MS;
    const startedAt = Date.now();
    while (Date.now() - startedAt < maxWaitMs && Date.now() - observation.lastWorkspaceChangeAtMs < quietMs) {
      const remainingQuiet = quietMs - (Date.now() - observation.lastWorkspaceChangeAtMs);
      await delay(Math.max(1, Math.min(remainingQuiet, maxWaitMs - (Date.now() - startedAt))));
    }
  }

  private async acquireChangesetLock(prepared: PreparedInvocation, store: InvocationStore): Promise<void> {
    const roots = prepared.noteRoots.map((root) => path.resolve(root));
    const recoveryBlock = [...this.recoveryBlocks.values()].find((block) => rootsOverlap(block.noteRoots, roots));
    if (recoveryBlock) {
      throw new InvocationRunnerError("review-busy", recoveryBlock.reason);
    }
    if ([...this.changesetLocks.values()].some((lock) => rootsOverlap(lock.noteRoots, roots))) {
      throw new InvocationRunnerError("review-busy", "Another invocation is changing an overlapping Note Root.");
    }
    this.changesetLocks.set(prepared.id, { invocationId: prepared.id, noteRoots: roots });
    try {
      const unresolved = (await store.listRecords()).find((record) =>
        record.id !== prepared.id &&
        (record.changeset?.files.some((change) => isUnresolvedReviewDecision(change.decision.status)) ||
          ((record.status === "pending" || record.status === "running" || record.status === "orphaned") && !record.changeset)) &&
        rootsOverlap(record.noteRoots ?? [], roots));
      if (unresolved) {
        throw new InvocationRunnerError("review-busy", "Review the previous invocation before starting another in this Note Root.", { invocationId: unresolved.id });
      }
    } catch (error) {
      this.releaseChangesetLock(prepared.id);
      throw error;
    }
  }

  private releaseChangesetLock(id: string): void {
    this.changesetLocks.delete(id);
  }

  private reviewService(workspaceRoot: string): InvocationReviewService {
    return new InvocationReviewService(workspaceRoot);
  }

  private async resolveReview(
    id: string,
    resolutions: Array<{ changeId: string; action: "keep" | "reject" }>,
    allAction?: "keep" | "reject",
  ): Promise<InvocationRecord> {
    return this.serializeReviewDecision(id, async () => {
      const scope = this.scopeForInvocation(id);
      const store = new InvocationStore(scope.workspaceRoot);
      const record = await requiredInvocation(store, id);
      const effectiveResolutions = allAction
        ? record.changeset?.files
          .filter((change) => change.decision.status === "pending" || allAction === "keep" && change.decision.status === "conflict")
          .map((change) => ({ changeId: change.id, action: allAction })) ?? []
        : resolutions;
      const requested = new Map<string, "keep" | "reject">();
      for (const resolution of effectiveResolutions) {
        const existing = requested.get(resolution.changeId);
        if (existing && existing !== resolution.action) {
          throw new InvocationRunnerError("review-unavailable", "A file cannot have two review decisions.");
        }
        requested.set(resolution.changeId, resolution.action);
      }

      const pending: Array<{ changeId: string; action: "keep" | "reject" }> = [];
      for (const [changeId, action] of requested) {
        const change = record.changeset?.files.find((entry) => entry.id === changeId);
        if (!change) {
          throw new InvocationRunnerError("review-unavailable", `Invocation change ${changeId} was not found.`);
        }
        const resolvedAsRequested = action === "keep"
          ? change.decision.status === "kept"
          : change.decision.status === "rejected";
        if (resolvedAsRequested) continue;
        const reviewable = change.decision.status === "pending" ||
          change.decision.status === "conflict" && action === "keep";
        if (!reviewable) {
          throw new InvocationRunnerError(
            "review-unavailable",
            `Invocation change ${changeId} was already resolved as ${change.decision.status}.`,
          );
        }
        pending.push({ changeId, action });
      }
      if (pending.length === 0) return record;

      try {
        const next = await this.reviewService(scope.workspaceRoot).resolve(record, pending);
        const observation = this.active.get(id);
        if (observation) observation.record = next;
        if (next.changeset) await this.compactArtifacts(store, next.id, next.changeset);
        this.emit("updated", next);
        return next;
      } catch (error) {
        if (error instanceof InvocationReviewError) throw new InvocationRunnerError(error.code, error.message);
        throw error;
      }
    });
  }

  private async serializeReviewDecision<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const predecessor = this.reviewDecisionTails.get(id) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    this.reviewDecisionTails.set(id, current);
    await predecessor.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (this.reviewDecisionTails.get(id) === current) this.reviewDecisionTails.delete(id);
    }
  }

  private async compactArtifacts(
    store: InvocationStore,
    invocationId: string,
    changeset: NonNullable<InvocationRecord["changeset"]>,
  ): Promise<void> {
    try {
      const report = await store.compactArtifacts(invocationId, changeset);
      this.emit("artifacts-compacted", { invocationId, report });
    } catch (error) {
      // Compaction is deliberately post-commit. A cleanup failure may retain
      // extra immutable snapshots, but it must never turn a valid Changeset
      // into an orphan or block the user's Keep/Reject decision.
      this.emit("artifact-compaction-error", { invocationId, error });
    }
  }

  private emitActivity(id: string, activity: { kind: InvocationActivityKind; label?: string }, immediate = false): void {
    const key = `${activity.kind}:${activity.label ?? ""}`;
    const now = Date.now();
    const state = this.activityState.get(id) ?? { lastKey: "", emittedAtMs: 0 };
    if (state.lastKey === key && !state.pending) return;
    const elapsed = now - state.emittedAtMs;
    if (!immediate && elapsed < INVOCATION_ACTIVITY_INTERVAL_MS) {
      state.pending = activity;
      if (!state.timer) {
        state.timer = setTimeout(() => {
          const current = this.activityState.get(id);
          if (!current?.pending) return;
          const pending = current.pending;
          current.pending = undefined;
          current.timer = undefined;
          this.publishActivity(id, pending, current);
        }, INVOCATION_ACTIVITY_INTERVAL_MS - elapsed);
        state.timer.unref?.();
      }
      this.activityState.set(id, state);
      return;
    }
    if (state.timer) clearTimeout(state.timer);
    state.timer = undefined;
    state.pending = undefined;
    this.publishActivity(id, activity, state);
  }

  private publishActivity(
    id: string,
    activity: { kind: InvocationActivityKind; label?: string },
    state: { lastKey: string; emittedAtMs: number; pending?: { kind: InvocationActivityKind; label?: string }; timer?: NodeJS.Timeout },
  ): void {
    state.lastKey = `${activity.kind}:${activity.label ?? ""}`;
    state.emittedAtMs = Date.now();
    this.activityState.set(id, state);
    const event: InvocationActivityEvent = {
      invocationId: id,
      kind: activity.kind,
      emittedAt: new Date(state.emittedAtMs).toISOString(),
      ...(activity.label ? { label: activity.label } : {}),
    };
    this.emit("activity", event);
  }

  private emitTerminalActivity(id: string, kind: "done" | "stopped" | "failed"): void {
    const observation = this.active.get(id);
    if (!observation || observation.terminalActivityEmitted) return;
    observation.terminalActivityEmitted = true;
    this.emitActivity(id, { kind }, true);
  }

  private clearActivity(id: string): void {
    const state = this.activityState.get(id);
    if (state?.timer) clearTimeout(state.timer);
    this.activityState.delete(id);
  }

  private resolveCommand(settings: WorkspaceSettings, handleInput: string): AgentCommand {
    const handle = normalizeAgentHandle(handleInput);
    const command = settings.agentCommands?.find((entry) => entry.handle === handle);
    if (!handle || !command) throw new InvocationRunnerError("not-found", `No AgentCommand is configured for @${handleInput.replace(/^@/, "")}.`);
    return command;
  }

  private async assertAuthorizationCurrent(prepared: PreparedInvocation, expectedFingerprint: string): Promise<AgentCommandLaunchFacts> {
    const preparedFingerprint = prepared.pending.command.executableFingerprint;
    if (expectedFingerprint !== preparedFingerprint) {
      throw new InvocationRunnerError(
        "fingerprint-drift",
        `Command @${prepared.command.handle} changed after confirmation. Review it and try again.`,
      );
    }
    const settings = this.options.getWorkspaceSettings();
    if (settings.workspaceRoot !== prepared.workspaceRoot) {
      throw new InvocationRunnerError(
        "fingerprint-drift",
        "The active Workspace changed after confirmation. Review the invocation and try again.",
      );
    }
    const current = this.resolveCommand(settings, prepared.command.handle);
    const facts = await inspectAgentCommandLaunchFacts(current, prepared.request.context === "note"
      ? { kind: "note", workspaceRoot: prepared.workspaceRoot, documentPath: prepared.request.documentPath! }
      : { kind: "cli", workspaceRoot: prepared.workspaceRoot });
    if (!facts.launchable || facts.fingerprint !== expectedFingerprint) {
      throw new InvocationRunnerError(
        "fingerprint-drift",
        `Command @${prepared.command.handle} changed after confirmation. Review it and try again.`,
      );
    }
    return facts;
  }
}

const INVOCATION_ACTIVITY_INTERVAL_MS = 200;

async function snapshotTextFile(filePath: string): Promise<FileSnapshot> {
  try {
    const info = await stat(filePath);
    const content = await readFile(filePath, "utf8");
    return {
      path: filePath,
      exists: true,
      content,
      sha256: createHash("sha256").update(content).digest("hex"),
      mode: info.mode & 0o777,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { path: filePath, exists: false, content: "", sha256: null, mode: null };
    }
    throw error;
  }
}

async function assertLaunchDocumentStillCurrent(
  prepared: PreparedInvocation,
  artifacts: InvocationLaunchArtifacts,
): Promise<void> {
  if (!prepared.before || prepared.cleanBaseContent === undefined) return;
  const taggedPath = artifacts.cleanBase.file.path;
  const launchState = artifacts.launchManifest.files[taggedPath];
  const cleanBaseSha256 = createHash("sha256").update(prepared.cleanBaseContent).digest("hex");
  const current = await snapshotTextFile(taggedPath);
  const matchesPrepared = launchState?.sha256 === prepared.before.sha256 &&
    launchState?.mode === prepared.before.mode;
  const matchesCleanBase = artifacts.cleanBase.file.sha256 === cleanBaseSha256 &&
    artifacts.cleanBase.file.mode === prepared.before.mode;
  const matchesCurrent = current.exists && current.sha256 === launchState?.sha256 &&
    current.mode === launchState?.mode;
  if (!matchesPrepared || !matchesCleanBase || !matchesCurrent) {
    throw new InvocationRunnerError(
      "document-drift",
      "The document changed while Exograph prepared the invocation. The Command was not run; your edit was preserved.",
    );
  }
}
async function requiredInvocation(store: InvocationStore, id: string): Promise<InvocationRecord> {
  const record = await store.readRecord(id);
  if (!record) throw new InvocationRunnerError("not-found", `Invocation ${id} was not found.`);
  return record;
}

async function hasDurableResponse(
  store: InvocationStore,
  invocationId: string,
  manifest: InvocationWorkspaceManifest,
  taggedDocumentPath: string | undefined,
  protocolInvocationId: string,
  handle: string,
): Promise<boolean> {
  if (!taggedDocumentPath) return false;
  // Invocation manifests use canonical file identities; the record retains
  // the user-facing path captured at compose time (which may traverse /var on
  // macOS). Resolve once, then inspect that one immutable document only.
  let canonicalDocumentPath: string;
  try {
    canonicalDocumentPath = await realpath(taggedDocumentPath);
  } catch {
    return false;
  }
  const state = manifest.files[canonicalDocumentPath];
  if (!state || state.mediaType !== "text") return false;
  const bytes = await store.readSnapshot(invocationId, state);
  if (!bytes) return false;

  const envelopes = findDocumentAgentEnvelopes(bytes.toString("utf8"));
  const invocation = envelopes.find((envelope) =>
    envelope.kind === "invocation" &&
    envelope.id === protocolInvocationId &&
    envelope.agent === handle,
  );
  if (!invocation) return false;
  return envelopes.some((envelope) =>
    envelope.kind === "response" &&
    envelope.invocationId === protocolInvocationId &&
    envelope.agent === handle &&
    // The response belongs to this exact request, not a similarly named
    // envelope elsewhere in the document or workspace.
    envelope.from === invocation.to + 1,
  );
}

function reviewListItem(record: InvocationRecord): InvocationReviewListItem {
  return {
    invocationId: record.id,
    createdAt: record.createdAt,
    ...(record.endedAt ? { endedAt: record.endedAt } : {}),
    command: { handle: record.command.handle, label: record.command.label, ...(record.command.appearance ? { appearance: record.command.appearance } : {}) },
    changedFileCount: record.changeset?.files.length ?? 0,
    pendingFileCount: record.changeset?.files.filter((change) => isUnresolvedReviewDecision(change.decision.status)).length ?? 0,
    pendingChangeIds: record.changeset?.files
      .filter((change) => isUnresolvedReviewDecision(change.decision.status))
      .map((change) => change.id) ?? [],
    status: record.status,
  };
}

function isUnresolvedReviewDecision(status: string): boolean {
  return status === "pending" || status === "conflict";
}

function newestRecordFirst(left: InvocationRecord, right: InvocationRecord): number {
  return right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id);
}

function invocationHistoryOutcome(record: InvocationRecord): InvocationHistoryItem["outcome"] {
  const changesetStatus = record.changeset?.status;
  if (changesetStatus === "pending-review" || changesetStatus === "partially-resolved" || changesetStatus === "conflict" ||
      record.status === "pending" || record.status === "running") return "pending";
  if (changesetStatus === "rejected") return "rejected";
  if (changesetStatus === "kept" || changesetStatus === "resolved") return "kept";
  if (record.status === "failed" || record.status === "orphaned") return "failed";
  return "kept";
}

function rootsOverlap(left: readonly string[], right: readonly string[]): boolean {
  return left.some((leftRoot) => right.some((rightRoot) =>
    isWithinPath(leftRoot, rightRoot) || isWithinPath(rightRoot, leftRoot)));
}

function isWithinPath(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function runtimeRootForWorkspace(workspaceRoot: string): string {
  return process.env.EXOGRAPH_RUNTIME_ROOT ?? path.join(workspaceRoot, WORKSPACE_RUNTIME_DIRECTORY);
}

async function canonicalPathOrResolved(filePath: string): Promise<string> {
  try {
    return await realpath(filePath);
  } catch {
    const resolved = path.resolve(filePath);
    try {
      return path.join(await realpath(path.dirname(resolved)), path.basename(resolved));
    } catch {
      return resolved;
    }
  }
}

/** Claude's documented print JSON exposes its real session_id. Generic Commands
 * retain their configured command and simply have no resumable provenance. */
export function commandForHeadlessInvocation(command: AgentCommand, head: InvocationConversationHead | null = null): string {
  return buildHeadlessInvocationCommand(command, head);
}

export function extractClaudeSessionId(stdout: string): string | null {
  return extractStructuredClaudeSessionId(stdout);
}

/** Reuse the configured Claude executable for the visible provider-native
 * handoff, removing only print-mode switches that conflict with --resume. */
export function commandForClaudeResume(command: AgentCommand, sessionId: string): string {
  return buildClaudeResumeCommand(command, sessionId);
}
