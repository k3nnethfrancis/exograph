import { BrowserWindow, dialog, shell, type OpenDialogOptions } from "electron";
import path from "node:path";
import { stat } from "node:fs/promises";
import {
  assertOntologyReviewGuard,
  assertWorkspaceOntologySelection,
  WorkspaceFiles,
  type WorkspaceModel,
} from "@exograph/core";

import type { DesktopApi, FileStatInfo, RendererEditorDiagnostic, WorkspaceRegistryEntry } from "../../shared/api";
import { nextAppZoomFactor } from "../../shared/app-zoom";
import { handleDesktopInvoke } from "../typed-ipc";

type WorkspaceApi = DesktopApi["workspace"];
type NotesApi = DesktopApi["notes"];

export interface WorkspaceIpcHandlers {
  activateWorkspace: WorkspaceApi["activateWorkspace"];
  createFolder: WorkspaceApi["createFolder"];
  createFile: WorkspaceApi["createFile"];
  deletePath: WorkspaceApi["deletePath"];
  embedIndex: WorkspaceApi["embedIndex"];
  ensureTarget: NotesApi["ensureTarget"];
  getIndexStatus: WorkspaceApi["getIndexStatus"];
  previewOntology: WorkspaceApi["previewOntology"];
  keepOntology: WorkspaceApi["keepOntology"];
  rejectOntology: WorkspaceApi["rejectOntology"];
  getFolderOverview: WorkspaceApi["getFolderOverview"];
  ensureFolderIndex: WorkspaceApi["ensureFolderIndex"];
  launchAgentInvocation: WorkspaceApi["launchAgentInvocation"];
  getAgentInvocationAuthorization: WorkspaceApi["getAgentInvocationAuthorization"];
  prepareGraphMaintenanceSkill: WorkspaceApi["prepareGraphMaintenanceSkill"];
  discoverOntology: WorkspaceApi["discoverOntology"];
  getAgentCommandContinuity: WorkspaceApi["getAgentCommandContinuity"];
  resetAgentCommandContinuity: WorkspaceApi["resetAgentCommandContinuity"];
  configureProviderMcp: WorkspaceApi["configureProviderMcp"];
  getCliInstallationStatus: WorkspaceApi["getCliInstallationStatus"];
  installCli: WorkspaceApi["installCli"];
  recordRendererDiagnostic: WorkspaceApi["recordRendererDiagnostic"];
  endAgentInvocation: WorkspaceApi["endAgentInvocation"];
  listPendingInvocationReviews: WorkspaceApi["listPendingInvocationReviews"];
  listInvocationHistory: WorkspaceApi["listInvocationHistory"];
  getInvocationFileReview: WorkspaceApi["getInvocationFileReview"];
  reviewInvocationFile: WorkspaceApi["reviewInvocationFile"];
  reviewInvocationAll: WorkspaceApi["reviewInvocationAll"];
  resumeInvocationInTerminal: WorkspaceApi["resumeInvocationInTerminal"];
  resolvePreviewTarget: WorkspaceApi["resolvePreviewTarget"];
  readPdfFile: WorkspaceApi["readPdfFile"];
  getGraphContext: NotesApi["getGraphContext"];
  getGraphTopology: NotesApi["getGraphTopology"];
  getGraphConceptSummaries: NotesApi["getGraphConceptSummaries"];
  graphConceptLookup: NotesApi["graphConceptLookup"];
  getGraphConceptDetailByIndex: NotesApi["getGraphConceptDetailByIndex"];
  getMainWindow: () => BrowserWindow | null;
  getModel: () => WorkspaceModel;
  inspectContentScope: WorkspaceApi["inspectContentScope"];
  getSettings: WorkspaceApi["getSettings"];
  getSetupState: WorkspaceApi["getSetupState"];
  saveOnboardingProgress: WorkspaceApi["saveOnboardingProgress"];
  resetOnboardingProgress: WorkspaceApi["resetOnboardingProgress"];
  markOnboardingComplete: WorkspaceApi["markOnboardingComplete"];
  listTree: WorkspaceApi["listTree"];
  listWorkspaces: () => Promise<WorkspaceRegistryEntry[]>;
  readNote: NotesApi["read"];
  renamePath: WorkspaceApi["renamePath"];
  resolveTarget: NotesApi["resolveTarget"];
  resolveMarkdownImage: NotesApi["resolveMarkdownImage"];
  saveNote: NotesApi["save"];
  saveNoteCopy: NotesApi["saveCopy"];
  saveSettings: WorkspaceApi["saveSettings"];
  searchIndex: WorkspaceApi["searchIndex"];
  searchTag: WorkspaceApi["searchTag"];
  searchWorkspace: WorkspaceApi["searchWorkspace"];
  statNote: (filePath: string) => Promise<FileStatInfo | null>;
  suggestTargets: NotesApi["suggestTargets"];
  syncIndex: WorkspaceApi["syncIndex"];
  updateIndex: WorkspaceApi["updateIndex"];
}

