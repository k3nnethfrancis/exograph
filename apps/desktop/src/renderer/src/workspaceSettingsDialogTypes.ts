import type { AgentCommand, IndexedRoot, SearchEngine, WorkspaceContentPolicy, WorkspaceSettings, WorkspaceSettingsRevision, WorkspaceShortcutBindings } from "@exograph/core";

import type { AppearanceMode } from "./appearance";
import type { ColorThemeId } from "./theme/types";
import type { WorkspaceSettingsSection } from "../../shared/api";

export type { WorkspaceSettingsSection };

export type IndexBusyState = "syncing" | "updating" | "embedding" | null;

export function defaultIndexedRoot(path: string, index: number): IndexedRoot {
  const trimmedPath = path.trim();
  return {
    id: `index-root-${index + 1}`,
    label: trimmedPath.split(/[\\/]/).filter(Boolean).at(-1) ?? "root",
    path: trimmedPath,
    kind: "mixed",
    pattern: "**/*.md",
    ignore: [],
    backend: "qmd",
  };
}

export interface WorkspaceSettingsDialogState {
  publishing?: WorkspaceSettings["publishing"];
  section: WorkspaceSettingsSection;
  settingsRevision: WorkspaceSettingsRevision;
  workspaceRoot: string;
  defaultTerminalCwd: string;
  noteRoots: string[];
  indexedRoots: IndexedRoot[];
  contentPolicy?: WorkspaceContentPolicy;
  indexMode: WorkspaceSettings["indexing"]["mode"];
  searchEngine: SearchEngine;
  appearanceMode: AppearanceMode;
  colorThemeId: ColorThemeId;
  editorFontSize: string;
  terminalFontSize: string;
  explorerScale: string;
  graphInverseNavigation: boolean;
  graphShowOverflowLabels: boolean;
  ontologyDiscoveryPrompt?: string;
  shortcutBindings?: WorkspaceShortcutBindings;
  exploreIndexSearchOnEnter: boolean;
  indexUpdateStrategy: WorkspaceSettings["indexUpdateStrategy"];
  agentCommands: AgentCommand[];
  defaultAgentCommandId?: string;
  agentInvocationPrompt?: string;
  saveStatus: "idle" | "saving" | "saved" | "error";
  errorMessage: string | null;
  appliedWorkspaceKey: string;
  applyStatus: "idle" | "applying" | "applied" | "error";
  applyErrorMessage: string | null;
}
