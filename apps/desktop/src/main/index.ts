import { planWorkspaceSettingsApply } from "./runtime/workspace-settings-apply-plan";
import { app, nativeTheme, powerMonitor } from "electron";
import path from "node:path";
import { appendFile, mkdir, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import {
  exportPublication,
  verifyPublicationSnapshot,
  createFolderWithIndex,
  DEFAULT_APPEARANCE_MODE,
  beginOnboardingProgress,
  createWorkspaceFile,
  deleteWorkspacePath,
  listRootTree,
  emptyOnboardingStateStore,
  isWorkspaceOntologyPath,
  inspectWorkspaceContent,
  WORKSPACE_RUNTIME_DIRECTORY,
  markOnboardingComplete,
  readOnboardingStateStore,
  DocumentPersistence,
  renameWorkspacePath,
  resolveWorkspaceModel,
  workspaceModelFromSettings,
  writeOnboardingStateStore,
  type OnboardingStateStore,
  type OnboardingProgressDraft,
  type WorkspaceModel,
  type WorkspaceSettings,
  type WorkspaceSettingsSaveRequest,
} from "@exograph/core";

import type { DesktopEventChannel, DesktopEventPayloads } from "../shared/desktop-ipc";
import type { WorkspaceSettingsSaveOutcome } from "../shared/api";
import { ManagedSiteSetup } from "./publishing/managed-site-setup";
import { PublishingService } from "./publishing/publishing-service";
import { registerPublishingIpc } from "./publishing/publishing-ipc";
import { InvocationRunner } from "./invocation/invocation-runner";
import { awaitInvocationAwareQuit } from "./invocation/invocation-quit";
import { AppLifecycleController } from "./app-lifecycle";
import { CommandServer } from "./command/command-server";
import { CommandServerLifecycle } from "./command/command-server-lifecycle";
import { IndexingService } from "./indexing/indexing-service";
import { UtilityDerivedIndexClient } from "./indexing/derived-index-process";
import { WorkspaceConfigStore, workspaceSettingsFromModel } from "./workspace/workspace-config-store";
import { registerTerminalIpcHandlers } from "./terminal/terminal-ipc";
import { TerminalManager } from "./terminal/terminal-manager";
import { registerWorkspaceIpcHandlers } from "./workspace/workspace-ipc";
import { configureProviderMcp } from "./provider-mcp-setup";
import { findSourceProjectRoot, inspectCliInstallation, installPackagedCli } from "./cli-installation";
import { readPdfFile, resolvePreviewTarget } from "./preview-target";
import { WorkspaceNotesService } from "./workspace/workspace-notes-service";
import { WorkspaceWatcherService } from "./workspace/workspace-watchers";
import { WorkspaceRuntimeCoordinator } from "./runtime/workspace-runtime-coordinator";
import { hasOperatorWorkspaceSetup, workspaceSetupDecision, type WorkspaceSetupDecision } from "./workspace/workspace-setup-gate";
import { configureGpuStartup } from "./gpu-startup-policy";
import { runStandaloneGraphGpuProbe } from "./gpu-probe-runner";
import { isMarkdownFilePath, markdownFilePathsFromCommandLine } from "./markdown-file-open";
import {
  prepareOntologyMaintenanceMessage,
  resolveOntologyMaintenanceSkill,
} from "./workspace/ontology-maintenance-skill";
import {
  createOntologyDesignPrompt,
  OntologyDiscoveryCoordinator,
  runOntologyDiscovery,
  stopActiveOntologyDiscoveries,
} from "./workspace/ontology-discovery";

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const sourceProjectRoot = resolveSourceProjectRoot();
const gpuStartupPolicy = configureGpuStartup(app, process.env);
const BOOTSTRAP_WORKSPACE_GENERATION = 0;

if (process.env.EXOGRAPH_USER_DATA_PATH) {
  app.setPath("userData", process.env.EXOGRAPH_USER_DATA_PATH);
}

process.on("uncaughtException", (error) => {
  logMain("uncaught exception", serializeError(error));
});

process.on("unhandledRejection", (reason) => {
  logMain("unhandled rejection", serializeError(reason));
});

let appLifecycle: AppLifecycleController;
let commandServerLifecycle: CommandServerLifecycle;
let workspaceModel: WorkspaceModel;
let managedSiteSetup: ManagedSiteSetup | undefined;
let publishingService: PublishingService | undefined;
let workspaceSettings: WorkspaceSettings | null = null;
let workspaceSettingsRevision: string | null = null;
let workspaceConfig: WorkspaceConfigStore;
let workspaceSetupComplete = false;
let operatorWorkspaceSetupComplete = false;
let onboardingState: OnboardingStateStore = emptyOnboardingStateStore();
let onboardingRecovery: WorkspaceSetupDecision["onboardingRecovery"] = null;
let legacyOnboardingComplete = false;
let onboardingStateWrite: Promise<void> = Promise.resolve();
let onboardingRuntimeRoot: string | null = null;
let terminalManager: TerminalManager;
let workspaceWatcherService: WorkspaceWatcherService;
let indexingService: IndexingService;
let workspaceNotesService: WorkspaceNotesService;
let invocationRunner: InvocationRunner;
let workspaceRuntimeCoordinator: WorkspaceRuntimeCoordinator;
let quitFlushStarted = false;
let quitFlushComplete = false;
const pendingOsOpenFiles: string[] = [];
const pendingOsOpenFileSet = new Set<string>();
let flushingOsOpenFiles = false;

const ontologyDiscoveryCoordinator = new OntologyDiscoveryCoordinator({
  getCommands: () => currentSettings().agentCommands ?? [],
  getDefaultCommandId: () => currentSettings().defaultAgentCommandId,
  getWorkspace: () => ({
    workspaceRoot: workspaceModel.workspaceRoot,
    runtimeRoot: resolveRuntimeRoot(),
    noteRoots: workspaceModel.noteRoots.map((root) => root.path),
  }),
  getCommandLaunchFacts: (commandId) => invocationRunner.getCommandLaunchFacts(commandId),
  getCommandTrust: (handle) => invocationRunner.getCommandTrust(handle),
  getPrompt: () => createOntologyDesignPrompt(currentSettings().ontologyDiscoveryPrompt),
  invalidateDerivedState: () => workspaceNotesService.invalidateDerivedState(),
  previewOntology: (sourcePath) => workspaceNotesService.previewOntology(sourcePath),
  getGraphTopology: () => workspaceNotesService.getGraphTopology(),
  runDiscovery: runOntologyDiscovery,
  notifyCandidateChanged: () => sendToRenderer("workspace:ontology-candidate-changed", undefined),
});

const singleInstanceLock = app.requestSingleInstanceLock(resolveSingleInstanceData());

if (!singleInstanceLock) {
  console.error(
    "[exograph] another Exograph instance is already running; this dev process will exit after asking the running app to focus and refresh command-server discovery.",
  );
  app.quit();
}

function createCommandServer(runtimeRoot = resolveRuntimeRoot()) {
  return new CommandServer({
    runtimeRoot,
    onShowWindow: () => appLifecycle.showMainWindow(),
    onOpenFile: async (filePath: string) => {
      const authorizedPath = await workspaceNotesService.authorizeOpenFile(filePath);
      sendToRenderer("command:open-file", authorizedPath);
    },
    onIndexSearch: (query, options) => indexingService.search(query, options),
    onGraphTraverse: (request) => workspaceNotesService.traverseGraph(request),
    onIndexStatus: () => indexingService.getMeasuredStatus(),
    onIndexSync: () => indexingService.runSync("command"),
    onGetStatus: () => ({
      workspace: workspaceModel,
      terminals: terminalManager.list(),
    }),
    onListTerminals: () => terminalManager.list(),
    onCreateTerminal: () => terminalManager.create({ terminalKind: "shell" }),
    onWriteTerminal: async ({ id, data }) => {
      const terminal = terminalManager.getInfo(id);
      if (!terminal) return { terminal: null };
      const result = await terminalManager.write(id, data);
      return result.ok ? { terminal, writeId: result.writeId } : { terminal: null };
    },
    onReadTerminal: async ({ id, cursor }) => {
      const terminal = terminalManager.getInfo(id);
      const tail = terminalManager.readTailSince(id, cursor);
      return terminal && tail ? { terminal, ...tail } : null;
    },
    onStopTerminal: async (id) => {
      if (!terminalManager.getInfo(id)) return false;
      await terminalManager.kill(id);
      return true;
    },
    onSpawnAgentCommand: async (input) => {
      const prepared = await invocationRunner.prepare({
        context: "cli", handle: input.handle, task: input.task, message: input.task,
      });
      const result = await invocationRunner.authorizeAndStart(prepared, {
        decision: { kind: "trusted" },
        expectedFingerprint: prepared.pending.command.executableFingerprint,
      });
      if (!result.terminal) throw new Error("CLI command launches must create a visible terminal.");
      return result;
    },
  });
}

async function refreshCommandServerDiscovery(reason: string): Promise<void> {
  if (!commandServerLifecycle.status().listening) {
    console.warn(`[exograph] command server was not listening during ${reason}; restarting it.`);
    logMain("command server discovery refresh restarting server", { reason });
    await commandServerLifecycle.restart();
    return;
  }

  try {
    const info = await commandServerLifecycle.refreshDiscovery();
    console.info(`[exograph] command server discovery refreshed for ${reason}: ${info.path} (port ${info.port})`);
    logMain("command server discovery refreshed", { reason, path: info.path, port: info.port });
  } catch (error) {
    console.error(`[exograph] failed to refresh command server discovery for ${reason}:`, error);
    logMain("command server discovery refresh failed", { reason, error: serializeError(error) });
  }
}

function resolveSingleInstanceData(): Record<string, string | number> {
  return {
    pid: process.pid,
    runtimeRoot: resolveRuntimeRoot(),
    workspaceRoot: resolveWorkspaceModel().workspaceRoot,
  };
}

function queueOsOpenFile(filePath: string): void {
  if (!isMarkdownFilePath(filePath)) return;

  const normalizedPath = path.resolve(filePath);
  if (pendingOsOpenFileSet.has(normalizedPath)) return;
  pendingOsOpenFileSet.add(normalizedPath);
  pendingOsOpenFiles.push(normalizedPath);
  void flushOsOpenFiles();
}

async function flushOsOpenFiles(): Promise<void> {
  if (typeof appLifecycle === "undefined" || typeof workspaceNotesService === "undefined" || !appLifecycle.isRendererReady()) {
    return;
  }
  if (flushingOsOpenFiles) return;

  flushingOsOpenFiles = true;
  try {
    while (pendingOsOpenFiles.length > 0) {
      const filePath = pendingOsOpenFiles.shift();
      if (!filePath) continue;
      pendingOsOpenFileSet.delete(filePath);

      try {
        const authorizedPath = await workspaceNotesService.authorizeOpenFile(filePath);
        appLifecycle.showMainWindow();
        sendToRenderer("command:open-file", authorizedPath);
      } catch (error) {
        console.warn("[exograph] unable to open Markdown file from the operating system", { filePath, error });
        logMain("operating-system Markdown open rejected", { filePath, error: serializeError(error) });
      }
    }
  } finally {
    flushingOsOpenFiles = false;
    if (pendingOsOpenFiles.length > 0) void flushOsOpenFiles();
  }
}

app.on("open-file", (event, filePath) => {
  event.preventDefault();
  queueOsOpenFile(filePath);
});

function extractRuntimeRoot(value: unknown): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const runtimeRoot = (value as { runtimeRoot?: unknown }).runtimeRoot;
  return typeof runtimeRoot === "string" ? runtimeRoot : undefined;
}

