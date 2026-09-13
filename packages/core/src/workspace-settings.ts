import { createHash, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { chmod, mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { IndexMode, WorkspaceCanvasLayoutSettings, WorkspaceModel, WorkspacePaneContent, WorkspacePaneNode, WorkspaceSettings, WorkspaceSettingsRevision, WorkspaceShortcutBindings, WorkspaceShortcutId } from "./types";
import {
  agentCommandConfigurationError,
  normalizeAgentCommand,
  normalizeAgentCommands,
  normalizeDefaultAgentCommandId,
  normalizeAgentInvocationPrompt,
  isLegacyBuiltInCodexCommand,
} from "./agent-invocation";
import { isPathWithinRoot } from "./path-containment";
import { createIndexedRoot, DEFAULT_INDEXING } from "./workspace";
import { normalizeWorkspaceContentPolicy } from "./workspace-content-policy";

export const DEFAULT_APPEARANCE_MODE: WorkspaceSettings["appearanceMode"] = "system";
export const DEFAULT_COLOR_THEME_ID: WorkspaceSettings["colorThemeId"] = "exograph-neutral";
export const DEFAULT_EDITOR_FONT_SIZE = 15;
export const DEFAULT_TERMINAL_FONT_SIZE = 13;
export const DEFAULT_EXPLORER_SCALE = 1;
export const DEFAULT_GRAPH_INVERSE_NAVIGATION = true;
export const DEFAULT_GRAPH_SHOW_OVERFLOW_LABELS = true;
const UNSUPPORTED_WORKSPACE_SETTINGS_KEYS = [
  "migrationMetadata",
  "projectRoots",
  "terminalHistoryLines",
  "terminalTranscriptRetention",
  "terminalTranscriptRetentionDays",
  "terminalInputCoalesceMs",
  "terminalAgentStartupGraceMs",
  "terminalAgentSubmitDelayMs",
  "terminalInitialColumns",
  "terminalInitialRows",
  "terminalMinimumColumns",
  "terminalMinimumRows",
  "terminalReadTailChars",
  "terminalMaxReadTailChars",
  "terminalUnresponsiveThresholdMs",
  "terminalIdleThresholdMs",
] as const;
export interface WorkspaceRegistryEntry {
  id: string;
  label: string;
  notesFolder: string;
  settings: WorkspaceSettings;
  updatedAt: string;
}

export interface WorkspaceRegistry {
  activeWorkspaceId: string | null;
  workspaces: WorkspaceRegistryEntry[];
}

export function workspaceEnvOverrides(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(
      env.EXOGRAPH_WORKSPACE_ROOT ||
      env.EXOGRAPH_DEFAULT_TERMINAL_CWD ||
      env.EXOGRAPH_NOTE_ROOTS ||
      env.EXOGRAPH_INDEXED_ROOTS ||
      env.EXOGRAPH_INDEX_ENABLED ||
      env.EXOGRAPH_INDEX_MODE,
  );
}

export function resolveWorkspaceSettingsPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.EXOGRAPH_SETTINGS_PATH ?? path.join(resolveDesktopUserDataPath(env), "workspace-settings.json");
}

export function resolveWorkspaceRegistryPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(path.dirname(resolveWorkspaceSettingsPath(env)), "workspace-registry.json");
}

export function resolveWorkspaceSettingsTransactionPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(path.dirname(resolveWorkspaceSettingsPath(env)), "workspace-settings-transaction.json");
}

export async function loadWorkspaceSettings(env: NodeJS.ProcessEnv = process.env): Promise<WorkspaceSettings | null> {
  await recoverWorkspaceSettingsTransaction(env);
  const settings = await loadWorkspaceSettingsFile(env);
  const requiresIndexedRootMigration = await duplicateIndexedRootPathsInPersistence(env);
  const requiresCodexCommandMigration = await legacyCodexCommandInPersistence(env);
  if (settings) {
    // Validate every persisted registry entry against the same canonical
    // parser before Desktop can select or rewrite it.
    await loadWorkspaceRegistryFile(env, settings);
  }
  if (settings && (requiresIndexedRootMigration || requiresCodexCommandMigration)) {
    await saveWorkspaceSettings(settings, env);
  }
  return settings;
}

