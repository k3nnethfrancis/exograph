import { describe, expect, it } from "vitest";

import type { WorkspaceModel, WorkspaceSettings } from "@exograph/core";

import { WorkspaceRuntimeCoordinator } from "./workspace-runtime-coordinator";

describe("WorkspaceRuntimeCoordinator", () => {
  it("recovers and rebinds a destination before one final active-scope commit", async () => {
    const events: string[] = [];
    const destination = settings("/destination");
    let finishRecovery!: () => void;
    const recovery = new Promise<void>((resolve) => { finishRecovery = resolve; });
    const coordinator = coordinatorFor(events, {
      recoverInvocations: async (candidate) => {
        events.push(`recover:${candidate.settings.workspaceRoot}`);
        await recovery;
        events.push("recovered");
      },
    });

    const activating = coordinator.activate(request(destination));

    await Promise.resolve();
    expect(events).toEqual(["recover:/destination"]);
    expect(coordinator.current()).toBeNull();
    // The desktop composition root creates the renderer only after this
    // activation resolves; publishing is therefore the test seam for visible
    // startup state.
    expect(events.some((event) => event.startsWith("publish:"))).toBe(false);

    finishRecovery();
    await expect(activating).resolves.toMatchObject({
      status: "applied",
      active: { settings: destination, revision: "destination-revision", runtimeRoot: "/destination/.exograph" },
    });
    expect(events).toEqual([
      "recover:/destination",
      "recovered",
      "prepare:/destination",
      "stage-commands:/destination",
      "stage-watcher:/destination",
      "commit-commands:/destination",
      "publish:/destination:destination-revision",
      "commit-watcher:/destination",
      "invalidate:/destination",
      "terminal:/destination",
      "index:workspace-switch:/source:/destination",
    ]);
  });

  it("does not let a recovered older request publish over a newer destination", async () => {
    const events: string[] = [];
    let finishSourceRecovery!: () => void;
    const sourceRecovery = new Promise<void>((resolve) => { finishSourceRecovery = resolve; });
    const coordinator = coordinatorFor(events, {
      recoverInvocations: async (candidate) => {
        events.push(`recover:${candidate.settings.workspaceRoot}`);
        if (candidate.settings.workspaceRoot === "/source") await sourceRecovery;
      },
    });

    const source = coordinator.activate(request(settings("/source"), "settings-apply"));
    await Promise.resolve();
    const destination = coordinator.activate(request(settings("/destination")));

    await expect(destination).resolves.toMatchObject({ status: "applied", active: { model: { workspaceRoot: "/destination" } } });
    finishSourceRecovery();
    await expect(source).resolves.toEqual({ status: "superseded" });

    expect(events.filter((event) => event.startsWith("publish:"))).toEqual(["publish:/destination:destination-revision"]);
    expect(coordinator.current()).toMatchObject({ model: { workspaceRoot: "/destination" } });
  });

  it("traces A to B to A without any stale active scope surviving the return", async () => {
    const events: string[] = [];
    const coordinator = coordinatorFor(events);
    const workspaceA = settings("/workspace-a");
    const workspaceB = settings("/workspace-b");

    await coordinator.activate(request(workspaceA, "startup"));
    await coordinator.activate(request(workspaceB));
    await coordinator.activate(request(workspaceA));

    expect(coordinator.current()).toMatchObject({
      settings: { workspaceRoot: "/workspace-a" },
      model: { workspaceRoot: "/workspace-a" },
      runtimeRoot: "/workspace-a/.exograph",
    });
    expect(events.filter((event) => event.startsWith("publish:"))).toEqual([
      "publish:/workspace-a:destination-revision",
      "publish:/workspace-b:destination-revision",
      "publish:/workspace-a:destination-revision",
    ]);
    expect(events.filter((event) => event.startsWith("terminal:"))).toEqual([
      "terminal:/workspace-a",
      "terminal:/workspace-b",
      "terminal:/workspace-a",
    ]);
  });

  it("preserves a null operator-startup revision for the first settings save", async () => {
    const events: string[] = [];
    const coordinator = coordinatorFor(events);

    await expect(coordinator.activate({
      ...request(settings("/operator"), "startup"),
      revision: null,
    })).resolves.toMatchObject({ status: "applied", active: { revision: null } });
    expect(coordinator.current()?.revision).toBeNull();
    expect(events).toContain("publish:/operator:null");
  });

  it("publishes non-structural settings without replacing Workspace resources", async () => {
    const events: string[] = [];
    const coordinator = coordinatorFor(events);
    const workspace = settings("/workspace");
    await coordinator.activate(request(workspace, "startup"));
    events.length = 0;

    const next = {
      ...workspace,
      appearanceMode: "dark" as const,
      indexUpdateStrategy: "manual" as const,
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
    };
    expect(coordinator.applySettings({
      previousSettings: workspace,
      settings: next,
      revision: "settings-revision",
    })).toBe(true);

    expect(coordinator.current()).toMatchObject({
      settings: next,
      revision: "settings-revision",
      model: { workspaceRoot: "/workspace" },
    });
    expect(events).toEqual([
      "publish:/workspace:settings-revision",
      "settings:/workspace:/workspace",
    ]);
  });

  it("refuses in-place publication when Workspace authority changes", async () => {
    const events: string[] = [];
    const coordinator = coordinatorFor(events);
    const source = settings("/source");
    await coordinator.activate(request(source, "startup"));
    events.length = 0;

    expect(coordinator.applySettings({
      previousSettings: source,
      settings: settings("/destination"),
      revision: "settings-revision",
    })).toBe(false);
    expect(coordinator.current()).toMatchObject({ model: { workspaceRoot: "/source" } });
    expect(events).toEqual([]);
  });

  it("keeps degraded runtime settings on the repair path", async () => {
    const events: string[] = [];
    const coordinator = coordinatorFor(events);
    const workspace = settings("/workspace");
    await coordinator.activate(request(workspace, "startup"));
    expect(coordinator.reportLateRuntimeFailure(1, "watcher", "watcher failed")).toBe(true);
    events.length = 0;

    expect(coordinator.applySettings({
      previousSettings: workspace,
      settings: { ...workspace, appearanceMode: "dark" },
      revision: "settings-revision",
    })).toBe(false);
    expect(events).toEqual([]);
    expect(coordinator.status()).toMatchObject({ status: "degraded", errorMessage: "watcher failed" });
  });

  it("keeps A's runtime intact when B watcher preparation fails", async () => {
    const events: string[] = [];
    let publishedWorkspace: string | null = null;
    let watcherWorkspace: string | null = null;
    let terminalCwd: string | null = null;
    let indexedWorkspace: string | null = null;
    let commandDiscoveryWorkspace: string | null = null;
    const coordinator = coordinatorFor(events, {
      publishActive: (active) => { publishedWorkspace = active.settings.workspaceRoot; },
      stageCommandServer: async (candidate) => ({
        commit: () => { commandDiscoveryWorkspace = candidate.settings.workspaceRoot; },
        abort: async () => {},
      }),
      stageWatcher: async (candidate) => {
        if (candidate.settings.workspaceRoot === "/destination") {
          events.push("stage-watcher-failed");
          throw new Error("watch setup failed");
        }
        return {
          commit: () => { watcherWorkspace = candidate.settings.workspaceRoot; },
          abort: () => {},
        };
      },
      setTerminalDefaultCwd: (candidate) => { terminalCwd = candidate.model.defaultTerminalCwd; },
      reconcileIndex: (_previous, candidate) => { indexedWorkspace = candidate.settings.workspaceRoot; },
    });

    await expect(coordinator.activate(request(settings("/source"), "startup"))).resolves.toMatchObject({
      status: "applied",
      active: { settings: { workspaceRoot: "/source" } },
    });
    expect({ publishedWorkspace, watcherWorkspace, terminalCwd, indexedWorkspace, commandDiscoveryWorkspace }).toEqual({
      publishedWorkspace: "/source",
      watcherWorkspace: "/source",
      terminalCwd: "/source",
      indexedWorkspace: "/source",
      commandDiscoveryWorkspace: "/source",
    });
    events.length = 0;

    const outcome = await coordinator.activate(request(settings("/destination")));

    expect(outcome).toMatchObject({
      status: "failed",
      phase: "watcher",
      errorMessage: "watch setup failed",
      active: { settings: { workspaceRoot: "/source" } },
    });
    expect(coordinator.current()).toMatchObject({ settings: { workspaceRoot: "/source" } });
    expect(coordinator.status()).toMatchObject({
      status: "degraded",
      active: { settings: { workspaceRoot: "/source" } },
      phase: "watcher",
    });
    expect(events).not.toContain("publish:/destination:destination-revision");
    expect(events).not.toContain("commit-watcher:/destination");
    expect(events).not.toContain("terminal:/destination");
    expect(events).not.toContain("index:workspace-switch:/source:/destination");
    expect({ publishedWorkspace, watcherWorkspace, terminalCwd, indexedWorkspace, commandDiscoveryWorkspace }).toEqual({
      publishedWorkspace: "/source",
      watcherWorkspace: "/source",
      terminalCwd: "/source",
      indexedWorkspace: "/source",
      commandDiscoveryWorkspace: "/source",
    });
  });

  it("reports committed-degraded rather than falsely restoring A after discovery commits", async () => {
    const events: string[] = [];
    const coordinator = coordinatorFor(events, {
      invalidateDerivedState: () => { throw new Error("derived refresh failed"); },
    });

    await expect(coordinator.activate(request(settings("/destination")))).resolves.toMatchObject({
      status: "committed-degraded",
      active: { settings: { workspaceRoot: "/destination" } },
      errorMessage: "derived refresh failed",
    });
    expect(coordinator.current()).toMatchObject({ settings: { workspaceRoot: "/destination" } });
    expect(coordinator.status()).toMatchObject({
      status: "degraded",
      active: { settings: { workspaceRoot: "/destination" } },
      phase: "post-commit",
    });
    expect(events).toContain("commit-commands:/destination");
    expect(events).toContain("publish:/destination:destination-revision");
  });

  it("records a late watcher failure only for the active generation", async () => {
    const events: string[] = [];
    const coordinator = coordinatorFor(events);
    const workspaceA = settings("/workspace-a");
    const workspaceB = settings("/workspace-b");

    await coordinator.activate(request(workspaceA, "startup"));
    expect(coordinator.reportLateRuntimeFailure(1, "watcher", "A watcher failed")).toBe(true);
    expect(coordinator.status()).toMatchObject({
      status: "degraded",
      active: { settings: { workspaceRoot: "/workspace-a" } },
      phase: "watcher",
      errorMessage: "A watcher failed",
    });

    await coordinator.activate(request(workspaceB));
    expect(coordinator.reportLateRuntimeFailure(1, "watcher", "stale A watcher failed")).toBe(false);
    expect(coordinator.status()).toMatchObject({
      status: "active",
      active: { settings: { workspaceRoot: "/workspace-b" } },
    });
  });

  it("keeps A's watcher health report valid after a failed B candidate", async () => {
    const events: string[] = [];
    const coordinator = coordinatorFor(events, {
      prepareNoteRoots: async (candidate) => {
        if (candidate.settings.workspaceRoot === "/workspace-b") {
          throw new Error("B note roots are unavailable");
        }
        events.push(`prepare:${candidate.model.workspaceRoot}`);
      },
    });

    await coordinator.activate(request(settings("/workspace-a"), "startup"));
    await expect(coordinator.activate(request(settings("/workspace-b")))).resolves.toMatchObject({
      status: "failed",
      phase: "note-roots",
      active: { settings: { workspaceRoot: "/workspace-a" } },
    });

    expect(coordinator.reportLateRuntimeFailure(2, "watcher", "aborted B watcher failed")).toBe(false);
    expect(coordinator.reportLateRuntimeFailure(1, "watcher", "A watcher failed after B aborted")).toBe(true);
    expect(coordinator.status()).toMatchObject({
      status: "degraded",
      active: { settings: { workspaceRoot: "/workspace-a" } },
      errorMessage: "A watcher failed after B aborted",
    });
  });
});

