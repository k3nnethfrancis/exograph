import { contextBridge, ipcRenderer, webUtils } from "electron";

import type { DesktopApi } from "../shared/api";
import { invokeDesktop } from "./typed-ipc";

const droppedFilePathsByKey = new Map<string, string>();

window.addEventListener(
  "drop",
  (event) => {
    const files = Array.from(event.dataTransfer?.files ?? []);
    for (const file of files) {
      const filePath = webUtils.getPathForFile(file);
      if (filePath) {
        droppedFilePathsByKey.set(fileKey(file), filePath);
      }
    }

    while (droppedFilePathsByKey.size > 100) {
      const firstKey = droppedFilePathsByKey.keys().next().value;
      if (!firstKey) break;
      droppedFilePathsByKey.delete(firstKey);
    }
  },
  true,
);

const api: DesktopApi = {
  ...(process.env.EXOGRAPH_TEST === "1" ? { test: { graphHooks: true as const } } : {}),
  publishing: {
    getStatus: () => invokeDesktop("publishing:get-status"),
    build: (input) => invokeDesktop("publishing:build", input),
    publish: (input) => invokeDesktop("publishing:publish", input),
    stop: () => invokeDesktop("publishing:stop"),
    revealOutput: () => invokeDesktop("publishing:reveal-output"),
    onStatus: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, status: Awaited<ReturnType<DesktopApi["publishing"]["getStatus"]>>) => callback(status);
      ipcRenderer.on("publishing:status", listener);
      return () => ipcRenderer.removeListener("publishing:status", listener);
    },
  },
  workspace: {
    getModel: () => invokeDesktop("workspace:get-model"),
    getSettings: () => invokeDesktop("workspace:get-settings"),
    getSetupState: () => invokeDesktop("workspace:get-setup-state"),
    saveOnboardingProgress: (draft) => invokeDesktop("workspace:save-onboarding-progress", draft),
    resetOnboardingProgress: () => invokeDesktop("workspace:reset-onboarding-progress"),
    markOnboardingComplete: () => invokeDesktop("workspace:mark-onboarding-complete"),
    listWorkspaces: () => invokeDesktop("workspace:list-workspaces"),
    activateWorkspace: (input) => invokeDesktop("workspace:activate-workspace", input),
    saveSettings: (request) => invokeDesktop("workspace:save-settings", request),
    selectFolder: (options) => invokeDesktop("workspace:select-folder", options),
    inspectContentScope: (rootPath) => invokeDesktop("workspace:inspect-content-scope", rootPath),
    getIndexStatus: () => invokeDesktop("workspace:get-index-status"),
    previewOntology: (sourcePath) => invokeDesktop("workspace:ontology-preview", sourcePath),
    keepOntology: (guard) => invokeDesktop("workspace:ontology-keep", guard),
    rejectOntology: (guard) => invokeDesktop("workspace:ontology-reject", guard),
    resolvePreviewTarget: (target) => invokeDesktop("workspace:resolve-preview-target", target),
    readPdfFile: (filePath) => invokeDesktop("workspace:read-pdf-file", filePath),
    launchAgentInvocation: (input) => invokeDesktop("workspace:launch-agent-invocation", input),
    getAgentInvocationAuthorization: (input) => invokeDesktop("workspace:get-agent-invocation-authorization", input),
    prepareGraphMaintenanceSkill: (input) => invokeDesktop("workspace:prepare-graph-maintenance-skill", input),
    discoverOntology: () => invokeDesktop("workspace:discover-ontology"),
    getAgentCommandContinuity: (commandId) => invokeDesktop("workspace:get-agent-command-continuity", commandId),
    resetAgentCommandContinuity: (commandId) => invokeDesktop("workspace:reset-agent-command-continuity", commandId),
    configureProviderMcp: (input) => invokeDesktop("workspace:configure-provider-mcp", input),
    getCliInstallationStatus: () => invokeDesktop("workspace:get-cli-installation-status"),
    installCli: () => invokeDesktop("workspace:install-cli"),
    recordRendererDiagnostic: (diagnostic) => invokeDesktop("workspace:record-renderer-diagnostic", diagnostic),
    endAgentInvocation: (invocationId) => invokeDesktop("workspace:end-agent-invocation", invocationId),
    listPendingInvocationReviews: () => invokeDesktop("workspace:list-pending-invocation-reviews"),
    listInvocationHistory: (notePath) => invokeDesktop("workspace:list-invocation-history", notePath),
    getInvocationFileReview: (input) => invokeDesktop("workspace:get-invocation-file-review", input),
    reviewInvocationFile: (input) => invokeDesktop("workspace:review-invocation-file", input),
    reviewInvocationAll: (input) => invokeDesktop("workspace:review-invocation-all", input),
    resumeInvocationInTerminal: (invocationId) => invokeDesktop("workspace:resume-invocation-in-terminal", invocationId),
    onInvocationUpdated: (callback) => {
      const listener = (_event: unknown, payload: Parameters<typeof callback>[0]) => callback(payload);
      ipcRenderer.on("workspace:invocation-updated", listener);
      return () => ipcRenderer.removeListener("workspace:invocation-updated", listener);
    },
    onInvocationActivity: (callback) => {
      const listener = (_event: unknown, payload: Parameters<typeof callback>[0]) => callback(payload);
      ipcRenderer.on("workspace:invocation-activity", listener);
      return () => ipcRenderer.removeListener("workspace:invocation-activity", listener);
    },
    syncIndex: () => invokeDesktop("workspace:index-sync"),
    updateIndex: () => invokeDesktop("workspace:index-update"),
    embedIndex: () => invokeDesktop("workspace:index-embed"),
    listTree: (rootPath, options) => invokeDesktop("workspace:list-tree", rootPath, options),
    searchWorkspace: (query) => invokeDesktop("workspace:search-workspace", query),
    searchIndex: (query, options) => invokeDesktop("workspace:search-index", query, options),
    searchTag: (tag) => invokeDesktop("workspace:search-tag", tag),
    getFolderOverview: (directoryPath) => invokeDesktop("workspace:get-folder-overview", directoryPath),
    ensureFolderIndex: (directoryPath) => invokeDesktop("workspace:ensure-folder-index", directoryPath),
    createFile: (targetPath, content) => invokeDesktop("workspace:create-file", targetPath, content),
    createFolder: (targetPath) => invokeDesktop("workspace:create-folder", targetPath),
    renamePath: (sourcePath, nextPath) => invokeDesktop("workspace:rename-path", sourcePath, nextPath),
    deletePath: (targetPath) => invokeDesktop("workspace:delete-path", targetPath),
    onDidChange: (callback) => {
      const listener = (_event: unknown, payload: { rootPath: string; eventType: string; filePath: string | null }) =>
        callback(payload);
      ipcRenderer.on("workspace:changed", listener);
      return () => ipcRenderer.removeListener("workspace:changed", listener);
    },
    onIndexSyncState: (callback) => {
      const listener = (_event: unknown, payload: Parameters<typeof callback>[0]) => callback(payload);
      ipcRenderer.on("workspace:index-sync-state", listener);
      return () => ipcRenderer.removeListener("workspace:index-sync-state", listener);
    },
    onGraphChanged: (callback) => {
      const listener = () => callback();
      ipcRenderer.on("workspace:graph-changed", listener);
      return () => ipcRenderer.removeListener("workspace:graph-changed", listener);
    },
    onOntologyCandidateChanged: (callback) => {
      const listener = () => callback();
      ipcRenderer.on("workspace:ontology-candidate-changed", listener);
      return () => ipcRenderer.removeListener("workspace:ontology-candidate-changed", listener);
    },
    onCommandOpenFile: (callback) => {
      const listener = (_event: unknown, filePath: string) => callback(filePath);
      ipcRenderer.on("command:open-file", listener);
      return () => ipcRenderer.removeListener("command:open-file", listener);
    },
    onCommandOpenSettings: (callback) => {
      const listener = (_event: unknown, payload: Parameters<typeof callback>[0]) => callback(payload);
      ipcRenderer.on("command:open-settings", listener);
      return () => ipcRenderer.removeListener("command:open-settings", listener);
    },
  },
  notes: {
    read: (filePath) => invokeDesktop("notes:read", filePath),
    save: (filePath, frontmatter, body, expectedRevision) => invokeDesktop("notes:save", filePath, frontmatter, body, expectedRevision),
    saveCopy: (filePath, frontmatter, body) => invokeDesktop("notes:save-copy", filePath, frontmatter, body),
    stat: (filePath) => invokeDesktop("notes:stat", filePath),
    getGraphContext: (filePath) => invokeDesktop("notes:get-graph-context", filePath),
    getGraphTopology: () => invokeDesktop("notes:get-graph-topology"),
    getGraphConceptSummaries: (indexes, sourceSnapshotId) => invokeDesktop("notes:get-graph-concept-summaries", indexes, sourceSnapshotId),
    graphConceptLookup: (reference, sourceSnapshotId) => invokeDesktop("notes:graph-concept-lookup", reference, sourceSnapshotId),
    getGraphConceptDetailByIndex: (index, sourceSnapshotId) => invokeDesktop("notes:get-graph-concept-detail-by-index", index, sourceSnapshotId),
    resolveTarget: (sourceFilePath, target) => invokeDesktop("notes:resolve-target", sourceFilePath, target),
    resolveMarkdownImage: (sourceFilePath, target, lookupByFilename) => invokeDesktop("notes:resolve-markdown-image", sourceFilePath, target, lookupByFilename),
    ensureTarget: (sourceFilePath, target) => invokeDesktop("notes:ensure-target", sourceFilePath, target),
    suggestTargets: (sourceFilePath, query) => invokeDesktop("notes:suggest-targets", sourceFilePath, query),
  },
  terminals: {
    list: () => invokeDesktop("terminals:list"),
    create: (options) => invokeDesktop("terminals:create", options),
    read: (id, options) => invokeDesktop("terminals:read", id, options),
    write: (id, data) => invokeDesktop("terminals:write", id, data),
    sendMessage: (id, message, submit) => invokeDesktop("terminals:send-message", id, message, submit),
    resize: (id, cols, rows) => invokeDesktop("terminals:resize", id, cols, rows),
    kill: (id) => invokeDesktop("terminals:kill", id),
    resolveDroppedFilePaths: (files) =>
      files
        .map((file) => webUtils.getPathForFile(file) || droppedFilePathsByKey.get(fileKey(file)) || "")
        .filter((filePath): filePath is string => filePath.length > 0),
    onCreated: (callback) => {
      const listener = (_event: unknown, session: Awaited<ReturnType<DesktopApi["terminals"]["create"]>>) =>
        callback(session);
      ipcRenderer.on("terminal:created", listener);
      return () => ipcRenderer.removeListener("terminal:created", listener);
    },
    onData: (callback) => {
      const listener = (_event: unknown, payload: Parameters<typeof callback>[0]) => callback(payload);
      ipcRenderer.on("terminal:data", listener);
      return () => ipcRenderer.removeListener("terminal:data", listener);
    },
    onExit: (callback) => {
      const listener = (_event: unknown, payload: { id: string; exitCode?: number }) => callback(payload);
      ipcRenderer.on("terminal:exit", listener);
      return () => ipcRenderer.removeListener("terminal:exit", listener);
    },
  },
  shell: {
    openExternal: (target) => invokeDesktop("shell:open-external", target),
    focusWindow: () => invokeDesktop("shell:focus-window"),
    changeZoom: (direction) => invokeDesktop("shell:change-zoom", direction),
  },
};

contextBridge.exposeInMainWorld("exograph", api);

function fileKey(file: File): string {
  return [file.name, file.size, file.lastModified, file.type].join("\0");
}
