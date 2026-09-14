import { access, chmod, mkdir, mkdtemp, open, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { createDefaultClaudeAgentCommand, createDefaultCodexAgentCommand } from "../agent-invocation";
import type { WorkspaceSettings } from "../types";
import {
  loadWorkspaceSettings,
  getWorkspaceRegistryEntry,
  listWorkspaceRegistryEntries,
  loadWorkspaceRegistry,
  loadActiveWorkspaceSettings,
  normalizeWorkspaceSettings,
  resolveWorkspaceRegistryPath,
  resolveWorkspaceSettingsPath,
  resolveWorkspaceSettingsTransactionPath,
  saveWorkspaceSettings,
  workspaceEnvOverrides,
  workspaceModelFromSettings,
} from "../workspace-settings";

it("resolves conventional profiles, with a legacy fallback until the desktop migrates", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "exo-profile-resolver-"));
  const spy = vi.spyOn(os, "homedir").mockReturnValue(home);
  const appData = process.platform === "darwin" ? path.join(home, "Library", "Application Support")
    : process.platform === "win32" ? path.join(home, "AppData", "Roaming") : path.join(home, ".config");
  const legacy = path.join(appData, "@exograph", "desktop");
  const current = path.join(appData, "Exograph");
  try {
    expect(resolveWorkspaceSettingsPath({})).toBe(path.join(current, "workspace-settings.json"));
    await mkdir(legacy, { recursive: true });
    expect(resolveWorkspaceSettingsPath({})).toBe(path.join(legacy, "workspace-settings.json"));
    await mkdir(current);
    expect(resolveWorkspaceSettingsPath({})).toBe(path.join(current, "workspace-settings.json"));
    expect(resolveWorkspaceSettingsPath({ EXOGRAPH_USER_DATA_PATH: "/custom" })).toBe(path.join("/custom", "workspace-settings.json"));
  } finally { spy.mockRestore(); await rm(home, { recursive: true, force: true }); }
});

