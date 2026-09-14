import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveWorkspaceRegistryPath, resolveWorkspaceSettingsPath, saveWorkspaceSettings, type WorkspaceSettings } from "@exograph/core";
import { WorkspaceConfigConflictError, WorkspaceConfigStore } from "./workspace-config-store";

const paths: string[] = [];
afterEach(async () => Promise.all(paths.splice(0).map((target) => rm(target, { recursive: true, force: true }))));

describe("WorkspaceConfigStore", () => {
  it("owns serialized revision-checked patches while preserving unknown settings", async () => {
    const userDataPath = await mkdtemp(path.join(os.tmpdir(), "exograph-config-"));
    paths.push(userDataPath);
    await saveWorkspaceSettings({ ...settings(), futureSetting: { local: true } } as WorkspaceSettings, { EXOGRAPH_USER_DATA_PATH: userDataPath });
    const first = new WorkspaceConfigStore({ userDataPath, env: {} });
    const second = new WorkspaceConfigStore({ userDataPath, env: {} });
    const loaded = await first.load();
    const saved = await first.patch(loaded!.revision, { appearanceMode: "dark" });
    await expect(second.patch(loaded!.revision, { terminalFontSize: 18 })).rejects.toBeInstanceOf(WorkspaceConfigConflictError);
    expect(saved.settings).toMatchObject({ appearanceMode: "dark", futureSetting: { local: true } });
  });

  it("surfaces unsupported pre-launch settings without logging or rewriting them", async () => {
    const userDataPath = await mkdtemp(path.join(os.tmpdir(), "exograph-config-unsupported-"));
    paths.push(userDataPath);
    const env = { EXOGRAPH_USER_DATA_PATH: userDataPath };
    const unsupportedJson = JSON.stringify({ ...settings(), projectRoots: ["/old/project"], futureSetting: { preserved: true } });
    await writeFile(resolveWorkspaceSettingsPath(env), unsupportedJson);

    const store = new WorkspaceConfigStore({ userDataPath, env: {} });
    await expect(store.load()).rejects.toThrow("unsupported pre-launch format");
    expect(await readFile(resolveWorkspaceSettingsPath(env), "utf8")).toBe(unsupportedJson);
    await expect(readFile(resolveWorkspaceRegistryPath(env), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("requires visible onboarding when direct settings are missing even if the registry survives", async () => {
    const userDataPath = await mkdtemp(path.join(os.tmpdir(), "exograph-config-missing-active-"));
    paths.push(userDataPath);
    const env = { EXOGRAPH_USER_DATA_PATH: userDataPath };
    await saveWorkspaceSettings(settings(), env);
    await rm(resolveWorkspaceSettingsPath(env));

    const store = new WorkspaceConfigStore({ userDataPath, env: {} });

    await expect(store.load()).resolves.toBeNull();
    await expect(store.listWorkspaces()).resolves.toHaveLength(1);
    await expect(store.patch(null, { ...settings(), workspaceRoot: "/replacement", noteRoots: ["/replacement"] }))
      .resolves.toMatchObject({ settings: { workspaceRoot: "/replacement", noteRoots: ["/replacement"] } });
  });

  it("requires visible onboarding when direct settings are invalid even if the registry survives", async () => {
    const userDataPath = await mkdtemp(path.join(os.tmpdir(), "exograph-config-invalid-active-"));
    paths.push(userDataPath);
    const env = { EXOGRAPH_USER_DATA_PATH: userDataPath };
    await saveWorkspaceSettings(settings(), env);
    await writeFile(resolveWorkspaceSettingsPath(env), "{ invalid", "utf8");

    const store = new WorkspaceConfigStore({ userDataPath, env: {} });

    await expect(store.load()).resolves.toBeNull();
    await expect(store.listWorkspaces()).resolves.toHaveLength(1);
    await expect(store.patch(null, { ...settings(), workspaceRoot: "/replacement", noteRoots: ["/replacement"] }))
      .resolves.toMatchObject({ settings: { workspaceRoot: "/replacement", noteRoots: ["/replacement"] } });
  });
});

function settings(): WorkspaceSettings {
  return { workspaceRoot: "/workspace", defaultTerminalCwd: "/workspace", noteRoots: ["/workspace/notes"], indexedRoots: [], indexing: { enabled: false, mode: "off", backend: "qmd" }, appearanceMode: "system", colorThemeId: "exograph-neutral", editorFontSize: 15, terminalFontSize: 13, explorerScale: 1, graphInverseNavigation: true, graphShowOverflowLabels: true, exploreIndexSearchOnEnter: false, indexUpdateStrategy: "on-save" };
}
