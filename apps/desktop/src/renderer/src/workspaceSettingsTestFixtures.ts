import type { WorkspaceSettingsDialogState } from "./workspaceSettingsDialogTypes";

export function workspaceSettingsDialogFixture(
  overrides: Partial<WorkspaceSettingsDialogState> = {},
): WorkspaceSettingsDialogState {
  return {
    section: "workspace",
    settingsRevision: null,
    workspaceRoot: "/workspace",
    defaultTerminalCwd: "/workspace",
    noteRoots: ["/workspace/notes"],
    indexedRoots: [],
    indexMode: "off",
    searchEngine: "filesystem",
    appearanceMode: "system",
    colorThemeId: "exograph-neutral",
    editorFontSize: "15",
    terminalFontSize: "13",
    explorerScale: "1",
    graphInverseNavigation: true,
    graphShowOverflowLabels: true,
    shortcutBindings: {},
    exploreIndexSearchOnEnter: false,
    indexUpdateStrategy: "on-save",
    agentCommands: [],
    defaultAgentCommandId: undefined,
    saveStatus: "idle",
    errorMessage: null,
    appliedWorkspaceKey: "",
    applyStatus: "idle",
    applyErrorMessage: null,
    ...overrides,
  };
}
