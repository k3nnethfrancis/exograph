import { expect, test, type Page } from "@playwright/test";
import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  agentCommandSnapshot,
  createDefaultClaudeAgentCommand,
  createDefaultCodexAgentCommand,
  InvocationStore,
  type WorkspaceCanvasLayoutSettings,
} from "@exograph/core";

import { launchExographWorkspaceFixture, relaunchExographWorkspaceFixture } from "../helpers";

test("overflow label preference saves immediately and survives close and restart", async () => {
  const fixture = await launchExographWorkspaceFixture({ mutable: true });
  let relaunched: Awaited<ReturnType<typeof relaunchExographWorkspaceFixture>> | null = null;
  try {
    await openSettingsSection(fixture.page, "graph");
    const toggle = fixture.page.getByRole("checkbox", { name: "Show overflow labels", exact: true });
    await expect(toggle).toBeChecked();
    await toggle.uncheck();
    await expect.poll(() => persistedSettings(fixture.settingsPath)).toMatchObject({ graphShowOverflowLabels: false });
    await fixture.page.getByTestId("workspace-settings-close").click();
    await openSettingsSection(fixture.page, "graph");
    await expect(toggle).not.toBeChecked();
    await fixture.electronApp.close();
    relaunched = await relaunchExographWorkspaceFixture(fixture);
    await openSettingsSection(relaunched.page, "graph");
    const restored = relaunched.page.getByRole("checkbox", { name: "Show overflow labels", exact: true });
    await expect(restored).not.toBeChecked();
    await restored.check();
    await expect.poll(() => persistedSettings(fixture.settingsPath)).toMatchObject({ graphShowOverflowLabels: true });
  } finally {
    await relaunched?.electronApp.close().catch(() => {});
    await fixture.cleanup();
  }
});

