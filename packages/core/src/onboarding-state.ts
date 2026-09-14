import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  agentCommandConfigurationError,
  normalizeAgentCommands,
  normalizeDefaultAgentCommandId,
  normalizeAgentInvocationPrompt,
  type AgentCommand,
} from "./agent-invocation";
import type { IndexMode, IndexUpdateStrategy, SearchEngine } from "./types";
import { normalizeWorkspaceContentPolicy, type WorkspaceContentPolicy } from "./workspace-content-policy";

export const EXOGRAPH_ONBOARDING_STATE_FILE = "onboarding-state.json";

export type OnboardingProgressStep = "select" | "configure" | "scope" | "mcp" | "agents";
export type OnboardingMcpProvider = "claude" | "codex";

export interface OnboardingProgressDraft {
  version: 1;
  step: OnboardingProgressStep;
  selectedWorkspaceId: string | null;
  notesFolder: string;
  defaultTerminalCwd: string;
  contentPolicy: WorkspaceContentPolicy;
  /** Whether inspection still owns the recommendation or the user chose scope explicitly. */
  contentPolicyChoice: "recommended" | "explicit";
  search: {
    indexMode: IndexMode;
    searchEngine: SearchEngine;
    exploreIndexSearchOnEnter: boolean;
    indexUpdateStrategy: IndexUpdateStrategy;
  };
  agentCommands: AgentCommand[];
  defaultAgentCommandId: string | null;
  agentInvocationPrompt: string;
  selectedMcpProviders: OnboardingMcpProvider[];
}

export interface OnboardingStateStore {
  version: 1;
  status: "not-started" | "in-progress" | "complete";
  phase: "workspace" | "done";
  workspaceBasicsSaved: boolean;
  draft?: OnboardingProgressDraft;
  updatedAt?: string;
  completedAt?: string;
}

export type OnboardingStateReadResult =
  | { kind: "missing"; state: OnboardingStateStore }
  | { kind: "valid"; state: OnboardingStateStore }
  | { kind: "malformed"; state: OnboardingStateStore; errorMessage: string };

type OnboardingStateTimestamp = Date | string;

export function onboardingStatePath(userDataPath: string): string {
  return path.join(userDataPath, EXOGRAPH_ONBOARDING_STATE_FILE);
}

export function emptyOnboardingStateStore(): OnboardingStateStore {
  return {
    version: 1,
    status: "not-started",
    phase: "workspace",
    workspaceBasicsSaved: false,
  };
}

export async function readOnboardingStateStore(userDataPath: string): Promise<OnboardingStateReadResult> {
  try {
    const raw = await readFile(onboardingStatePath(userDataPath), "utf8");
    return {
      kind: "valid",
      state: validateOnboardingStateStore(JSON.parse(raw), { strictAgentCommands: false }),
    };
  } catch (error) {
    if (isMissingFileError(error)) {
      return { kind: "missing", state: emptyOnboardingStateStore() };
    }
    return {
      kind: "malformed",
      state: emptyOnboardingStateStore(),
      errorMessage: "Saved setup progress could not be read. Restart setup to replace it safely.",
    };
  }
}

