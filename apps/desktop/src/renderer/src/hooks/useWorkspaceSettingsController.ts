import { useCallback, useEffect, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import type {
  IndexStatus,
  WorkspaceSettings,
  WorkspaceSettingsRevision,
} from "@exograph/core";
import { agentCommandConfigurationError } from "@exograph/core/agent-command-configuration";
import type { IndexSyncStateEvent, WorkspaceSettingsSaveOutcome } from "../../../shared/api";
import { DEFAULT_AGENT_INVOCATION_PROMPT } from "@exograph/core/agent-invocation-prompt";
import { normalizeWorkspaceContentPolicy } from "@exograph/core/workspace-content-policy";
import { shortcutBindingsHaveConflict } from "../shellHelpModel";
import type { AppearanceMode } from "../appearance";
import { normalizeColorThemeId } from "../theme/registry";
import {
  clampNumber,
  workspaceSettingsImmediateDraftKey,
  workspaceSettingsStructuralDraftFromSettings,
  workspaceSettingsStructuralDraftKey,
  workspaceSettingsStructuralKeyFromSettings,
} from "../workspaceSettingsModel";
import type {
  IndexBusyState,
  WorkspaceSettingsDialogState,
  WorkspaceSettingsSection,
} from "../workspaceSettingsDialogTypes";

interface UseWorkspaceSettingsControllerOptions {
  workspaceSettingsRef: MutableRefObject<WorkspaceSettings | null>;
  workspaceSettingsRevisionRef: MutableRefObject<WorkspaceSettingsRevision>;
  applyWorkspaceSettings: (settings: WorkspaceSettings) => void;
  refreshWorkspaceModel: () => Promise<void>;
  setIndexStatus: Dispatch<SetStateAction<IndexStatus | null>>;
  onSettingsSaved?: () => void | Promise<void>;
}

interface WorkspaceRuntimeApplyIssue {
  message: string;
}

export function useWorkspaceSettingsController(options: UseWorkspaceSettingsControllerOptions) {
  const [dialog, setDialog] = useState<WorkspaceSettingsDialogState | null>(null);
  const [indexBusy, setIndexBusy] = useState<IndexBusyState>(null);
  const [runtimeApplyIssue, setRuntimeApplyIssue] = useState<WorkspaceRuntimeApplyIssue | null>(null);
  const optionsRef = useRef(options);
  const runtimeApplyIssueRef = useRef<WorkspaceRuntimeApplyIssue | null>(null);
  const settingsSaveTailRef = useRef<Promise<void>>(Promise.resolve());
  const dialogSessionIdRef = useRef(0);
  const publishRuntimeApplyIssue = useCallback((issue: WorkspaceRuntimeApplyIssue | null) => {
    runtimeApplyIssueRef.current = issue;
    setRuntimeApplyIssue(issue);
  }, []);
  const reconcileRuntimeApply = useCallback((saved: WorkspaceSettingsSaveOutcome) => {
    if (saved.runtimeApply.status === "applied") {
      publishRuntimeApplyIssue(null);
      return;
    }
    publishRuntimeApplyIssue({ message: saved.runtimeApply.errorMessage });
  }, [publishRuntimeApplyIssue]);
  const enqueueSettingsSave = useCallback((
    buildSettings: (baseSettings: WorkspaceSettings) => WorkspaceSettings,
    publishSavedSettings?: (saved: WorkspaceSettingsSaveOutcome) => Promise<void>,
    publishSaveError?: (error: unknown) => void,
  ) => {
    // Every renderer-originated Settings write and its dependent renderer
    // publication share this stream. The next request reads the revision and
    // workspace model published by its predecessor.
    const result = settingsSaveTailRef.current.then(async () => {
      try {
        const baseSnapshot = optionsRef.current.workspaceSettingsRef.current
          ? {
              settings: optionsRef.current.workspaceSettingsRef.current,
              revision: optionsRef.current.workspaceSettingsRevisionRef.current,
            }
          : await window.exograph.workspace.getSettings();
        const nextSettings: WorkspaceSettings = {
          ...buildSettings(baseSnapshot.settings),
        };
        const saved = await window.exograph.workspace.saveSettings({
          settings: nextSettings,
          expectedRevision: baseSnapshot.revision,
        });
        optionsRef.current.workspaceSettingsRef.current = saved.settings;
        optionsRef.current.workspaceSettingsRevisionRef.current = saved.revision;
        await publishSavedSettings?.(saved);
        return saved;
      } catch (error) {
        publishSaveError?.(error);
        throw error;
      }
    });
    settingsSaveTailRef.current = result.then(() => undefined, () => undefined);
    return result;
  }, []);
  const saveSettingsPatch = useCallback(async (patch: Partial<WorkspaceSettings>): Promise<void> => {
    const saved = await enqueueSettingsSave(
      (baseSettings) => ({
        ...baseSettings,
        ...patch,
      }),
      async (savedSettings) => {
        reconcileRuntimeApply(savedSettings);
        if (savedSettings.runtimeApply.status !== "failed") {
          await optionsRef.current.onSettingsSaved?.();
        }
      },
      (error) => publishRuntimeApplyIssue({
        message: error instanceof Error ? error.message : "Workspace settings could not be applied.",
      }),
    );
    if (saved.runtimeApply.status === "failed") throw new Error(saved.runtimeApply.errorMessage);
  }, [enqueueSettingsSave, publishRuntimeApplyIssue, reconcileRuntimeApply]);
  const retryRuntimeApply = useCallback(async (): Promise<void> => {
    // A Retry click can race a newer save that is already queued. Let that
    // save settle first: if it applies, it clears this issue and recovery must
    // not replay or supersede it.
    await settingsSaveTailRef.current;
    if (!runtimeApplyIssueRef.current) return;
    const saved = await enqueueSettingsSave(
      (currentSettings) => currentSettings,
      async (savedSettings) => {
        if (savedSettings.runtimeApply.status !== "applied") reconcileRuntimeApply(savedSettings);
        if (savedSettings.runtimeApply.status === "failed") return;
        optionsRef.current.applyWorkspaceSettings(savedSettings.settings);
        await optionsRef.current.refreshWorkspaceModel();
        optionsRef.current.setIndexStatus(await window.exograph.workspace.getIndexStatus());
        await optionsRef.current.onSettingsSaved?.();
        if (savedSettings.runtimeApply.status === "applied") reconcileRuntimeApply(savedSettings);
      },
      (error) => publishRuntimeApplyIssue({
        message: error instanceof Error ? error.message : "Workspace settings could not be published.",
      }),
    );
    if (saved.runtimeApply.status === "failed") throw new Error(saved.runtimeApply.errorMessage);
  }, [enqueueSettingsSave, publishRuntimeApplyIssue, reconcileRuntimeApply]);

  useEffect(() => {
    optionsRef.current = options;
  }, [options]);

  useEffect(() => {
    return window.exograph.workspace.onIndexSyncState((event) => {
      if (event.state === "running") {
        setIndexBusy((current) => indexBusyStateForEvent(event, current));
        return;
      }
      setIndexBusy(null);
      if (event.result?.status) {
        optionsRef.current.setIndexStatus(event.result.status);
      }
      if (event.state === "error") {
        setDialog((current) =>
          current
            ? {
                ...current,
                applyStatus: "error",
                applyErrorMessage: event.error ?? "Index sync failed.",
              }
            : current,
        );
      }
    });
  }, []);

  useEffect(() => {
    if (!dialog || dialog.saveStatus !== "idle") {
      return;
    }

    const snapshot = dialog;
    const timeout = window.setTimeout(() => {
      void saveDialog(snapshot);
    }, 650);

    return () => window.clearTimeout(timeout);
  }, [dialog]);

  async function openDialog(section: WorkspaceSettingsSection = "workspace") {
    const dialogSessionId = dialogSessionIdRef.current + 1;
    dialogSessionIdRef.current = dialogSessionId;
    await settingsSaveTailRef.current;
    if (dialogSessionIdRef.current !== dialogSessionId) {
      return;
    }
    const snapshot = await window.exograph.workspace.getSettings();
    if (dialogSessionIdRef.current !== dialogSessionId) {
      return;
    }
    const settings = snapshot.settings;
    optionsRef.current.workspaceSettingsRef.current = settings;
    optionsRef.current.workspaceSettingsRevisionRef.current = snapshot.revision;
    const appliedWorkspaceKey = workspaceSettingsStructuralKeyFromSettings(settings);
    const structuralDraft = workspaceSettingsStructuralDraftFromSettings(settings);
    setDialog({
      section,
      settingsRevision: snapshot.revision,
      ...structuralDraft,
      publishing: settings.publishing,
      appearanceMode: settings.appearanceMode as AppearanceMode,
      colorThemeId: normalizeColorThemeId(settings.colorThemeId),
      editorFontSize: String(settings.editorFontSize),
      terminalFontSize: String(settings.terminalFontSize),
      explorerScale: String(settings.explorerScale),
      graphInverseNavigation: settings.graphInverseNavigation,
      graphShowOverflowLabels: settings.graphShowOverflowLabels,
      ontologyDiscoveryPrompt: settings.ontologyDiscoveryPrompt,
      shortcutBindings: settings.shortcutBindings ?? {},
      exploreIndexSearchOnEnter: settings.exploreIndexSearchOnEnter,
      indexUpdateStrategy: settings.indexUpdateStrategy,
      agentCommands: settings.agentCommands ?? [],
      defaultAgentCommandId: settings.defaultAgentCommandId,
      agentInvocationPrompt: settings.agentInvocationPrompt ?? DEFAULT_AGENT_INVOCATION_PROMPT,
      saveStatus: "saved",
      errorMessage: null,
      appliedWorkspaceKey,
      applyStatus: "idle",
      applyErrorMessage: null,
    });
    void window.exograph.workspace.getIndexStatus().then(optionsRef.current.setIndexStatus).catch((error) => {
      console.warn("[exograph] failed to load index status", error);
      optionsRef.current.setIndexStatus(null);
    });
  }

  function closeDialog() {
    const snapshot = dialog;
    const commandError = snapshot ? agentCommandConfigurationError(snapshot.agentCommands) : null;
    const shortcutError = snapshot && shortcutBindingsHaveConflict(snapshot.shortcutBindings) ? "Each global shortcut must be unique." : null;
    if (snapshot && (commandError || shortcutError)) {
      // A command draft is local form state until it validates. Keep it in the
      // dialog so Close never turns a fixable validation problem into a
      // misleading runtime-recovery notice or silently discards the edit.
      setDialog({ ...snapshot, saveStatus: "error", errorMessage: commandError ?? shortcutError });
      return;
    }
    if (snapshot && snapshot.saveStatus !== "saved" && snapshot.saveStatus !== "saving") {
      void saveDialog(snapshot, { includeStructural: false });
    }
    dialogSessionIdRef.current += 1;
    setDialog(null);
  }

  async function chooseFolder(target: "workspaceRoot" | "defaultTerminalCwd" | "noteRoot") {
    const folders = await window.exograph.workspace.selectFolder({
      title:
        target === "noteRoot"
          ? "Choose notes folder"
          : "Choose folder",
      buttonLabel: "Use Folder",
    });
    if (folders.length === 0) {
      return;
    }
    setDialog((current) => {
      if (!current) {
        return current;
      }
      if (target === "workspaceRoot") {
        return { ...current, workspaceRoot: folders[0], applyStatus: "idle", applyErrorMessage: null };
      }
      if (target === "defaultTerminalCwd") {
        return { ...current, defaultTerminalCwd: folders[0], applyStatus: "idle", applyErrorMessage: null };
      }
      if (target === "noteRoot") {
        return { ...current, noteRoots: [folders[0]], applyStatus: "idle", applyErrorMessage: null };
      }
      return current;
    });
  }

  async function runIndexUpdate(action: Exclude<IndexBusyState, null>) {
    setIndexBusy(action);
    setDialog((current) =>
      current
        ? {
            ...current,
            applyStatus: "idle",
            applyErrorMessage: null,
          }
        : current,
    );

    try {
      const status = action === "syncing"
        ? (await window.exograph.workspace.syncIndex()).status
        : action === "embedding"
          ? await window.exograph.workspace.embedIndex()
          : await window.exograph.workspace.updateIndex();
      optionsRef.current.setIndexStatus(status);
    } catch (error) {
      setDialog((current) =>
        current
          ? {
              ...current,
              applyStatus: "error",
              applyErrorMessage: error instanceof Error ? error.message : "Unable to update the index.",
            }
          : current,
      );
    } finally {
      setIndexBusy(null);
    }
  }

  async function saveDialog(settingsDialog = dialog, saveOptions = { includeStructural: false }) {
    if (!settingsDialog) {
      return;
    }

    const commandError = agentCommandConfigurationError(settingsDialog.agentCommands);
    const shortcutError = shortcutBindingsHaveConflict(settingsDialog.shortcutBindings) ? "Each global shortcut must be unique." : null;
    if (commandError || shortcutError) {
      const invalidDraftKey = saveOptions.includeStructural
        ? workspaceSettingsStructuralDraftKey(settingsDialog)
        : workspaceSettingsImmediateDraftKey(settingsDialog);
      setDialog((current) =>
        current
        && (saveOptions.includeStructural ? workspaceSettingsStructuralDraftKey(current) : workspaceSettingsImmediateDraftKey(current)) === invalidDraftKey
          ? { ...current, saveStatus: "error", errorMessage: commandError ?? shortcutError }
          : current,
      );
      return;
    }

    const dialogSessionId = dialogSessionIdRef.current;
    const snapshotKey = saveOptions.includeStructural
      ? workspaceSettingsStructuralDraftKey(settingsDialog)
      : workspaceSettingsImmediateDraftKey(settingsDialog);

    setDialog((current) =>
      current && (saveOptions.includeStructural ? workspaceSettingsStructuralDraftKey(current) : workspaceSettingsImmediateDraftKey(current)) === snapshotKey
        ? {
            ...current,
            ...(saveOptions.includeStructural
              ? { applyStatus: "applying" as const, applyErrorMessage: null }
              : { saveStatus: "saving" as const, errorMessage: null }),
          }
        : current,
    );

    try {
      const saved = await enqueueSettingsSave(
        (baseSettings) => workspaceSettingsFromDialog(settingsDialog, saveOptions, baseSettings),
        async (savedSettings) => {
          if (savedSettings.runtimeApply.status !== "applied") reconcileRuntimeApply(savedSettings);
          optionsRef.current.applyWorkspaceSettings(savedSettings.settings);
          if (savedSettings.runtimeApply.status === "failed") return;
          if (saveOptions.includeStructural) {
            await optionsRef.current.refreshWorkspaceModel();
            try {
              optionsRef.current.setIndexStatus(await window.exograph.workspace.getIndexStatus());
            } catch (error) {
              console.warn("[exograph] failed to refresh search status", error);
              optionsRef.current.setIndexStatus(null);
            }
          }
          await optionsRef.current.onSettingsSaved?.();
          if (savedSettings.runtimeApply.status === "applied") reconcileRuntimeApply(savedSettings);
        },
        (error) => publishRuntimeApplyIssue({
          message: error instanceof Error ? error.message : "Workspace settings could not be published.",
        }),
      );
      if (saved.runtimeApply.status === "failed") {
        const runtimeApplyErrorMessage = saved.runtimeApply.errorMessage;
        setDialog((current) => {
          if (!current || dialogSessionIdRef.current !== dialogSessionId) {
            return current;
          }
          const savedDraftIsCurrent = (
            saveOptions.includeStructural
              ? workspaceSettingsStructuralDraftKey(current)
              : workspaceSettingsImmediateDraftKey(current)
          ) === snapshotKey;
          return {
            ...current,
            settingsRevision: saved.revision,
            ...(savedDraftIsCurrent
              ? saveOptions.includeStructural
                ? {
                    applyStatus: "error" as const,
                    applyErrorMessage: runtimeApplyErrorMessage,
                  }
                : {
                    saveStatus: "error" as const,
                    errorMessage: runtimeApplyErrorMessage,
                  }
              : {}),
          };
        });
        return;
      }
      const degradedRuntimeMessage = saved.runtimeApply.status === "degraded"
        ? saved.runtimeApply.errorMessage
        : null;
      setDialog((current) => {
        if (!current || dialogSessionIdRef.current !== dialogSessionId) {
          return current;
        }
        const savedDraftIsCurrent = (
          saveOptions.includeStructural
            ? workspaceSettingsStructuralDraftKey(current)
            : workspaceSettingsImmediateDraftKey(current)
        ) === snapshotKey;
        return {
          ...current,
          settingsRevision: saved.revision,
          // Publish the normalized values without replacing input typed after
          // this save began, including while a structural Apply is in flight.
          ...Object.fromEntries(
            (["editorFontSize", "terminalFontSize", "explorerScale"] as const)
              .filter((field) => current[field] === settingsDialog[field])
              .map((field) => [field, String(saved.settings[field])]),
          ),
          ...(savedDraftIsCurrent
            ? saveOptions.includeStructural
              ? {
                  ...workspaceSettingsStructuralDraftFromSettings(saved.settings),
                  appliedWorkspaceKey: workspaceSettingsStructuralKeyFromSettings(saved.settings),
                  applyStatus: degradedRuntimeMessage ? "error" as const : "applied" as const,
                  applyErrorMessage: degradedRuntimeMessage,
                }
              : {
                  saveStatus: degradedRuntimeMessage ? "error" as const : "saved" as const,
                  errorMessage: degradedRuntimeMessage,
                }
            : {}),
        };
      });
    } catch (error) {
      setDialog((current) =>
        current
        && dialogSessionIdRef.current === dialogSessionId
        && (saveOptions.includeStructural ? workspaceSettingsStructuralDraftKey(current) : workspaceSettingsImmediateDraftKey(current)) === snapshotKey
          ? {
              ...current,
              ...(saveOptions.includeStructural
                ? {
                    applyStatus: "error" as const,
                    applyErrorMessage: error instanceof Error ? error.message : "Unable to apply workspace settings.",
                  }
                : {
                    saveStatus: "error" as const,
                    errorMessage: error instanceof Error ? error.message : "Unable to save workspace settings.",
                  }),
            }
          : current,
      );
    }
  }

  return {
    dialog,
    setDialog,
    indexBusy,
    runtimeApplyIssue,
    saveSettingsPatch,
    retryRuntimeApply,
    openDialog,
    closeDialog,
    chooseFolder,
    runIndexUpdate,
    saveDialog,
  };
}

export function indexBusyStateForEvent(
  event: Pick<IndexSyncStateEvent, "state" | "reason">,
  current: IndexBusyState = null,
): IndexBusyState {
  if (event.state !== "running") {
    return null;
  }
  const reason = event.reason.toLowerCase();
  if (reason.includes("embed") || reason.includes("embedding") || reason.includes("catch-up")) {
    return "embedding";
  }
  if (reason.includes("update") || reason.includes("refresh") || reason.includes("note-save")) {
    return "updating";
  }
  return current ?? "syncing";
}

export function workspaceSettingsFromDialog(
  settingsDialog: WorkspaceSettingsDialogState,
  options: { includeStructural: boolean },
  currentSettings: WorkspaceSettings | null,
): WorkspaceSettings {
  if (!currentSettings) {
    throw new Error("Workspace settings are unavailable. Close Settings and try again.");
  }
    const commandError = agentCommandConfigurationError(settingsDialog.agentCommands);
    const shortcutError = shortcutBindingsHaveConflict(settingsDialog.shortcutBindings) ? "Each global shortcut must be unique." : null;
    if (commandError || shortcutError) {
      throw new Error(commandError ?? shortcutError ?? "Shortcut configuration is invalid.");
  }

  const structuralSettings = {
    workspaceRoot: settingsDialog.workspaceRoot.trim(),
    defaultTerminalCwd: settingsDialog.defaultTerminalCwd.trim(),
    noteRoots: settingsDialog.noteRoots
      .map((entry) => entry.trim())
      .filter(Boolean),
    indexedRoots: settingsDialog.indexedRoots
      .filter((root) => Boolean(root.path.trim()))
      .map((root) => ({ ...root, path: root.path.trim(), ignore: [...root.ignore] })),
    contentPolicy: normalizeWorkspaceContentPolicy(settingsDialog.contentPolicy),
    indexing: {
      enabled: settingsDialog.indexMode !== "off",
      mode: settingsDialog.indexMode,
      backend: "qmd" as const,
    },
    searchEngine: settingsDialog.searchEngine,
  };
  return {
    ...currentSettings,
    workspaceRoot: options.includeStructural ? structuralSettings.workspaceRoot : currentSettings.workspaceRoot,
    defaultTerminalCwd: options.includeStructural ? structuralSettings.defaultTerminalCwd : currentSettings.defaultTerminalCwd,
    noteRoots: options.includeStructural
      ? structuralSettings.noteRoots
      : currentSettings.noteRoots,
    indexedRoots: options.includeStructural
      ? structuralSettings.indexedRoots
      : currentSettings.indexedRoots,
    contentPolicy: options.includeStructural
      ? structuralSettings.contentPolicy
      : currentSettings.contentPolicy,
    indexing: options.includeStructural
      ? structuralSettings.indexing
      : currentSettings.indexing,
    searchEngine: options.includeStructural
      ? structuralSettings.searchEngine
      : currentSettings.searchEngine,
    publishing: settingsDialog.publishing,
    appearanceMode: settingsDialog.appearanceMode,
    colorThemeId: normalizeColorThemeId(settingsDialog.colorThemeId),
    editorFontSize: clampNumber(Number(settingsDialog.editorFontSize), 11, 24),
    terminalFontSize: clampNumber(Number(settingsDialog.terminalFontSize), 10, 22),
    explorerScale: clampNumber(Number(settingsDialog.explorerScale), 0.82, 1.35),
    graphInverseNavigation: settingsDialog.graphInverseNavigation,
    graphShowOverflowLabels: settingsDialog.graphShowOverflowLabels,
    ontologyDiscoveryPrompt: settingsDialog.ontologyDiscoveryPrompt,
    shortcutBindings: settingsDialog.shortcutBindings,
    exploreIndexSearchOnEnter: settingsDialog.exploreIndexSearchOnEnter,
    indexUpdateStrategy: settingsDialog.indexUpdateStrategy,
    agentCommands: settingsDialog.agentCommands,
    defaultAgentCommandId: settingsDialog.defaultAgentCommandId,
    agentInvocationPrompt: settingsDialog.agentInvocationPrompt,
  };
}