function coordinatorFor(
  events: string[],
  overrides: Partial<ConstructorParameters<typeof WorkspaceRuntimeCoordinator>[0]> = {},
): WorkspaceRuntimeCoordinator {
  return new WorkspaceRuntimeCoordinator({
    runtimeRootFor: (settings) => `${settings.workspaceRoot}/.exograph`,
    recoverInvocations: async (candidate) => { events.push(`recover:${candidate.settings.workspaceRoot}`); },
    modelFromSettings: (settings) => model(settings.workspaceRoot),
    prepareNoteRoots: async (candidate) => { events.push(`prepare:${candidate.model.workspaceRoot}`); },
    stageCommandServer: async (candidate) => {
      events.push(`stage-commands:${candidate.settings.workspaceRoot}`);
      return {
        commit: () => { events.push(`commit-commands:${candidate.settings.workspaceRoot}`); },
        abort: async () => { events.push(`abort-commands:${candidate.settings.workspaceRoot}`); },
      };
    },
    stageWatcher: async (candidate) => {
      events.push(`stage-watcher:${candidate.settings.workspaceRoot}`);
      return {
        commit: () => { events.push(`commit-watcher:${candidate.settings.workspaceRoot}`); },
        abort: () => { events.push(`abort-watcher:${candidate.settings.workspaceRoot}`); },
      };
    },
    invalidateDerivedState: (candidate) => { events.push(`invalidate:${candidate.model.workspaceRoot}`); },
    setTerminalDefaultCwd: (candidate) => { events.push(`terminal:${candidate.model.defaultTerminalCwd}`); },
    reconcileIndex: (previous, candidate, reason) => { events.push(`index:${reason}:${previous.workspaceRoot}:${candidate.settings.workspaceRoot}`); },
    applySettingsInPlace: (previous, active) => { events.push(`settings:${previous.workspaceRoot}:${active.settings.workspaceRoot}`); },
    publishActive: (active) => { events.push(`publish:${active.settings.workspaceRoot}:${active.revision}`); },
    ...overrides,
  });
}