export function registerWorkspaceIpcHandlers(handlers: WorkspaceIpcHandlers) {
  const workspaceFiles = () => new WorkspaceFiles(handlers.getModel().noteRoots.map((root) => root.path));

  handleDesktopInvoke("workspace:get-model", async () => handlers.getModel());
  handleDesktopInvoke("workspace:get-settings", async () => handlers.getSettings());
  handleDesktopInvoke("workspace:get-setup-state", async () => handlers.getSetupState());
  handleDesktopInvoke("workspace:save-onboarding-progress", async (_event, draft) => handlers.saveOnboardingProgress(draft));
  handleDesktopInvoke("workspace:reset-onboarding-progress", async () => handlers.resetOnboardingProgress());
  handleDesktopInvoke("workspace:mark-onboarding-complete", async () => handlers.markOnboardingComplete());
  handleDesktopInvoke("workspace:list-workspaces", async () => handlers.listWorkspaces());
  handleDesktopInvoke("workspace:activate-workspace", async (_event, input) => handlers.activateWorkspace(input));
  handleDesktopInvoke("workspace:get-index-status", async () => handlers.getIndexStatus());
  handleDesktopInvoke(
    "workspace:ontology-preview",
    async (_event, sourcePath) => handlers.previewOntology(
      sourcePath === undefined ? undefined : assertWorkspaceOntologySelection(sourcePath),
    ),
  );
  handleDesktopInvoke("workspace:ontology-keep", async (_event, guard) => handlers.keepOntology(assertOntologyReviewGuard(guard)));
  handleDesktopInvoke("workspace:ontology-reject", async (_event, guard) => handlers.rejectOntology(assertOntologyReviewGuard(guard)));
  handleDesktopInvoke("workspace:get-folder-overview", async (_event, directoryPath) => {
    const authorizedDirectory = await workspaceFiles().existing(directoryPath);
    return handlers.getFolderOverview(authorizedDirectory);
  });
  handleDesktopInvoke("workspace:resolve-preview-target", async (_event, target) => handlers.resolvePreviewTarget(target));
  handleDesktopInvoke("workspace:read-pdf-file", async (_event, filePath) => handlers.readPdfFile(filePath));
  handleDesktopInvoke("workspace:launch-agent-invocation", async (_event, input) => {
    const documentPath = await workspaceFiles().existing(input.documentPath);
    return handlers.launchAgentInvocation({ ...input, documentPath });
  });
  handleDesktopInvoke("workspace:get-agent-invocation-authorization", async (_event, input) => {
    const documentPath = await workspaceFiles().existing(input.documentPath);
    return handlers.getAgentInvocationAuthorization({ ...input, documentPath });
  });
  handleDesktopInvoke("workspace:prepare-graph-maintenance-skill", async (_event, input) => {
    const documentPath = await workspaceFiles().existing(input.documentPath);
    if (typeof input.commandId !== "string" || input.commandId.trim().length === 0) {
      throw new Error("Choose a configured agent before preparing graph maintenance.");
    }
    return handlers.prepareGraphMaintenanceSkill({ documentPath, commandId: input.commandId });
  });
  handleDesktopInvoke("workspace:discover-ontology", async () => handlers.discoverOntology());
  handleDesktopInvoke("workspace:get-agent-command-continuity", async (_event, commandId) => handlers.getAgentCommandContinuity(commandId));
  handleDesktopInvoke("workspace:reset-agent-command-continuity", async (_event, commandId) => handlers.resetAgentCommandContinuity(commandId));
  handleDesktopInvoke("workspace:configure-provider-mcp", async (_event, input) => handlers.configureProviderMcp(input));
  handleDesktopInvoke("workspace:get-cli-installation-status", async () => handlers.getCliInstallationStatus());
  handleDesktopInvoke("workspace:install-cli", async () => handlers.installCli());
  handleDesktopInvoke("workspace:record-renderer-diagnostic", async (_event, diagnostic) =>
    handlers.recordRendererDiagnostic(assertRendererEditorDiagnostic(diagnostic)),
  );
  handleDesktopInvoke("workspace:end-agent-invocation", async (_event, invocationId) => handlers.endAgentInvocation(invocationId));
  handleDesktopInvoke("workspace:list-pending-invocation-reviews", async () => handlers.listPendingInvocationReviews());
  handleDesktopInvoke("workspace:list-invocation-history", async (_event, notePath) =>
    handlers.listInvocationHistory(await workspaceFiles().writable(notePath)));
  handleDesktopInvoke("workspace:get-invocation-file-review", async (_event, input) => handlers.getInvocationFileReview(input));
  handleDesktopInvoke("workspace:review-invocation-file", async (_event, input) => {
    assertReviewAction(input.action);
    return handlers.reviewInvocationFile(input);
  });
  handleDesktopInvoke("workspace:review-invocation-all", async (_event, input) => {
    assertReviewAction(input.action);
    return handlers.reviewInvocationAll(input);
  });
  handleDesktopInvoke("workspace:resume-invocation-in-terminal", async (_event, invocationId) => handlers.resumeInvocationInTerminal(invocationId));
  handleDesktopInvoke("workspace:index-sync", async () => handlers.syncIndex());
  handleDesktopInvoke("workspace:index-update", async () => handlers.updateIndex());
  handleDesktopInvoke("workspace:index-embed", async () => handlers.embedIndex());
  handleDesktopInvoke("workspace:save-settings", async (_event, request) => handlers.saveSettings(request));
  handleDesktopInvoke(
    "workspace:select-folder",
    async (_event, options) => {
      if (process.env.EXOGRAPH_TEST === "1" && process.env.EXOGRAPH_TEST_SELECT_FOLDER_CANCEL === "1") {
        return [];
      }
      if (process.env.EXOGRAPH_TEST === "1" && process.env.EXOGRAPH_TEST_SELECT_FOLDER_PATH) {
        return options?.allowMultiple
          ? process.env.EXOGRAPH_TEST_SELECT_FOLDER_PATH.split(path.delimiter).filter(Boolean)
          : [process.env.EXOGRAPH_TEST_SELECT_FOLDER_PATH];
      }

      const dialogOptions: OpenDialogOptions = {
        title: options?.title,
        buttonLabel: options?.buttonLabel,
        defaultPath: options?.defaultPath,
        properties: [
          "openDirectory",
          "createDirectory",
          ...(options?.allowMultiple ? ["multiSelections" as const] : []),
        ],
      };
      const mainWindow = handlers.getMainWindow();
      const result = mainWindow && !mainWindow.isDestroyed()
        ? await dialog.showOpenDialog(mainWindow, dialogOptions)
        : await dialog.showOpenDialog(dialogOptions);
      return result.canceled ? [] : result.filePaths;
    },
  );
  handleDesktopInvoke(
    "workspace:list-tree",
    async (_event, rootPath, options) => {
      const authorizedRootPath = await workspaceFiles().existing(rootPath);
      return handlers.listTree(authorizedRootPath, options);
    },
  );
  handleDesktopInvoke("workspace:inspect-content-scope", async (_event, rootPath) => {
    const resolvedPath = path.resolve(rootPath);
    if (!(await stat(resolvedPath)).isDirectory()) {
      throw new Error("Choose a folder to inspect its Markdown scope.");
    }
    return handlers.inspectContentScope(resolvedPath);
  });
  handleDesktopInvoke("workspace:search-workspace", async (_event, query) => handlers.searchWorkspace(query));
  handleDesktopInvoke(
    "workspace:search-index",
    async (_event, query, options) =>
      handlers.searchIndex(query, options),
  );
  handleDesktopInvoke("workspace:create-file", async (_event, targetPath, content) => {
    const authorizedPath = await workspaceFiles().writable(targetPath);
    return handlers.createFile(authorizedPath, content);
  });
  handleDesktopInvoke("workspace:create-folder", async (_event, targetPath) => {
    const authorizedPath = await workspaceFiles().writable(targetPath);
    return handlers.createFolder(authorizedPath);
  });
  handleDesktopInvoke("workspace:ensure-folder-index", async (_event, directoryPath) => {
    const files = workspaceFiles();
    const authorizedDirectory = await files.existing(directoryPath);
    await files.writable(path.join(authorizedDirectory, "index.md"));
    return handlers.ensureFolderIndex(authorizedDirectory);
  });
  handleDesktopInvoke("workspace:rename-path", async (_event, sourcePath, nextPath) => {
    const files = workspaceFiles();
    const [authorizedSourcePath, authorizedNextPath] = await Promise.all([
      files.writable(sourcePath),
      files.writable(nextPath),
    ]);
    return handlers.renamePath(authorizedSourcePath, authorizedNextPath);
  });
  handleDesktopInvoke("workspace:delete-path", async (_event, targetPath) => {
    const authorizedPath = await workspaceFiles().writable(targetPath);
    return handlers.deletePath(authorizedPath);
  });
  handleDesktopInvoke("workspace:search-tag", async (_event, tag) => handlers.searchTag(tag));
  handleDesktopInvoke("notes:read", async (_event, filePath) => {
    const authorizedPath = await workspaceFiles().existing(filePath);
    return handlers.readNote(authorizedPath);
  });
  handleDesktopInvoke("notes:save", async (_event, filePath, frontmatter, body, expectedRevision) => {
    const authorizedPath = await workspaceFiles().writable(filePath);
    return handlers.saveNote(authorizedPath, frontmatter, body, expectedRevision);
  });
  handleDesktopInvoke("notes:save-copy", async (_event, filePath, frontmatter, body) => {
    const authorizedPath = await workspaceFiles().writable(filePath);
    return handlers.saveNoteCopy(authorizedPath, frontmatter, body);
  });
  handleDesktopInvoke("notes:stat", async (_event, filePath) => {
    const authorizedPath = await workspaceFiles().writable(filePath);
    return handlers.statNote(authorizedPath);
  });
  handleDesktopInvoke("notes:get-graph-context", async (_event, filePath) => {
    const authorizedPath = await workspaceFiles().existing(filePath);
    return handlers.getGraphContext(authorizedPath);
  });
  handleDesktopInvoke("notes:get-graph-topology", async () => handlers.getGraphTopology());
  handleDesktopInvoke("notes:get-graph-concept-summaries", async (_event, indexes, sourceSnapshotId) =>
    handlers.getGraphConceptSummaries(indexes, sourceSnapshotId),
  );
  handleDesktopInvoke("notes:graph-concept-lookup", async (_event, reference, sourceSnapshotId) =>
    handlers.graphConceptLookup(reference, sourceSnapshotId),
  );
  handleDesktopInvoke("notes:get-graph-concept-detail-by-index", async (_event, index, sourceSnapshotId) =>
    handlers.getGraphConceptDetailByIndex(index, sourceSnapshotId),
  );
  handleDesktopInvoke("notes:resolve-target", async (_event, sourceFilePath, target) => handlers.resolveTarget(sourceFilePath, target));
  handleDesktopInvoke("notes:resolve-markdown-image", async (_event, sourceFilePath, target, lookupByFilename) =>
    handlers.resolveMarkdownImage(sourceFilePath, target, lookupByFilename),
  );
  handleDesktopInvoke("notes:ensure-target", async (_event, sourceFilePath, target) => handlers.ensureTarget(sourceFilePath, target));
  handleDesktopInvoke("notes:suggest-targets", async (_event, sourceFilePath, query) => handlers.suggestTargets(sourceFilePath, query));
  handleDesktopInvoke("shell:open-external", async (_event, target) => {
    let parsed: URL;
    try {
      parsed = new URL(target);
    } catch {
      throw new Error("External links must be valid HTTP or HTTPS URLs.");
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("External links must use HTTP or HTTPS.");
    }
    await shell.openExternal(parsed.toString());
  });
  handleDesktopInvoke("shell:focus-window", async () => {
    const window = handlers.getMainWindow();
    window?.focus();
    window?.webContents.focus();
  });
  handleDesktopInvoke("shell:change-zoom", async (event, direction) => {
    if (direction !== -1 && direction !== 0 && direction !== 1) {
      throw new Error("App zoom direction must be -1, 0, or 1.");
    }
    const next = nextAppZoomFactor(event.sender.getZoomFactor(), direction);
    event.sender.setZoomFactor(next);
    return next;
  });
}

