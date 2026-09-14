import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import { flushSync } from "react-dom";
import type {
  AgentCommand,
  IndexStatus,
  InvocationSkillContext,
  WorkspaceModel,
  WorkspaceSettings,
  WorkspaceShortcutBindings,
} from "@exograph/core";
import type { InvocationActivityEvent } from "@exograph/core/invocation-activity";

import type { TerminalSessionInfo } from "../../shared/api";
import type { PreviewTarget } from "../../shared/api/workspace-filesystem";

import type { AppearanceMode, ResolvedAppearance } from "./appearance";
import { EditorPane, type AgentComposeRequest, type EditorPaneState } from "./components/EditorPane";
import type { EditorInitialSelectionRequest } from "./components/NoteEditor";
import { BrowserPane } from "./components/BrowserPane";
import { InspectorDock } from "./components/InspectorDock";
import { GraphPane } from "./components/GraphPane";
import {
  InvocationActivitySurface,
} from "./components/invocation";
import { AppInvocationAuthorizationGate } from "./appInvocationAuthorization";
import { cancelInlineAgentDraft, type InlineAgentDraft } from "./components/inlineAgentComposer";
import { OnboardingFlow } from "./components/OnboardingFlow";
import { ShellLayout } from "./components/ShellLayout";
import { TerminalDock } from "./components/TerminalDock";
import { WorkspaceSettingsDialog } from "./components/WorkspaceSettingsDialog";
import { WorkspaceRuntimeApplyNotice } from "./components/WorkspaceRuntimeApplyNotice";
import { useAppKeybindings } from "./hooks/useAppKeybindings";
import { useOpenDocuments, type OpenEditorDocument } from "./hooks/useOpenDocuments";
import { useInspectedConcept } from "./hooks/useInspectedConcept";
import { usePaneDropOrchestration } from "./hooks/usePaneDropOrchestration";
import { useShellLayout } from "./hooks/useShellLayout";
import { useTerminalSessions } from "./hooks/useTerminalSessions";
import { useWorkspaceBootstrap } from "./hooks/useWorkspaceBootstrap";
import { useWorkspaceCommandHandlers } from "./hooks/useWorkspaceCommandHandlers";
import { decodePersistedWorkspaceCanvas, useWorkspaceLayoutPersistence } from "./hooks/useWorkspaceLayoutPersistence";
import { useWorkspaceMutations } from "./hooks/useWorkspaceMutations";
import { useWorkspaceSettingsController } from "./hooks/useWorkspaceSettingsController";
import { useWorkspaceTrees } from "./hooks/useWorkspaceTrees";
import { useWorkspaceSearch } from "./hooks/useWorkspaceSearch";
import { useCanvasDocumentNavigation } from "./hooks/useCanvasDocumentNavigation";
import { useInvocationReviewController } from "./hooks/useInvocationReviewController";
import { applyTheme } from "./theme/applyTheme";
import { DEFAULT_COLOR_THEME_ID, resolveTheme } from "./theme/registry";
import type { ColorThemeId } from "./theme/types";
import { collectLeaves, findEditorLeaf, findEditorLeafByPath, findNode, paneId, removeNode, type PaneLeaf } from "./hooks/usePaneTree";
import { collectOpenEditorPaths, findFocusedEditorPath } from "./paneTreeSelectors";
import {
  DEFAULT_EDITOR_FONT_SIZE,
  DEFAULT_EXPLORER_SCALE,
  DEFAULT_TERMINAL_RUNTIME_SCROLLBACK_LINES,
  DEFAULT_TERMINAL_FONT_SIZE,
  DEFAULT_TERMINAL_PENDING_HYDRATION_CHARS,
  resolveSettingsTerminalRuntime,
  workspaceSettingsStructuralDraftKey,
} from "./workspaceSettingsModel";
import { pathLabel } from "./workspaceTree";
import { getPreviewTitle, markdownPreviewExcerpt } from "./graphAffordances";
import { workspaceBreadcrumb, type WorkspaceBreadcrumbSegment } from "./workspaceBreadcrumb";
import { DEFAULT_UTILITY_SURFACE_STATE, reduceUtilitySurface, type UtilityDestination } from "./utilitySurfaceModel";
import { addPreviewTab, closePreviewTab, EMPTY_PREVIEW_TABS, selectPreviewTab, updatePreviewTabTarget } from "./previewTabsModel";
import { routeMarkdownLink } from "./markdownLinkRouting";
import {
  applyInvocationActivityEvent,
  applyInvocationRecord,
  acknowledgeInvocationActivity,
  beginInvocationActivity,
  bindInvocationActivity,
  bufferEarlyInvocationActivityEvent,
  failActiveInvocationActivity,
  failInvocationActivity,
  invocationCommandPresentation,
  resolveInvocationActivityPaneId,
  takeEarlyInvocationActivityEvents,
  type InvocationActivityState,
} from "./invocationActivityState";
import {
  invocationReviewProjection,
  invocationReviewMatchesPath,
  invocationReviewNavigablePath,
  invocationReviewSourcePath,
  invocationReviewVirtualPath,
} from "./invocationReviewQueue";
import { refreshInvocationReviewAfterResolution } from "./invocationReviewResolution";

interface PendingInvocationAuthorization {
  command: AgentCommand;
  cwd: string;
  document: OpenEditorDocument;
  draft: InlineAgentDraft;
  fingerprint: string;
  reason: string;
  paneId: string;
  skill?: InvocationSkillContext;
}

