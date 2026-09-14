import type { WorkspaceSettings } from "@exograph/core";
import { normalizeWorkspaceContentPolicy } from "@exograph/core/workspace-content-policy";
import {
  DEFAULT_TERMINAL_PENDING_HYDRATION_CHARS as CORE_DEFAULT_TERMINAL_PENDING_HYDRATION_CHARS,
  DEFAULT_TERMINAL_SCROLLBACK_LINES,
} from "@exograph/core/terminal-settings";

import { defaultIndexedRoot, type WorkspaceSettingsDialogState } from "./workspaceSettingsDialogTypes";

export const DEFAULT_TERMINAL_RUNTIME_SCROLLBACK_LINES = DEFAULT_TERMINAL_SCROLLBACK_LINES;
export const DEFAULT_TERMINAL_PENDING_HYDRATION_CHARS = CORE_DEFAULT_TERMINAL_PENDING_HYDRATION_CHARS;
export const DEFAULT_EDITOR_FONT_SIZE = 15;
export const DEFAULT_TERMINAL_FONT_SIZE = 13;
export const DEFAULT_EXPLORER_SCALE = 1;

export function workspaceSettingsImmediateDraftKey(settings: WorkspaceSettingsDialogState): string {
  return JSON.stringify({
    publishing: settings.publishing,
    appearanceMode: settings.appearanceMode,
    colorThemeId: settings.colorThemeId,
    editorFontSize: settings.editorFontSize,
    terminalFontSize: settings.terminalFontSize,
    explorerScale: settings.explorerScale,
    graphInverseNavigation: settings.graphInverseNavigation,
    graphShowOverflowLabels: settings.graphShowOverflowLabels,
    ontologyDiscoveryPrompt: settings.ontologyDiscoveryPrompt,
    shortcutBindings: settings.shortcutBindings,
    exploreIndexSearchOnEnter: settings.exploreIndexSearchOnEnter,
    indexUpdateStrategy: settings.indexUpdateStrategy,
    agentCommands: settings.agentCommands,
    defaultAgentCommandId: settings.defaultAgentCommandId,
    agentInvocationPrompt: settings.agentInvocationPrompt,
  });
}

export function workspaceSettingsStructuralDraftKey(settings: WorkspaceSettingsDialogState): string {
  return JSON.stringify({
    workspaceRoot: settings.workspaceRoot,
    defaultTerminalCwd: settings.defaultTerminalCwd,
    noteRoots: settings.noteRoots,
    indexedRoots: settings.indexedRoots.map(indexedRootStructuralKey),
    contentPolicy: normalizeWorkspaceContentPolicy(settings.contentPolicy),
    indexMode: settings.indexMode,
    searchEngine: settings.searchEngine,
  });
}

export function workspaceSettingsStructuralKeyFromSettings(settings: WorkspaceSettings): string {
  return JSON.stringify({
    workspaceRoot: settings.workspaceRoot,
    defaultTerminalCwd: settings.defaultTerminalCwd,
    noteRoots: settings.noteRoots,
    indexedRoots: settings.indexedRoots.map(indexedRootStructuralKey),
    contentPolicy: normalizeWorkspaceContentPolicy(settings.contentPolicy),
    indexMode: settings.indexing.mode,
    searchEngine: settings.searchEngine ?? (settings.indexing.enabled && settings.indexing.mode !== "off" && settings.indexedRoots.length > 0 ? "qmd" : "filesystem"),
  });
}

export function workspaceSettingsStructuralDraftFromSettings(
  settings: WorkspaceSettings,
): Pick<
  WorkspaceSettingsDialogState,
  "workspaceRoot" | "defaultTerminalCwd" | "noteRoots" | "indexedRoots" | "contentPolicy" | "indexMode" | "searchEngine"
> {
  return {
    workspaceRoot: settings.workspaceRoot,
    defaultTerminalCwd: settings.defaultTerminalCwd,
    noteRoots: [...settings.noteRoots],
    indexedRoots: settings.indexedRoots.map((root) => ({ ...root, ignore: [...root.ignore] })),
    contentPolicy: normalizeWorkspaceContentPolicy(settings.contentPolicy),
    indexMode: settings.indexing.mode,
    searchEngine: settings.searchEngine
      ?? (settings.indexing.enabled && settings.indexing.mode !== "off" && settings.indexedRoots.length > 0 ? "qmd" : "filesystem"),
  };
}

export function selectWorkspaceSettingsSearchEngine(
  settings: WorkspaceSettingsDialogState,
  searchEngine: WorkspaceSettingsDialogState["searchEngine"],
): WorkspaceSettingsDialogState {
  const enablingQmd = searchEngine === "qmd";
  const needsDefaultRoots = enablingQmd && settings.indexedRoots.length === 0;
  return {
    ...settings,
    searchEngine,
    ...(enablingQmd && settings.indexMode === "off" ? { indexMode: "lexical" as const } : {}),
    ...(needsDefaultRoots
      ? { indexedRoots: settings.noteRoots.map(defaultIndexedRoot) }
      : {}),
    applyStatus: "idle",
    applyErrorMessage: null,
  };
}

export function resolveSettingsTerminalRuntime(_settings: WorkspaceSettings): { readTailChars: number; scrollbackLines: number } {
  return {
    readTailChars: DEFAULT_TERMINAL_PENDING_HYDRATION_CHARS,
    scrollbackLines: DEFAULT_TERMINAL_RUNTIME_SCROLLBACK_LINES,
  };
}

export function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, value));
}

function indexedRootStructuralKey(root: WorkspaceSettings["indexedRoots"][number]) {
  return {
    id: root.id,
    label: root.label,
    path: root.path,
    kind: root.kind,
    pattern: root.pattern,
    ignore: root.ignore,
    backend: root.backend,
  };
}