async function legacyCodexCommandInPersistence(env: NodeJS.ProcessEnv): Promise<boolean> {
  try {
    const parsed = JSON.parse(await readFile(resolveWorkspaceSettingsPath(env), "utf8")) as { agentCommands?: unknown };
    return Array.isArray(parsed.agentCommands) && parsed.agentCommands.some((entry) => {
      const command = normalizeAgentCommand(entry);
      return Boolean(command && isLegacyBuiltInCodexCommand({
        ...command,
        command: typeof (entry as { command?: unknown }).command === "string"
          ? (entry as { command: string }).command.trim()
          : command.command,
      }));
    });
  } catch {
    return false;
  }
}

async function loadWorkspaceSettingsFile(env: NodeJS.ProcessEnv): Promise<WorkspaceSettings | null> {
  let parsed: unknown;
  try {
    const raw = await readFile(resolveWorkspaceSettingsPath(env), "utf8");
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  assertSupportedWorkspaceSettings(parsed);
  return normalizeWorkspaceSettings(parsed as Partial<WorkspaceSettings>);
}

export function workspaceSettingsRevision(settings: WorkspaceSettings | null): WorkspaceSettingsRevision {
  if (!settings) {
    return null;
  }
  const normalized = normalizeWorkspaceSettings(settings);
  return normalized
    ? createHash("sha256").update(JSON.stringify(normalized)).digest("hex")
    : null;
}

export async function saveWorkspaceSettings(settings: WorkspaceSettings, env: NodeJS.ProcessEnv = process.env): Promise<WorkspaceSettings> {
  await recoverWorkspaceSettingsTransaction(env);
  assertSupportedWorkspaceSettings(settings, { strictAgentCommands: true });
  const normalized = normalizeWorkspaceSettings(settings);
  if (!normalized) {
    throw new Error("Workspace settings are incomplete.");
  }
  const registry = await loadWorkspaceRegistryFile(env, normalized);
  const transaction: WorkspaceSettingsTransaction = {
    version: 1,
    settings: normalized,
    registry: registryWithActiveWorkspace(registry, normalized),
  };
  await commitWorkspaceSettingsTransaction(transaction, env);
  return normalized;
}

async function commitWorkspaceSettingsTransaction(transaction: WorkspaceSettingsTransaction, env: NodeJS.ProcessEnv): Promise<void> {
  await writeJsonAtomically(resolveWorkspaceSettingsTransactionPath(env), transaction);
  try {
    await applyWorkspaceSettingsTransaction(transaction, env);
    await removeFileDurably(resolveWorkspaceSettingsTransactionPath(env));
  } catch (error) {
    try {
      await recoverWorkspaceSettingsTransaction(env);
    } catch (recoveryError) {
      throw new WorkspaceSettingsTransactionError(recoveryError, error);
    }
  }
}

export async function loadWorkspaceRegistry(env: NodeJS.ProcessEnv = process.env): Promise<WorkspaceRegistry> {
  await recoverWorkspaceSettingsTransaction(env);
  const settings = await loadWorkspaceSettingsFile(env);
  const registry = await loadWorkspaceRegistryFile(env, settings ?? undefined);
  if (await duplicateIndexedRootPathsInPersistence(env)) {
    const activeSettings = settings ?? registry.workspaces.find((entry) => entry.id === registry.activeWorkspaceId)?.settings;
    if (activeSettings) {
      await saveWorkspaceSettings(activeSettings, env);
      return loadWorkspaceRegistryFile(env, activeSettings);
    }
  }
  return registry;
}

async function loadWorkspaceRegistryFile(env: NodeJS.ProcessEnv, activeSettings?: WorkspaceSettings): Promise<WorkspaceRegistry> {
  let parsed: unknown;
  try {
    const raw = await readFile(resolveWorkspaceRegistryPath(env), "utf8");
    parsed = JSON.parse(raw);
  } catch {
    return { activeWorkspaceId: null, workspaces: [] };
  }
  return normalizeWorkspaceRegistry(parsed, activeSettings);
}

export async function listWorkspaceRegistryEntries(env: NodeJS.ProcessEnv = process.env, currentSettings?: WorkspaceSettings | null): Promise<WorkspaceRegistryEntry[]> {
  const registry = await loadWorkspaceRegistry(env);
  if (registry.workspaces.length > 0) {
    return registry.workspaces;
  }
  const normalized = normalizeWorkspaceSettings(currentSettings);
  return normalized ? [workspaceEntryFromSettings(normalized)] : [];
}

export async function getWorkspaceRegistryEntry(workspaceId: string, env: NodeJS.ProcessEnv = process.env): Promise<WorkspaceRegistryEntry | null> {
  const registry = await loadWorkspaceRegistry(env);
  return registry.workspaces.find((entry) => entry.id === workspaceId) ?? null;
}

export async function recoverWorkspaceSettingsTransaction(env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  const transactionPath = resolveWorkspaceSettingsTransactionPath(env);
  let raw: string;
  try {
    raw = await readFile(transactionPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
  const transaction = parseWorkspaceSettingsTransaction(raw);
  await applyWorkspaceSettingsTransaction(transaction, env);
  await removeFileDurably(transactionPath);
  return true;
}

function registryWithActiveWorkspace(registry: WorkspaceRegistry, settings: WorkspaceSettings): WorkspaceRegistry {
  const entry = workspaceEntryFromSettings(settings);
  const identityKey = workspaceIdentityFromSettings(settings);
  return {
    activeWorkspaceId: entry.id,
    workspaces: [entry, ...registry.workspaces.filter((workspace) => workspaceIdentityFromSettings(workspace.settings) !== identityKey)],
  };
}

interface NormalizedRegistryCandidate {
  entry: WorkspaceRegistryEntry;
  identityKey: string;
  persistedId: string | null;
}

function normalizeWorkspaceRegistry(value: unknown, activeSettings?: WorkspaceSettings): WorkspaceRegistry {
  const parsed = value && typeof value === "object" ? value as Partial<WorkspaceRegistry> : {};
  const candidates = Array.isArray(parsed.workspaces)
    ? parsed.workspaces.reduce<NormalizedRegistryCandidate[]>((entries, value) => {
        const entry = normalizeRegistryEntry(value);
        if (entry) {
          const persistedId = value && typeof value === "object" && typeof (value as Partial<WorkspaceRegistryEntry>).id === "string"
            ? (value as Partial<WorkspaceRegistryEntry>).id!.trim() || null
            : null;
          entries.push({ entry, identityKey: workspaceIdentityFromSettings(entry.settings), persistedId });
        }
        return entries;
      }, [])
    : [];
  const activeIdentityKey = activeSettings ? workspaceIdentityFromSettings(activeSettings) : null;
  const activeLexicalPath = activeSettings ? lexicalNotesFolder(notesFolderFromSettings(activeSettings)) : null;
  const persistedActiveId = typeof parsed.activeWorkspaceId === "string" ? parsed.activeWorkspaceId : null;
  const activeCandidate = activeIdentityKey
    ? candidates.find((candidate) => lexicalNotesFolder(notesFolderFromSettings(candidate.entry.settings)) === activeLexicalPath)
      ?? candidates.find((candidate) => candidate.identityKey === activeIdentityKey)
    : candidates.find((candidate) => candidate.persistedId === persistedActiveId)
      ?? candidates.find((candidate) => candidate.entry.id === persistedActiveId)
      ?? candidates[0];
  const retainedCandidates = candidates.reduce<NormalizedRegistryCandidate[]>((entries, candidate) => {
    const duplicateIndex = entries.findIndex((entry) => entry.identityKey === candidate.identityKey);
    if (duplicateIndex === -1) {
      entries.push(candidate);
    } else if (candidate === activeCandidate) {
      entries[duplicateIndex] = candidate;
    }
    return entries;
  }, []);
  const activeWorkspace = activeCandidate
    ? retainedCandidates.find((candidate) => candidate.identityKey === activeCandidate.identityKey)?.entry
    : retainedCandidates[0]?.entry;
  return {
    activeWorkspaceId: activeWorkspace?.id ?? null,
    workspaces: retainedCandidates.map((candidate) => candidate.entry),
  };
}

function parseWorkspaceSettingsTransaction(raw: string): WorkspaceSettingsTransaction {
  const parsed = JSON.parse(raw) as Partial<WorkspaceSettingsTransaction>;
  assertSupportedWorkspaceSettings(parsed.settings);
  const settings = normalizeWorkspaceSettings(parsed.settings);
  if (parsed.version !== 1 || !settings) {
    throw new Error("Workspace settings transaction is invalid.");
  }
  const registry = normalizeWorkspaceRegistry(parsed.registry, settings);
  if (registry.workspaces.length === 0) {
    throw new Error("Workspace settings transaction is invalid.");
  }
  return { version: 1, settings, registry };
}

async function applyWorkspaceSettingsTransaction(transaction: WorkspaceSettingsTransaction, env: NodeJS.ProcessEnv): Promise<void> {
  await writeJsonAtomically(resolveWorkspaceSettingsPath(env), transaction.settings);
  await writeJsonAtomically(resolveWorkspaceRegistryPath(env), transaction.registry);
}

interface WorkspaceSettingsTransaction {
  version: 1;
  settings: WorkspaceSettings;
  registry: WorkspaceRegistry;
}

export class WorkspaceSettingsTransactionError extends Error {
  readonly code = "workspace-settings-recovery-pending";

  constructor(readonly recoveryError: unknown, originalError: unknown) {
    super("Workspace settings were committed but could not be fully applied. Recovery will resume on the next settings read.", { cause: originalError });
    this.name = "WorkspaceSettingsTransactionError";
  }
}

async function writeJsonAtomically(targetPath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(targetPath), { recursive: true });
  const temporaryPath = path.join(
    path.dirname(targetPath),
    `.${path.basename(targetPath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    await writeFile(temporaryPath, JSON.stringify(value, null, 2), { mode: 0o600 });
    await chmod(temporaryPath, 0o600);
    const temporaryFile = await open(temporaryPath, "r");
    try {
      await temporaryFile.sync();
    } finally {
      await temporaryFile.close();
    }
    await rename(temporaryPath, targetPath);
    await syncDirectory(path.dirname(targetPath));
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function removeFileDurably(targetPath: string): Promise<void> {
  await rm(targetPath, { force: true });
  await syncDirectory(path.dirname(targetPath));
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

export async function loadActiveWorkspaceSettings(env: NodeJS.ProcessEnv = process.env): Promise<WorkspaceSettings | null> {
  const directSettings = await loadWorkspaceSettings(env);
  if (directSettings) {
    return directSettings;
  }
  const registry = await loadWorkspaceRegistry(env);
  const active = registry.workspaces.find((entry) => entry.id === registry.activeWorkspaceId) ?? registry.workspaces[0];
  return active?.settings ?? null;
}

/**
 * Converts persisted workspace choices into the filesystem model shared by
 * the desktop app and app-off operator commands. Settings remain user data;
 * this function only gives them stable root identities for one operation.
 */
export function workspaceModelFromSettings(settings: WorkspaceSettings): WorkspaceModel {
  return {
    workspaceRoot: settings.workspaceRoot,
    defaultTerminalCwd: settings.defaultTerminalCwd,
    noteRoots: settings.noteRoots.map((targetPath, index) => ({
      id: `note-root-${index + 1}`,
      label: path.basename(targetPath) || targetPath,
      path: targetPath,
      kind: "notes" as const,
    })),
    indexedRoots: settings.indexedRoots,
    indexing: settings.indexing,
    contentPolicy: normalizeWorkspaceContentPolicy(settings.contentPolicy),
    searchEngine: settings.searchEngine,
  };
}

/** Normalizes the canonical pre-launch Workspace settings shape. */
export function normalizeWorkspaceSettings(input: Partial<WorkspaceSettings> | null | undefined): WorkspaceSettings | null {
  if (!input || unsupportedWorkspaceSettingsReason(input)) {
    return null;
  }

  const workspaceRoot = typeof input.workspaceRoot === "string" ? input.workspaceRoot.trim() : "";
  const defaultTerminalCwd = typeof input.defaultTerminalCwd === "string" ? input.defaultTerminalCwd.trim() : "";
  const configuredNoteRoots = Array.isArray(input.noteRoots)
    ? input.noteRoots.map((entry) => (typeof entry === "string" && entry.trim() ? lexicalNotesFolder(entry) : "")).filter(Boolean)
    : [];
  const noteRoots = configuredNoteRoots;
  const configuredIndexedRoots = Array.isArray(input.indexedRoots)
    ? input.indexedRoots.reduce<WorkspaceSettings["indexedRoots"]>((roots, entry, index) => {
        if (!entry || typeof entry !== "object" || typeof entry.path !== "string" || !entry.path.trim()) {
          return roots;
        }
        const root: WorkspaceSettings["indexedRoots"][number] = {
          // Indexed Root settings are serialized user data. Preserve future
          // root-local fields while normalizing the fields this version owns.
          ...entry,
          ...createIndexedRoot(entry.path, {
            id: typeof entry.id === "string" ? entry.id : `index-root-${index + 1}`,
            label: typeof entry.label === "string" ? entry.label : undefined,
            kind: entry.kind === "notes" || entry.kind === "docs" || entry.kind === "code" || entry.kind === "mixed" ? entry.kind : "mixed",
            pattern: typeof entry.pattern === "string" ? entry.pattern : undefined,
            ignore: Array.isArray(entry.ignore) ? entry.ignore.filter((item): item is string => typeof item === "string") : [],
          }),
        };
        // Match IndexingService.addRoot: the later complete policy replaces an
        // exact resolved-path owner and moves to the end of survivor order.
        return [...roots.filter((candidate) => candidate.path !== root.path), root];
      }, [])
    : [];
  const indexedRoots = noteRoots.length === 1
    ? configuredIndexedRoots.filter((entry) => isPathWithinRoot(noteRoots[0], entry.path))
    : [];
  const mode: IndexMode = input.indexing?.mode === "lexical" || input.indexing?.mode === "semantic" || input.indexing?.mode === "hybrid" ? input.indexing.mode : input.indexing?.mode === "off" ? "off" : indexedRoots.length > 0 ? "lexical" : "off";
  const indexing = input.indexing && typeof input.indexing === "object"
    ? { enabled: Boolean(input.indexing.enabled) && mode !== "off", mode, backend: "qmd" as const }
    : indexedRoots.length > 0
      ? { enabled: true, mode: "lexical" as const, backend: "qmd" as const }
      : DEFAULT_INDEXING;
  const searchEngine = input.searchEngine === "qmd" || input.searchEngine === "filesystem"
    ? input.searchEngine
    : indexing.enabled && indexing.mode !== "off" && indexedRoots.length > 0
      ? "qmd"
      : "filesystem";

  if (!workspaceRoot || !defaultTerminalCwd || noteRoots.length === 0) {
    return null;
  }
  const agentCommands = normalizeAgentCommands(input.agentCommands);
  const defaultAgentCommandId = normalizeDefaultAgentCommandId(input.defaultAgentCommandId, agentCommands);
  const agentInvocationPrompt = normalizeAgentInvocationPrompt(input.agentInvocationPrompt);
  const ontologyDiscoveryPrompt = normalizeOptionalPrompt(input.ontologyDiscoveryPrompt);

  return {
    ...input,
    workspaceRoot,
    defaultTerminalCwd,
    noteRoots,
    agentCommands,
    ...(defaultAgentCommandId ? { defaultAgentCommandId } : {}),
    ...(agentInvocationPrompt ? { agentInvocationPrompt } : {}),
    ontologyDiscoveryPrompt,
    publishing: normalizePublishingSettings(input.publishing),
    indexedRoots,
    contentPolicy: normalizeWorkspaceContentPolicy(input.contentPolicy),
    indexing,
    searchEngine,
    appearanceMode: input.appearanceMode === "light" || input.appearanceMode === "dark" || input.appearanceMode === "system" ? input.appearanceMode : DEFAULT_APPEARANCE_MODE,
    colorThemeId: normalizeColorThemeId(input.colorThemeId),
    editorFontSize: clampSettingsNumber(input.editorFontSize, DEFAULT_EDITOR_FONT_SIZE, 11, 24),
    terminalFontSize: clampSettingsNumber(input.terminalFontSize, DEFAULT_TERMINAL_FONT_SIZE, 10, 22),
    explorerScale: clampSettingsNumber(input.explorerScale, DEFAULT_EXPLORER_SCALE, 0.82, 1.35),
    graphInverseNavigation: typeof input.graphInverseNavigation === "boolean"
      ? input.graphInverseNavigation
      : DEFAULT_GRAPH_INVERSE_NAVIGATION,
    graphShowOverflowLabels: typeof input.graphShowOverflowLabels === "boolean"
      ? input.graphShowOverflowLabels
      : DEFAULT_GRAPH_SHOW_OVERFLOW_LABELS,
    shortcutBindings: normalizeWorkspaceShortcutBindings(input.shortcutBindings),
    exploreIndexSearchOnEnter: typeof input.exploreIndexSearchOnEnter === "boolean" ? input.exploreIndexSearchOnEnter : indexing.enabled && indexing.mode !== "off" && indexedRoots.length > 0,
    indexUpdateStrategy: input.indexUpdateStrategy === "manual" ? "manual" : "on-save",
    layout: normalizeWorkspaceLayout(input.layout),
  };
}

function normalizePublishingSettings(value: unknown): WorkspaceSettings["publishing"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  return {
    publicationDirectory: typeof input.publicationDirectory === "string" ? input.publicationDirectory.trim() : "",
    engineDirectory: typeof input.engineDirectory === "string" ? input.engineDirectory.trim() : "",
    siteUrl: typeof input.siteUrl === "string" ? input.siteUrl.trim() : "",
    destinationRepository: typeof input.destinationRepository === "string" ? input.destinationRepository.trim() : "",
  };
}

function normalizeOptionalPrompt(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized && Buffer.byteLength(normalized, "utf8") <= 128 * 1024
    ? normalized
    : undefined;
}

const WORKSPACE_SHORTCUT_IDS: readonly WorkspaceShortcutId[] = ["explorer", "utility", "new-note", "daily-note", "terminal", "save"];

function normalizeWorkspaceShortcutBindings(value: unknown): WorkspaceShortcutBindings {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const bindings: WorkspaceShortcutBindings = {};
  for (const id of WORKSPACE_SHORTCUT_IDS) {
    const candidate = (value as Record<string, unknown>)[id];
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const code = (candidate as Record<string, unknown>).code;
    if (typeof code !== "string" || !/^(?:Key[A-Z]|Enter)$/.test(code)) continue;
    bindings[id] = {
      code,
      shift: (candidate as Record<string, unknown>).shift === true,
      alt: (candidate as Record<string, unknown>).alt === true,
    };
  }
  return bindings;
}

function assertSupportedWorkspaceSettings(
  input: unknown,
  options: { strictAgentCommands?: boolean } = {},
): void {
  const reason = unsupportedWorkspaceSettingsReason(input, options);
  if (reason) {
    throw new Error(`Workspace settings use an unsupported pre-launch format (${reason}).`);
  }
}

function unsupportedWorkspaceSettingsReason(
  input: unknown,
  options: { strictAgentCommands?: boolean } = {},
): string | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return null;
  }
  const candidate = input as Record<string, unknown>;
  const unsupportedKey = UNSUPPORTED_WORKSPACE_SETTINGS_KEYS.find((key) => Object.hasOwn(candidate, key));
  if (unsupportedKey) {
    return unsupportedKey;
  }
  if (Array.isArray(candidate.noteRoots) && candidate.noteRoots.length > 1) {
    return "multiple noteRoots";
  }
  if (Object.hasOwn(candidate, "agentCommands")) {
    if (options.strictAgentCommands) {
      const commandError = agentCommandConfigurationError(candidate.agentCommands);
      if (commandError) return `unsupported agentCommands: ${commandError}`;
    } else if (
      Array.isArray(candidate.agentCommands)
      && candidate.agentCommands.some((command, index) => !normalizeAgentCommand(command, `agent-command-${index + 1}`))
    ) {
      return "unsupported agentCommands";
    }
  }
  const layout = candidate.layout;
  if (layout && typeof layout === "object" && !Array.isArray(layout)) {
    const layoutCandidate = layout as Record<string, unknown>;
    if (
      layoutCandidate.version === 2
      || Object.hasOwn(layoutCandidate, "editorTree")
      || Object.hasOwn(layoutCandidate, "terminalTree")
    ) {
      return "pre-canvas layout";
    }
  }
  return null;
}

function hasDuplicateIndexedRootPaths(value: unknown): boolean {
  if (!value || typeof value !== "object") {
    return false;
  }
  const indexedRoots = (value as { indexedRoots?: unknown }).indexedRoots;
  if (!Array.isArray(indexedRoots)) {
    return false;
  }
  const seenPaths = new Set<string>();
  for (const entry of indexedRoots) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const targetPath = (entry as { path?: unknown }).path;
    if (typeof targetPath !== "string" || !targetPath.trim()) {
      continue;
    }
    const resolvedPath = path.resolve(targetPath);
    if (seenPaths.has(resolvedPath)) {
      return true;
    }
    seenPaths.add(resolvedPath);
  }
  return false;
}

async function duplicateIndexedRootPathsInPersistence(env: NodeJS.ProcessEnv): Promise<boolean> {
  try {
    if (hasDuplicateIndexedRootPaths(JSON.parse(await readFile(resolveWorkspaceSettingsPath(env), "utf8")))) {
      return true;
    }
  } catch {
    // Missing/corrupt settings already follow the normal load path.
  }
  try {
    const registry = JSON.parse(await readFile(resolveWorkspaceRegistryPath(env), "utf8")) as { workspaces?: unknown };
    if (Array.isArray(registry.workspaces)) {
      return registry.workspaces.some((workspace) => workspace && typeof workspace === "object"
        && hasDuplicateIndexedRootPaths((workspace as { settings?: unknown }).settings));
    }
  } catch {
    // Missing/corrupt registry already follows the normal load path.
  }
  return false;
}

function normalizeColorThemeId(value: unknown): WorkspaceSettings["colorThemeId"] {
  return value === "exograph-solar" || value === "exograph-neutral" ? value : DEFAULT_COLOR_THEME_ID;
}

export function workspaceEntryFromSettings(settings: WorkspaceSettings): WorkspaceRegistryEntry {
  const normalized = normalizeWorkspaceSettings(settings);
  if (!normalized) {
    throw new Error("Workspace settings are incomplete.");
  }
  const notesFolder = notesFolderFromSettings(normalized);
  return {
    id: workspaceIdForNotesFolder(notesFolder),
    label: path.basename(notesFolder) || notesFolder,
    notesFolder,
    settings: normalized,
    updatedAt: new Date().toISOString(),
  };
}

function normalizeRegistryEntry(value: unknown): WorkspaceRegistryEntry | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const candidate = value as Partial<WorkspaceRegistryEntry>;
  assertSupportedWorkspaceSettings(candidate.settings);
  const settings = normalizeWorkspaceSettings(candidate.settings);
  if (!settings) {
    return null;
  }
  const notesFolder = notesFolderFromSettings(settings);
  const id = workspaceIdForNotesFolder(notesFolder);
  if (candidate.id !== id || candidate.notesFolder !== notesFolder) {
    throw new Error("Workspace registry uses an unsupported pre-launch identity.");
  }
  return {
    ...candidate,
    id,
    label: typeof candidate.label === "string" && candidate.label.trim() ? candidate.label.trim() : path.basename(notesFolder) || notesFolder,
    notesFolder,
    settings,
    updatedAt: typeof candidate.updatedAt === "string" && candidate.updatedAt.trim() ? candidate.updatedAt : new Date().toISOString(),
  };
}

function resolveDesktopUserDataPath(env: NodeJS.ProcessEnv): string {
  if (env.EXOGRAPH_USER_DATA_PATH) {
    return env.EXOGRAPH_USER_DATA_PATH;
  }
  const home = os.homedir();
  if (process.platform === "darwin") {
    return path.join(home, "Library", "Application Support", "@exograph", "desktop");
  }
  if (process.platform === "win32") {
    return path.join(env.APPDATA ?? path.join(home, "AppData", "Roaming"), "@exograph", "desktop");
  }
  return path.join(env.XDG_CONFIG_HOME ?? path.join(home, ".config"), "@exograph", "desktop");
}

function workspaceIdForNotesFolder(notesFolder: string): string {
  return `workspace-v1-${createHash("sha256").update(workspaceIdentityKey(notesFolder)).digest("hex")}`;
}

function notesFolderFromSettings(settings: WorkspaceSettings): string {
  return lexicalNotesFolder(settings.noteRoots[0] || settings.workspaceRoot);
}

function workspaceIdentityFromSettings(settings: WorkspaceSettings): string {
  return workspaceIdentityKey(notesFolderFromSettings(settings));
}

function workspaceIdentityKey(notesFolder: string): string {
  const lexicalPath = lexicalNotesFolder(notesFolder);
  try {
    return realpathSync.native(lexicalPath);
  } catch (error) {
    if (!isMissingPathError(error)) {
      throw error;
    }
    return lexicalPath;
  }
}

function lexicalNotesFolder(notesFolder: string): string {
  return path.resolve(notesFolder.trim());
}

function isMissingPathError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR");
}

function clampSettingsNumber(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
}

const DEFAULT_SIDEBAR_WIDTH = 175;
const MIN_SIDEBAR_WIDTH = 140;
const MAX_SIDEBAR_WIDTH = 800;
const DEFAULT_UTILITY_WIDTH = 430;
const MIN_UTILITY_WIDTH = 320;
const MAX_UTILITY_WIDTH = 900;

function normalizeSidebarWidth(value: unknown): number {
  return clampSettingsNumber(value, DEFAULT_SIDEBAR_WIDTH, MIN_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH);
}

function normalizeWorkspaceLayout(input: unknown): WorkspaceCanvasLayoutSettings | undefined {
  if (!input || typeof input !== "object") {
    return undefined;
  }
  return normalizeWorkspaceCanvasLayout(input) ?? undefined;
}

function normalizeWorkspaceCanvasLayout(input: unknown): WorkspaceCanvasLayoutSettings | null {
  if (!input || typeof input !== "object") {
    return null;
  }
  const candidate = input as Omit<Partial<WorkspaceCanvasLayoutSettings>, "version"> & { version?: unknown };
  if (candidate.version !== 3) {
    return null;
  }
  const canvas = normalizePaneNode(candidate.canvas, 0);
  if (!canvas || !hasLeafKind(canvas, "editor")) {
    return null;
  }
  return {
    version: 3,
    canvas,
    sidebarCollapsed: Boolean(candidate.sidebarCollapsed),
    sidebarWidth: normalizeSidebarWidth(candidate.sidebarWidth),
    utilityWidth: clampSettingsNumber(candidate.utilityWidth, DEFAULT_UTILITY_WIDTH, MIN_UTILITY_WIDTH, MAX_UTILITY_WIDTH),
  };
}

function normalizePaneNode(input: unknown, depth: number): WorkspacePaneNode | null {
  if (!input || typeof input !== "object" || depth > 8) {
    return null;
  }
  const candidate = input as Partial<WorkspacePaneNode>;
  const id = typeof candidate.id === "string" && candidate.id.trim() ? candidate.id : `layout-pane-${depth}`;
  if (candidate.kind === "leaf") {
    const content = normalizePaneContent("content" in candidate ? candidate.content : null);
    return content ? { kind: "leaf", id, content } : null;
  }
  if (candidate.kind === "split") {
    const children = Array.isArray(candidate.children) ? candidate.children : [];
    if (children.length !== 2) {
      return null;
    }
    const left = normalizePaneNode(children[0], depth + 1);
    const right = normalizePaneNode(children[1], depth + 1);
    if (!left || !right) {
      return null;
    }
    return {
      kind: "split",
      id,
      direction: candidate.direction === "vertical" ? "vertical" : "horizontal",
      ratio: clampSettingsNumber(candidate.ratio, 0.5, 0.15, 0.85),
      children: [left, right],
    };
  }
  return null;
}

function normalizePaneContent(input: unknown): WorkspacePaneContent | null {
  const candidate = input && typeof input === "object"
    ? input as { kind?: unknown; openPaths?: unknown; activePath?: unknown; terminalIds?: unknown; activeTerminalId?: unknown; url?: unknown }
    : {};
  if (candidate.kind === "terminal") {
    const terminalIds = Array.isArray(candidate.terminalIds)
      ? candidate.terminalIds.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      : [];
    const activeTerminalId = typeof candidate.activeTerminalId === "string" && terminalIds.includes(candidate.activeTerminalId)
      ? candidate.activeTerminalId
      : terminalIds.at(-1) ?? null;
    return { kind: "terminal", terminalIds, activeTerminalId };
  }
  if (candidate.kind === "editor") {
    const openPaths = Array.isArray(candidate.openPaths)
      ? candidate.openPaths.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      : [];
    const activePath = typeof candidate.activePath === "string" && openPaths.includes(candidate.activePath)
      ? candidate.activePath
      : openPaths.at(-1) ?? null;
    return { kind: "editor", openPaths, activePath };
  }
  if (candidate.kind === "browser") {
    const url = typeof candidate.url === "string" && candidate.url.trim() ? candidate.url.trim() : "about:blank";
    return { kind: "browser", url };
  }
  if (candidate.kind === "graph") {
    return { kind: "graph" };
  }
  return null;
}

function hasLeafKind(node: WorkspacePaneNode, kind: WorkspacePaneContent["kind"]): boolean {
  if (node.kind === "leaf") {
    return node.content.kind === kind;
  }
  return hasLeafKind(node.children[0], kind) || hasLeafKind(node.children[1], kind);
}