describe("workspace settings registry", () => {
  it.each([
    [undefined, true],
    ["false", true],
    [null, true],
    [0, true],
    [false, false],
    [true, true],
  ])("normalizes overflow labels %j to %j", (value, expected) => {
    const { graphShowOverflowLabels: _preference, ...input } = workspaceSettingsFor("/tmp/exograph-graph-labels/notes");
    const raw = value === undefined ? input : { ...input, graphShowOverflowLabels: value };
    const settings = normalizeWorkspaceSettings(raw as Parameters<typeof normalizeWorkspaceSettings>[0]);
    expect(settings?.graphShowOverflowLabels).toBe(expected);
  });

  it("defaults inverse graph navigation on and preserves an explicit preference", () => {
    const defaults = normalizeWorkspaceSettings(workspaceSettingsFor("/tmp/exograph-graph-default/notes"));
    const direct = normalizeWorkspaceSettings({
      ...workspaceSettingsFor("/tmp/exograph-graph-direct/notes"),
      graphInverseNavigation: false,
    });

    expect(defaults?.graphInverseNavigation).toBe(true);
    expect(direct?.graphInverseNavigation).toBe(false);
  });

  it("stores only a meaningful Ontology discovery prompt override", () => {
    const customized = normalizeWorkspaceSettings({
      ...workspaceSettingsFor("/tmp/exograph-ontology-prompt/notes"),
      ontologyDiscoveryPrompt: "  Inspect this workspace carefully.  ",
    });
    const blank = normalizeWorkspaceSettings({
      ...workspaceSettingsFor("/tmp/exograph-ontology-prompt-default/notes"),
      ontologyDiscoveryPrompt: "   ",
    });

    expect(customized?.ontologyDiscoveryPrompt).toBe("Inspect this workspace carefully.");
    expect(blank?.ontologyDiscoveryPrompt).toBeUndefined();
  });

  it.each([
    ["project roots", { projectRoots: [] }],
    ["migration metadata", { migrationMetadata: { mainWiki: { retiredNoteRoots: ["/tmp/other"] } } }],
    ["retired terminal settings", { terminalHistoryLines: 5 }],
    ["multiple Note Roots", { noteRoots: ["/tmp/exograph-canonical/notes", "/tmp/exograph-canonical/other"] }],
    ["canvas v2 layout", { layout: { version: 2, canvas: { kind: "leaf", id: "editor", content: { kind: "editor", openPaths: [], activePath: null } } } }],
    ["two-zone layout", { layout: { editorTree: {}, terminalTree: {} } }],
    ["retired built-in Command", { agentCommands: [{ id: "claude", label: "Claude", handle: "claude", command: "claude -p", promptDelivery: "stdin" }] }],
  ])("rejects unsupported pre-launch %s instead of normalizing it", (_label, retiredPatch) => {
    expect(normalizeWorkspaceSettings({
      ...workspaceSettingsFor("/tmp/exograph-canonical/notes"),
      ...retiredPatch,
    } as unknown as Partial<WorkspaceSettings>)).toBeNull();
  });

  it("retains valid workspace shortcut overrides and discards unsupported shortcut shapes", () => {
    const settings = normalizeWorkspaceSettings({
      ...workspaceSettingsFor("/tmp/exograph-shortcuts/notes"),
      shortcutBindings: {
        "new-note": { code: "KeyK" },
        terminal: { code: "Enter", shift: true },
        save: { code: "Digit1" },
      },
    });

    expect(settings?.shortcutBindings).toEqual({
      "new-note": { code: "KeyK", shift: false, alt: false },
      terminal: { code: "Enter", shift: true, alt: false },
    });
  });

  it("retains the later full Indexed Root policy for an exact resolved-path duplicate", () => {
    const settings = normalizeWorkspaceSettings({
      workspaceRoot: "/tmp/exograph-indexed-root-dedupe",
      defaultTerminalCwd: "/tmp/exograph-indexed-root-dedupe",
      noteRoots: ["/tmp/exograph-indexed-root-dedupe/notes"],
      indexedRoots: [
        { id: "first", label: "First", path: "/tmp/exograph-indexed-root-dedupe/notes/shared", kind: "notes", pattern: "**/*.md", ignore: ["first/**"], backend: "qmd" },
        { id: "second", label: "Second", path: "/tmp/exograph-indexed-root-dedupe/notes/shared", kind: "code", pattern: "**/*.{ts,tsx}", ignore: ["second/**"], backend: "qmd" },
      ],
      indexing: { enabled: true, mode: "hybrid", backend: "qmd" },
    });

    expect(settings?.indexedRoots).toEqual([{
      id: "second",
      label: "Second",
      path: "/tmp/exograph-indexed-root-dedupe/notes/shared",
      kind: "code",
      pattern: "**/*.{ts,tsx}",
      ignore: ["second/**"],
      backend: "qmd",
    }]);
  });

  it("preserves survivor order when a later Indexed Root replaces an earlier path", () => {
    const settings = normalizeWorkspaceSettings({
      workspaceRoot: "/tmp/exograph-indexed-root-order",
      defaultTerminalCwd: "/tmp/exograph-indexed-root-order",
      noteRoots: ["/tmp/exograph-indexed-root-order/notes"],
      indexedRoots: [
        { id: "a", label: "A", path: "/tmp/exograph-indexed-root-order/notes/path-one", kind: "notes", pattern: "a/**/*.md", ignore: ["a/**"], backend: "qmd" },
        { id: "b", label: "B", path: "/tmp/exograph-indexed-root-order/notes/path-two", kind: "docs", pattern: "b/**/*.md", ignore: ["b/**"], backend: "qmd" },
        { id: "c", label: "C", path: "/tmp/exograph-indexed-root-order/notes/path-one", kind: "mixed", pattern: "c/**", ignore: ["c/**"], backend: "qmd" },
      ],
      indexing: { enabled: true, mode: "lexical", backend: "qmd" },
    });

    expect(settings?.indexedRoots).toEqual([
      { id: "b", label: "B", path: "/tmp/exograph-indexed-root-order/notes/path-two", kind: "docs", pattern: "b/**/*.md", ignore: ["b/**"], backend: "qmd" },
      { id: "c", label: "C", path: "/tmp/exograph-indexed-root-order/notes/path-one", kind: "mixed", pattern: "c/**", ignore: ["c/**"], backend: "qmd" },
    ]);
    expect(normalizeWorkspaceSettings(settings)).toEqual(settings);
  });

  it("migrates persisted duplicate Indexed Root paths once without rewriting stable settings", async () => {
    const userDataPath = await mkdtemp(path.join(os.tmpdir(), "exograph-core-indexed-root-dedupe-repair-"));
    const env = { EXOGRAPH_USER_DATA_PATH: userDataPath };
    const notesFolder = path.join(userDataPath, "notes");
    const pathOne = path.join(notesFolder, "path-one");
    const pathTwo = path.join(notesFolder, "path-two");
    const duplicateSettings = {
      ...workspaceSettingsFor(notesFolder),
      indexedRoots: [
        { id: "a", label: "A", path: pathOne, kind: "notes", pattern: "a/**/*.md", ignore: ["a/**"], backend: "qmd" },
        { id: "b", label: "B", path: pathTwo, kind: "docs", pattern: "b/**/*.md", ignore: ["b/**"], backend: "qmd" },
        { id: "c", label: "C", path: pathOne, kind: "code", pattern: "c/**/*.{ts,tsx}", ignore: ["c/**"], backend: "qmd" },
      ],
      indexing: { enabled: true, mode: "hybrid", backend: "qmd" },
    } satisfies Parameters<typeof saveWorkspaceSettings>[0];
    const expectedIndexedRoots = [
      { id: "b", label: "B", path: pathTwo, kind: "docs", pattern: "b/**/*.md", ignore: ["b/**"], backend: "qmd" },
      { id: "c", label: "C", path: pathOne, kind: "code", pattern: "c/**/*.{ts,tsx}", ignore: ["c/**"], backend: "qmd" },
    ];

    try {
      await saveWorkspaceSettings({ ...duplicateSettings, indexedRoots: [] }, env);
      const seededRegistry = JSON.parse(await readFile(resolveWorkspaceRegistryPath(env), "utf8")) as {
        activeWorkspaceId: string;
        workspaces: Array<{ settings: unknown; [key: string]: unknown }>;
      };
      seededRegistry.workspaces[0]!.settings = duplicateSettings;
      await writeFile(resolveWorkspaceSettingsPath(env), JSON.stringify(duplicateSettings), { mode: 0o600 });
      await writeFile(resolveWorkspaceRegistryPath(env), JSON.stringify(seededRegistry), { mode: 0o600 });

      await expect(loadWorkspaceSettings(env)).resolves.toMatchObject({ indexedRoots: expectedIndexedRoots });
      const settingsAfterMigration = await readFile(resolveWorkspaceSettingsPath(env), "utf8");
      const registryAfterMigration = await readFile(resolveWorkspaceRegistryPath(env), "utf8");
      expect(JSON.parse(settingsAfterMigration).indexedRoots).toEqual(expectedIndexedRoots);
      expect(JSON.parse(registryAfterMigration).workspaces[0].settings.indexedRoots).toEqual(expectedIndexedRoots);
      const settingsInode = (await stat(resolveWorkspaceSettingsPath(env))).ino;
      const registryInode = (await stat(resolveWorkspaceRegistryPath(env))).ino;

      await expect(loadWorkspaceSettings(env)).resolves.toMatchObject({ indexedRoots: [{ id: "b" }, { id: "c" }] });
      expect(await readFile(resolveWorkspaceSettingsPath(env), "utf8")).toBe(settingsAfterMigration);
      expect(await readFile(resolveWorkspaceRegistryPath(env), "utf8")).toBe(registryAfterMigration);
      expect((await stat(resolveWorkspaceSettingsPath(env))).ino).toBe(settingsInode);
      expect((await stat(resolveWorkspaceRegistryPath(env))).ino).toBe(registryInode);
    } finally {
      await rm(userDataPath, { recursive: true, force: true });
    }
  });

  it("keeps distinct real-path and symlink spellings as separate Indexed Roots", async () => {
    const userDataPath = await mkdtemp(path.join(os.tmpdir(), "exograph-core-indexed-root-lexical-alias-"));
    const realPath = path.join(userDataPath, "real-notes");
    const aliasPath = path.join(userDataPath, "alias-notes");

    try {
      await mkdir(realPath);
      await symlink(realPath, aliasPath, "dir");
      const settings = normalizeWorkspaceSettings({
        workspaceRoot: userDataPath,
        defaultTerminalCwd: userDataPath,
        noteRoots: [userDataPath],
        indexedRoots: [
          { id: "real", label: "Real", path: realPath, kind: "notes", pattern: "**/*.md", ignore: [], backend: "qmd" },
          { id: "alias", label: "Alias", path: aliasPath, kind: "notes", pattern: "**/*.md", ignore: [], backend: "qmd" },
        ],
        indexing: { enabled: true, mode: "lexical", backend: "qmd" },
      });

      expect(settings?.indexedRoots.map((root) => root.path)).toEqual([realPath, aliasPath]);
    } finally {
      await rm(userDataPath, { recursive: true, force: true });
    }
  });

  it("derives a search engine when one is not explicitly configured", () => {
    const base = {
      workspaceRoot: "/tmp/exograph-search-engine",
      defaultTerminalCwd: "/tmp/exograph-search-engine",
      noteRoots: ["/tmp/exograph-search-engine/notes"],
    };

    expect(normalizeWorkspaceSettings({
      ...base,
      indexedRoots: [{ id: "notes", label: "notes", path: "/tmp/exograph-search-engine/notes", kind: "notes", pattern: "**/*.md", ignore: [], backend: "qmd" }],
      indexing: { enabled: true, mode: "lexical", backend: "qmd" },
    })?.searchEngine).toBe("qmd");
    expect(normalizeWorkspaceSettings({
      ...base,
      indexedRoots: [],
      indexing: { enabled: false, mode: "off", backend: "qmd" },
    })?.searchEngine).toBe("filesystem");
  });

  it("retains QMD configuration when Simple search is selected", () => {
    const settings = normalizeWorkspaceSettings({
      workspaceRoot: "/tmp/exograph-search-engine",
      defaultTerminalCwd: "/tmp/exograph-search-engine",
      noteRoots: ["/tmp/exograph-search-engine/notes"],
      indexedRoots: [{ id: "notes", label: "notes", path: "/tmp/exograph-search-engine/notes", kind: "notes", pattern: "**/*.md", ignore: [], backend: "qmd" }],
      indexing: { enabled: true, mode: "hybrid", backend: "qmd" },
      searchEngine: "filesystem",
    });

    expect(settings).toMatchObject({
      searchEngine: "filesystem",
      indexing: { enabled: true, mode: "hybrid" },
      indexedRoots: [{ path: "/tmp/exograph-search-engine/notes" }],
    });
  });

  it.each([
    ["projectRoots", { projectRoots: ["/tmp/exograph-unsupported/project"] }],
    ["terminalHistoryLines", { terminalHistoryLines: 100_000 }],
    ["multiple noteRoots", { noteRoots: ["/tmp/exograph-unsupported/notes", "/tmp/exograph-unsupported/other"] }],
    ["canvas v2", { layout: { version: 2, canvas: { kind: "leaf", id: "editor", content: { kind: "editor", openPaths: [], activePath: null } } } }],
  ])("rejects persisted unsupported %s without rewriting settings or registry", async (_label, retiredPatch) => {
    const userDataPath = await mkdtemp(path.join(os.tmpdir(), "exograph-core-unsupported-settings-"));
    const env = { EXOGRAPH_USER_DATA_PATH: userDataPath };
    const unsupportedSettings = { ...workspaceSettingsFor("/tmp/exograph-unsupported/notes"), ...retiredPatch };
    const settingsJson = JSON.stringify(unsupportedSettings);
    const registryJson = JSON.stringify({ activeWorkspaceId: null, workspaces: [] });
    try {
      await writeFile(resolveWorkspaceSettingsPath(env), settingsJson, { mode: 0o600 });
      await writeFile(resolveWorkspaceRegistryPath(env), registryJson, { mode: 0o600 });

      await expect(loadWorkspaceSettings(env)).rejects.toThrow("unsupported pre-launch format");
      expect(await readFile(resolveWorkspaceSettingsPath(env), "utf8")).toBe(settingsJson);
      expect(await readFile(resolveWorkspaceRegistryPath(env), "utf8")).toBe(registryJson);
    } finally {
      await rm(userDataPath, { recursive: true, force: true });
    }
  });

  it("leaves an unsupported interrupted transaction intact instead of applying a partial rewrite", async () => {
    const userDataPath = await mkdtemp(path.join(os.tmpdir(), "exograph-core-unsupported-recovery-"));
    const env = { EXOGRAPH_USER_DATA_PATH: userDataPath };
    const unsupported = {
      ...workspaceSettingsFor("/tmp/exograph-unsupported-recovery/notes"),
      terminalHistoryLines: 5,
      futureSetting: { retained: true },
    };
    const transaction = {
      version: 1,
      settings: unsupported,
      registry: { activeWorkspaceId: "old", workspaces: [{ id: "old", label: "old", notesFolder: unsupported.noteRoots[0], settings: unsupported, updatedAt: "2026-07-12T00:00:00.000Z" }] },
    };
    const transactionJson = JSON.stringify(transaction);

    try {
      await writeFile(resolveWorkspaceSettingsTransactionPath(env), transactionJson, { mode: 0o600 });
      await expect(loadWorkspaceSettings(env)).rejects.toThrow("unsupported pre-launch format");
      expect(await readFile(resolveWorkspaceSettingsTransactionPath(env), "utf8")).toBe(transactionJson);
      await expect(access(resolveWorkspaceSettingsPath(env))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(access(resolveWorkspaceRegistryPath(env))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(userDataPath, { recursive: true, force: true });
    }
  });

  it("recovers a committed settings transaction after an interrupted registry write", async () => {
    const userDataPath = await mkdtemp(path.join(os.tmpdir(), "exograph-core-settings-recovery-"));
    const env = { EXOGRAPH_USER_DATA_PATH: userDataPath };
    const settings = normalizeWorkspaceSettings({
      workspaceRoot: "/tmp/exograph-recovery/notes",
      defaultTerminalCwd: "/tmp/exograph-recovery",
      noteRoots: ["/tmp/exograph-recovery/notes"],
      indexedRoots: [],
      indexing: { enabled: false, mode: "off", backend: "qmd" },
    });

    try {
      expect(settings).not.toBeNull();
      await saveWorkspaceSettings(settings!, env);
      const registry = JSON.parse(await readFile(resolveWorkspaceRegistryPath(env), "utf8")) as WorkspaceSettingsTransaction["registry"];
      const nextSettings = { ...settings!, appearanceMode: "dark" as const };
      const nextRegistry = {
        ...registry,
        workspaces: registry.workspaces.map((entry, index) =>
          index === 0 ? { ...entry, settings: nextSettings } : entry),
      };
      const transactionPath = resolveWorkspaceSettingsTransactionPath(env);
      await writeFile(transactionPath, JSON.stringify({ version: 1, settings: nextSettings, registry: nextRegistry }), { mode: 0o600 });
      await writeFile(resolveWorkspaceSettingsPath(env), JSON.stringify(nextSettings), { mode: 0o600 });

      await expect(loadActiveWorkspaceSettings(env)).resolves.toMatchObject({ appearanceMode: "dark" });

      const recoveredRegistry = JSON.parse(await readFile(resolveWorkspaceRegistryPath(env), "utf8")) as WorkspaceSettingsTransaction["registry"];
      expect(recoveredRegistry.workspaces[0]?.settings.appearanceMode).toBe("dark");
      await expect(access(transactionPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(userDataPath, { recursive: true, force: true });
    }
  });

  it("enforces private permissions on settings and registry files", async () => {
    const userDataPath = await mkdtemp(path.join(os.tmpdir(), "exograph-core-private-settings-"));
    const env = { EXOGRAPH_USER_DATA_PATH: userDataPath };
    const settings = normalizeWorkspaceSettings({
      workspaceRoot: "/tmp/exograph-private/notes",
      defaultTerminalCwd: "/tmp/exograph-private",
      noteRoots: ["/tmp/exograph-private/notes"],
      indexedRoots: [],
      indexing: { enabled: false, mode: "off", backend: "qmd" },
    });

    try {
      expect(settings).not.toBeNull();
      await saveWorkspaceSettings(settings!, env);
      await chmod(resolveWorkspaceSettingsPath(env), 0o666);
      await chmod(resolveWorkspaceRegistryPath(env), 0o666);

      await saveWorkspaceSettings({ ...settings!, appearanceMode: "dark" }, env);

      expect((await stat(resolveWorkspaceSettingsPath(env))).mode & 0o777).toBe(0o600);
      expect((await stat(resolveWorkspaceRegistryPath(env))).mode & 0o777).toBe(0o600);
    } finally {
      await rm(userDataPath, { recursive: true, force: true });
    }
  });

  it("atomically replaces the settings and registry files", async () => {
    const userDataPath = await mkdtemp(path.join(os.tmpdir(), "exograph-core-atomic-settings-"));
    const env = { EXOGRAPH_USER_DATA_PATH: userDataPath };
    const initial = normalizeWorkspaceSettings({
      workspaceRoot: "/tmp/exograph-atomic/notes",
      defaultTerminalCwd: "/tmp/exograph-atomic",
      noteRoots: ["/tmp/exograph-atomic/notes"],
      indexedRoots: [],
      indexing: { enabled: false, mode: "off", backend: "qmd" },
      appearanceMode: "system",
    });

    try {
      expect(initial).not.toBeNull();
      await saveWorkspaceSettings(initial!, env);
      const originalSettingsFile = await open(resolveWorkspaceSettingsPath(env), "r");
      const originalRegistryFile = await open(resolveWorkspaceRegistryPath(env), "r");

      try {
        await saveWorkspaceSettings({ ...initial!, appearanceMode: "dark" }, env);

        const originalSettings = JSON.parse(await originalSettingsFile.readFile("utf8")) as { appearanceMode: string };
        const currentSettings = JSON.parse(await readFile(resolveWorkspaceSettingsPath(env), "utf8")) as { appearanceMode: string };
        const originalRegistry = JSON.parse(await originalRegistryFile.readFile("utf8")) as WorkspaceRegistryAppearance;
        const currentRegistry = JSON.parse(await readFile(resolveWorkspaceRegistryPath(env), "utf8")) as WorkspaceRegistryAppearance;
        expect(originalSettings.appearanceMode).toBe("system");
        expect(currentSettings.appearanceMode).toBe("dark");
        expect(originalRegistry.workspaces[0]?.settings.appearanceMode).toBe("system");
        expect(currentRegistry.workspaces[0]?.settings.appearanceMode).toBe("dark");
      } finally {
        await Promise.all([originalSettingsFile.close(), originalRegistryFile.close()]);
      }
    } finally {
      await rm(userDataPath, { recursive: true, force: true });
    }
  });

  it("defaults missing color theme ids and normalizes unknown ids", () => {
    const missing = normalizeWorkspaceSettings({
      workspaceRoot: "/tmp/exograph-theme/notes",
      defaultTerminalCwd: "/tmp/exograph-theme/project",
      noteRoots: ["/tmp/exograph-theme/notes"],
      indexedRoots: [],
      indexing: { enabled: false, mode: "off", backend: "qmd" },
    });
    const unknown = normalizeWorkspaceSettings({
      workspaceRoot: "/tmp/exograph-theme/notes",
      defaultTerminalCwd: "/tmp/exograph-theme/project",
      noteRoots: ["/tmp/exograph-theme/notes"],
      indexedRoots: [],
      indexing: { enabled: false, mode: "off", backend: "qmd" },
      colorThemeId: "unknown-theme" as never,
    });

    expect(missing?.colorThemeId).toBe("exograph-neutral");
    expect(unknown?.colorThemeId).toBe("exograph-neutral");
  });

  it("persists selected color theme ids", async () => {
    const userDataPath = await mkdtemp(path.join(os.tmpdir(), "exograph-core-theme-"));
    const env = { EXOGRAPH_USER_DATA_PATH: userDataPath };

    try {
      await saveWorkspaceSettings({
        workspaceRoot: "/tmp/exograph-theme/notes",
        defaultTerminalCwd: "/tmp/exograph-theme/project",
        noteRoots: ["/tmp/exograph-theme/notes"],
        indexedRoots: [],
        indexing: { enabled: false, mode: "off", backend: "qmd" },
        appearanceMode: "dark",
        colorThemeId: "exograph-solar",
        editorFontSize: 15,
        terminalFontSize: 13,
        explorerScale: 1,
        graphInverseNavigation: true,
        graphShowOverflowLabels: true,
        exploreIndexSearchOnEnter: false,
        indexUpdateStrategy: "on-save",
      }, env);

      await expect(loadWorkspaceSettings(env)).resolves.toMatchObject({
        appearanceMode: "dark",
        colorThemeId: "exograph-solar",
      });
    } finally {
      await rm(userDataPath, { recursive: true, force: true });
    }
  });

  it("normalizes legacy configured agent commands while reading persisted settings", async () => {
    const userDataPath = await mkdtemp(path.join(os.tmpdir(), "exograph-core-agent-commands-"));
    const env = { EXOGRAPH_USER_DATA_PATH: userDataPath };

    try {
      await writeFile(resolveWorkspaceSettingsPath(env), JSON.stringify({
        workspaceRoot: "/tmp/exograph-agent/notes",
        defaultTerminalCwd: "/tmp/exograph-agent",
        noteRoots: ["/tmp/exograph-agent/notes"],
        indexedRoots: [],
        indexing: { enabled: false, mode: "off", backend: "qmd" },
        appearanceMode: "system",
        colorThemeId: "exograph-neutral",
        editorFontSize: 15,
        terminalFontSize: 13,
        explorerScale: 1,
        exploreIndexSearchOnEnter: false,
        indexUpdateStrategy: "on-save",
        agentCommands: [
          {
            id: " Claude Code ",
            label: " Claude Code ",
            handle: " @Claude ",
            command: " claude ",
            adapter: "generic",
            continuityPolicy: "fresh",
            cwdPolicy: "workspace_root",
            promptDelivery: "stdin",
            version: 0,
            enabled: true,
          },
          {
            ...createDefaultClaudeAgentCommand(),
            id: "legacy-duplicate",
          },
        ],
      }), { mode: 0o600 });

      await expect(loadWorkspaceSettings(env)).resolves.toMatchObject({
        agentCommands: [{
          id: "Claude-Code",
          label: "Claude Code",
          handle: "claude",
          command: "claude",
          cwdPolicy: "workspace_root",
          promptDelivery: "stdin",
          version: 1,
          enabled: true,
        }],
      });
    } finally {
      await rm(userDataPath, { recursive: true, force: true });
    }
  });

  it("persists the safe built-in Codex migration without changing customized commands", async () => {
    const userDataPath = await mkdtemp(path.join(os.tmpdir(), "exograph-core-codex-migration-"));
    const env = { EXOGRAPH_USER_DATA_PATH: userDataPath };
    const legacy = {
      ...createDefaultCodexAgentCommand(),
      command: "codex exec --sandbox workspace-write -",
      version: 1,
    };
    const custom = {
      ...createDefaultClaudeAgentCommand(),
      id: "custom",
      label: "Custom",
      handle: "custom",
      command: "custom-agent -",
      adapter: "generic" as const,
      continuityPolicy: "fresh" as const,
    };
    try {
      await writeFile(resolveWorkspaceSettingsPath(env), JSON.stringify({
        ...workspaceSettingsFor("/tmp/exograph-codex-migration/notes"),
        agentCommands: [legacy, custom],
      }), { mode: 0o600 });

      await expect(loadWorkspaceSettings(env)).resolves.toMatchObject({
        agentCommands: [
          { id: "codex", command: "codex exec --sandbox workspace-write --skip-git-repo-check -", version: 2 },
          { id: "custom", command: "custom-agent -" },
        ],
      });
      const persisted = JSON.parse(await readFile(resolveWorkspaceSettingsPath(env), "utf8"));
      expect(persisted.agentCommands).toMatchObject([
        { id: "codex", command: "codex exec --sandbox workspace-write --skip-git-repo-check -", version: 2 },
        { id: "custom", command: "custom-agent -" },
      ]);
    } finally {
      await rm(userDataPath, { recursive: true, force: true });
    }
  });

  it("rejects duplicate or malformed Command configuration instead of dropping entries", async () => {
    const userDataPath = await mkdtemp(path.join(os.tmpdir(), "exograph-core-command-validation-"));
    const command = createDefaultClaudeAgentCommand();
    const codex = createDefaultCodexAgentCommand();
    const custom = {
      ...codex,
      id: "custom",
      label: "Local",
      handle: "local",
      command: "/bin/echo local",
      adapter: "generic" as const,
    };
    const base = workspaceSettingsFor("/tmp/exograph-command-validation/notes");

    try {
      await expect(saveWorkspaceSettings({
        ...base,
        agentCommands: [command, { ...command, id: "claude-copy" }],
      }, { EXOGRAPH_USER_DATA_PATH: userDataPath })).rejects.toThrow("Command handle @claude is already configured");
      await expect(saveWorkspaceSettings({
        ...base,
        agentCommands: [{ ...command, command: "" }],
      }, { EXOGRAPH_USER_DATA_PATH: userDataPath })).rejects.toThrow("Command 1 is malformed");
      for (const nonCanonical of [
        { ...command, id: "???" },
        { ...command, handle: "@CLAUDE" },
        { ...command, adapter: "unknown" },
        { ...command, cwdPolicy: "unknown" },
        { ...command, version: "one" },
        { ...command, enabled: "yes" },
      ]) {
        await expect(saveWorkspaceSettings({
          ...base,
          agentCommands: [nonCanonical],
        } as WorkspaceSettings, { EXOGRAPH_USER_DATA_PATH: userDataPath })).rejects.toThrow("non-canonical");
      }
      await expect(saveWorkspaceSettings({
        ...base,
        agentCommands: [
          command,
          codex,
          custom,
          { ...custom, id: "other", label: "Other", handle: "other" },
        ],
      }, { EXOGRAPH_USER_DATA_PATH: userDataPath })).rejects.toThrow("Only one Custom command can be configured");
    } finally {
      await rm(userDataPath, { recursive: true, force: true });
    }
  });

  it("preserves configured and future settings across load, edit, save, and reload", async () => {
    const userDataPath = await mkdtemp(path.join(os.tmpdir(), "exograph-core-lossless-settings-"));
    const env = { EXOGRAPH_USER_DATA_PATH: userDataPath };
    const initialSettings: WorkspaceSettings & {
      indexedRoots: Array<WorkspaceSettings["indexedRoots"][number] & {
        opaqueRootOptions: { version: number; includeDrafts: boolean };
      }>;
      futureSettings: { version: number; preferences: string[] };
      piHarness: { command: string };
    } = {
      workspaceRoot: "/tmp/exograph-lossless/notes",
      defaultTerminalCwd: "/tmp/exograph-lossless",
      noteRoots: ["/tmp/exograph-lossless/notes"],
      indexedRoots: [{
        id: "index-lossless",
        label: "Lossless notes",
        path: "/tmp/exograph-lossless/notes",
        kind: "notes",
        pattern: "**/*.md",
        ignore: [],
        backend: "qmd",
        opaqueRootOptions: {
          version: 2,
          includeDrafts: true,
        },
      }],
      indexing: { enabled: false, mode: "off", backend: "qmd" },
      appearanceMode: "system",
      colorThemeId: "exograph-neutral",
      editorFontSize: 15,
      terminalFontSize: 13,
      explorerScale: 1,
      graphInverseNavigation: true,
      graphShowOverflowLabels: false,
      exploreIndexSearchOnEnter: false,
      indexUpdateStrategy: "on-save",
      agentCommands: [createDefaultClaudeAgentCommand()],
      layout: {
        version: 3,
        canvas: {
          kind: "leaf",
          id: "editor-primary",
          content: { kind: "editor", openPaths: ["/tmp/exograph-lossless/notes/home.md"], activePath: "/tmp/exograph-lossless/notes/home.md" },
        },
        sidebarCollapsed: false,
        sidebarWidth: 220,
        utilityWidth: 430,
      },
      futureSettings: {
        version: 2,
        preferences: ["local", "lossless"],
      },
      piHarness: {
        command: "/opt/retired-pi",
      },
    };

    try {
      await saveWorkspaceSettings(initialSettings, env);
      const loaded = await loadWorkspaceSettings(env);

      expect(loaded).not.toBeNull();
      await saveWorkspaceSettings({ ...loaded!, appearanceMode: "dark" }, env);

      const reloaded = await loadWorkspaceSettings(env) as typeof initialSettings | null;
      expect(reloaded?.graphShowOverflowLabels).toBe(false);
      expect(reloaded).toMatchObject({
        appearanceMode: "dark",
        agentCommands: initialSettings.agentCommands,
        layout: initialSettings.layout,
        futureSettings: initialSettings.futureSettings,
        piHarness: initialSettings.piHarness,
        indexedRoots: [{
          opaqueRootOptions: {
            version: 2,
            includeDrafts: true,
          },
        }],
      });
    } finally {
      await rm(userDataPath, { recursive: true, force: true });
    }
  });

  it("preserves the current renderer canvas layout across a settings edit", async () => {
    const userDataPath = await mkdtemp(path.join(os.tmpdir(), "exograph-core-canvas-layout-"));
    const env = { EXOGRAPH_USER_DATA_PATH: userDataPath };
    const layout = {
      version: 3 as const,
      canvas: {
        kind: "leaf" as const,
        id: "editor-primary",
        content: {
          kind: "editor" as const,
          openPaths: ["/tmp/exograph-canvas-layout/notes/home.md"],
          activePath: "/tmp/exograph-canvas-layout/notes/home.md",
        },
      },
      sidebarCollapsed: false,
      sidebarWidth: 275,
      utilityWidth: 430,
    };
    const settings = normalizeWorkspaceSettings({
      workspaceRoot: "/tmp/exograph-canvas-layout",
      defaultTerminalCwd: "/tmp/exograph-canvas-layout",
      noteRoots: ["/tmp/exograph-canvas-layout/notes"],
      indexedRoots: [],
      indexing: { enabled: false, mode: "off", backend: "qmd" },
      appearanceMode: "system",
      colorThemeId: "exograph-neutral",
      editorFontSize: 15,
      terminalFontSize: 13,
      explorerScale: 1,
      exploreIndexSearchOnEnter: false,
      indexUpdateStrategy: "on-save",
      layout,
    });

    try {
      expect(settings).not.toBeNull();
      const saved = await saveWorkspaceSettings(settings!, env);
      expect(saved.layout).toEqual(layout);

      const reloaded = await loadWorkspaceSettings(env);
      expect(reloaded).not.toBeNull();
      const edited = await saveWorkspaceSettings({ ...reloaded!, appearanceMode: "dark" }, env);
      expect(edited.layout).toEqual(layout);
    } finally {
      await rm(userDataPath, { recursive: true, force: true });
    }
  });

  it("defaults missing agent commands to an empty settings list without installing commands", () => {
    const settings = normalizeWorkspaceSettings({
      workspaceRoot: "/tmp/exograph-agent/notes",
      defaultTerminalCwd: "/tmp/exograph-agent",
      noteRoots: ["/tmp/exograph-agent/notes"],
      indexedRoots: [],
      indexing: { enabled: false, mode: "off", backend: "qmd" },
    });

    expect(settings?.agentCommands).toEqual([]);
    expect(createDefaultClaudeAgentCommand()).toMatchObject({
      handle: "claude",
      promptDelivery: "stdin",
    });
  });

  it("persists an explicit default agent and gives existing workspaces a compatible default", () => {
    const commands = [createDefaultClaudeAgentCommand(), createDefaultCodexAgentCommand()];
    const migrated = normalizeWorkspaceSettings({
      ...workspaceSettingsFor("/tmp/exograph-agent-default/notes"),
      agentCommands: commands,
    });
    const selected = normalizeWorkspaceSettings({
      ...workspaceSettingsFor("/tmp/exograph-agent-selected/notes"),
      agentCommands: commands,
      defaultAgentCommandId: "codex",
    });

    expect(migrated?.defaultAgentCommandId).toBe("claude");
    expect(selected?.defaultAgentCommandId).toBe("codex");
  });

  it("normalizes current canvas layout bounds and pane contents", async () => {
    const userDataPath = await mkdtemp(path.join(os.tmpdir(), "exograph-core-layout-"));

    try {
      const saved = await saveWorkspaceSettings({
        workspaceRoot: "/tmp/exograph-layout/notes",
        defaultTerminalCwd: "/tmp/exograph-layout/project",
        noteRoots: ["/tmp/exograph-layout/notes"],
        indexedRoots: [],
        indexing: { enabled: false, mode: "off", backend: "qmd" },
        appearanceMode: "system",
        colorThemeId: "exograph-neutral",
        editorFontSize: 15,
        terminalFontSize: 13,
        explorerScale: 1,
        graphInverseNavigation: true,
        graphShowOverflowLabels: true,
        exploreIndexSearchOnEnter: false,
        indexUpdateStrategy: "on-save",
        layout: {
          version: 3,
          canvas: {
            kind: "split",
            id: "editor-split",
            direction: "horizontal",
            ratio: 0.9,
            children: [
              { kind: "leaf", id: "editor-a", content: { kind: "editor", openPaths: ["/tmp/exograph-layout/notes/a.md"], activePath: "/tmp/exograph-layout/notes/a.md" } },
              { kind: "leaf", id: "editor-b", content: { kind: "browser", url: "localhost:3000" } },
            ],
          },
          sidebarCollapsed: true,
          sidebarWidth: 9999,
          utilityWidth: 100,
        },
      }, { EXOGRAPH_USER_DATA_PATH: userDataPath });

      expect(saved.layout).toMatchObject({
        version: 3,
        sidebarWidth: 800,
        utilityWidth: 320,
      });
      expect(saved.layout?.canvas.kind).toBe("split");
      if (saved.layout?.canvas.kind === "split" && saved.layout.canvas.children[1].kind === "leaf") {
        expect(saved.layout.canvas.children[1].content).toEqual({ kind: "browser", url: "localhost:3000" });
      }
    } finally {
      await rm(userDataPath, { recursive: true, force: true });
    }
  });

  it("preserves an in-range current explorer width", async () => {
    const userDataPath = await mkdtemp(path.join(os.tmpdir(), "exograph-core-sidebar-width-"));

    try {
      const saved = await saveWorkspaceSettings({
        workspaceRoot: "/tmp/exograph-layout/notes",
        defaultTerminalCwd: "/tmp/exograph-layout/project",
        noteRoots: ["/tmp/exograph-layout/notes"],
        indexedRoots: [],
        indexing: { enabled: false, mode: "off", backend: "qmd" },
        appearanceMode: "system",
        colorThemeId: "exograph-neutral",
        editorFontSize: 15,
        terminalFontSize: 13,
        explorerScale: 1,
        graphInverseNavigation: true,
        graphShowOverflowLabels: true,
        exploreIndexSearchOnEnter: false,
        indexUpdateStrategy: "on-save",
        layout: {
          version: 3,
          canvas: { kind: "leaf", id: "editor-a", content: { kind: "editor", openPaths: [], activePath: null } },
          sidebarCollapsed: false,
          sidebarWidth: 260,
          utilityWidth: 430,
        },
      }, { EXOGRAPH_USER_DATA_PATH: userDataPath });

      expect(saved.layout?.sidebarWidth).toBe(260);
    } finally {
      await rm(userDataPath, { recursive: true, force: true });
    }
  });

  it("persists and reloads the active desktop workspace", async () => {
    const userDataPath = await mkdtemp(path.join(os.tmpdir(), "exograph-core-workspace-registry-"));
    const env = { EXOGRAPH_USER_DATA_PATH: userDataPath };

    try {
      await saveWorkspaceSettings({
        workspaceRoot: "/tmp/exograph/notes-alpha",
        defaultTerminalCwd: "/tmp/exograph/project-alpha",
        noteRoots: ["/tmp/exograph/notes-alpha"],
        indexedRoots: [],
        indexing: { enabled: false, mode: "off", backend: "qmd" },
        appearanceMode: "system",
        colorThemeId: "exograph-neutral",
        editorFontSize: 15,
        terminalFontSize: 13,
        explorerScale: 1,
        graphInverseNavigation: true,
        graphShowOverflowLabels: true,
        exploreIndexSearchOnEnter: false,
        indexUpdateStrategy: "on-save",
      }, env);

      await expect(loadActiveWorkspaceSettings(env)).resolves.toMatchObject({
        workspaceRoot: "/tmp/exograph/notes-alpha",
        defaultTerminalCwd: "/tmp/exograph/project-alpha",
      });
      await expect(listWorkspaceRegistryEntries(env)).resolves.toHaveLength(1);
    } finally {
      await rm(userDataPath, { recursive: true, force: true });
    }
  });

  it("retains distinct Workspace identities that collide under a short hash", async () => {
    const userDataPath = await mkdtemp(path.join(os.tmpdir(), "exograph-core-workspace-identity-collision-"));
    const env = { EXOGRAPH_USER_DATA_PATH: userDataPath };

    try {
      await saveWorkspaceSettings(workspaceSettingsFor("/tmp/Aa"), env);
      await saveWorkspaceSettings(workspaceSettingsFor("/tmp/BB"), env);

      const registry = JSON.parse(await readFile(resolveWorkspaceRegistryPath(env), "utf8")) as WorkspaceRegistrySnapshot;
      expect(registry.workspaces).toHaveLength(2);
      expect(registry.workspaces.map((workspace) => workspace.notesFolder)).toEqual(["/tmp/BB", "/tmp/Aa"]);
      expect(new Set(registry.workspaces.map((workspace) => workspace.id)).size).toBe(2);
      expect(registry.workspaces.every((workspace) => workspace.id.startsWith("workspace-v1-"))).toBe(true);
      expect(registry.activeWorkspaceId).toBe(registry.workspaces[0]?.id);
      await expect(loadActiveWorkspaceSettings(env)).resolves.toMatchObject({ noteRoots: ["/tmp/BB"] });
    } finally {
      await rm(userDataPath, { recursive: true, force: true });
    }
  });

  it("deduplicates lexical aliases and persists their canonical absolute Notes Folder", async () => {
    const userDataPath = await mkdtemp(path.join(os.tmpdir(), "exograph-core-workspace-identity-canonical-"));
    const env = { EXOGRAPH_USER_DATA_PATH: userDataPath };

    try {
      await saveWorkspaceSettings(workspaceSettingsFor("/tmp/exograph-canonical/notes"), env);
      await saveWorkspaceSettings(workspaceSettingsFor("/tmp/exograph-canonical/./notes"), env);

      const registry = JSON.parse(await readFile(resolveWorkspaceRegistryPath(env), "utf8")) as WorkspaceRegistrySnapshot;
      expect(registry.workspaces).toHaveLength(1);
      expect(registry.workspaces[0]?.notesFolder).toBe("/tmp/exograph-canonical/notes");
      expect(registry.workspaces[0]?.settings.noteRoots).toEqual(["/tmp/exograph-canonical/notes"]);
    } finally {
      await rm(userDataPath, { recursive: true, force: true });
    }
  });

  it("rejects pre-current registry identities without rewriting either durable file", async () => {
    const userDataPath = await mkdtemp(path.join(os.tmpdir(), "exograph-core-workspace-identity-unsupported-"));
    const env = { EXOGRAPH_USER_DATA_PATH: userDataPath };
    const settings = workspaceSettingsFor("/tmp/exograph-identity/notes");
    const settingsJson = JSON.stringify(settings);
    const registryJson = JSON.stringify({
      activeWorkspaceId: "old-id",
      workspaces: [{ id: "old-id", label: "Notes", notesFolder: settings.noteRoots[0], settings, updatedAt: "2026-07-24T01:00:00.000Z" }],
    });

    try {
      await writeFile(resolveWorkspaceSettingsPath(env), settingsJson, { mode: 0o600 });
      await writeFile(resolveWorkspaceRegistryPath(env), registryJson, { mode: 0o600 });

      await expect(loadWorkspaceSettings(env)).rejects.toThrow("unsupported pre-launch identity");
      await expect(loadWorkspaceRegistry(env)).rejects.toThrow("unsupported pre-launch identity");
      expect(await readFile(resolveWorkspaceSettingsPath(env), "utf8")).toBe(settingsJson);
      expect(await readFile(resolveWorkspaceRegistryPath(env), "utf8")).toBe(registryJson);
    } finally {
      await rm(userDataPath, { recursive: true, force: true });
    }
  });

  it.each([null, "missing-id"])("selects the first canonical registry entry for active ID %s without rewriting order or metadata", async (activeWorkspaceId) => {
    const userDataPath = await mkdtemp(path.join(os.tmpdir(), "exograph-core-workspace-active-fallback-"));
    const env = { EXOGRAPH_USER_DATA_PATH: userDataPath };

    try {
      await saveWorkspaceSettings({ ...workspaceSettingsFor("/tmp/exograph-first/notes"), futureSetting: { retained: "first" } }, env);
      await saveWorkspaceSettings({ ...workspaceSettingsFor("/tmp/exograph-second/notes"), futureSetting: { retained: "second" } }, env);
      const canonical = JSON.parse(await readFile(resolveWorkspaceRegistryPath(env), "utf8")) as WorkspaceRegistrySnapshot;
      canonical.activeWorkspaceId = activeWorkspaceId;
      canonical.workspaces[0]!.label = "Second custom label";
      canonical.workspaces[0]!.updatedAt = "2026-07-24T02:00:00.000Z";
      canonical.workspaces[0]!.futureMetadata = { retained: true };
      const registryJson = JSON.stringify(canonical);
      await writeFile(resolveWorkspaceRegistryPath(env), registryJson, { mode: 0o600 });
      await writeFile(resolveWorkspaceSettingsPath(env), JSON.stringify(canonical.workspaces[0]!.settings), { mode: 0o600 });

      await expect(loadWorkspaceRegistry(env)).resolves.toMatchObject({
        activeWorkspaceId: canonical.workspaces[0]!.id,
        workspaces: [
          {
            label: "Second custom label",
            updatedAt: "2026-07-24T02:00:00.000Z",
            futureMetadata: { retained: true },
            settings: { futureSetting: { retained: "second" } },
          },
          { settings: { futureSetting: { retained: "first" } } },
        ],
      });
      expect(await readFile(resolveWorkspaceRegistryPath(env), "utf8")).toBe(registryJson);
    } finally {
      await rm(userDataPath, { recursive: true, force: true });
    }
  });

  it("uses one physical identity for a real Notes Folder and its symlink alias", async () => {
    const userDataPath = await mkdtemp(path.join(os.tmpdir(), "exograph-core-workspace-identity-symlink-"));
    const env = { EXOGRAPH_USER_DATA_PATH: userDataPath };
    const realNotesFolder = path.join(userDataPath, "real-notes");
    const aliasNotesFolder = path.join(userDataPath, "alias-notes");

    try {
      await mkdir(realNotesFolder);
      await symlink(realNotesFolder, aliasNotesFolder, "dir");
      await saveWorkspaceSettings(workspaceSettingsFor(realNotesFolder), env);
      const firstRegistry = JSON.parse(await readFile(resolveWorkspaceRegistryPath(env), "utf8")) as WorkspaceRegistrySnapshot;

      await saveWorkspaceSettings(workspaceSettingsFor(aliasNotesFolder), env);
      const registry = JSON.parse(await readFile(resolveWorkspaceRegistryPath(env), "utf8")) as WorkspaceRegistrySnapshot;
      expect(registry.workspaces).toHaveLength(1);
      expect(registry.workspaces[0]?.id).toBe(firstRegistry.workspaces[0]?.id);
      expect(registry.workspaces[0]?.notesFolder).toBe(aliasNotesFolder);
      expect(registry.workspaces[0]?.settings.noteRoots).toEqual([aliasNotesFolder]);
    } finally {
      await rm(userDataPath, { recursive: true, force: true });
    }
  });

  it("uses one physical identity for case aliases on a case-insensitive macOS volume", async () => {
    if (process.platform !== "darwin") {
      return;
    }
    const userDataPath = await mkdtemp(path.join(os.tmpdir(), "exograph-core-workspace-identity-case-"));
    const env = { EXOGRAPH_USER_DATA_PATH: userDataPath };
    const notesFolder = path.join(userDataPath, "CaseSensitiveSpelling");
    const aliasNotesFolder = path.join(userDataPath, "casesensitivespelling");

    try {
      await mkdir(notesFolder);
      try {
        await realpath(aliasNotesFolder);
      } catch {
        return;
      }
      await saveWorkspaceSettings(workspaceSettingsFor(notesFolder), env);
      const firstRegistry = JSON.parse(await readFile(resolveWorkspaceRegistryPath(env), "utf8")) as WorkspaceRegistrySnapshot;
      await saveWorkspaceSettings(workspaceSettingsFor(aliasNotesFolder), env);
      const registry = JSON.parse(await readFile(resolveWorkspaceRegistryPath(env), "utf8")) as WorkspaceRegistrySnapshot;
      expect(registry.workspaces).toHaveLength(1);
      expect(registry.workspaces[0]?.id).toBe(firstRegistry.workspaces[0]?.id);
    } finally {
      await rm(userDataPath, { recursive: true, force: true });
    }
  });

  it("uses physical identity for relative existing roots and lexical identity for absent roots", async () => {
    const userDataPath = await mkdtemp(path.join(os.tmpdir(), "exograph-core-workspace-identity-fallback-"));
    const env = { EXOGRAPH_USER_DATA_PATH: userDataPath };
    const existingNotesFolder = path.join(userDataPath, "existing-notes");
    const relativeNotesFolder = path.relative(process.cwd(), existingNotesFolder);
    const absentNotesFolder = path.join(userDataPath, "absent-notes");
    const absentAlias = path.join(userDataPath, "missing-parent", "..", "absent-notes");

    try {
      await mkdir(existingNotesFolder);
      const relativeSettings = workspaceSettingsFor(relativeNotesFolder);
      expect(relativeSettings.noteRoots).toEqual([existingNotesFolder]);
      expect(workspaceModelFromSettings(relativeSettings).noteRoots[0]?.path).toBe(existingNotesFolder);
      await saveWorkspaceSettings(workspaceSettingsFor(existingNotesFolder), env);
      const existingId = (JSON.parse(await readFile(resolveWorkspaceRegistryPath(env), "utf8")) as WorkspaceRegistrySnapshot).workspaces[0]?.id;
      await saveWorkspaceSettings(relativeSettings, env);
      let registry = JSON.parse(await readFile(resolveWorkspaceRegistryPath(env), "utf8")) as WorkspaceRegistrySnapshot;
      expect(registry.workspaces).toHaveLength(1);
      expect(registry.workspaces[0]?.id).toBe(existingId);
      expect(registry.workspaces[0]?.notesFolder).toBe(existingNotesFolder);
      expect(registry.workspaces[0]?.settings.noteRoots).toEqual([existingNotesFolder]);

      await saveWorkspaceSettings(workspaceSettingsFor(absentNotesFolder), env);
      const absentId = (JSON.parse(await readFile(resolveWorkspaceRegistryPath(env), "utf8")) as WorkspaceRegistrySnapshot).workspaces[0]?.id;
      await saveWorkspaceSettings(workspaceSettingsFor(absentAlias), env);
      registry = JSON.parse(await readFile(resolveWorkspaceRegistryPath(env), "utf8")) as WorkspaceRegistrySnapshot;
      expect(registry.workspaces).toHaveLength(2);
      expect(registry.workspaces[0]?.id).toBe(absentId);
      expect(registry.workspaces[0]?.notesFolder).toBe(absentNotesFolder);
      expect(registry.workspaces.map((entry) => entry.id)).toContain(existingId);
    } finally {
      await rm(userDataPath, { recursive: true, force: true });
    }
  });

  it("loads a current registry snapshot twice without rewriting it", async () => {
    const userDataPath = await mkdtemp(path.join(os.tmpdir(), "exograph-core-workspace-stable-load-"));
    const env = { EXOGRAPH_USER_DATA_PATH: userDataPath };

    try {
      await saveWorkspaceSettings({ ...workspaceSettingsFor("/tmp/exograph-stable/notes"), futureSetting: { retained: true } }, env);
      const settingsJson = await readFile(resolveWorkspaceSettingsPath(env), "utf8");
      const registryJson = await readFile(resolveWorkspaceRegistryPath(env), "utf8");
      const settingsInode = (await stat(resolveWorkspaceSettingsPath(env))).ino;
      const registryInode = (await stat(resolveWorkspaceRegistryPath(env))).ino;

      await expect(loadWorkspaceSettings(env)).resolves.toMatchObject({ futureSetting: { retained: true } });
      await expect(loadWorkspaceSettings(env)).resolves.toMatchObject({ futureSetting: { retained: true } });
      expect(await readFile(resolveWorkspaceSettingsPath(env), "utf8")).toBe(settingsJson);
      expect(await readFile(resolveWorkspaceRegistryPath(env), "utf8")).toBe(registryJson);
      expect((await stat(resolveWorkspaceSettingsPath(env))).ino).toBe(settingsInode);
      expect((await stat(resolveWorkspaceRegistryPath(env))).ino).toBe(registryInode);
    } finally {
      await rm(userDataPath, { recursive: true, force: true });
    }
  });

  it("treats explicit workspace env as an override", () => {
    expect(workspaceEnvOverrides({ EXOGRAPH_WORKSPACE_ROOT: "/tmp/manual" })).toBe(true);
    expect(workspaceEnvOverrides({})).toBe(false);
  });

  it("persists saved workspaces for the switcher", async () => {
    const userDataPath = await mkdtemp(path.join(os.tmpdir(), "exograph-workspace-registry-"));
    const env = { EXOGRAPH_USER_DATA_PATH: userDataPath };

    try {
      const firstSettings = normalizeWorkspaceSettings({
        workspaceRoot: "/tmp/exograph-test/notes-alpha",
        defaultTerminalCwd: "/tmp/exograph-test/notes-alpha",
        noteRoots: ["/tmp/exograph-test/notes-alpha"],
        indexedRoots: [],
        indexing: { enabled: false, mode: "off", backend: "qmd" },
      });
      const secondSettings = normalizeWorkspaceSettings({
        workspaceRoot: "/tmp/exograph-test/notes-beta",
        defaultTerminalCwd: "/tmp/exograph-test/project-beta",
        noteRoots: ["/tmp/exograph-test/notes-beta"],
        indexedRoots: [],
        indexing: { enabled: false, mode: "off", backend: "qmd" },
      });

      expect(firstSettings).not.toBeNull();
      expect(secondSettings).not.toBeNull();
      await saveWorkspaceSettings(firstSettings!, env);
      await saveWorkspaceSettings(secondSettings!, env);

      const workspaces = await listWorkspaceRegistryEntries(env);
      expect(workspaces.map((workspace) => workspace.label)).toEqual(["notes-beta", "notes-alpha"]);
      expect(workspaces[0].settings.defaultTerminalCwd).toBe("/tmp/exograph-test/project-beta");
      await expect(getWorkspaceRegistryEntry(workspaces[1].id, env)).resolves.toMatchObject({
        notesFolder: "/tmp/exograph-test/notes-alpha",
      });
    } finally {
      await rm(userDataPath, { recursive: true, force: true });
    }
  });
});

interface WorkspaceRegistryAppearance {
  workspaces: Array<{ settings: { appearanceMode: string } }>;
}

interface WorkspaceRegistrySnapshot {
  activeWorkspaceId: string | null;
  workspaces: Array<{
    id: string;
    label: string;
    notesFolder: string;
    settings: { noteRoots: string[]; futureSetting?: unknown };
    updatedAt: string;
    futureMetadata?: unknown;
  }>;
}

function workspaceSettingsFor(notesFolder: string) {
  const settings = normalizeWorkspaceSettings({
    workspaceRoot: path.dirname(notesFolder),
    defaultTerminalCwd: path.dirname(notesFolder),
    noteRoots: [notesFolder],
    indexedRoots: [],
    indexing: { enabled: false, mode: "off", backend: "qmd" },
  });
  if (!settings) {
    throw new Error("Expected fixture settings to normalize.");
  }
  return settings;
}

interface WorkspaceSettingsTransaction {
  registry: {
    activeWorkspaceId: string | null;
    workspaces: Array<{ settings: { appearanceMode: string }; [key: string]: unknown }>;
  };
}