function assertReviewAction(action: unknown): asserts action is "keep" | "reject" {
  if (action !== "keep" && action !== "reject") throw new Error("Invocation review action must be keep or reject.");
}

function assertRendererEditorDiagnostic(value: unknown): RendererEditorDiagnostic {
  if (!value || typeof value !== "object") throw new Error("Invalid renderer diagnostic.");
  const diagnostic = value as Partial<RendererEditorDiagnostic>;
  if (diagnostic.kind !== "editor-render-fault" || typeof diagnostic.occurredAt !== "string") {
    throw new Error("Invalid renderer diagnostic.");
  }
  if (diagnostic.notePath !== null && typeof diagnostic.notePath !== "string") throw new Error("Invalid renderer diagnostic path.");
  if (!(["markdown-live", "markdown-raw", "code", "empty"] as const).includes(diagnostic.mode as RendererEditorDiagnostic["mode"])) {
    throw new Error("Invalid renderer diagnostic mode.");
  }
  if (diagnostic.agentHandle !== null && typeof diagnostic.agentHandle !== "string") throw new Error("Invalid renderer diagnostic agent.");
  if (typeof diagnostic.errorSignature !== "string") throw new Error("Invalid renderer diagnostic signature.");
  const selection = diagnostic.selection;
  if (selection !== null && (!selection || !Number.isInteger(selection.anchor) || !Number.isInteger(selection.head))) {
    throw new Error("Invalid renderer diagnostic selection.");
  }
  return {
    kind: "editor-render-fault",
    occurredAt: diagnostic.occurredAt.slice(0, 40),
    notePath: diagnostic.notePath?.slice(0, 4096) ?? null,
    mode: diagnostic.mode as RendererEditorDiagnostic["mode"],
    selection: selection ?? null,
    agentHandle: diagnostic.agentHandle?.slice(0, 120) ?? null,
    errorSignature: diagnostic.errorSignature.slice(0, 160),
  };
}