function logWorkspaceStartup(model: WorkspaceModel) {
  if (process.env.NODE_ENV === "production") {
    return;
  }

  const details = {
    workspaceRoot: model.workspaceRoot,
    defaultTerminalCwd: model.defaultTerminalCwd,
    noteRoots: model.noteRoots.map((root) => root.path),
    userDataPath: app.getPath("userData"),
    settingsPath: path.join(app.getPath("userData"), "workspace-settings.json"),
    hardwareAcceleration: gpuStartupPolicy,
  };
  console.info("[exograph] workspace startup", details);
  logMain("workspace startup", details);
}

function createFirstRunWorkspaceModel(): WorkspaceModel {
  const userDataRoot = app.getPath("userData");
  const homeRoot = app.getPath("home");

  return {
    workspaceRoot: userDataRoot,
    defaultTerminalCwd: homeRoot,
    noteRoots: [],
    indexedRoots: [],
    indexing: {
      enabled: false,
      mode: "off",
      backend: "qmd",
    },
    searchEngine: "filesystem",
  };
}

function broadcastTerminalData() {
  terminalManager.on("created", (session) => {
    sendToRenderer("terminal:created", session);
  });
  terminalManager.on("data", (event) => {
    sendToRenderer("terminal:data", event);
  });
  terminalManager.on("exit", (event) => {
    sendToRenderer("terminal:exit", event);
  });
}