export async function writeOnboardingStateStore(userDataPath: string, store: OnboardingStateStore): Promise<void> {
  const target = onboardingStatePath(userDataPath);
  await mkdir(userDataPath, { recursive: true });
  const temporaryPath = path.join(
    userDataPath,
    `.${path.basename(target)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    await writeFile(temporaryPath, `${JSON.stringify(validateOnboardingStateStore(store), null, 2)}\n`, { mode: 0o600 });
    await chmod(temporaryPath, 0o600);
    const temporaryFile = await open(temporaryPath, "r");
    try {
      await temporaryFile.sync();
    } finally {
      await temporaryFile.close();
    }
    await rename(temporaryPath, target);
    await syncDirectory(userDataPath);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export function beginOnboardingProgress(
  store: OnboardingStateStore,
  draft: OnboardingProgressDraft,
  now?: OnboardingStateTimestamp,
): OnboardingStateStore {
  return validateOnboardingStateStore({
    ...store,
    status: "in-progress",
    phase: "workspace",
    draft,
    completedAt: undefined,
    updatedAt: timestamp(now),
  });
}

export function markOnboardingWorkspaceBasicsSaved(store: OnboardingStateStore, now?: OnboardingStateTimestamp): OnboardingStateStore {
  if (!store.draft) {
    throw new Error("Onboarding workspace basics cannot be saved without a confirmed draft.");
  }
  return validateOnboardingStateStore({
    ...store,
    status: "in-progress",
    phase: "workspace",
    workspaceBasicsSaved: true,
    updatedAt: timestamp(now),
  });
}

export function markOnboardingComplete(store: OnboardingStateStore, now?: OnboardingStateTimestamp): OnboardingStateStore {
  const completedAt = timestamp(now);
  return validateOnboardingStateStore({
    ...store,
    status: "complete",
    phase: "done",
    workspaceBasicsSaved: true,
    updatedAt: completedAt,
    completedAt,
  });
}

export function validateOnboardingStateStore(
  input: unknown,
  options: { strictAgentCommands?: boolean } = {},
): OnboardingStateStore {
  if (!isRecord(input) || input.version !== 1) {
    throw new Error("Onboarding state store must be a version 1 object.");
  }
  const status = requiredUnion(input, "status", ["not-started", "in-progress", "complete"]);
  const phase = requiredUnion(input, "phase", ["workspace", "done"]);
  const workspaceBasicsSaved = input.workspaceBasicsSaved === undefined
    ? false
    : requiredBoolean(input, "workspaceBasicsSaved");

  if (status === "complete") {
    if (phase !== "done" || !workspaceBasicsSaved) {
      throw new Error("Complete onboarding state must be in the done phase with Workspace basics saved.");
    }
    return {
      version: 1,
      status,
      phase,
      workspaceBasicsSaved,
      updatedAt: optionalIsoString(input, "updatedAt"),
      completedAt: optionalIsoString(input, "completedAt"),
    };
  }

  if (phase !== "workspace") {
    throw new Error("Incomplete onboarding state must remain in the workspace phase.");
  }
  if (status === "not-started") {
    if (workspaceBasicsSaved) {
      throw new Error("Not-started onboarding cannot have Workspace basics saved.");
    }
    return {
      version: 1,
      status,
      phase,
      workspaceBasicsSaved,
      updatedAt: optionalIsoString(input, "updatedAt"),
    };
  }

  if (input.draft === undefined) {
    throw new Error("Explicit in-progress onboarding requires a valid draft.");
  }
  return {
    version: 1,
    status,
    phase,
    workspaceBasicsSaved,
    draft: validateOnboardingProgressDraft(input.draft, options),
    updatedAt: optionalIsoString(input, "updatedAt"),
  };
}

export function validateOnboardingProgressDraft(
  input: unknown,
  options: { strictAgentCommands?: boolean } = {},
): OnboardingProgressDraft {
  if (!isRecord(input) || input.version !== 1) {
    throw new Error("Onboarding progress draft must be a version 1 object.");
  }
  const notesFolder = requiredString(input, "notesFolder");
  const defaultTerminalCwd = requiredString(input, "defaultTerminalCwd");
  const selectedWorkspaceId = optionalNullableString(input, "selectedWorkspaceId");
  const contentPolicy = validateContentPolicy(input.contentPolicy);
  const contentPolicyChoice = requiredUnion(input, "contentPolicyChoice", ["recommended", "explicit"]);
  const search = validateSearchSettings(input.search);
  if (options.strictAgentCommands !== false) {
    const commandError = agentCommandConfigurationError(input.agentCommands);
    if (commandError) {
      throw new Error(`Onboarding progress field agentCommands is invalid: ${commandError}`);
    }
  }
  const agentCommands = normalizeAgentCommands(input.agentCommands);
  if (!Array.isArray(input.agentCommands) || agentCommands.length !== input.agentCommands.length) {
    throw new Error("Onboarding progress field agentCommands contains an invalid or duplicate Command.");
  }
  const agentInvocationPrompt = normalizeAgentInvocationPrompt(input.agentInvocationPrompt);
  if (!agentInvocationPrompt) {
    throw new Error("Onboarding progress field agentInvocationPrompt must be a non-empty prompt.");
  }
  const selectedMcpProviders = validateMcpProviders(input.selectedMcpProviders);
  const step = requiredUnion(input, "step", ["select", "configure", "scope", "mcp", "agents"]);
  if (["scope", "mcp", "agents"].includes(step) && notesFolder.trim().length === 0) {
    throw new Error(`Onboarding progress step ${step} requires a selected notes folder.`);
  }

  return {
    version: 1,
    step,
    selectedWorkspaceId,
    notesFolder,
    defaultTerminalCwd,
    contentPolicy,
    contentPolicyChoice,
    search,
    agentCommands,
    defaultAgentCommandId: normalizeDefaultAgentCommandId(input.defaultAgentCommandId, agentCommands) ?? null,
    agentInvocationPrompt,
    selectedMcpProviders,
  };
}

function validateContentPolicy(input: unknown): WorkspaceContentPolicy {
  if (
    !isRecord(input)
    || !Array.isArray(input.excludedPaths)
    || !input.excludedPaths.every((entry) => typeof entry === "string")
    || typeof input.sourceVisibility !== "boolean"
  ) {
    throw new Error("Onboarding progress field contentPolicy must be a complete Workspace Content Policy.");
  }
  return normalizeWorkspaceContentPolicy(input);
}

function validateSearchSettings(input: unknown): OnboardingProgressDraft["search"] {
  if (!isRecord(input)) {
    throw new Error("Onboarding progress field search must be a complete search settings object.");
  }
  return {
    indexMode: requiredUnion(input, "indexMode", ["off", "lexical", "semantic", "hybrid"]),
    searchEngine: requiredUnion(input, "searchEngine", ["qmd", "filesystem"]),
    exploreIndexSearchOnEnter: requiredBoolean(input, "exploreIndexSearchOnEnter"),
    indexUpdateStrategy: requiredUnion(input, "indexUpdateStrategy", ["manual", "on-save"]),
  };
}

function validateMcpProviders(input: unknown): OnboardingMcpProvider[] {
  if (!Array.isArray(input)) {
    throw new Error("Onboarding progress field selectedMcpProviders must be an array.");
  }
  const providers = [...new Set(input)];
  if (providers.length !== input.length || providers.some((provider) => provider !== "claude" && provider !== "codex")) {
    throw new Error("Onboarding progress field selectedMcpProviders contains an unsupported provider.");
  }
  return providers as OnboardingMcpProvider[];
}

function requiredUnion<T extends string>(record: Record<string, unknown>, key: string, values: readonly T[]): T {
  const value = record[key];
  if (typeof value !== "string" || !values.includes(value as T)) {
    throw new Error(`Onboarding state field ${key} contains unsupported value: ${String(value)}`);
  }
  return value as T;
}

function optionalIsoString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || value.trim().length === 0 || Number.isNaN(Date.parse(value))) {
    throw new Error(`Onboarding state field ${key} must be an ISO timestamp when provided.`);
  }
  return value;
}

function requiredBoolean(record: Record<string, unknown>, key: string): boolean {
  const value = record[key];
  if (typeof value !== "boolean") {
    throw new Error(`Onboarding state field ${key} must be a boolean.`);
  }
  return value;
}

function requiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string") {
    throw new Error(`Onboarding state field ${key} must be a string.`);
  }
  return value;
}

function optionalNullableString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  if (value === null) {
    return null;
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Onboarding state field ${key} must be a non-empty string or null.`);
  }
  return value;
}

function timestamp(now?: OnboardingStateTimestamp): string {
  if (now instanceof Date) {
    return now.toISOString();
  }
  if (typeof now === "string") {
    return now;
  }
  return new Date().toISOString();
}

function isMissingFileError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

async function syncDirectory(directoryPath: string): Promise<void> {
  if (process.platform === "win32") {
    return;
  }
  const directory = await open(directoryPath, "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