test("every non-structural Settings round trip preserves commands, layout, and opaque metadata", async () => {
  const fixture = await launchExographWorkspaceFixture({
    mutable: true,
    prepareSettings: async ({ settingsPath, workspaceRoot }) => {
      await writeFile(settingsPath, JSON.stringify({
        workspaceRoot,
        defaultTerminalCwd: workspaceRoot,
        noteRoots: [path.join(workspaceRoot, "notes/test-notes")],
        agentCommands: [{
          id: "preserved-command",
          label: "Preserved command",
          handle: "preserved",
          command: "/bin/cat",
          cwdPolicy: "workspace_root",
          promptDelivery: "stdin",
          version: 1,
          enabled: true,
        }],
        futureSetting: { keep: "me" },
        futureWorkspaceMetadata: { sourceVersion: 3, keep: true },
        indexedRoots: [path.join(workspaceRoot, "notes/test-notes")],
        indexing: { enabled: true, mode: "lexical", backend: "qmd" },
        searchEngine: "qmd",
        appearanceMode: "system",
        colorThemeId: "exograph-neutral",
        editorFontSize: 15,
        terminalFontSize: 13,
        explorerScale: 1,
        graphInverseNavigation: true,
        exploreIndexSearchOnEnter: false,
        indexUpdateStrategy: "on-save",
      }, null, 2), "utf8");
    },
  });

  try {
    // Let independent canvas persistence settle before proving Settings itself
    // is read-only while untouched.
    await fixture.page.waitForTimeout(1_100);
    const before = await readFile(fixture.settingsPath, "utf8");
    await fixture.page.getByTestId("workspace-menu-toggle").click();
    await fixture.page.getByTestId("workspace-menu-settings").click();
    await expect(fixture.page.getByTestId("workspace-settings-dialog")).toBeVisible();
    await fixture.page.waitForTimeout(800);
    await fixture.page.getByTestId("workspace-settings-close").click();
    await expect(fixture.page.getByTestId("workspace-settings-dialog")).not.toBeVisible();
    expect(await readFile(fixture.settingsPath, "utf8")).toBe(before);

    await fixture.page.getByTestId("workspace-menu-toggle").click();
    await fixture.page.getByTestId("workspace-menu-settings").click();
    await expect(fixture.page.getByTestId("workspace-settings-dialog")).toBeVisible();
    await fixture.page.waitForTimeout(800);
    await fixture.page.getByTestId("workspace-settings-close").click();
    await expect(fixture.page.getByTestId("workspace-settings-dialog")).not.toBeVisible();
    expect(await readFile(fixture.settingsPath, "utf8")).toBe(before);

    const layout = preservedLayout(path.join(fixture.workspaceRoot, "notes/test-notes/focus-note.md"));
    const savedLayout = await fixture.page.evaluate(async (nextLayout) => {
      const snapshot = await window.exograph.workspace.getSettings();
      const saved = await window.exograph.workspace.saveSettings({
        settings: { ...snapshot.settings, layout: nextLayout },
        expectedRevision: snapshot.revision,
      });
      return saved.settings.layout;
    }, layout);
    expect(savedLayout).toEqual(layout);

    // The renderer owns canvas persistence. Let that normal path settle, then
    // treat its saved canvas as the layout Settings must leave untouched.
    await fixture.page.waitForTimeout(1_100);
    const seeded = await persistedSettings(fixture.settingsPath);
    expect(seeded.layout).toBeDefined();
    await editSettingsAndClose(fixture.page, "appearance", async (page) => {
      await page.getByTestId("workspace-settings-appearance").selectOption("dark");
    });
    await expectPreservedSettings(fixture.settingsPath, seeded, { appearanceMode: "dark" });

    await editSettingsAndClose(fixture.page, "index", async (page) => {
      await page.getByTestId("workspace-settings-index-update-strategy").selectOption("manual");
    });
    await expectPreservedSettings(fixture.settingsPath, seeded, { appearanceMode: "dark", indexUpdateStrategy: "manual" });

    await editSettingsAndClose(fixture.page, "terminal", async (page) => {
      await page.getByTestId("workspace-settings-terminal-font-size").fill("14");
    });
    await expectPreservedSettings(fixture.settingsPath, seeded, {
      appearanceMode: "dark",
      indexUpdateStrategy: "manual",
      terminalFontSize: 14,
    });

    await editSettingsAndClose(fixture.page, "graph", async (page) => {
      await page.getByText("Inverse navigation", { exact: true }).click();
      await expect(page.getByTestId("workspace-settings-graph-inverse-navigation")).not.toBeChecked();
    });
    await expectPreservedSettings(fixture.settingsPath, seeded, {
      appearanceMode: "dark",
      graphInverseNavigation: false,
      indexUpdateStrategy: "manual",
      terminalFontSize: 14,
    });
  } finally {
    await fixture.cleanup();
  }
});

test("an explicit empty Commands list stays empty and does not offer @claude", async () => {
  const fixture = await launchExographWorkspaceFixture({
    mutable: true,
    prepareSettings: async ({ settingsPath, workspaceRoot }) => {
      await writeFile(settingsPath, JSON.stringify({
        workspaceRoot,
        defaultTerminalCwd: workspaceRoot,
        noteRoots: [path.join(workspaceRoot, "notes/test-notes")],
        agentCommands: [],
        indexedRoots: [],
        indexing: { enabled: false, mode: "off", backend: "qmd" },
        searchEngine: "filesystem",
        appearanceMode: "system",
        colorThemeId: "exograph-neutral",
        editorFontSize: 15,
        terminalFontSize: 13,
        explorerScale: 1,
        exploreIndexSearchOnEnter: false,
        indexUpdateStrategy: "on-save",
      }, null, 2), "utf8");
    },
  });

  try {
    await editSettingsAndClose(fixture.page, "terminal", async (page) => {
      await page.getByTestId("workspace-settings-terminal-font-size").fill("14");
    });
    await expect.poll(() => persistedSettings(fixture.settingsPath)).toMatchObject({ agentCommands: [] });

    await fixture.page.locator(".editor-surface .cm-content").click();
    await fixture.page.keyboard.press("Meta+End");
    await fixture.page.keyboard.type("@claude");
    await expect(fixture.page.getByTestId("agent-suggestions")).toHaveCount(0);
  } finally {
    await fixture.cleanup();
  }
});