function request(settingsValue: WorkspaceSettings, reason: "startup" | "settings-apply" | "workspace-switch" = "workspace-switch") {
  return {
    previousSettings: settings("/source"),
    settings: settingsValue,
    revision: "destination-revision",
    reason,
  } as const;
}

function settings(workspaceRoot: string): WorkspaceSettings {
  return {
    workspaceRoot,
    defaultTerminalCwd: workspaceRoot,
    noteRoots: [`${workspaceRoot}/notes`],
    indexedRoots: [],
    indexing: { enabled: false, mode: "off", backend: "qmd" },
    searchEngine: "filesystem",
    appearanceMode: "system",
    colorThemeId: "exograph-neutral",
    editorFontSize: 15,
    terminalFontSize: 13,
    explorerScale: 1,
    graphInverseNavigation: true,
    graphShowOverflowLabels: true,
    exploreIndexSearchOnEnter: false,
    indexUpdateStrategy: "on-save",
  };
}

function model(workspaceRoot: string): WorkspaceModel {
  return {
    workspaceRoot,
    defaultTerminalCwd: workspaceRoot,
    noteRoots: [{ id: "notes", label: "Notes", path: `${workspaceRoot}/notes` }],
    indexedRoots: [],
    indexing: { enabled: false, mode: "off", backend: "qmd" },
    searchEngine: "filesystem",
  };
}