const NOTE_TREE_MAX_DEPTH = 3;
export function App() {
  const workspaceTrees = useWorkspaceTrees({ noteTreeMaxDepth: NOTE_TREE_MAX_DEPTH });
  const { noteTrees } = workspaceTrees;
  const [exploreIndexSearchOnEnter, setExploreIndexSearchOnEnter] = useState(false);
  const [shortcutBindings, setShortcutBindings] = useState<WorkspaceShortcutBindings>({});
  const [qmdSearchSelected, setQmdSearchSelected] = useState(false);
  const workspaceSearch = useWorkspaceSearch({ indexedOnEnter: exploreIndexSearchOnEnter, qmdSelected: qmdSearchSelected });
  const graphInspection = useInspectedConcept();
  const [revealExplorerPathRequest, setRevealExplorerPathRequest] = useState<{ path: string; nonce: number } | null>(null);
  const [inspectorTabRequest, setInspectorTabRequest] = useState<{ tab: "history"; nonce: number } | null>(null);
  const [pendingInvocationAuthorization, setPendingInvocationAuthorization] = useState<PendingInvocationAuthorization | null>(null);
  const [agentComposeRequest, setAgentComposeRequest] = useState<AgentComposeRequest | null>(null);
  const agentComposeNonceRef = useRef(0);
  const [editorInitialSelectionRequest, setEditorInitialSelectionRequest] = useState<EditorInitialSelectionRequest | null>(null);
  const editorInitialSelectionNonceRef = useRef(0);
  const [invocationActivity, setInvocationActivity] = useState<InvocationActivityState | null>(null);
  const [indexStatus, setIndexStatus] = useState<IndexStatus | null>(null);
  const [appearanceMode, setAppearanceMode] = useState<AppearanceMode>("system");
  const [colorThemeId, setColorThemeId] = useState<ColorThemeId>(DEFAULT_COLOR_THEME_ID);
  const [editorFontSize, setEditorFontSize] = useState(DEFAULT_EDITOR_FONT_SIZE);
  const [terminalFontSize, setTerminalFontSize] = useState(DEFAULT_TERMINAL_FONT_SIZE);
  const [terminalRuntimeScrollbackLines, setTerminalRuntimeScrollbackLines] = useState(DEFAULT_TERMINAL_RUNTIME_SCROLLBACK_LINES);
  const [terminalRuntimeReadTailChars, setTerminalRuntimeReadTailChars] = useState(DEFAULT_TERMINAL_PENDING_HYDRATION_CHARS);
  const [explorerScale, setExplorerScale] = useState(DEFAULT_EXPLORER_SCALE);
  const [graphInverseNavigation, setGraphInverseNavigation] = useState(true);
  const [graphShowOverflowLabels, setGraphShowOverflowLabels] = useState(true);
  const [systemPrefersDark, setSystemPrefersDark] = useState(() =>
    window.matchMedia("(prefers-color-scheme: dark)").matches,
  );
  const terminalRuntimeScrollbackLinesRef = useRef(DEFAULT_TERMINAL_RUNTIME_SCROLLBACK_LINES);
  const invocationActivityEarlyEventsRef = useRef(new Map<string, InvocationActivityEvent[]>());
  const shellLayout = useShellLayout();
  const { tree: canvasTree, focusedLeafId: focusedPaneId, actions: canvasActions } = shellLayout.canvasPaneTree;
  const focusedEditorPath = useMemo(
    () => findFocusedEditorPath(canvasTree, focusedPaneId),
    [canvasTree, focusedPaneId],
  );
  const [utilityState, dispatchUtility] = useReducer(reduceUtilitySurface, DEFAULT_UTILITY_SURFACE_STATE);
  const [previewTabs, setPreviewTabs] = useState(EMPTY_PREVIEW_TABS);
  const terminalState = useTerminalSessions({
    maxPendingDataChars: terminalRuntimeReadTailChars,
    onExternalSessions: (sessions) => {
      if (sessions.length > 0) dispatchUtility({ type: "select", destination: "terminal" });
    },
  });
  const {
    sessions: terminalSessions,
    activeTerminalId,
    hydrationSnapshots: terminalHydrationSnapshots,
    hydrationVersions: terminalHydrationVersions,
    hydrationReasons: terminalHydrationReasons,
  } = terminalState;
  const workspaceBootstrap = useWorkspaceBootstrap({
    noteTreeMaxDepth: NOTE_TREE_MAX_DEPTH,
    applyWorkspaceSettings,
    applyPersistedLayout,
    setIndexStatus,
    replaceTreesForModel: workspaceTrees.replaceTreesForModel,
    restoreInitialDocuments,
    restoreTerminals,
  });
  const {
    workspaceModel,
    setWorkspaceModel,
    onboardingState,
    setOnboardingState,
    bootstrapError,
    layoutPersistenceReady,
    workspaceSettingsRef,
    workspaceSettingsRevisionRef,
  } = workspaceBootstrap;
  const workspaceSettingsController = useWorkspaceSettingsController({
    workspaceSettingsRef,
    workspaceSettingsRevisionRef,
    applyWorkspaceSettings,
    refreshWorkspaceModel,
    setIndexStatus,
  });
  const {
    dialog: workspaceSettingsDialog,
    setDialog: setWorkspaceSettingsDialog,
    indexBusy,
    runtimeApplyIssue,
    saveSettingsPatch,
    retryRuntimeApply,
  } = workspaceSettingsController;
  const openDocumentsState = useOpenDocuments({
    workspaceModel,
    activeDocumentPath: focusedEditorPath,
    getOpenEditorPaths: () => collectOpenEditorPaths(shellLayout.canvasPaneTree.tree),
    getEditorScrollTopForPath,
  });
  const {
    openDocuments,
    graphContextByPath,
    documentSaveStatuses,
    activeDocumentPath,
    activeDocument,
    scrollRestoreRequest: editorScrollRestoreRequest,
    ensureDocumentLoaded,
    openVirtualDocument,
    scheduleRefresh: scheduleOpenDocumentRefresh,
    updateBody,
    updateFrontmatter,
    saveDocument,
    prepareDocumentsForReview,
    discardAndReloadDocument,
  } = openDocumentsState;
  const canvasNavigation = useCanvasDocumentNavigation({
    canvasTree,
    focusedPaneId,
    canvasActions,
    workspaceKey: workspaceModel?.workspaceRoot ?? null,
    ensureDocumentLoaded,
    remapDocumentPaths: openDocumentsState.remapOpenPaths,
    deleteDocumentPaths: openDocumentsState.deletePathsWithin,
    onLastEditorClosed: (openRecoveredFile) => void openOrCreateDailyNote(openRecoveredFile),
  });
  const openEditorPaths = useMemo(() => collectOpenEditorPaths(canvasTree), [canvasTree]);
  useEffect(() => {
    const hiddenConflict = Object.entries(openDocuments).find(([filePath, document]) => document.saveConflict && !openEditorPaths.has(filePath));
    if (hiddenConflict) canvasNavigation.activateEditorDocument(hiddenConflict[0]);
  }, [openDocuments, openEditorPaths]);
  useEffect(() => {
    const request = openDocumentsState.conflictRevealRequest;
    if (request) canvasNavigation.activateEditorDocument(request.filePath);
  }, [openDocumentsState.conflictRevealRequest]);
  const inspectedPath = graphInspection.state.concept
    ? graphInspection.state.concept.filePath ?? null
    : activeDocumentPath;
  const inspectedDocument = inspectedPath ? openDocuments[inspectedPath] ?? null : null;
  const inspectedGraphContext = inspectedPath ? graphContextByPath[inspectedPath] ?? null : null;
  const workspaceMutations = useWorkspaceMutations({
    workspaceModel,
    activeDocumentPath,
    editorFocusedLeafId: focusedPaneId,
    reloadTrees,
    openFile: canvasNavigation.openFile,
    remapOpenPaths: canvasNavigation.remapOpenPaths,
    saveConflictCopy: openDocumentsState.saveConflictCopy,
    removeDeletedPaths: canvasNavigation.removeDeletedPaths,
    revealExplorerPath: (path) => setRevealExplorerPathRequest({ path, nonce: Date.now() }),
    requestGeneratedTitleSelection,
  });
  const { dialog: workspaceDialog, setDialog: setWorkspaceDialog } = workspaceMutations;
  const dragManager = usePaneDropOrchestration({
    canvasTree,
    canvasActions,
    focusPane: canvasNavigation.focusPane,
    ensureDocumentLoaded,
    moveWorkspacePathIntoDirectory: workspaceMutations.moveWorkspacePathIntoDirectory,
    returnSurfaceToUtility,
  });
  const compactEditorChrome = collectLeaves(canvasTree).length > 1;
  const resolvedAppearance: ResolvedAppearance = appearanceMode === "system" ? (systemPrefersDark ? "dark" : "light") : appearanceMode;
  const resolvedTheme = useMemo(() => resolveTheme(colorThemeId, resolvedAppearance), [colorThemeId, resolvedAppearance]);
  const invocationReviewController = useInvocationReviewController({
    workspaceKey: workspaceModel?.workspaceRoot ?? null,
    historyDocument: inspectedDocument,
    openDocumentPaths: Object.keys(openDocuments),
    prepareDocumentsForReview,
    reloadTrees,
    onOpenReviewDocument: openInvocationReviewDocument,
    onReviewError: (command, error) => setInvocationActivity(failInvocationActivity(command, error)),
    onReviewResolved: refreshReviewAfterResolution,
  });
  const {
    activeEntry: activeReviewEntry,
    activePayload: activeReviewPayload,
    decisionPending: invocationReviewDecisionPending,
    frozenPaths: invocationReviewFrozenPaths,
    history: invocationHistory,
    historyError: invocationHistoryError,
  } = invocationReviewController;

  useEffect(() => {
    terminalRuntimeScrollbackLinesRef.current = terminalRuntimeScrollbackLines;
  }, [terminalRuntimeScrollbackLines]);

  useEffect(() => {
    const openPaths = new Set(openEditorPaths);
    if (inspectedPath) openPaths.add(inspectedPath);
    openDocumentsState.pruneToOpenPaths(openPaths);
  }, [inspectedPath, openEditorPaths]);

  useEffect(() => {
    if (activeDocumentPath) {
      graphInspection.inspect({ filePath: activeDocumentPath });
    }
  }, [activeDocumentPath, graphInspection.inspect]);

  useEffect(() => {
    return window.exograph.workspace.onInvocationUpdated((record) => {
      if (record.workspaceRoot && record.workspaceRoot !== workspaceModel?.workspaceRoot) {
        return;
      }
      if (record.taggedDocumentPath && (record.changeset || record.status !== "pending" && record.status !== "running")) {
        scheduleOpenDocumentRefresh(record.taggedDocumentPath);
      }
      invocationReviewController.applyRecord(record);
      if (record.context === "note") {
        setInvocationActivity((current) => applyInvocationRecord(current, record));
      }
    });
  }, [invocationReviewController.applyRecord, scheduleOpenDocumentRefresh, workspaceModel?.workspaceRoot]);

  useEffect(() => {
    return window.exograph.workspace.onInvocationActivity((event) => {
      setInvocationActivity((current) => {
        if (current?.invocationId === null && current.kind !== "done" && current.kind !== "stopped" && current.kind !== "failed") {
          bufferEarlyInvocationActivityEvent(invocationActivityEarlyEventsRef.current, event);
          return current;
        }
        return applyInvocationActivityEvent(current, event);
      });
    });
  }, []);

  useEffect(() => {
    terminalState.pruneHydration(activeTerminalId ? new Set([activeTerminalId]) : new Set());
  }, [activeTerminalId]);
  useEffect(() => {
    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");

    function handleChange(event: MediaQueryListEvent) {
      setSystemPrefersDark(event.matches);
    }

    if (typeof mediaQuery.addEventListener === "function") {
      mediaQuery.addEventListener("change", handleChange);
      return () => mediaQuery.removeEventListener("change", handleChange);
    }

    mediaQuery.addListener(handleChange);
    return () => mediaQuery.removeListener(handleChange);
  }, []);

  useEffect(() => {
    document.documentElement.dataset.appearanceMode = appearanceMode;
    document.documentElement.dataset.theme = resolvedAppearance;
    document.documentElement.style.colorScheme = resolvedAppearance;
    applyTheme(document.documentElement, resolvedTheme);
  }, [appearanceMode, resolvedAppearance, resolvedTheme]);

  useWorkspaceLayoutPersistence({
    canvas: canvasTree,
    sidebarCollapsed: shellLayout.sidebarCollapsed,
    sidebarWidth: shellLayout.sidebarWidth,
    utilityWidth: shellLayout.utilityWidth,
    layoutPersistenceReady,
    onboardingActive: Boolean(onboardingState),
    workspaceModel,
    workspaceSettingsRef,
    saveSettingsPatch,
  });

  useWorkspaceCommandHandlers({
    workspaceModel,
    openFile: canvasNavigation.openFile,
    openSettings: workspaceSettingsController.openDialog,
    reloadTrees,
    scheduleOpenDocumentRefresh,
  });

  useAppKeybindings({
    activeDocumentPath,
    settingsOpen: Boolean(workspaceSettingsDialog),
    shortcutBindings,
    saveDocument,
    createUntitledNote: workspaceMutations.createUntitledNote,
    openOrCreateDailyNote,
    createShellTerminal: async () => {
      await createUtilityTerminal("shell");
    },
    toggleExplorerPanel: () => shellLayout.setSidebarCollapsed((current) => !current),
    toggleUtilityPanel: toggleUtilitySurface,
    updateAppZoom,
  });

  function applyWorkspaceSettings(settings: WorkspaceSettings) {
    const terminalPolicy = resolveSettingsTerminalRuntime(settings);
    setAppearanceMode(settings.appearanceMode);
    setColorThemeId(settings.colorThemeId);
    setEditorFontSize(settings.editorFontSize);
    setTerminalFontSize(settings.terminalFontSize);
    setTerminalRuntimeScrollbackLines(terminalPolicy.scrollbackLines);
    setTerminalRuntimeReadTailChars(terminalPolicy.readTailChars);
    setExplorerScale(settings.explorerScale);
    setGraphInverseNavigation(settings.graphInverseNavigation);
    setGraphShowOverflowLabels(settings.graphShowOverflowLabels);
    setExploreIndexSearchOnEnter(settings.exploreIndexSearchOnEnter);
    setShortcutBindings(settings.shortcutBindings ?? {});
    setQmdSearchSelected(settings.searchEngine === "qmd");
  }

  function persistSettingsPatch(patch: Partial<WorkspaceSettings>) {
    void saveSettingsPatch(patch).catch(() => {
      // The controller owns the visible recovery state.
    });
  }

  function retryWorkspaceSettings() {
    void retryRuntimeApply().catch(() => {
      // The controller keeps the current recovery state visible.
    });
  }

  function applyPersistedLayout(layout: WorkspaceSettings["layout"] | undefined) {
    shellLayout.applyPersistedLayout(layout);
  }

  async function restoreInitialDocuments(settings: WorkspaceSettings) {
    const restoredTree = decodePersistedWorkspaceCanvas(settings.layout)?.canvas ?? canvasTree;
    const restoredPaths = collectOpenEditorPaths(restoredTree);
    if (restoredPaths.size > 0) {
      await Promise.all(
        Array.from(restoredPaths).map((filePath) =>
          ensureDocumentLoaded(filePath).catch((error) => {
            console.warn("[exograph] failed to restore open document", { filePath, error });
          }),
        ),
      );
    }
  }

  function restoreTerminals(input: {
    settings: WorkspaceSettings;
    sessions: TerminalSessionInfo[];
  }) {
    const restoredActiveTerminalId = input.sessions.at(-1)?.id ?? null;
    terminalState.initialize(input.sessions, restoredActiveTerminalId);
  }

  function updateAppearanceMode(nextMode: AppearanceMode) {
    setAppearanceMode(nextMode);
    persistSettingsPatch({ appearanceMode: nextMode });
  }

  function updateAppZoom(direction: -1 | 0 | 1) {
    void window.exograph.shell.changeZoom(direction);
  }

  const noteSections = useMemo(
    () =>
      workspaceModel?.noteRoots.map((root) => ({
        label: root.label,
        path: root.path,
        nodes: noteTrees[root.path] ?? [],
      })) ?? [],
    [noteTrees, workspaceModel],
  );
  async function reloadTrees() {
    if (!workspaceModel) {
      return;
    }

    await reloadTreesForModel(workspaceModel);
  }

  async function reloadTreesForModel(model: WorkspaceModel) {
    await workspaceTrees.reloadTreesForModel(model);
  }

  async function refreshWorkspaceModel() {
    const [model] = await Promise.all([
      window.exograph.workspace.getModel(),
      refreshIndexStatus(),
    ]);
    setWorkspaceModel(model);
    await reloadTreesForModel(model);
  }

  async function refreshIndexStatus() {
    const status = await window.exograph.workspace.getIndexStatus();
    setIndexStatus(status);
    return status;
  }

  async function invokeInlineAgent(draft: InlineAgentDraft, documentPath: string, paneId: string) {
    const document = openDocuments[documentPath] ?? null;
    if (!document) {
      return;
    }
    const commandPresentation = invocationCommandPresentation(
      draft.handle,
      workspaceSettingsRef.current?.agentCommands ?? [],
    );
    // The send gesture receives an immediate, honest response before either
    // fingerprint or trust IPC can yield to another frame.
    setInvocationActivity(acknowledgeInvocationActivity(commandPresentation, paneId, draft.protocolInvocationId));
    // CodeMirror owns the authoritative post-envelope body. Its ordinary
    // React propagation is deliberately deprioritized for typing latency, so
    // publish this exact snapshot to the synchronous document ref before any
    // trust/fingerprint await can race the invocation save.
    flushSync(() => updateBody(document.filePath, draft.documentBody));
    let authorization;
    try {
      authorization = await window.exograph.workspace.getAgentInvocationAuthorization({
        handle: draft.handle,
        documentPath: document.filePath,
      });
    } catch (error) {
      cancelInlineAgentDraft(draft, () => undefined);
      setInvocationActivity(failInvocationActivity(commandPresentation, error, paneId));
      return;
    }
    if (!authorization.launchable || !authorization.cwd) {
      cancelInlineAgentDraft(draft, () => undefined);
      setInvocationActivity(failInvocationActivity(commandPresentation, authorization.detail, paneId));
      return;
    }
    const pending = {
      command: authorization.command,
      cwd: authorization.cwd,
      document,
      draft,
      fingerprint: authorization.fingerprint,
      reason: authorization.detail,
      paneId,
      ...(draft.skill ? { skill: draft.skill } : {}),
    };
    if (!authorization.trusted) {
      setInvocationActivity(null);
      setPendingInvocationAuthorization(pending);
      return;
    }
    await startInlineAgentInvocation(pending, { kind: "trusted" });
  }

  async function startInlineAgentInvocation(
    pending: PendingInvocationAuthorization,
    authorization: { kind: "trusted" | "run-once" | "always-allow" },
  ) {
    // Authorization is a decision surface, not invocation status. Close it as
    // soon as the decision is made; failures belong to the document status UI.
    setPendingInvocationAuthorization(null);
    invocationActivityEarlyEventsRef.current.clear();
    setInvocationActivity(beginInvocationActivity(pending.command, pending.paneId, pending.draft.protocolInvocationId));
    try {
      await saveDocument(pending.document.filePath);
      const persisted = await window.exograph.notes.read(pending.document.filePath);
      if (persisted.body !== pending.draft.documentBody) {
        throw new Error("The document changed after this invocation was composed. Review the note and send it again.");
      }
      const result = await window.exograph.workspace.launchAgentInvocation({
        handle: pending.draft.handle,
        protocolInvocationId: pending.draft.protocolInvocationId,
        documentPath: pending.document.filePath,
        mentionText: `@${pending.draft.handle}`,
        message: pending.draft.message,
        documentFrontmatter: persisted.frontmatter,
        documentBody: persisted.body,
        ...(pending.skill ? { skill: pending.skill } : {}),
        authorization,
        expectedFingerprint: pending.fingerprint,
      });
      const earlyEvents = takeEarlyInvocationActivityEvents(invocationActivityEarlyEventsRef.current, result.invocation.id);
      setInvocationActivity((current) => bindInvocationActivity(current, result.invocation, earlyEvents));
    } catch (error) {
      setInvocationActivity(failInvocationActivity(pending.command, error, pending.paneId));
    }
  }

  function cancelPendingInlineAgentInvocation() {
    const pending = pendingInvocationAuthorization;
    if (!pending) return;
    cancelInlineAgentDraft(pending.draft, () => {
      setPendingInvocationAuthorization(null);
      setInvocationActivity(null);
    });
  }

  async function stopInlineAgentInvocation(invocationId: string) {
    try {
      const finalized = await window.exograph.workspace.endAgentInvocation(invocationId);
      if (!finalized) return;
      if (finalized.taggedDocumentPath) {
        scheduleOpenDocumentRefresh(finalized.taggedDocumentPath);
      }
      invocationReviewController.applyRecord(finalized);
      setInvocationActivity((current) => applyInvocationRecord(current, finalized));
    } catch (error) {
      setInvocationActivity((current) => current?.invocationId === invocationId
        ? failActiveInvocationActivity(current, error)
        : current);
    }
  }

  function openInvocationReviewDocument(
    payload: import("../../shared/api").InvocationFileReviewPayload,
    source: "pending" | "history",
  ) {
    const path = invocationReviewSourcePath(payload);
    if (!path) return;
    const mediaType = payload.change.after?.mediaType ?? payload.change.before?.mediaType;
    const textPreviewOmitted = Boolean(payload.beforeTextOmitted || payload.afterTextOmitted);
    if (source === "pending" && payload.change.operation !== "deleted" && mediaType !== "binary" && !textPreviewOmitted) {
      void canvasNavigation.openFile(invocationReviewNavigablePath(payload) ?? path);
      return;
    }
    const virtualPath = invocationReviewVirtualPath(payload);
    if (!virtualPath) return;
    const body = textPreviewOmitted
      ? "This file is too large for an inline review. Keep or reject it from the review controls.\n"
      : mediaType === "binary" || payload.change.operation === "deleted"
      ? ""
      : payload.afterText ?? "";
    openVirtualDocument({
      filePath: virtualPath,
      title: mediaType === "binary"
        ? `${fileName(path)} · binary`
        : payload.change.operation === "deleted"
          ? `${fileName(path)} · deleted`
          : `${fileName(path)} · review`,
      kind: "text",
      frontmatter: {},
      body,
    });
    canvasNavigation.activateEditorDocument(virtualPath);
  }

  async function refreshReviewAfterResolution(
    payload: import("../../shared/api").InvocationFileReviewPayload | null,
    action: "keep" | "reject",
  ) {
    if (!payload) return;
    await refreshInvocationReviewAfterResolution(payload, action, {
      isDocumentOpen: (filePath) => Boolean(openDocuments[filePath]),
      removeOpenPath: canvasNavigation.removeDeletedPaths,
      reloadDocument: discardAndReloadDocument,
      openDocument: canvasNavigation.openFile,
    });
  }

  async function resumeInvocationInTerminal(
    invocationId: string,
    command?: Pick<AgentCommand, "handle" | "label">,
  ) {
    try {
      await window.exograph.workspace.resumeInvocationInTerminal(invocationId);
      setInvocationActivity(null);
      dispatchUtility({ type: "select", destination: "terminal" });
    } catch (error) {
      setInvocationActivity((current) => current?.invocationId === invocationId
        ? failActiveInvocationActivity(current, error)
        : command
          ? failInvocationActivity(command, error)
          : current);
    }
  }

  async function openTitleSegment(segment: WorkspaceBreadcrumbSegment) {
    if (segment.kind === "file") {
      await canvasNavigation.openFile(segment.path);
      return;
    }
    canvasNavigation.openFolderOverview(segment.path);
  }

  async function openKnowledgeTarget(target: string) {
    if (/^https?:\/\//.test(target)) {
      await window.exograph.shell.openExternal(target);
      return;
    }

    const route = routeMarkdownLink(target);
    if (route.kind === "pdf-preview") {
      if (!activeDocumentPath) return;
      const resolved = await window.exograph.notes.resolveTarget(activeDocumentPath, route.target);
      if (!resolved) return;
      const previewTarget = await window.exograph.workspace.resolvePreviewTarget(resolved);
      if (previewTarget.kind !== "pdf") return;
      createBrowserPane(previewTarget);
      return;
    }

    if (/^(?:\/|[A-Za-z]:[\\/])/.test(target)) {
      // Graph and Note context can own focus while navigating. Route an
      // absolute Concept path to an editor leaf explicitly instead of treating
      // the currently focused graph/utility surface as the file destination.
      await canvasNavigation.openFile(target, findEditorLeaf(canvasTree)?.id);
      return;
    }

    if (!activeDocumentPath) return;

    const resolved = target.endsWith(".md") || target.includes("/")
      ? await window.exograph.notes.resolveTarget(activeDocumentPath, target)
      : await window.exograph.notes.resolveTarget(activeDocumentPath, `${target}.md`);

    const ensured = resolved ?? await window.exograph.notes.ensureTarget(activeDocumentPath, target);
    if (!resolved) {
      requestGeneratedTitleSelection(ensured);
    }
    await reloadTrees();
    await canvasNavigation.openFile(ensured, focusedPaneId);
  }

  async function composeGraphMaintenance(filePath: string) {
    const command = workspaceSettingsRef.current?.agentCommands?.find((candidate) => candidate.enabled);
    if (!command) {
      await workspaceSettingsController.openDialog("agents");
      return;
    }
    try {
      const prepared = await window.exograph.workspace.prepareGraphMaintenanceSkill({
        documentPath: filePath,
        commandId: command.id,
      });
      await canvasNavigation.openFile(filePath, findEditorLeaf(canvasTree)?.id);
      const nonce = agentComposeNonceRef.current + 1;
      agentComposeNonceRef.current = nonce;
      setAgentComposeRequest({
        filePath,
        nonce,
        handle: command.handle,
        message: prepared.message,
        skill: prepared.skill,
      });
    } catch (error) {
      setInvocationActivity(failInvocationActivity(command, error));
    }
  }

  async function openTag(tag: string) {
    await openKnowledgeTarget(tag.replace(/^#/, ""));
  }

  async function suggestNoteTargets(query: string) {
    if (!activeDocumentPath) return [];
    const suggestions = await window.exograph.notes.suggestTargets(activeDocumentPath, query);
    return suggestions.map((suggestion) => ({
      label: suggestion.title,
      target: suggestion.target,
      detail: suggestion.snippet,
    }));
  }

  async function previewKnowledgeTarget(target: string) {
    if (!activeDocumentPath || /^https?:\/\//.test(target)) {
      return null;
    }
    if (routeMarkdownLink(target).kind === "pdf-preview") {
      return null;
    }

    const resolved = target.endsWith(".md") || target.includes("/")
      ? await window.exograph.notes.resolveTarget(activeDocumentPath, target)
      : await window.exograph.notes.resolveTarget(activeDocumentPath, `${target}.md`);
    if (!resolved) {
      return null;
    }

    const document = await window.exograph.notes.read(resolved);
    return {
      title: document.title || getPreviewTitle(resolved),
      excerpt: markdownPreviewExcerpt(document.body),
    };
  }

  function createBrowserPane(target: PreviewTarget = { kind: "web", source: "url", url: "about:blank" }) {
    const id = paneId();
    flushSync(() => {
      setPreviewTabs((current) => addPreviewTab(current, { id, target }));
      dispatchUtility({ type: "select", destination: "preview" });
    });
  }

  async function openExplorerFile(filePath: string, line?: number | null) {
    if (filePath.toLowerCase().endsWith(".pdf")) {
      const previewTarget = await window.exograph.workspace.resolvePreviewTarget(filePath);
      if (previewTarget.kind === "pdf") {
        createBrowserPane(previewTarget);
        return;
      }
    }
    await canvasNavigation.openFile(filePath, undefined, { line });
  }

  async function createUtilityTerminal(kind: "shell", cwd?: string) {
    selectUtilitySurface("terminal");
    const session = await terminalState.createTerminal(kind, cwd);
    await terminalState.activateTerminal(session.id);
  }

  async function showUtilityTerminal(sessionId: string) {
    selectUtilitySurface("terminal");
    await terminalState.activateTerminal(sessionId);
  }

  function openUtilityTerminal() {
    selectUtilitySurface("terminal");
  }

  function toggleUtilitySurface() {
    dispatchUtility({ type: "toggle" });
  }

  function closeNoteContext() {
    dispatchUtility({ type: "close" });
  }

  function openNoteContext() {
    selectUtilitySurface("context");
  }

  function restoreEditorInspection(filePath: string) {
    graphInspection.inspect({ filePath });
  }

  function activateOpenGraphTarget(filePath: string) {
    const targetLeaf = findEditorLeafByPath(canvasTree, filePath) ?? findEditorLeaf(canvasTree);
    canvasNavigation.activateEditorDocument(filePath, targetLeaf?.id);
  }

  function openGraphUtility(focusPath?: string) {
    if (focusPath) graphInspection.focus({ filePath: focusPath });
    canvasNavigation.rememberGraphReturnPath(focusPath ?? focusedEditorPath);
    selectUtilitySurface("graph");
  }

  function focusBrowserPane() {
    selectUtilitySurface("preview");
  }

  function selectUtilitySurface(destination: UtilityDestination) {
    flushSync(() => dispatchUtility({ type: "select", destination }));
  }

  function closeBrowserPane() {
    if (!previewTabs.activeId) return;
    closeBrowserTab(previewTabs.activeId);
  }

  function closeBrowserTab(id: string) {
    const next = closePreviewTab(previewTabs, id);
    setPreviewTabs(next);
  }

  /**
   * Surface ids have one visual owner: either a canvas leaf or their matching
   * utility surface. Moving back removes only the matching canvas leaf; the
   * direct PTY itself remains owned by TerminalManager and is never restarted.
   */
  function returnSurfaceToUtility(surface: "terminal" | "preview", id: string, sourcePaneId?: string) {
    if (!sourcePaneId) {
      return;
    }
    const source = findNode(canvasTree, (node) => node.kind === "leaf" && node.id === sourcePaneId) as PaneLeaf | undefined;
    const matchesSource = source?.content.kind === "terminal"
      ? surface === "terminal" && source.content.terminalId === id
      : source?.content.kind === "browser"
        ? surface === "preview" && source.content.previewId === id
        : false;
    if (!matchesSource) {
      return;
    }

    canvasActions.setTree((previous) => {
      const current = findNode(previous, (node) => node.kind === "leaf" && node.id === sourcePaneId) as PaneLeaf | undefined;
      const matchesCurrent = current?.content.kind === "terminal"
        ? surface === "terminal" && current.content.terminalId === id
        : current?.content.kind === "browser"
          ? surface === "preview" && current.content.previewId === id
          : false;
      return matchesCurrent ? (removeNode(previous, sourcePaneId) ?? previous) : previous;
    });
    if (surface === "terminal") {
      dispatchUtility({ type: "select", destination: "terminal" });
      void terminalState.activateTerminal(id);
    } else {
      setPreviewTabs((current) => selectPreviewTab(current, id));
      dispatchUtility({ type: "select", destination: "preview" });
    }
  }

  async function openOrCreateDailyNote(
    openDailyFile: (filePath: string) => Promise<void> = canvasNavigation.openFile,
  ) {
    if (!workspaceModel || workspaceModel.noteRoots.length === 0) {
      return;
    }
    const noteRoot = workspaceModel.noteRoots[0].path;
    const now = new Date();
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, "0");
    const dd = String(now.getDate()).padStart(2, "0");
    const dailyPath = joinPath(noteRoot, `${yyyy}-${mm}-${dd}.md`);

    try {
      await window.exograph.notes.read(dailyPath);
    } catch {
      await window.exograph.workspace.createFile(dailyPath);
      requestGeneratedTitleSelection(dailyPath);
      await reloadTrees();
    }

    await openDailyFile(dailyPath);
  }

  function requestGeneratedTitleSelection(filePath: string) {
    editorInitialSelectionNonceRef.current += 1;
    setEditorInitialSelectionRequest({
      filePath,
      kind: "generated-title",
      nonce: editorInitialSelectionNonceRef.current,
    });
  }

  if (!workspaceModel) {
    return (
      <div className="shell shell--loading">
        <div>Loading Exograph…</div>
        {bootstrapError ? <div className="dialog-card__status dialog-card__status--error">{bootstrapError}</div> : null}
      </div>
    );
  }

  if (onboardingState) {
    return (
      <OnboardingFlow
        actions={workspaceBootstrap}
        onDismiss={() => setOnboardingState(null)}
        onEditState={(update) => setOnboardingState((current) => current ? update(current) : current)}
        state={onboardingState}
      />
    );
  }

  const workspaceLabel = workspaceModel ? pathLabel(workspaceModel.workspaceRoot) : "Exograph";
  const titleSegments = activeDocument
    ? workspaceBreadcrumb(activeDocument.filePath, workspaceModel?.noteRoots.map((root) => root.path) ?? [])
    : [{ kind: "folder" as const, label: workspaceLabel, path: workspaceModel?.workspaceRoot ?? "" }];
  const canvasLeaves = collectLeaves(canvasTree);
  const editorPaneIds = canvasLeaves.flatMap((leaf) => leaf.content.kind === "editor" ? [leaf.id] : []);
  const invocationActivityPaneId = invocationActivity
    ? resolveInvocationActivityPaneId(invocationActivity.paneId, editorPaneIds, focusedPaneId)
    : null;
  const canvasTerminalIds = new Set(canvasLeaves.flatMap((leaf) => leaf.content.kind === "terminal" ? [leaf.content.terminalId] : []));
  const canvasPreviewIds = new Set(canvasLeaves.flatMap((leaf) => leaf.content.kind === "browser" ? [leaf.content.previewId] : []));
  const utilityTerminalSessions = terminalSessions.filter((session) => !canvasTerminalIds.has(session.id));
  const utilityPreviewTabs = previewTabs.tabs.filter((tab) => !canvasPreviewIds.has(tab.id));
  const activePreview = utilityPreviewTabs.find((tab) => tab.id === previewTabs.activeId) ?? utilityPreviewTabs[0] ?? null;
  const activityCanStop = invocationActivity?.kind !== "done" && invocationActivity?.kind !== "stopped" && invocationActivity?.kind !== "failed" && invocationActivity?.kind !== "review";
  const utilityContent = utilityState.destination === "preview" && activePreview ? (
    <BrowserPane
      paneId={activePreview.id}
      target={activePreview.target}
      compact={false}
      onFocus={() => undefined}
      onNavigate={async (target) => {
        const result = await window.exograph.workspace.resolvePreviewTarget(target);
        setPreviewTabs((current) => updatePreviewTabTarget(current, activePreview.id, result));
        return result;
      }}
      onOpenExternal={(target) => window.exograph.shell.openExternal(target)}
      onClosePane={closeBrowserPane}
      tabs={utilityPreviewTabs}
      activeTabId={activePreview.id}
      onSelectTab={(id) => setPreviewTabs((current) => selectPreviewTab(current, id))}
      onCreateTab={() => createBrowserPane()}
      onCloseTab={closeBrowserTab}
      dragManager={dragManager}
    />
  ) : utilityState.destination === "preview" ? (
    <section className="utility-preview-empty" data-testid="preview-empty-state">
      <div>
        <strong>Preview</strong>
        <p>Open a local file or localhost URL when you want to inspect it.</p>
      </div>
      <button className="utility-preview-empty__action" onClick={() => createBrowserPane()} type="button">New preview</button>
    </section>
  ) : utilityState.destination === "terminal" ? (
    <TerminalDock
      paneId="utility-terminal"
      compact={false}
      empty={utilityTerminalSessions.length === 0}
      focused={utilityState.open}
      sessions={utilityTerminalSessions}
      activeTerminalId={utilityTerminalSessions.some((session) => session.id === activeTerminalId) ? activeTerminalId : utilityTerminalSessions[0]?.id ?? null}
      hydrationSnapshots={terminalHydrationSnapshots}
      hydrationVersions={terminalHydrationVersions}
      hydrationReasons={terminalHydrationReasons}
      hydratingTerminalIds={terminalState.hydratingTerminalIds}
      theme={resolvedTheme}
      fontSize={terminalFontSize}
      scrollbackLines={terminalRuntimeScrollbackLines}
      onFocus={() => undefined}
      onHydrate={(id, options) => void terminalState.hydrateTerminal(id, options)}
      onHydrated={(id) => terminalState.markTerminalHydrated(id)}
      onSetActiveTerminal={(id) => void terminalState.activateTerminal(id)}
      onWrite={(id, data) => void window.exograph.terminals.write(id, data)}
      onGeometryMeasured={(id, cols, rows) => void window.exograph.terminals.resize(id, cols, rows)}
      onKill={(id) => void terminalState.killTerminal(id)}
      onCreateTerminal={() => void createUtilityTerminal("shell")}
      dragManager={dragManager}
    />
  ) : utilityState.destination === "graph" ? (
    <GraphPane
      inverseNavigation={graphInverseNavigation}
      showOverflowLabels={graphShowOverflowLabels}
      inspectedConcept={graphInspection.state.concept}
      focusRequest={graphInspection.state.focusRequest}
      graphReturnPath={canvasNavigation.graphReturnPath}
      isTargetOpen={(target) => openEditorPaths.has(target)}
      onRestoreEditorConcept={restoreEditorInspection}
      onActivateOpenTarget={activateOpenGraphTarget}
      onClose={() => dispatchUtility({ type: "close" })}
      onFocus={() => undefined}
      onOpenTarget={(target) => void openKnowledgeTarget(target)}
      onStartMaintenance={(filePath) => void composeGraphMaintenance(filePath)}
    />
  ) : utilityState.destination === "context" ? (
    <InspectorDock document={inspectedDocument} graphContext={inspectedGraphContext} open activeTag={null} tagResults={[]} invocationHistory={invocationHistory} invocationHistoryError={invocationHistoryError} requestedTab={inspectorTabRequest} onOpenInvocationHistory={(item) => {
      invocationReviewController.openHistory(item);
    }} onResumeInvocation={(id) => {
      const item = invocationHistory.find((candidate) => candidate.invocationId === id);
      void resumeInvocationInTerminal(id, item?.command);
    }} onRetryInvocationHistory={invocationReviewController.retryHistory} onToggle={closeNoteContext} onOpenHeading={(filePath, line) => {
      const editorLeaf = findEditorLeafByPath(canvasTree, filePath) ?? findEditorLeaf(canvasTree);
      void canvasNavigation.openFile(filePath, editorLeaf?.id, { line });
    }} onOpenTarget={(target) => void openKnowledgeTarget(target)} onOpenExternal={(target) => void window.exograph.shell.openExternal(target)} onOpenTag={(tag) => void openTag(tag)} />
  ) : null;

  return (
    <>
      <ShellLayout
      titleSegments={titleSegments}
      onOpenTitleSegment={(segment) => void openTitleSegment(segment)}
      onOpenFolder={(directoryPath) => canvasNavigation.openFolderOverview(directoryPath)}
      workspaceLabel={workspaceLabel}
      shortcutBindings={shortcutBindings}
      noteSections={noteSections}
      appearanceMode={appearanceMode}
      resolvedAppearance={resolvedAppearance}
      searchQuery={workspaceSearch.query}
      searchResults={workspaceSearch.results}
      searchResultMode={workspaceSearch.resultMode}
      searchResultQuery={workspaceSearch.resultQuery}
      searchMessage={workspaceSearch.message}
      sidebarCollapsed={shellLayout.sidebarCollapsed}
      sidebarWidth={shellLayout.sidebarWidth}
      utilityWidth={shellLayout.utilityWidth}
      onToggleSidebar={() => shellLayout.setSidebarCollapsed((current) => !current)}
      onResizeSidebar={(event) => shellLayout.startSidebarResize(event)}
      onResizeUtility={shellLayout.startUtilityResize}
      canvas={canvasTree}
      focusedPaneId={focusedPaneId}
      canvasActions={canvasActions}
      onFocusCanvasPane={canvasNavigation.focusPane}
      utilitySurface={utilityState.destination}
      utilityContent={utilityContent}
      utilityOpen={utilityState.open}
      onToggleUtility={toggleUtilitySurface}
      onOpenUtilityBrowser={focusBrowserPane}
      onOpenUtilityTerminal={openUtilityTerminal}
      onOpenUtilityGraph={() => openGraphUtility(inspectedPath ?? activeDocumentPath ?? undefined)}
      onOpenNoteContext={openNoteContext}
      revealExplorerPathRequest={revealExplorerPathRequest}
      renderLeaf={(leaf, isFocused) => {
        if (leaf.content.kind === "graph") {
          return <GraphPane
            inverseNavigation={graphInverseNavigation}
            showOverflowLabels={graphShowOverflowLabels}
            inspectedConcept={graphInspection.state.concept}
            focusRequest={graphInspection.state.focusRequest}
            graphReturnPath={canvasNavigation.graphReturnPath}
            isTargetOpen={(target) => openEditorPaths.has(target)}
            onRestoreEditorConcept={restoreEditorInspection}
            onActivateOpenTarget={activateOpenGraphTarget}
            onClose={() => canvasActions.removeLeaf(leaf.id)}
            onFocus={() => canvasNavigation.focusPane(leaf.id)}
            onOpenTarget={(target) => void openKnowledgeTarget(target)}
            onStartMaintenance={(filePath) => void composeGraphMaintenance(filePath)}
          />;
        }
        if (leaf.content.kind === "terminal") {
          const terminalId = leaf.content.terminalId;
          const session = terminalSessions.find((entry) => entry.id === terminalId);
          if (!session) {
            return <section className="utility-preview-empty"><div><strong>Terminal closed</strong><p>This shell is no longer running.</p></div></section>;
          }
          return (
            <TerminalDock
              paneId={leaf.id}
              compact={false}
              empty={false}
              focused={isFocused}
              sessions={[session]}
              activeTerminalId={session.id}
              hydrationSnapshots={terminalHydrationSnapshots}
              hydrationVersions={terminalHydrationVersions}
              hydrationReasons={terminalHydrationReasons}
              hydratingTerminalIds={terminalState.hydratingTerminalIds}
              theme={resolvedTheme}
              fontSize={terminalFontSize}
              scrollbackLines={terminalRuntimeScrollbackLines}
              onFocus={() => canvasNavigation.focusPane(leaf.id)}
              onHydrate={(id, options) => void terminalState.hydrateTerminal(id, options)}
              onHydrated={(id) => terminalState.markTerminalHydrated(id)}
              onSetActiveTerminal={(id) => void terminalState.activateTerminal(id)}
              onWrite={(id, data) => void window.exograph.terminals.write(id, data)}
              onGeometryMeasured={(id, cols, rows) => void window.exograph.terminals.resize(id, cols, rows)}
              onKill={(id) => void terminalState.killTerminal(id)}
              onCreateTerminal={() => void createUtilityTerminal("shell")}
              onClosePane={() => canvasActions.removeLeaf(leaf.id)}
              dragManager={dragManager}
            />
          );
        }
        if (leaf.content.kind === "browser") {
          const previewId = leaf.content.previewId;
          const tab = previewTabs.tabs.find((entry) => entry.id === previewId);
          if (!tab) {
            return <section className="utility-preview-empty"><div><strong>Preview closed</strong><p>This preview is no longer open.</p></div></section>;
          }
          return (
            <BrowserPane
              paneId={leaf.id}
              target={tab.target}
              compact={false}
              onFocus={() => canvasNavigation.focusPane(leaf.id)}
              onNavigate={async (target) => {
                const result = await window.exograph.workspace.resolvePreviewTarget(target);
                setPreviewTabs((current) => updatePreviewTabTarget(current, tab.id, result));
                return result;
              }}
              onOpenExternal={(target) => window.exograph.shell.openExternal(target)}
              onClosePane={() => canvasActions.removeLeaf(leaf.id)}
              tabs={[tab]}
              activeTabId={tab.id}
              dragManager={dragManager}
            />
          );
        }
        const pane: EditorPaneState = {
          id: leaf.id,
          openPaths: leaf.content.openPaths,
          activePath: leaf.content.activePath,
          openFolderPaths: leaf.content.openFolderPaths,
          activeFolderPath: leaf.content.activeFolderPath,
        };
        return (
          <>
            <EditorPane
              key={leaf.id}
              pane={pane}
              documents={openDocuments}
              graphContextByPath={graphContextByPath}
              saveStatuses={documentSaveStatuses}
              isFocused={isFocused}
              onFocusPane={() => {
                canvasNavigation.focusPane(leaf.id);
              }}
              onActivateTab={(filePath) => canvasNavigation.setPaneActivePath(leaf.id, filePath)}
              onCloseTab={(filePath) => canvasNavigation.closeDocumentInPane(leaf.id, filePath)}
              onActivateFolder={(directoryPath) => canvasNavigation.openFolderOverview(directoryPath, leaf.id)}
              onCloseFolder={(directoryPath) => canvasNavigation.closeFolderOverview(leaf.id, directoryPath)}
              onOpenFolder={(directoryPath) => canvasNavigation.openFolderOverview(directoryPath, leaf.id)}
              onOpenFile={(filePath) => void canvasNavigation.openFile(filePath, leaf.id)}
              onClosePane={collectLeaves(canvasTree).length > 1 ? () => canvasActions.removeLeaf(leaf.id) : null}
              dragManager={dragManager}
              onOpenGraph={() => openGraphUtility(pane.activePath ?? undefined)}
              onUpdateFrontmatter={(key, value) => {
                if (leaf.content.kind === "editor" && leaf.content.activePath) {
                  updateFrontmatter(leaf.content.activePath, key, value);
                }
              }}
              onBodyChange={(body) => {
                if (leaf.content.kind === "editor" && leaf.content.activePath) {
                  updateBody(leaf.content.activePath, body);
                }
              }}
              onSave={() => void (leaf.content.kind === "editor" && leaf.content.activePath ? saveDocument(leaf.content.activePath) : Promise.resolve()).catch(() => {})}
              onSaveConflictCopy={() => { if (pane.activePath) workspaceMutations.saveConflictCopy(pane.activePath); }}
              onDiscardSaveConflict={async () => {
                if (pane.activePath && await openDocumentsState.discardSaveConflict(pane.activePath) === "closed") canvasNavigation.removeDeletedPaths(pane.activePath);
              }}
              onOpenTag={(tag) => void openTag(tag)}
              onOpenTarget={(target) => void openKnowledgeTarget(target)}
              onSuggestTargets={(query) => suggestNoteTargets(query)}
              onPreviewTarget={(target) => previewKnowledgeTarget(target)}
              agentCommands={workspaceSettingsRef.current?.agentCommands ?? []}
              onInvokeAgent={(draft) => {
                if (pane.activePath) void invokeInlineAgent(draft, pane.activePath, leaf.id);
              }}
              invocationReview={
                isFocused && activeReviewEntry && activeReviewPayload && pane.activePath && invocationReviewMatchesPath(activeReviewPayload, pane.activePath, activeReviewEntry.source)
                  ? {
                      payload: activeReviewPayload,
                      queue: {
                        items: invocationReviewProjection(activeReviewEntry),
                        currentIndex: activeReviewEntry.currentIndex,
                      },
                      readOnly: activeReviewEntry.source === "history",
                      decisionPending: invocationReviewDecisionPending,
                      onNavigate: invocationReviewController.navigate,
                      onKeepCurrent: () => void invocationReviewController.resolveCurrent("keep"),
                      onRejectCurrent: () => void invocationReviewController.resolveCurrent("reject"),
                      onKeepAll: () => void invocationReviewController.resolveAll("keep"),
                      onRejectAll: () => void invocationReviewController.resolveAll("reject"),
                      onRefreshConflict: invocationReviewController.refreshActiveConflict,
                      onOpenConflict: () => openInvocationReviewDocument(activeReviewPayload, activeReviewEntry.source),
                      onDismiss: activeReviewEntry.source === "history"
                        ? invocationReviewController.dismissHistory
                        : undefined,
                      onResume: invocationActivity?.providerSessionId && invocationActivity.invocationId === activeReviewEntry.invocationId
                        ? () => void resumeInvocationInTerminal(activeReviewEntry.invocationId, activeReviewEntry.command)
                        : undefined,
                    }
                  : null
              }
              editingFrozen={openDocumentsState.transitionPending || Boolean(pane.activePath && (invocationReviewFrozenPaths.includes(pane.activePath) || openDocuments[pane.activePath]?.resolvingConflict))}
              historyAvailable={invocationHistory.length > 0 || Boolean(invocationHistoryError)}
              onOpenHistory={() => {
                openNoteContext();
                setInspectorTabRequest({ tab: "history", nonce: Date.now() });
              }}
              theme={resolvedTheme}
              fontSize={editorFontSize}
              onAppZoom={updateAppZoom}
              compact={compactEditorChrome}
              revealLineRequest={canvasNavigation.editorRevealLineRequest}
              scrollRestoreRequest={editorScrollRestoreRequest}
              initialSelectionRequest={editorInitialSelectionRequest}
              onInitialSelectionRequestHandled={(nonce) => {
                setEditorInitialSelectionRequest((current) => current?.nonce === nonce ? null : current);
              }}
              agentComposeRequest={agentComposeRequest}
              onAgentComposeRequestHandled={(nonce) => {
                setAgentComposeRequest((current) => current?.nonce === nonce ? null : current);
              }}
              isNoteDocument={(filePath) => workspaceModel ? workspaceModel.noteRoots.some((root) => isPathWithin(root.path, filePath)) : true}
              invocationActivity={invocationActivity && leaf.id === invocationActivityPaneId && invocationActivity.kind !== "review" ? {
                protocolInvocationId: invocationActivity.protocolInvocationId,
                render: (position) => (
                  <InvocationActivitySurface
                    commandHandle={invocationActivity.commandHandle}
                    commandAppearance={invocationActivity.commandAppearance}
                    commandLabel={invocationActivity.commandLabel}
                    kind={invocationActivity.kind}
                    label={invocationActivity.label}
                    errorDetail={invocationActivity.errorDetail}
                    position={position}
                    onDismiss={invocationActivity.kind === "done" || invocationActivity.kind === "stopped" || invocationActivity.kind === "failed"
                      ? () => setInvocationActivity(null)
                      : undefined}
                    onResume={invocationActivity.providerSessionId && invocationActivity.invocationId
                      ? () => void resumeInvocationInTerminal(invocationActivity.invocationId!)
                      : undefined}
                    onStop={activityCanStop && invocationActivity.invocationId
                      ? () => void stopInlineAgentInvocation(invocationActivity.invocationId!)
                      : undefined}
                  />
                ),
              } : undefined}
              onResumeProtocolInvocation={(protocolInvocationId) => {
                const item = invocationHistory.find((candidate) => candidate.protocolInvocationId === protocolInvocationId && candidate.providerSessionId);
                if (item) void resumeInvocationInTerminal(item.invocationId, item.command);
              }}
            />
          </>
        );
      }}
      onAppearanceModeChange={updateAppearanceMode}
      onOpenWorkspaceSettings={() => void workspaceSettingsController.openDialog()}
      onSearchQueryChange={(value) => {
        workspaceSearch.setQuery(value);
        workspaceSearch.setSubmittedQuery(value.trim());
      }}
      onSearchSubmit={() => void workspaceSearch.runIndexedSearch()}
      onSearchClear={() => {
        workspaceSearch.setQuery("");
        workspaceSearch.setSubmittedQuery("");
      }}
      onOpenFile={(filePath, line) => void openExplorerFile(filePath, line)}
      onOpenTerminalSession={(sessionId) => void showUtilityTerminal(sessionId)}
      onOpenTag={(tag) => void openTag(tag)}
      onExpandDirectory={(directoryPath) => void workspaceTrees.expandTreeDirectory(directoryPath)}
      explorerScale={explorerScale}
      dragManager={dragManager}
      onCreateFile={(directoryPath) => workspaceMutations.createFileInDirectory(directoryPath)}
      onCreateDirectory={(directoryPath) => workspaceMutations.createDirectoryInDirectory(directoryPath)}
      onCreateTerminalInDirectory={(directoryPath) => void createUtilityTerminal("shell", directoryPath)}
      onRenamePath={(targetPath, kind) => workspaceMutations.renameWorkspacePath(targetPath, kind)}
      onDeletePath={(targetPath) => workspaceMutations.deleteWorkspacePath(targetPath)}
    />

      {runtimeApplyIssue ? (
        <WorkspaceRuntimeApplyNotice
          message={runtimeApplyIssue.message}
          onRetry={retryWorkspaceSettings}
        />
      ) : null}

      {workspaceDialog ? (
        <div className="dialog-overlay" data-testid="workspace-dialog-overlay">
          <div className="dialog-card" data-testid="workspace-dialog">
            <div className="dialog-card__title">{workspaceDialog.title}</div>
            {workspaceMutations.dialogError ? <div role="alert" className="dialog-card__message">{workspaceMutations.dialogError}</div> : null}
            {"message" in workspaceDialog ? <div className="dialog-card__message">{workspaceDialog.message}</div> : null}
            {"value" in workspaceDialog ? (
              <input
                autoFocus
                className="dialog-card__input"
                data-testid="workspace-dialog-input"
                value={workspaceDialog.value}
                onChange={(event) =>
                  setWorkspaceDialog((current) => (current && "value" in current ? { ...current, value: event.target.value } : current))
                }
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    void workspaceMutations.submitDialog();
                  }
                  if (event.key === "Escape") {
                    event.preventDefault();
                    setWorkspaceDialog(null);
                  }
                }}
              />
            ) : null}
            {workspaceDialog.kind === "save-copy" ? <div className="dialog-card__message">Filename: {workspaceMutations.copyFilename}</div> : null}
            {workspaceDialog.kind === "rename" && workspaceDialog.preserveMarkdown ? (
              <div className="dialog-card__message">
                Filename: {workspaceMutations.renameFilename}
              </div>
            ) : null}
            <div className="dialog-card__actions">
              <button className="toolbar-button" onClick={() => setWorkspaceDialog(null)} type="button">
                Cancel
              </button>
              <button
                className={`toolbar-button ${workspaceDialog.kind === "delete" ? "toolbar-button--danger" : ""}`}
                data-testid="workspace-dialog-confirm"
                disabled={workspaceMutations.dialogPending}
                onClick={() => void workspaceMutations.submitDialog()}
                type="button"
              >
                {workspaceDialog.confirmLabel}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {pendingInvocationAuthorization ? (
        <AppInvocationAuthorizationGate
          pending={pendingInvocationAuthorization}
          onAuthorize={(authorization) => void startInlineAgentInvocation(
            pendingInvocationAuthorization,
            authorization,
          )}
          onCancel={cancelPendingInlineAgentInvocation}
        />
      ) : null}

      {workspaceSettingsDialog ? (
        <WorkspaceSettingsDialog
          indexBusy={indexBusy}
          indexStatus={indexStatus}
          settings={workspaceSettingsDialog}
          setSettings={setWorkspaceSettingsDialog}
          structuralDraftKey={workspaceSettingsStructuralDraftKey}
          onChooseFolder={(target) => void workspaceSettingsController.chooseFolder(target)}
          onClose={workspaceSettingsController.closeDialog}
          onOpenWorkspaceSwitcher={() => {
            setWorkspaceSettingsDialog(null);
            void workspaceBootstrap.openWorkspaceSwitcher();
          }}
          onRunIndexUpdate={(kind) => void workspaceSettingsController.runIndexUpdate(kind)}
          onSave={(settingsDialog, options) => void workspaceSettingsController.saveDialog(settingsDialog, options)}
        />
      ) : null}
    </>
  );
}

function joinPath(parentPath: string, name: string): string {
  return `${parentPath.replace(/\/$/, "")}/${name.replace(/^\//, "")}`;
}

function isPathWithin(parentPath: string, targetPath: string): boolean {
  return targetPath === parentPath || targetPath.startsWith(`${parentPath}/`);
}

function getEditorScrollTopForPath(filePath: string): number | null {
  const scroller = getEditorScrollerForPath(filePath);
  return scroller ? scroller.scrollTop : null;
}

function getEditorScrollerForPath(filePath: string): HTMLElement | null {
  for (const title of document.querySelectorAll<HTMLElement>(".editor-panel__title[title]")) {
    if (title.title !== filePath) {
      continue;
    }
    return title.closest(".editor-pane")?.querySelector<HTMLElement>(".editor-surface .cm-scroller") ?? null;
  }
  return null;
}

function fileName(filePath: string): string {
  return filePath.split(/[\\/]/u).filter(Boolean).at(-1) ?? "File";
}