function sendToRenderer<C extends DesktopEventChannel>(channel: C, payload: DesktopEventPayloads[C]) {
  // Recovery can publish invocation updates before the window lifecycle is
  // constructed. Those records are durable and the renderer hydrates them on
  // startup, so there is intentionally nothing to send in this phase.
  if (typeof appLifecycle === "undefined") return;
  const mainWindow = appLifecycle.getMainWindow();
  if (!appLifecycle.isRendererReady() || !mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) {
    return;
  }

  try {
    mainWindow.webContents.send(channel, payload);
  } catch (err) {
    console.warn(`[main] failed to send ${channel}:`, err);
  }
}

function logMain(message: string, details?: unknown) {
  const line = `${new Date().toISOString()} ${message}${details === undefined ? "" : ` ${JSON.stringify(details)}`}\n`;
  const logPath = path.join(app.getPath("userData"), "exograph-main.log");
  appendFile(logPath, line, "utf8").catch(() => {});
}

function serializeError(error: unknown): unknown {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }

  return error;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isForcedTheme(value: string | undefined): value is WorkspaceSettings["appearanceMode"] {
  return value === "light" || value === "dark" || value === "system";
}

function isPathWithin(rootPath: string, candidatePath: string): boolean {
  const relativePath = path.relative(path.resolve(rootPath), path.resolve(candidatePath));
  return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

function registerIpcHandlers() {
  publishingService = new PublishingService({
    context: () => ({ ...currentSnapshot(), model: workspaceModel }),
    stagingParent: path.join(app.getPath("userData"), "publishing"),
    capture: async (model, publicationDirectory, stagingParent, generatedRoutes, assertCurrent) => {
      await appLifecycle.withDocumentsFlushed(async () => {});
      assertCurrent();
      return exportPublication({ model, publicationDirectory, stagingParent, generatedRoutes });
    },
    verify: verifyPublicationSnapshot,
    publishStatus: (status) => sendToRenderer("publishing:status", status),
  });
  managedSiteSetup = new ManagedSiteSetup({
    context: () => ({ ...currentSnapshot(), model: workspaceModel }),
    sitesParent: path.join(app.getPath("userData"), "publishing-sites"),
    capture: async (model, publicationDirectory, stagingParent, generatedRoutes, assertCurrent) => {
      await appLifecycle.withDocumentsFlushed(async () => {});
      assertCurrent();
      return exportPublication({ model, publicationDirectory, stagingParent, generatedRoutes });
    },
    verify: verifyPublicationSnapshot,
  });
  registerPublishingIpc(publishingService, managedSiteSetup);
  registerWorkspaceIpcHandlers({
    activateWorkspace: async (input) => {
      return switchWorkspace(input.workspaceId, input.expectedRevision);
    },
    createFolder: createFolderWithIndex,
    createFile: createWorkspaceFile,
    deletePath: deleteWorkspacePath,
    embedIndex: () => indexingService.embed("settings"),
    ensureTarget: (sourceFilePath, target) => workspaceNotesService.ensureTarget(sourceFilePath, target),
    getIndexStatus: () => indexingService.getMeasuredStatus(),
    previewOntology: (sourcePath) => workspaceNotesService.previewOntology(sourcePath),
    keepOntology: (guard) => workspaceNotesService.keepOntology(guard),
    rejectOntology: (guard) => workspaceNotesService.rejectOntology(guard),
    getFolderOverview: (directoryPath) => workspaceNotesService.getFolderOverview(directoryPath),
    ensureFolderIndex: (directoryPath) => workspaceNotesService.ensureFolderIndex(directoryPath),
    launchAgentInvocation: async (input) => {
      const prepared = await invocationRunner.prepare({
        context: "note", handle: input.handle, documentPath: input.documentPath,
        mentionText: input.mentionText, message: input.message,
        protocolInvocationId: input.protocolInvocationId,
        documentFrontmatter: input.documentFrontmatter, documentBody: input.documentBody,
        skill: input.skill,
      });
      return invocationRunner.authorizeAndStart(prepared, {
        decision: input.authorization,
        expectedFingerprint: input.expectedFingerprint,
      });
    },
    getAgentInvocationAuthorization: (input) => invocationRunner.getInvocationAuthorization(input.handle, input.documentPath),
    prepareGraphMaintenanceSkill: async ({ documentPath, commandId }) => {
      const noteRoot = workspaceModel.noteRoots
        .filter((root) => isPathWithin(root.path, documentPath))
        .sort((left, right) => right.path.length - left.path.length)[0];
      if (!noteRoot) throw new Error("The selected note is outside the active Note Root.");
      const command = currentSettings().agentCommands?.find((candidate) =>
        candidate.enabled && candidate.id === commandId,
      );
      if (!command) throw new Error("The selected agent command is no longer enabled.");
      const resolvedSkill = await resolveOntologyMaintenanceSkill({
        adapter: command.adapter,
        homeDir: app.getPath("home"),
        codexHome: process.env.CODEX_HOME,
        bundledSkillPath: ontologyMaintenanceSkillPath(),
      });
      const [ontologyReview, graphContext, topology] = await Promise.all([
        workspaceNotesService.previewOntology(),
        workspaceNotesService.getGraphContext(documentPath),
        workspaceNotesService.getGraphTopology(),
      ]);
      const prepared = prepareOntologyMaintenanceMessage({
        documentPath,
        skill: resolvedSkill.skill,
        delivery: resolvedSkill.delivery,
        ontologyReview,
        graphContext,
        graphSnapshotId: topology.sourceSnapshotId,
      });
      return {
        message: prepared.message,
        skill: {
          ...prepared.skill,
          graphSnapshotId: prepared.graphSnapshotId,
          ontology: prepared.ontology,
        },
      };
    },
    discoverOntology: () => ontologyDiscoveryCoordinator.discover(),
    getAgentCommandContinuity: (commandId) => invocationRunner.getCommandContinuityStatus(commandId),
    resetAgentCommandContinuity: (commandId) => invocationRunner.resetCommandContinuity(commandId),
    configureProviderMcp,
    getCliInstallationStatus: () => inspectCliInstallation({ sourceProjectRoot, packagedCli: packagedCliPaths() }),
    installCli: () => installPackagedCli(packagedCliPaths()),
    recordRendererDiagnostic: async (diagnostic) => {
      logMain("renderer editor diagnostic", diagnostic);
    },
    endAgentInvocation: (invocationId) => invocationRunner.endObservation(invocationId),
    listPendingInvocationReviews: () => invocationRunner.listPendingReviews(),
    listInvocationHistory: (notePath) => invocationRunner.listHistoryForNote(notePath),
    getInvocationFileReview: (input) => invocationRunner.getInvocationFileReview(input.invocationId, input.changeId),
    reviewInvocationFile: (input) => invocationRunner.reviewInvocationFile(input.invocationId, input.changeId, input.action),
    reviewInvocationAll: (input) => invocationRunner.reviewInvocationAll(input.invocationId, input.action),
    resumeInvocationInTerminal: (invocationId) => invocationRunner.resumeInTerminal(invocationId),
    getGraphContext: (filePath) => workspaceNotesService.getGraphContext(filePath),
    getGraphTopology: () => workspaceNotesService.getGraphTopology(),
    getGraphConceptSummaries: (indexes, sourceSnapshotId) => workspaceNotesService.getGraphConceptSummaries(indexes, sourceSnapshotId),
    graphConceptLookup: (reference, sourceSnapshotId) => workspaceNotesService.graphConceptLookup(reference, sourceSnapshotId),
    getGraphConceptDetailByIndex: (index, sourceSnapshotId) => workspaceNotesService.getGraphConceptDetailByIndex(index, sourceSnapshotId),
    getMainWindow: () => appLifecycle.getMainWindow(),
    getModel: () => workspaceModel,
    getSettings: async () => currentSnapshot(),
    getSetupState: async () => ({
      complete: rendererWorkspaceSetupComplete(),
      onboardingComplete: onboardingComplete(),
      onboarding: onboardingState,
      onboardingRecovery,
      settingsPath: path.join(app.getPath("userData"), "workspace-settings.json"),
    }),
    inspectContentScope: (rootPath) => inspectWorkspaceContent(rootPath),
    saveOnboardingProgress: (draft) => saveWorkspaceOnboardingProgress(draft),
    resetOnboardingProgress: () => resetWorkspaceOnboardingProgress(),
    markOnboardingComplete: () => completeWorkspaceOnboarding(),
    listTree: listRootTree,
    listWorkspaces: () => workspaceConfig.listWorkspaces(),
    readNote: (filePath) => documentPersistence.read(filePath),
    renamePath: renameWorkspacePath,
    resolvePreviewTarget: async (target) => {
      const result = await resolvePreviewTarget(target, currentSettings());
      return result;
    },
    readPdfFile: (filePath) => readPdfFile(filePath, currentSettings()),
    resolveTarget: (sourceFilePath, target) => workspaceNotesService.resolveTarget(sourceFilePath, target),
    resolveMarkdownImage: (sourceFilePath, target, lookupByFilename) => workspaceNotesService.resolveMarkdownImage(sourceFilePath, target, lookupByFilename),
    saveNote: async (filePath, frontmatter, body, expectedRevision) => {
      const result = await documentPersistence.save(filePath, frontmatter, body, expectedRevision);
      if (result.status === "saved") indexingService.scheduleForFile(filePath, "note-save");
      return result;
    },
    saveNoteCopy: async (filePath, frontmatter, body) => {
      const document = await documentPersistence.saveCopy(filePath, frontmatter, body);
      indexingService.scheduleForFile(filePath, "note-save");
      return document;
    },
    saveSettings,
    searchIndex: (query, options) => indexingService.search(query, options),
    searchTag: (tag) => workspaceNotesService.searchTag(tag),
    searchWorkspace: (query) => workspaceNotesService.searchFilenames(query),
    statNote: async (filePath) => {
      try {
        const info = await stat(filePath);
        return { size: info.size, mtimeMs: info.mtimeMs };
      } catch {
        return null;
      }
    },
    suggestTargets: (sourceFilePath, query) => workspaceNotesService.suggestTargets(sourceFilePath, query),
    syncIndex: () => indexingService.runSync("settings"),
    updateIndex: () => indexingService.update("settings"),
  });
  registerTerminalIpcHandlers(terminalManager);
}

function onboardingComplete(): boolean {
  return onboardingState.status === "complete" || operatorWorkspaceSetupComplete || legacyOnboardingComplete;
}

function rendererWorkspaceSetupComplete(): boolean {
  if (operatorWorkspaceSetupComplete) return true;
  if (onboardingRecovery || onboardingState.status === "in-progress" || onboardingState.status === "not-started") {
    return legacyOnboardingComplete && workspaceSettings !== null;
  }
  return workspaceSettings !== null;
}

async function writeWorkspaceOnboardingState(nextState: OnboardingStateStore): Promise<OnboardingStateStore> {
  const operation = onboardingStateWrite.then(async () => {
    await writeOnboardingStateStore(app.getPath("userData"), nextState);
    onboardingState = nextState;
  });
  onboardingStateWrite = operation.catch(() => undefined);
  await operation;
  return nextState;
}

async function saveWorkspaceOnboardingProgress(draft: OnboardingProgressDraft): Promise<OnboardingStateStore> {
  if (onboardingRecovery) {
    throw new Error("Restart setup before saving new progress.");
  }
  const saved = await writeWorkspaceOnboardingState(beginOnboardingProgress(onboardingState, draft));
  legacyOnboardingComplete = false;
  return saved;
}

async function resetWorkspaceOnboardingProgress(): Promise<OnboardingStateStore> {
  const reset = emptyOnboardingStateStore();
  await writeWorkspaceOnboardingState(reset);
  onboardingRecovery = null;
  legacyOnboardingComplete = false;
  return reset;
}

async function completeWorkspaceOnboarding(): Promise<OnboardingStateStore> {
  if (onboardingRecovery) {
    throw new Error("Restart setup before completing onboarding.");
  }
  if (!workspaceSettings) {
    throw new Error("Workspace settings must be saved before onboarding can complete.");
  }
  const completed = await writeWorkspaceOnboardingState(markOnboardingComplete(onboardingState));
  legacyOnboardingComplete = false;
  return completed;
}

function resolveSourceProjectRoot(): string | undefined {
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  return findSourceProjectRoot([
    process.cwd(),
    ...(resourcesPath ? [resourcesPath] : []),
    path.resolve(currentDirectory, "../../.."),
    path.resolve(currentDirectory, "../../../.."),
  ]);
}

function packagedCliPaths() {
  return {
    appExecutablePath: process.execPath,
    scriptPath: path.join(currentDirectory, "cli.js"),
  };
}

function ontologyMaintenanceSkillPath(): string {
  if (!app.isPackaged && sourceProjectRoot) {
    return path.join(sourceProjectRoot, "skills", "find-and-connect-relevant-context", "SKILL.md");
  }
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  return path.join(
    resourcesPath ?? path.resolve(currentDirectory, "../../.."),
    "skills",
    "find-and-connect-relevant-context",
    "SKILL.md",
  );
}

function applyWorkspaceSettings(settings: WorkspaceSettings | null) {
  if (!isForcedTheme(process.env.EXOGRAPH_FORCE_THEME)) {
    nativeTheme.themeSource = settings?.appearanceMode ?? DEFAULT_APPEARANCE_MODE;
  }
}

function currentSettings(): WorkspaceSettings {
  return workspaceSettings ?? workspaceSettingsFromModel(workspaceModel);
}

function currentSnapshot() {
  return { settings: currentSettings(), revision: workspaceSettingsRevision };
}

const documentPersistence = new DocumentPersistence();

async function saveSettings(request: WorkspaceSettingsSaveRequest): Promise<WorkspaceSettingsSaveOutcome> {
  const previous = currentSettings();
  const apply = () => commitSettings(request);
  return planWorkspaceSettingsApply(previous, { ...previous, ...request.settings }).reactivateWorkspace
    ? appLifecycle.withDocumentsFlushed(apply)
    : apply();
}

async function commitSettings(request: WorkspaceSettingsSaveRequest): Promise<WorkspaceSettingsSaveOutcome> {
  const previous = currentSettings();
  const saved = await workspaceConfig.patch(request.expectedRevision, { ...previous, ...request.settings });
  if (workspaceRuntimeCoordinator.applySettings({
    previousSettings: previous,
    settings: saved.settings,
    revision: saved.revision,
  })) {
    return { ...saved, runtimeApply: { status: "applied" } };
  }
  const activation = await workspaceRuntimeCoordinator.activate({
    previousSettings: previous,
    settings: saved.settings,
    revision: saved.revision,
    reason: "settings-apply",
  });
  if (activation.status === "applied" || activation.status === "committed-degraded") {
    if (activation.status === "committed-degraded") {
      logMain("workspace activation committed degraded", activation);
      return { ...saved, runtimeApply: { status: "degraded", errorMessage: activation.errorMessage } };
    }
    return { ...saved, runtimeApply: { status: "applied" } };
  }
  return {
    ...saved,
    runtimeApply: {
      status: "failed",
      errorMessage: activation.status === "failed"
        ? activation.errorMessage
        : "A newer Workspace request superseded this activation.",
    },
  };
}

async function switchWorkspace(workspaceId: string, expectedRevision: string | null): Promise<WorkspaceSettingsSaveOutcome> {
  return appLifecycle.withDocumentsFlushed(() => commitWorkspaceSwitch(workspaceId, expectedRevision));
}

async function commitWorkspaceSwitch(workspaceId: string, expectedRevision: string | null): Promise<WorkspaceSettingsSaveOutcome> {
  const saved = await workspaceConfig.switchWorkspace(workspaceId, expectedRevision);
  const activation = await workspaceRuntimeCoordinator.activate({
    previousSettings: currentSettings(),
    settings: saved.settings,
    revision: saved.revision,
    reason: "workspace-switch",
  });
  if (activation.status === "applied" || activation.status === "committed-degraded") {
    if (activation.status === "committed-degraded") {
      logMain("workspace switch committed degraded", activation);
      return { ...saved, runtimeApply: { status: "degraded", errorMessage: activation.errorMessage } };
    }
    return { ...saved, runtimeApply: { status: "applied" } };
  }
  return {
    ...saved,
    runtimeApply: {
      status: "failed",
      errorMessage: activation.status === "failed"
        ? activation.errorMessage
        : "A newer Workspace request superseded this activation.",
    },
  };
}

function applyOnboardingRuntimeEnv() {
  if (process.env.EXOGRAPH_RUNTIME_ROOT) {
    return;
  }
  onboardingRuntimeRoot = path.join(app.getPath("userData"), "onboarding-runtime");
}

app.whenReady().then(async () => {
  for (const filePath of markdownFilePathsFromCommandLine(process.argv)) {
    queueOsOpenFile(filePath);
  }

  if (process.env.EXOGRAPH_GPU_PROBE_OUTPUT) {
    await runStandaloneGraphGpuProbe({
      app,
      currentDirectory,
      outputPath: process.env.EXOGRAPH_GPU_PROBE_OUTPUT,
      gpuStartupPolicy,
    });
    return;
  }

  workspaceConfig = new WorkspaceConfigStore({ userDataPath: app.getPath("userData") });
  workspaceWatcherService = new WorkspaceWatcherService((event) => {
    if (event.filePath && isWorkspaceOntologyPath(workspaceModel.workspaceRoot, event.filePath)) {
      // Candidate Ontology changes are passive review input. They must not
      // invalidate Note caches, refresh Explorer trees, or publish graph state.
      sendToRenderer("workspace:ontology-candidate-changed", undefined);
      return;
    }
    // Queue graph refresh before notifying the renderer so a following context
    // request observes that refresh. Graph owns a separate utility process, so
    // this ordering never delays foreground Search or QMD maintenance.
    const refresh = Promise.resolve(workspaceNotesService?.handleWorkspaceChange(event));
    sendToRenderer("workspace:changed", event);
    void refresh.catch((error) => {
      console.warn("[exograph] incremental workspace refresh failed", error);
    });
  }, {
    onRuntimeError: ({ generation, rootPath, errorMessage }) => {
      const recorded = workspaceRuntimeCoordinator?.reportLateRuntimeFailure(
        generation,
        "watcher",
        `Watcher failed for ${rootPath}: ${errorMessage}`,
      );
      if (recorded) {
        logMain("active workspace watcher failed", { generation, rootPath, errorMessage });
      }
    },
  });

  const forcedTheme = process.env.EXOGRAPH_FORCE_THEME;
  if (isForcedTheme(forcedTheme)) {
    nativeTheme.themeSource = forcedTheme;
  }

  operatorWorkspaceSetupComplete = hasOperatorWorkspaceSetup();
  const loadedWorkspaceSettings = await workspaceConfig.load();
  workspaceSettings = loadedWorkspaceSettings?.settings ?? null;
  workspaceSettingsRevision = loadedWorkspaceSettings?.revision ?? null;
  const onboardingRead = await readOnboardingStateStore(app.getPath("userData"));
  onboardingState = onboardingRead.state;
  const setupDecision = workspaceSetupDecision({
    hasWorkspaceSettings: workspaceSettings !== null,
    onboarding: onboardingRead,
    operatorSetupComplete: operatorWorkspaceSetupComplete,
  });
  onboardingRecovery = setupDecision.onboardingRecovery;
  legacyOnboardingComplete = onboardingRead.kind === "missing" && workspaceSettings !== null;
  workspaceSetupComplete = setupDecision.complete;
  workspaceModel = workspaceSettings ? workspaceModelFromSettings(workspaceSettings) : workspaceSetupComplete ? resolveWorkspaceModel() : createFirstRunWorkspaceModel();
  if (workspaceSetupComplete) {
    applyWorkspaceSettings(workspaceSettings ?? workspaceSettingsFromModel(workspaceModel));
  } else {
    applyOnboardingRuntimeEnv();
    applyWorkspaceSettings(null);
  }
  if (workspaceSetupComplete) {
    const savedWorkspaceSettings = await workspaceConfig.patch(loadedWorkspaceSettings?.revision ?? null, workspaceSettings ?? workspaceSettingsFromModel(workspaceModel));
    workspaceSettings = savedWorkspaceSettings.settings;
    workspaceSettingsRevision = savedWorkspaceSettings.revision;
  }
  logWorkspaceStartup(workspaceModel);
  terminalManager = new TerminalManager(
    workspaceModel.defaultTerminalCwd,
  );
  indexingService = new IndexingService({
    getWorkspaceModel: () => workspaceModel,
    getCurrentSettings: () => currentSettings(),
    getRuntimeRoot: () => resolveRuntimeRoot(),
    saveWorkspaceSettings: async (settings) => {
      const saved = await saveSettings({
        settings,
        expectedRevision: (await currentSnapshot()).revision,
      });
      if (saved.runtimeApply.status === "failed") {
        throw new Error(saved.runtimeApply.errorMessage);
      }
      return saved.settings;
    },
    sendState: (event) => sendToRenderer("workspace:index-sync-state", event),
    errorMessage,
    foregroundDerivedIndexFactory: () => new UtilityDerivedIndexClient(),
    maintenanceDerivedIndexFactory: () => new UtilityDerivedIndexClient(),
    getSystemIdleTimeMs: () => powerMonitor.getSystemIdleTime() * 1_000,
  });
  invocationRunner = new InvocationRunner({
    trustStateRoot: app.getPath("userData"),
    workspaceWatcherService,
    terminalManager,
    getWorkspaceSettings: () => currentSettings(),
  });
  invocationRunner.on("updated", (record) => {
    if (invocationRunner.workspaceRootForInvocation(record.id) !== workspaceModel.workspaceRoot) return;
    sendToRenderer("workspace:invocation-updated", record);
  });
  invocationRunner.on("activity", (event) => {
    if (invocationRunner.workspaceRootForInvocation(event.invocationId) !== workspaceModel.workspaceRoot) return;
    sendToRenderer("workspace:invocation-activity", event);
  });
  invocationRunner.on("settlement-error", (event: { invocationId: string; error: unknown }) => {
    logMain("invocation settlement failed", { invocationId: event.invocationId, error: serializeError(event.error) });
  });
  invocationRunner.on("artifact-compaction-error", (event: { invocationId: string; error: unknown }) => {
    logMain("invocation artifact compaction retained stale snapshots", {
      invocationId: event.invocationId,
      error: serializeError(event.error),
    });
  });
  workspaceNotesService = new WorkspaceNotesService({
    getWorkspaceModel: () => workspaceModel,
    getRuntimeRoot: () => resolveRuntimeRoot(),
    derivedIndexFactory: () => new UtilityDerivedIndexClient(),
    onGraphChanged: () => sendToRenderer("workspace:graph-changed", { source: "ontology" }),
  });
  commandServerLifecycle = new CommandServerLifecycle({
    runtimeRoot: resolveRuntimeRoot(),
    createServer: createCommandServer,
    log: logMain,
  });
  appLifecycle = new AppLifecycleController({
    currentDirectory,
    getTerminals: () => terminalManager?.list() ?? [],
    getCommandServerStatus: () => commandServerLifecycle.status(),
    openSettings: () => {
      sendToRenderer("command:open-settings", { section: "workspace" });
    },
    onRendererReady: () => void flushOsOpenFiles(),
    restartCommandServer: () => void commandServerLifecycle.restart(),
    logMain,
  });
  workspaceRuntimeCoordinator = new WorkspaceRuntimeCoordinator({
    runtimeRootFor: (settings) => path.join(settings.workspaceRoot, WORKSPACE_RUNTIME_DIRECTORY),
    recoverInvocations: (candidate) => invocationRunner.recoverWorkspace(candidate.settings),
    modelFromSettings: workspaceModelFromSettings,
    prepareNoteRoots: (candidate) => ensureNoteRoots(candidate.model),
    stageCommandServer: async (candidate) => {
      const previousLifecycle = commandServerLifecycle;
      const destinationLifecycle = new CommandServerLifecycle({
        runtimeRoot: candidate.runtimeRoot,
        createServer: () => createCommandServer(candidate.runtimeRoot),
        log: logMain,
      });
      await destinationLifecycle.start({ publishDiscovery: false });
      const discovery = await destinationLifecycle.prepareDiscovery();
      return {
        commit: () => {
          discovery.commit();
          commandServerLifecycle = destinationLifecycle;
          void previousLifecycle.stop().catch((error) => {
            logMain("previous command server stop failed after Workspace commit", serializeError(error));
          });
        },
        abort: async () => {
          discovery.abort();
          await destinationLifecycle.stop();
        },
      };
    },
    stageWatcher: async (candidate) => workspaceWatcherService.stage(candidate.model, candidate.generation),
    publishActive: (active) => {
      workspaceSettings = active.settings;
      workspaceSettingsRevision = active.revision;
      workspaceModel = active.model;
      publishingService?.updateContext();
      managedSiteSetup?.updateContext();
      workspaceSetupComplete = true;
      try {
        applyWorkspaceSettings(active.settings);
      } catch (error) {
        logMain("workspace theme apply failed after runtime commit", serializeError(error));
      }
    },
    invalidateDerivedState: (candidate) => {
      workspaceNotesService.activateWorkspace({
        model: candidate.model,
        runtimeRoot: candidate.runtimeRoot,
        generation: candidate.generation,
      });
      workspaceNotesService.invalidateDerivedState();
    },
    setTerminalDefaultCwd: (candidate) => terminalManager.setDefaultCwd(candidate.model.defaultTerminalCwd),
    reconcileIndex: (previous, candidate, reason) => {
      indexingService.activateWorkspace({
        model: candidate.model,
        settings: candidate.settings,
        runtimeRoot: candidate.runtimeRoot,
      });
      if (reason === "startup" || indexingService.shouldReconcileAfterSettingsApply(previous, candidate.settings)) {
        indexingService.scheduleReconciliation(reason, 0);
      } else {
        indexingService.applyCurrentAutomaticPolicy();
      }
    },
    applySettingsInPlace: (previous, active, plan) => {
      workspaceNotesService.applyWorkspaceModel(active.model);
      if (plan.rebindIndex) {
        indexingService.activateWorkspace({
          model: active.model,
          settings: active.settings,
          runtimeRoot: active.runtimeRoot,
        });
      } else {
        indexingService.applySettings({
          model: active.model,
          settings: active.settings,
          runtimeRoot: active.runtimeRoot,
        });
      }
      if (plan.rebindIndex || plan.updateIndexPolicy) {
        if (indexingService.shouldReconcileAfterSettingsApply(previous, active.settings)) {
          indexingService.scheduleReconciliation("settings-apply", 0);
        } else {
          indexingService.applyCurrentAutomaticPolicy();
        }
      }
      if (plan.updateTerminalDefault) {
        terminalManager.setDefaultCwd(active.model.defaultTerminalCwd);
      }
    },
  });
  registerIpcHandlers();
  broadcastTerminalData();
  if (workspaceSetupComplete) {
    const startupSettings = currentSettings();
    const activation = await workspaceRuntimeCoordinator.activate({
      previousSettings: startupSettings,
      settings: startupSettings,
      revision: workspaceSettingsRevision,
      reason: "startup",
    });
    if (activation.status !== "applied") {
      logMain("workspace runtime startup activation failed", activation);
    }
  } else {
    // Onboarding has no persisted Workspace yet. It intentionally keeps the
    // small bootstrap runtime until the first settings save enters the same
    // coordinator path used by every later Workspace transition.
    workspaceWatcherService.start(workspaceModel, BOOTSTRAP_WORKSPACE_GENERATION);
    void commandServerLifecycle.start().catch((error) => {
      console.error("Failed to start onboarding command server:", error);
      logMain("onboarding command server start failed", serializeError(error));
    });
  }
  // A configured Workspace becomes renderer-visible only after recovery and
  // every critical runtime rebind have committed. Onboarding has deliberately
  // chosen the bootstrap path above, so it may expose its empty workspace now.
  appLifecycle.createWindow();
  appLifecycle.setupTray();

  nativeTheme.on("updated", () => {
    appLifecycle.updateBackgroundForTheme();
  });


  app.on("activate", () => {
    appLifecycle.activate();
  });

  app.on("second-instance", (_event, commandLine, workingDirectory, additionalData) => {
    logMain("second instance requested focus", {
      workingDirectory,
      requestedRuntimeRoot: extractRuntimeRoot(additionalData),
    });
    for (const filePath of markdownFilePathsFromCommandLine(commandLine)) {
      queueOsOpenFile(filePath);
    }
    void refreshCommandServerDiscovery("second-instance");
    appLifecycle.showMainWindow();
  });
});

async function ensureNoteRoots(model: WorkspaceModel): Promise<void> {
  await Promise.all(model.noteRoots.map((root) => mkdir(root.path, { recursive: true })));
}

function resolveRuntimeRoot(): string {
  if (process.env.EXOGRAPH_RUNTIME_ROOT) {
    return process.env.EXOGRAPH_RUNTIME_ROOT;
  }

  if (!workspaceSetupComplete && onboardingRuntimeRoot) {
    return onboardingRuntimeRoot;
  }

  // Settings own the active workspace after startup. Falling back to the launch
  // directory here made packaged Exograph derive `/.exograph`, because Electron launches
  // the app from `/` rather than from the user's workspace.
  const workspaceRoot = workspaceSettings?.workspaceRoot ?? workspaceModel?.workspaceRoot ?? resolveWorkspaceModel().workspaceRoot;
  return path.join(workspaceRoot, WORKSPACE_RUNTIME_DIRECTORY);
}

app.on("before-quit", (event) => {
  if (!quitFlushComplete) {
    event.preventDefault();
    if (quitFlushStarted) return;
    quitFlushStarted = true;
    void awaitInvocationAwareQuit({
      flushDirtyDocuments: () => appLifecycle?.prepareDocumentTransition() ?? Promise.resolve(),
      stopInvocations: async () => {
        await Promise.all([
          typeof invocationRunner === "undefined" ? Promise.resolve() : invocationRunner.stopAll(),
          stopActiveOntologyDiscoveries(),
          publishingService?.stop() ?? Promise.resolve(),
          managedSiteSetup?.cancelSetup() ?? Promise.resolve(),
        ]);
      },
      onError: (phase, error) => {
        logMain(`${phase} failed during quit`, serializeError(error));
      },
    }).then(() => {
      quitFlushComplete = true;
      appLifecycle?.prepareToQuit();
      app.quit();
    }).catch((error) => {
      quitFlushStarted = false;
      void appLifecycle?.finishDocumentTransition();
      appLifecycle?.showMainWindow();
      logMain("quit remains blocked because durable shutdown did not settle", serializeError(error));
    });
    return;
  }
  appLifecycle?.prepareToQuit();
  void commandServerLifecycle?.stop();
  workspaceWatcherService?.stop();
  indexingService?.dispose();
  workspaceNotesService?.dispose();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