test("a disabled Claude command stays unavailable to inline completion", async () => {
  const fixture = await launchExographWorkspaceFixture({
    mutable: true,
    prepareSettings: async ({ settingsPath, workspaceRoot }) => {
      await writeFile(settingsPath, JSON.stringify({
        workspaceRoot,
        defaultTerminalCwd: workspaceRoot,
        noteRoots: [path.join(workspaceRoot, "notes/test-notes")],
        agentCommands: [{
          id: "claude",
          label: "Claude",
          handle: "claude",
          command: "/bin/echo",
          adapter: "claude-code",
          continuityPolicy: "continuous",
          cwdPolicy: "workspace_root",
          promptDelivery: "stdin",
          version: 1,
          enabled: false,
        }],
        indexedRoots: [],
        indexing: { enabled: false, mode: "off", backend: "qmd" },
        searchEngine: "filesystem",
        appearanceMode: "system",
        colorThemeId: "exograph-neutral",
        editorFontSize: 15,
        terminalFontSize: 13,
        explorerScale: 1,
        exploreIndexSearchOnEnter: false,
        indexUpdateStrategy: "on-save",
      }, null, 2), "utf8");
    },
  });

  try {
    await fixture.page.locator(".editor-surface .cm-content").click();
    await fixture.page.keyboard.press("Meta+End");
    await fixture.page.keyboard.type("@claude");
    await expect(fixture.page.getByTestId("agent-suggestions")).toHaveCount(0);
  } finally {
    await fixture.cleanup();
  }
});

test("keeps an invalid existing Agent Command in Settings instead of discarding it on close", async () => {
  const fixture = await launchExographWorkspaceFixture({
    mutable: true,
    prepareSettings: async ({ settingsPath, workspaceRoot }) => {
      const noteRoot = path.join(workspaceRoot, "notes/test-notes");
      await writeFile(settingsPath, JSON.stringify({
        workspaceRoot,
        defaultTerminalCwd: workspaceRoot,
        noteRoots: [noteRoot],
        agentCommands: [createDefaultClaudeAgentCommand(), createDefaultCodexAgentCommand()],
        indexedRoots: [],
        indexing: { enabled: false, mode: "off", backend: "qmd" },
        searchEngine: "filesystem",
        appearanceMode: "system",
        colorThemeId: "exograph-neutral",
        editorFontSize: 15,
        terminalFontSize: 13,
        explorerScale: 1,
        exploreIndexSearchOnEnter: false,
        indexUpdateStrategy: "on-save",
      }, null, 2), "utf8");
    },
  });
  try {
    await fixture.page.getByTestId("workspace-menu-toggle").click();
    await fixture.page.getByTestId("workspace-menu-settings").click();
    await fixture.page.getByTestId("workspace-settings-tab-agents").click();

    const configurator = fixture.page.getByTestId("workspace-settings-agents-config");
    const claudeCommand = configurator.getByTestId("workspace-settings-agents-config-command-input-claude");
    const persistedBefore = await persistedSettings(fixture.settingsPath);
    await claudeCommand.fill("");
    await fixture.page.getByTestId("workspace-settings-close").click();

    await expect(fixture.page.getByTestId("workspace-settings-dialog")).toBeVisible();
    await expect(fixture.page.locator(".dialog-card__status--error")).toContainText(/command/i);
    await expect(fixture.page.getByLabel("Retry workspace settings")).toHaveCount(0);
    expect((await persistedSettings(fixture.settingsPath)).agentCommands).toEqual(persistedBefore.agentCommands);

    await fixture.page.getByTestId("workspace-settings-overlay").click({ position: { x: 5, y: 5 } });
    await expect(fixture.page.getByTestId("workspace-settings-dialog")).toBeVisible();
    await claudeCommand.focus();
    await fixture.page.keyboard.press("Escape");
    await expect(fixture.page.getByTestId("workspace-settings-dialog")).toBeVisible();
    expect((await persistedSettings(fixture.settingsPath)).agentCommands).toEqual(persistedBefore.agentCommands);

    await claudeCommand.fill(String((persistedBefore.agentCommands as Array<{ id: string; command: string }>)
      .find((command) => command.id === "claude")?.command));
    await expect(fixture.page.getByTestId("workspace-settings-status")).toContainText("Settings saved.");
    await fixture.page.getByTestId("workspace-settings-close").click();
    await expect(fixture.page.getByTestId("workspace-settings-dialog")).toHaveCount(0);
  } finally {
    await fixture.cleanup();
  }
});

