import { describe, expect, it } from "vitest";

import type { WorkspaceSettings } from "@exograph/core";

import { planWorkspaceSettingsApply } from "./workspace-settings-apply-plan";

describe("planWorkspaceSettingsApply", () => {
  it.each([
    ["workspace root", (settings: WorkspaceSettings) => ({ ...settings, workspaceRoot: "/other" })],
    ["note roots", (settings: WorkspaceSettings) => ({ ...settings, noteRoots: ["/workspace/other"] })],
  ])("reactivates Workspace authority for %s changes", (_label, change) => {
    const previous = settings();
    expect(planWorkspaceSettingsApply(previous, change(previous))).toMatchObject({
      reactivateWorkspace: true,
    });
  });

  it.each([
    ["indexed roots", (settings: WorkspaceSettings) => ({ ...settings, indexedRoots: [] })],
    ["indexing configuration", (settings: WorkspaceSettings) => ({
      ...settings,
      indexing: { enabled: false, mode: "off" as const, backend: "qmd" as const },
    })],
    ["search engine", (settings: WorkspaceSettings) => ({ ...settings, searchEngine: "filesystem" as const })],
  ])("rebinds only the index owner for %s changes", (_label, change) => {
    const previous = settings();
    expect(planWorkspaceSettingsApply(previous, change(previous))).toEqual({
      reactivateWorkspace: false,
      rebindIndex: true,
      updateIndexPolicy: false,
      updateTerminalDefault: false,
    });
  });

  it("updates terminal and index policy through their existing owners", () => {
    const previous = settings();
    expect(planWorkspaceSettingsApply(previous, {
      ...previous,
      defaultTerminalCwd: "/workspace/other",
      indexUpdateStrategy: "manual",
    })).toEqual({
      reactivateWorkspace: false,
      rebindIndex: false,
      updateIndexPolicy: true,
      updateTerminalDefault: true,
    });
  });

  it("rebuilds derived Workspace owners when content scope changes", () => {
    const previous = settings();
    expect(planWorkspaceSettingsApply(previous, {
      ...previous,
      contentPolicy: { excludedPaths: ["release/**"], sourceVisibility: false },
    })).toEqual({
      reactivateWorkspace: true,
      rebindIndex: true,
      updateIndexPolicy: false,
      updateTerminalDefault: false,
    });
  });

  it.each([
    ["no-op", (settings: WorkspaceSettings) => ({ ...settings })],
    ["layout", (settings: WorkspaceSettings) => ({
      ...settings,
      layout: {
        version: 3 as const,
        canvas: {
          kind: "leaf" as const,
          id: "editor",
          content: { kind: "editor" as const, openPaths: [], activePath: null },
        },
        sidebarCollapsed: false,
        sidebarWidth: 280,
        utilityWidth: 360,
      },
    })],
    ["appearance", (settings: WorkspaceSettings) => ({ ...settings, appearanceMode: "dark" as const })],
    ["agent prompt", (settings: WorkspaceSettings) => ({ ...settings, agentInvocationPrompt: "custom" })],
    ["unknown forward-compatible key", (settings: WorkspaceSettings) => ({ ...settings, futureSetting: true })],
  ])("publishes %s changes without restarting a runtime owner", (_label, change) => {
    const previous = settings();
    expect(planWorkspaceSettingsApply(previous, change(previous))).toEqual({
      reactivateWorkspace: false,
      rebindIndex: false,
      updateIndexPolicy: false,
      updateTerminalDefault: false,
    });
  });
});

function settings(): WorkspaceSettings {
  return {
    workspaceRoot: "/workspace",
    defaultTerminalCwd: "/workspace",
    noteRoots: ["/workspace/notes"],
    indexedRoots: [{
      id: "notes",
      label: "Notes",
      path: "/workspace/notes",
      kind: "notes",
      pattern: "**/*.md",
      ignore: [],
      backend: "qmd",
    }],
    indexing: { enabled: true, mode: "hybrid", backend: "qmd" },
    searchEngine: "qmd",
    appearanceMode: "system",
    colorThemeId: "exograph-neutral",
    editorFontSize: 15,
    terminalFontSize: 13,
    explorerScale: 1,
    graphInverseNavigation: true,
    graphShowOverflowLabels: true,
    exploreIndexSearchOnEnter: true,
    indexUpdateStrategy: "on-save",
  };
}