test("persists the default agent used by Exograph-initiated features", async () => {
  const fixture = await launchExographWorkspaceFixture({
    mutable: true,
    prepareSettings: async ({ settingsPath, workspaceRoot }) => {
      const noteRoot = path.join(workspaceRoot, "notes/test-notes");
      await writeFile(settingsPath, JSON.stringify({
        workspaceRoot,
        defaultTerminalCwd: workspaceRoot,
        noteRoots: [noteRoot],
        agentCommands: [createDefaultClaudeAgentCommand(), createDefaultCodexAgentCommand()],
        defaultAgentCommandId: "claude",
        indexedRoots: [],
        indexing: { enabled: false, mode: "off", backend: "qmd" },
        searchEngine: "filesystem",
        appearanceMode: "system",
        colorThemeId: "exograph-neutral",
        editorFontSize: 15,
        terminalFontSize: 13,
        explorerScale: 1,
        exploreIndexSearchOnEnter: false,
        indexUpdateStrategy: "on-save",
      }, null, 2), "utf8");
    },
  });

  try {
    await fixture.page.getByTestId("workspace-menu-toggle").click();
    await fixture.page.getByTestId("workspace-menu-settings").click();
    await fixture.page.getByTestId("workspace-settings-tab-agents").click();

    const selector = fixture.page.getByTestId("workspace-settings-default-agent");
    await expect(selector).toHaveValue("claude");
    await selector.selectOption("codex");
    await expect(fixture.page.getByTestId("workspace-settings-status")).toHaveText("Settings saved.");
    await expect.poll(() => persistedSettings(fixture.settingsPath))
      .toMatchObject({ defaultAgentCommandId: "codex" });
  } finally {
    await fixture.cleanup();
  }
});

test("adds one Custom Command, removes it explicitly, and retains its History snapshot", async () => {
  const historyId = "historical-local-command";
  let notePath = "";
  let markerPath = "";
  const customCommand = {
    ...createDefaultCodexAgentCommand(),
    id: "custom",
    label: "Local",
    handle: "local",
    command: "/bin/echo historical",
    adapter: "generic" as const,
  };
  const fixture = await launchExographWorkspaceFixture({
    mutable: true,
    prepareSettings: async ({ settingsPath, workspaceRoot }) => {
      const noteRoot = path.join(workspaceRoot, "notes/test-notes");
      notePath = path.join(noteRoot, "removed-command-history.md");
      markerPath = path.join(workspaceRoot, "configuration-must-not-run");
      await writeFile(notePath, "# Removed Command History\n", "utf8");
      await new InvocationStore(workspaceRoot).writeRecord({
        id: historyId,
        workspaceRoot,
        noteRoots: [noteRoot],
        status: "failed",
        context: "note",
        taggedDocumentPath: notePath,
        originalMentionText: "@local",
        mentionProvenance: "human-authored",
        message: "Historical request",
        promptDelivery: "stdin",
        command: agentCommandSnapshot(customCommand),
        cwd: workspaceRoot,
        createdAt: "2026-07-26T00:00:00.000Z",
        endedAt: "2026-07-26T00:00:01.000Z",
        failureReason: "Fixture failure.",
        continuity: { policy: "fresh", outcome: "fresh" },
      });
      await writeFile(settingsPath, JSON.stringify({
        workspaceRoot,
        defaultTerminalCwd: workspaceRoot,
        noteRoots: [noteRoot],
        agentCommands: [createDefaultClaudeAgentCommand(), createDefaultCodexAgentCommand()],
        indexedRoots: [],
        indexing: { enabled: false, mode: "off", backend: "qmd" },
        searchEngine: "filesystem",
        appearanceMode: "system",
        colorThemeId: "exograph-neutral",
        editorFontSize: 15,
        terminalFontSize: 13,
        explorerScale: 1,
        exploreIndexSearchOnEnter: false,
        indexUpdateStrategy: "on-save",
      }, null, 2), "utf8");
    },
  });

  try {
    await fixture.page.getByTestId("workspace-menu-toggle").click();
    await fixture.page.getByTestId("workspace-menu-settings").click();
    await fixture.page.getByTestId("workspace-settings-tab-agents").click();
    const configurator = fixture.page.getByTestId("workspace-settings-agents-config");
    await expect(configurator.locator("#workspace-settings-agents-config-recommended-title")).toBeVisible();
    await configurator.getByTestId("workspace-settings-agents-config-add-custom").click();
    await configurator.getByRole("textbox", { name: "Custom command name" }).fill("Local");
    await configurator.getByRole("textbox", { name: "Custom command handle" }).fill("claude");
    await configurator.getByRole("textbox", { name: "Custom command executable and arguments" })
      .fill(`/bin/sh -c 'touch "${markerPath}"'`);
    await expect(configurator.getByTestId("workspace-settings-agents-config-custom-error"))
      .toHaveText("@claude is already configured.");
    await expect(configurator.getByTestId("workspace-settings-agents-config-confirm-custom")).toBeDisabled();
    await configurator.getByRole("textbox", { name: "Custom command handle" }).fill("local");
    await configurator.getByTestId("workspace-settings-agents-config-confirm-custom").click();
    await expect(fixture.page.getByTestId("workspace-settings-status")).toHaveText("Settings saved.");
    await expect.poll(async () => (await persistedSettings(fixture.settingsPath)).agentCommands)
      .toEqual(expect.arrayContaining([expect.objectContaining({ id: "custom", handle: "local", label: "Local" })]));
    await expect(access(markerPath)).rejects.toMatchObject({ code: "ENOENT" });

    await configurator.getByTestId("workspace-settings-agents-config-remove-custom").click();
    const confirmation = configurator.getByTestId("workspace-settings-agents-config-remove-confirmation-custom");
    await expect(confirmation).toContainText("Invocation History stays available.");
    expect(((await persistedSettings(fixture.settingsPath)).agentCommands as Array<{ id: string }>).some((entry) => entry.id === "custom"))
      .toBe(true);
    await configurator.getByTestId("workspace-settings-agents-config-confirm-remove-custom").click();
    await expect(fixture.page.getByTestId("workspace-settings-status")).toHaveText("Settings saved.");
    await expect.poll(async () => (await persistedSettings(fixture.settingsPath)).agentCommands)
      .toEqual([
        expect.objectContaining({ id: "claude" }),
        expect.objectContaining({ id: "codex" }),
      ]);
    await expect(access(path.join(fixture.workspaceRoot, ".exograph/invocations", historyId, "record.json"))).resolves.toBeUndefined();
    await expect(access(markerPath)).rejects.toMatchObject({ code: "ENOENT" });

    await expect.poll(() => fixture.page.evaluate((targetPath) =>
      window.exograph.workspace.listInvocationHistory(targetPath), notePath))
      .toEqual([
        expect.objectContaining({
          invocationId: historyId,
          command: { handle: "local", label: "Local" },
          outcome: "failed",
        }),
      ]);
    const removedError = await fixture.page.evaluate(async (targetPath) => {
      try {
        await window.exograph.workspace.getAgentInvocationAuthorization({ handle: "local", documentPath: targetPath });
        return null;
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    }, notePath);
    expect(removedError).toContain("No AgentCommand is configured for @local.");

    await configurator.getByTestId("workspace-settings-agents-config-remove-codex").click();
    await configurator.getByTestId("workspace-settings-agents-config-confirm-remove-codex").click();
    await expect(configurator.getByTestId("workspace-settings-agents-config-add-codex")).toBeVisible();
    await configurator.getByTestId("workspace-settings-agents-config-add-codex").click();
    await expect(configurator.getByRole("textbox", { name: "Codex command" })).toHaveValue(/codex exec/);
  } finally {
    await fixture.cleanup();
  }
});

test("structural Settings Apply preserves retained Indexed Root policy", async () => {
  const fixture = await launchExographWorkspaceFixture({
    mutable: true,
    prepareSettings: async ({ settingsPath, workspaceRoot }) => {
      const notesPath = path.join(workspaceRoot, "notes/test-notes");
      await writeFile(settingsPath, JSON.stringify({
        workspaceRoot,
        defaultTerminalCwd: workspaceRoot,
        noteRoots: [notesPath],
        indexedRoots: [{
          id: "research-docs",
          label: "Research documents",
          path: notesPath,
          kind: "docs",
          pattern: "**/*.{md,mdx}",
          ignore: ["private/**", "archive/**"],
          backend: "qmd",
        }],
        indexing: { enabled: true, mode: "lexical", backend: "qmd" },
        searchEngine: "qmd",
        appearanceMode: "system",
        colorThemeId: "exograph-neutral",
        editorFontSize: 15,
        terminalFontSize: 13,
        explorerScale: 1,
        exploreIndexSearchOnEnter: false,
        indexUpdateStrategy: "on-save",
      }, null, 2), "utf8");
    },
  });

  try {
    const expectedRoot = {
      id: "research-docs",
      label: "Research documents",
      path: path.join(fixture.workspaceRoot, "notes/test-notes"),
      kind: "docs",
      pattern: "**/*.{md,mdx}",
      ignore: ["private/**", "archive/**"],
      backend: "qmd",
    };
    await fixture.page.getByTestId("workspace-menu-toggle").click();
    await fixture.page.getByTestId("workspace-menu-settings").click();
    await expect(fixture.page.getByTestId("workspace-settings-dialog")).toBeVisible();

    const workspaceRoot = fixture.page.getByTestId("workspace-settings-workspace-root");
    await workspaceRoot.fill(`${fixture.workspaceRoot} `);
    await fixture.page.getByTestId("workspace-settings-apply").click();
    await expect(fixture.page.getByTestId("workspace-settings-apply-status")).toHaveText("Changes applied.");
    await expect(fixture.page.getByTestId("workspace-settings-apply")).toHaveCount(0);
    await expect.poll(() => persistedSettings(fixture.settingsPath)).toMatchObject({ indexedRoots: [expectedRoot] });
    await fixture.page.getByTestId("workspace-settings-close").click();
    await fixture.page.getByTestId("workspace-menu-toggle").click();
    await fixture.page.getByTestId("workspace-menu-settings").click();
    await expect(fixture.page.getByTestId("workspace-settings-apply")).toHaveCount(0);
  } finally {
    await fixture.cleanup();
  }
});

test("structural Apply reports an external revision conflict without overwriting it", async () => {
  const fixture = await launchExographWorkspaceFixture({ mutable: true });

  try {
    await fixture.page.waitForTimeout(1_100);
    await openSettingsSection(fixture.page, "workspace");
    await fixture.page.getByTestId("workspace-settings-workspace-root").fill(`${fixture.workspaceRoot} `);

    await fixture.page.evaluate(async () => {
      const snapshot = await window.exograph.workspace.getSettings();
      await window.exograph.workspace.saveSettings({
        settings: { ...snapshot.settings, terminalFontSize: 17 },
        expectedRevision: snapshot.revision,
      });
    });

    await fixture.page.getByTestId("workspace-settings-apply").click();
    await expect(fixture.page.locator(".dialog-card__status--error")).toContainText(
      "Workspace settings changed since this edit began",
    );
    await expect(fixture.page.getByTestId("workspace-settings-apply")).toBeVisible();
    await expect.poll(() => persistedSettings(fixture.settingsPath)).toMatchObject({
      workspaceRoot: fixture.workspaceRoot,
      terminalFontSize: 17,
    });
  } finally {
    await fixture.cleanup();
  }
});

test("re-enabling QMD preserves retained Indexed Roots through restart", async () => {
  const fixture = await launchExographWorkspaceFixture({
    mutable: true,
    prepareSettings: async ({ settingsPath, workspaceRoot }) => {
      const notesPath = path.join(workspaceRoot, "notes/test-notes");
      await writeFile(settingsPath, JSON.stringify({
        workspaceRoot,
        defaultTerminalCwd: workspaceRoot,
        noteRoots: [notesPath],
        indexedRoots: [
          {
            id: "research-docs",
            label: "Research documents",
            path: path.join(notesPath, "research"),
            kind: "docs",
            pattern: "**/*.mdx",
            ignore: ["private/**"],
            backend: "qmd",
          },
          {
            id: "source-code",
            label: "Source code",
            path: path.join(notesPath, "code"),
            kind: "code",
            pattern: "**/*.{ts,tsx}",
            ignore: ["generated/**"],
            backend: "qmd",
          },
        ],
        indexing: { enabled: false, mode: "off", backend: "qmd" },
        searchEngine: "filesystem",
      }, null, 2), "utf8");
    },
  });
  let relaunched: Awaited<ReturnType<typeof relaunchExographWorkspaceFixture>> | null = null;

  try {
    const before = await persistedSettings(fixture.settingsPath);
    await openSettingsSection(fixture.page, "index");
    await fixture.page.getByTestId("workspace-settings-search-engine-qmd").click();
    await fixture.page.getByTestId("workspace-settings-apply").click();
    await expect(fixture.page.getByTestId("workspace-settings-apply")).toHaveCount(0);
    await expect.poll(() => persistedSettings(fixture.settingsPath)).toMatchObject({
      indexedRoots: before.indexedRoots,
      indexing: { enabled: true, mode: "lexical", backend: "qmd" },
      searchEngine: "qmd",
    });

    await fixture.electronApp.close();
    relaunched = await relaunchExographWorkspaceFixture(fixture);
    await openSettingsSection(relaunched.page, "index");
    await expect(relaunched.page.getByTestId("workspace-settings-search-engine-qmd")).toBeChecked();
    await expect(relaunched.page.getByTestId("workspace-settings-apply")).toHaveCount(0);
    expect((await persistedSettings(fixture.settingsPath)).indexedRoots).toEqual(before.indexedRoots);
  } finally {
    await relaunched?.electronApp.close().catch(() => {});
    await fixture.cleanup();
  }
});

test("QMD setup defaults empty roots once and remains idempotent after restart", async () => {
  const fixture = await launchExographWorkspaceFixture({
    mutable: true,
    prepareSettings: async ({ settingsPath, workspaceRoot }) => {
      const notesPath = path.join(workspaceRoot, "notes/test-notes");
      await writeFile(settingsPath, JSON.stringify({
        workspaceRoot,
        defaultTerminalCwd: workspaceRoot,
        noteRoots: [notesPath],
        indexedRoots: [],
        indexing: { enabled: false, mode: "off", backend: "qmd" },
        searchEngine: "filesystem",
      }, null, 2), "utf8");
    },
  });
  let relaunched: Awaited<ReturnType<typeof relaunchExographWorkspaceFixture>> | null = null;

  try {
    const noteRoot = path.join(fixture.workspaceRoot, "notes/test-notes");
    const expectedRoot = {
      id: "index-root-1",
      label: "test-notes",
      path: noteRoot,
      kind: "mixed",
      pattern: "**/*.md",
      ignore: [],
      backend: "qmd",
    };
    await openSettingsSection(fixture.page, "index");
    await fixture.page.getByTestId("workspace-settings-search-engine-qmd").click();
    await fixture.page.getByTestId("workspace-settings-apply").click();
    await expect(fixture.page.getByTestId("workspace-settings-apply")).toHaveCount(0);
    await expect.poll(() => persistedSettings(fixture.settingsPath)).toMatchObject({ indexedRoots: [expectedRoot] });

    await fixture.electronApp.close();
    relaunched = await relaunchExographWorkspaceFixture(fixture);
    await openSettingsSection(relaunched.page, "index");
    await relaunched.page.getByTestId("workspace-settings-search-engine-qmd").click();
    await expect(relaunched.page.getByTestId("workspace-settings-apply")).toHaveCount(0);
    expect((await persistedSettings(fixture.settingsPath)).indexedRoots).toEqual([expectedRoot]);
  } finally {
    await relaunched?.electronApp.close().catch(() => {});
    await fixture.cleanup();
  }
});

async function editSettingsAndClose(page: Page, section: "appearance" | "graph" | "index" | "terminal", edit: (page: Page) => Promise<void>): Promise<void> {
  await page.getByTestId("workspace-menu-toggle").click();
  await page.getByTestId("workspace-menu-settings").click();
  await expect(page.getByTestId("workspace-settings-dialog")).toBeVisible();
  await page.getByTestId(`workspace-settings-tab-${section}`).click();
  await edit(page);
  await expect(page.getByTestId("workspace-settings-status")).toContainText("Settings saved.");
  await page.getByTestId("workspace-settings-close").click();
  await expect(page.getByTestId("workspace-settings-dialog")).not.toBeVisible();
}

async function openSettingsSection(page: Page, section: "workspace" | "index" | "graph"): Promise<void> {
  await page.getByTestId("workspace-menu-toggle").click();
  await page.getByTestId("workspace-menu-settings").click();
  await expect(page.getByTestId("workspace-settings-dialog")).toBeVisible();
  await page.getByTestId(`workspace-settings-tab-${section}`).click();
}

async function expectPreservedSettings(settingsPath: string, seeded: Record<string, unknown>, expectedOwnedValues: Record<string, unknown>): Promise<void> {
  await expect.poll(() => persistedSettings(settingsPath)).toMatchObject(expectedOwnedValues);
  const persisted = await persistedSettings(settingsPath);
  expect(persisted.agentCommands).toEqual(seeded.agentCommands);
  expect(persisted.layout).toEqual(seeded.layout);
  expect(persisted.futureSetting).toEqual(seeded.futureSetting);
  expect(persisted.futureWorkspaceMetadata).toEqual(seeded.futureWorkspaceMetadata);
}

async function persistedSettings(settingsPath: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(settingsPath, "utf8")) as Record<string, unknown>;
}

function preservedLayout(focusNotePath: string): WorkspaceCanvasLayoutSettings {
  return {
    version: 3,
    canvas: {
      kind: "leaf",
      id: "preserved-editor",
      content: { kind: "editor", openPaths: [focusNotePath], activePath: focusNotePath },
    },
    sidebarCollapsed: false,
    sidebarWidth: 275,
    utilityWidth: 430,
  };
}
