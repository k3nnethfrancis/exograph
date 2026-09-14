import { _electron as electron, expect, test, type Locator, type Page } from "@playwright/test";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  createDefaultClaudeAgentCommand,
  createDefaultCodexAgentCommand,
} from "@exograph/core/default-agent-command";
import { saveWorkspaceSettings, type WorkspaceSettings } from "@exograph/core";

import { launchExographWorkspaceFixture, relaunchExographWorkspaceFixture } from "../helpers";

const customClaudeCommand = "/bin/echo claude-clean-state";
const customCodexCommand = "/bin/echo codex-clean-state";
const customLocalCommand = "/bin/echo local-clean-state";
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

for (const activeFileState of ["missing", "invalid"] as const) {
  test(`shows onboarding when active settings are ${activeFileState} and a registry Workspace survives`, async () => {
    const { page, cleanup } = await launchExographWorkspaceFixture({
      configured: false,
      cwd: "/",
      workspaceRootEnv: false,
      runtimeRootEnv: false,
      prepareSettings: async ({ settingsPath, userDataRoot, workspaceRoot }) => {
        await saveWorkspaceSettings(workspaceSettings(path.join(workspaceRoot, "notes", "test-notes")), {
          EXOGRAPH_SETTINGS_PATH: settingsPath,
          EXOGRAPH_USER_DATA_PATH: userDataRoot,
        });
        if (activeFileState === "missing") {
          await rm(settingsPath);
        } else {
          await writeFile(settingsPath, "{ invalid", "utf8");
        }
      },
    });

    await expect(page.getByTestId("onboarding")).toContainText("Choose a wiki");
    await expect(page.getByTestId("workspace-picker-item")).toHaveCount(1);
    await expect(page.getByTestId("sidebar")).toHaveCount(0);

    await cleanup();
  });
}

test("opens valid persisted settings without a fixture Workspace bypass", async () => {
  const { page, cleanup } = await launchExographWorkspaceFixture({
    configured: false,
    expectOnboarding: false,
    workspaceRootEnv: false,
    runtimeRootEnv: false,
    prepareSettings: async ({ settingsPath, userDataRoot, workspaceRoot }) => {
      await saveWorkspaceSettings(workspaceSettings(path.join(workspaceRoot, "notes", "test-notes")), {
        EXOGRAPH_SETTINGS_PATH: settingsPath,
        EXOGRAPH_USER_DATA_PATH: userDataRoot,
      });
    },
  });

  await expect(page.getByTestId("onboarding")).toHaveCount(0);
  await expect(page.getByTestId("sidebar")).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.exograph.workspace.getSetupState())).toMatchObject({
    complete: true,
    onboardingComplete: true,
    onboarding: { status: "not-started" },
  });

  await cleanup();
});

test("resumes the exact confirmed draft across reload and relaunch at every setup page", async () => {
  const first = await launchExographWorkspaceFixture({
    configured: false,
    mutable: true,
    workspaceRootEnv: false,
    runtimeRootEnv: false,
    env: { PATH: "/usr/bin:/bin" },
    prepareHome: prepareFakeProviderHome,
    prepareWorkspace: async (workspaceRoot) => {
      await writeFile(path.join(workspaceRoot, "notes", "test-notes", "package.json"), "{}\n", "utf8");
    },
    selectFolderPath: (workspaceRoot) => path.join(workspaceRoot, "notes", "test-notes"),
  });
  const noteRoot = path.join(first.workspaceRoot, "notes", "test-notes");
  const prompt = "Resume {{message}} from {{working_note}} with {{protocol}}.";
  let activeApp = first.electronApp;
  let activePage = first.page;

  await activePage.getByTestId("onboarding-choose-notes").click();
  await expect(activePage.getByTestId("onboarding-notes-folder")).toContainText(noteRoot);
  await expect(readOptional(first.settingsPath)).resolves.toBeNull();
  await expect(pathExists(path.join(noteRoot, ".exograph"))).resolves.toBe(false);
  await activePage.reload();
  await expect(activePage.getByRole("heading", { name: "Choose your main wiki" })).toBeVisible();
  await expect(activePage.getByTestId("onboarding-notes-folder")).toContainText(noteRoot);

  await activeApp.close();
  let resumed = await relaunchExographWorkspaceFixture(first, {
    configured: false,
    workspaceRootEnv: false,
    runtimeRootEnv: false,
    expectOnboarding: true,
    env: { PATH: "/usr/bin:/bin" },
  });
  activeApp = resumed.electronApp;
  activePage = resumed.page;
  await expect(activePage.getByRole("heading", { name: "Choose your main wiki" })).toBeVisible();
  await expect(activePage.getByTestId("onboarding-notes-folder")).toContainText(noteRoot);

  await activePage.getByTestId("onboarding-continue").click();
  await expect(activePage.getByRole("heading", { name: "Code repository detected" })).toBeVisible();
  await expect(activePage.getByTestId("onboarding-content-scope-notes")).toHaveAttribute("aria-pressed", "true");
  await expect.poll(() => activePage.evaluate(() => window.exograph.workspace.getSetupState())).toMatchObject({
    onboarding: {
      draft: {
        contentPolicyChoice: "recommended",
        contentPolicy: { excludedPaths: expect.arrayContaining(["node_modules/**"]) },
      },
    },
  });
  await activePage.reload();
  await expect(activePage.getByRole("heading", { name: "Code repository detected" })).toBeVisible();
  await expect(activePage.getByTestId("onboarding-content-scope-notes")).toHaveAttribute("aria-pressed", "true");

  await activeApp.close();
  resumed = await relaunchExographWorkspaceFixture(first, {
    configured: false,
    workspaceRootEnv: false,
    runtimeRootEnv: false,
    expectOnboarding: true,
    env: { PATH: "/usr/bin:/bin" },
  });
  activeApp = resumed.electronApp;
  activePage = resumed.page;
  await expect(activePage.getByRole("heading", { name: "Code repository detected" })).toBeVisible();
  await expect(activePage.getByTestId("onboarding-content-scope-notes")).toHaveAttribute("aria-pressed", "true");
  await activePage.getByTestId("onboarding-content-scope-all").click();
  await activePage.reload();
  await expect(activePage.getByTestId("onboarding-content-scope-all")).toHaveAttribute("aria-pressed", "true");
  await expect.poll(() => activePage.evaluate(() => window.exograph.workspace.getSetupState())).toMatchObject({
    onboarding: {
      draft: {
        contentPolicyChoice: "explicit",
        contentPolicy: { excludedPaths: [] },
      },
    },
  });

  await activePage.getByRole("button", { name: "Continue to tools" }).click();
  await expect(activePage.getByRole("heading", { name: "Agent access" })).toBeVisible();
  await activePage.locator(".onboarding-provider-menu__item").filter({ hasText: "Codex" }).click();
  await activePage.getByRole("button", { name: "Install MCP" }).click();
  await expect(activePage.getByText("Added Exograph MCP to Claude.")).toBeVisible();
  await expect.poll(() => readOptional(path.join(first.homeRoot, "claude-mcp.log"))).toContain("mcp\nadd\n--scope\nuser\nexo");
  await activePage.reload();
  await expect(activePage.getByRole("heading", { name: "Agent access" })).toBeVisible();
  await expect(activePage.locator(".onboarding-provider-menu__item").filter({ hasText: "Claude" })).toHaveAttribute("aria-pressed", "true");
  await expect(activePage.locator(".onboarding-provider-menu__item").filter({ hasText: "Codex" })).toHaveAttribute("aria-pressed", "false");
  await expect(activePage.getByText(/Added Exograph MCP|already installed/)).toHaveCount(0);

  await activeApp.close();
  resumed = await relaunchExographWorkspaceFixture(first, {
    configured: false,
    workspaceRootEnv: false,
    runtimeRootEnv: false,
    expectOnboarding: true,
    env: { PATH: "/usr/bin:/bin" },
  });
  activeApp = resumed.electronApp;
  activePage = resumed.page;
  await expect(activePage.getByRole("heading", { name: "Agent access" })).toBeVisible();
  await expect(activePage.locator(".onboarding-provider-menu__item").filter({ hasText: "Codex" })).toHaveAttribute("aria-pressed", "false");
  await expect(activePage.getByText(/Added Exograph MCP|already installed/)).toHaveCount(0);

  await activePage.getByRole("button", { name: "Set up CLI agents" }).click();
  const claudeInput = activePage.getByRole("textbox", { name: "Claude command" });
  await claudeInput.fill(customClaudeCommand);
  await claudeInput.press("Tab");
  await activePage.locator(".agent-invocation-prompt-disclosure > summary").click();
  await activePage.getByTestId("onboarding-invocation-prompt-edit").click();
  await activePage.getByTestId("onboarding-invocation-prompt-input").fill(prompt);
  await activePage.getByTestId("onboarding-invocation-prompt-save").click();
  await activePage.reload();
  await expect(activePage.getByRole("heading", { name: "Set up agents" })).toBeVisible();
  await expect(activePage.getByRole("textbox", { name: "Claude command" })).toHaveValue(customClaudeCommand);
  await expect(activePage.getByTestId("onboarding-invocation-prompt")).toContainText(prompt);
  await expect(readOptional(first.settingsPath)).resolves.toBeNull();
  await expect(pathExists(path.join(noteRoot, ".exograph"))).resolves.toBe(false);

  await activeApp.close();
  resumed = await relaunchExographWorkspaceFixture(first, {
    configured: false,
    workspaceRootEnv: false,
    runtimeRootEnv: false,
    expectOnboarding: true,
    env: { PATH: "/usr/bin:/bin" },
  });
  activeApp = resumed.electronApp;
  activePage = resumed.page;
  await expect(activePage.getByRole("heading", { name: "Set up agents" })).toBeVisible();
  await expect(activePage.getByRole("textbox", { name: "Claude command" })).toHaveValue(customClaudeCommand);
  await expect(activePage.getByTestId("onboarding-invocation-prompt")).toContainText(prompt);

  await activeApp.close();
  await first.cleanup();
});

test("saved settings cannot bypass an explicit in-progress draft", async () => {
  const first = await launchExographWorkspaceFixture({
    configured: false,
    mutable: true,
    workspaceRootEnv: false,
    runtimeRootEnv: false,
    selectFolderPath: (workspaceRoot) => path.join(workspaceRoot, "notes", "test-notes"),
  });
  const noteRoot = path.join(first.workspaceRoot, "notes", "test-notes");

  await continueToAgents(first.page);
  await first.page.getByRole("textbox", { name: "Claude command" }).fill(customClaudeCommand);
  await first.page.getByRole("textbox", { name: "Claude command" }).press("Tab");
  await first.page.evaluate(async (settings) => {
    const snapshot = await window.exograph.workspace.getSettings();
    await window.exograph.workspace.saveSettings({ settings, expectedRevision: snapshot.revision });
  }, workspaceSettings(noteRoot));

  await expect(readOptional(first.settingsPath)).resolves.not.toBeNull();
  await first.page.reload();
  await expect(first.page.getByRole("heading", { name: "Set up agents" })).toBeVisible();
  await expect(first.page.getByTestId("sidebar")).toHaveCount(0);
  await expect(first.page.getByRole("textbox", { name: "Claude command" })).toHaveValue(customClaudeCommand);
  await first.electronApp.close();

  const restarted = await relaunchExographWorkspaceFixture(first, {
    configured: false,
    workspaceRootEnv: false,
    runtimeRootEnv: false,
    expectOnboarding: true,
  });
  await expect(restarted.page.getByRole("heading", { name: "Set up agents" })).toBeVisible();
  await expect(restarted.page.getByTestId("sidebar")).toHaveCount(0);
  await restarted.electronApp.close();
  await first.cleanup();
});

test("shows non-destructive recovery for malformed progress", async () => {
  let malformed = "";
  const fixture = await launchExographWorkspaceFixture({
    configured: false,
    workspaceRootEnv: false,
    runtimeRootEnv: false,
    prepareSettings: async ({ settingsPath, userDataRoot, workspaceRoot }) => {
      await saveWorkspaceSettings(workspaceSettings(path.join(workspaceRoot, "notes", "test-notes")), {
        EXOGRAPH_SETTINGS_PATH: settingsPath,
        EXOGRAPH_USER_DATA_PATH: userDataRoot,
      });
      malformed = path.join(userDataRoot, "onboarding-state.json");
      await writeFile(malformed, "{ truncated", "utf8");
    },
  });

  await expect(fixture.page.getByTestId("onboarding-recovery")).toContainText("Setup progress needs recovery");
  await expect(fixture.page.getByTestId("sidebar")).toHaveCount(0);
  await expect(readFile(malformed, "utf8")).resolves.toBe("{ truncated");
  await fixture.page.getByTestId("onboarding-restart-setup").click();
  await expect(fixture.page.getByRole("heading", { name: "Choose a wiki" })).toBeVisible();
  await expect.poll(async () => JSON.parse(await readFile(malformed, "utf8"))).toMatchObject({ status: "not-started" });

  await fixture.cleanup();
});

test("a cancelled folder choice leaves first-run state empty and writes nothing", async () => {
  const { page, cleanup, settingsPath } = await launchExographWorkspaceFixture({
    configured: false,
    cwd: "/",
    workspaceRootEnv: false,
    runtimeRootEnv: false,
    env: { EXOGRAPH_TEST_SELECT_FOLDER_CANCEL: "1" },
  });

  await page.getByTestId("onboarding-choose-notes").click();

  await expect(page.getByTestId("onboarding-notes-folder")).toContainText("No main wiki selected.");
  await expect(page.getByTestId("onboarding-continue")).toBeDisabled();
  await expect(readOptional(settingsPath)).resolves.toBeNull();

  await cleanup();
});

test("keeps MCP and CLI setup independent without touching real provider state", async () => {
  const { page, cleanup, homeRoot } = await launchExographWorkspaceFixture({
    configured: false,
    mutable: true,
    workspaceRootEnv: false,
    runtimeRootEnv: false,
    env: { PATH: "/usr/bin:/bin" },
    selectFolderPath: (workspaceRoot) => path.join(workspaceRoot, "notes", "test-notes"),
    prepareHome: prepareFakeProviderHome,
  });

  await page.getByTestId("onboarding-choose-notes").click();
  await page.getByTestId("onboarding-continue").click();
  await continueFromContentPolicy(page);
  await expect(page.getByRole("heading", { name: "Agent access" })).toBeVisible();
  await expect(page.getByText("Choose CLI, MCP, or both.")).toBeVisible();
  // CLI inspection is asynchronous; wait for the deliberately fake packaged
  // command before taking the control snapshot for the MCP-isolation check.
  await expect(page.locator(".onboarding-cli-installation")).toContainText("CLI installed");
  const cliStateBefore = await page.locator(".onboarding-cli-installation").innerText();

  await page.locator(".onboarding-provider-menu__item").filter({ hasText: "Codex" }).click();
  await page.getByRole("button", { name: "Install MCP" }).click();

  await expect(page.getByText("Added Exograph MCP to Claude.")).toBeVisible();
  await expect.poll(() => readOptional(path.join(homeRoot, "claude-mcp.log"))).toContain("mcp\nadd\n--scope\nuser\nexo");
  expect(await page.locator(".onboarding-cli-installation").innerText()).toBe(cliStateBefore);

  await cleanup();
});

test("installs the bundled CLI before enabling MCP", async () => {
  const { page, cleanup, homeRoot } = await launchExographWorkspaceFixture({
    configured: false,
    mutable: true,
    workspaceRootEnv: false,
    runtimeRootEnv: false,
    env: { PATH: "/usr/bin:/bin" },
    selectFolderPath: (workspaceRoot) => path.join(workspaceRoot, "notes", "test-notes"),
    prepareHome: async (root) => {
      const bin = path.join(root, ".local", "bin");
      await mkdir(bin, { recursive: true });
      await Promise.all([
        writeExecutable(path.join(bin, "claude"), "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$HOME/claude-mcp.log\"\n"),
        writeExecutable(path.join(bin, "codex"), "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$HOME/codex-mcp.log\"\n"),
      ]);
    },
  });

  try {
    await page.getByTestId("onboarding-choose-notes").click();
    await page.getByTestId("onboarding-continue").click();
    await continueFromContentPolicy(page);
    await expect(page.locator(".onboarding-cli-installation")).toContainText("CLI not installed");
    await expect(page.getByRole("button", { name: "Install MCP" })).toBeDisabled();

    await page.getByRole("button", { name: "Install CLI" }).click();
    await expect(page.locator(".onboarding-cli-installation")).toContainText("CLI installed");
    await expect(page.locator(".onboarding-cli-installation")).toContainText("Available to Exograph and MCP");
    await expect(page.locator(".onboarding-cli-shell-path")).toContainText('export PATH="$HOME/.local/bin:$PATH"');
    await expect(readOptional(path.join(homeRoot, ".local", "bin", "exo"))).resolves.toContain("exograph-packaged-cli");

    await page.getByRole("button", { name: "Install MCP" }).click();
    await expect(page.getByText("Added Exograph MCP to Claude.")).toBeVisible();
  } finally {
    await cleanup();
  }
});

test("resumes a new main wiki draft launched from an existing workspace", async () => {
  const first = await launchExographWorkspaceFixture({
    mutable: true,
    configured: false,
    expectOnboarding: false,
    workspaceRootEnv: false,
    runtimeRootEnv: false,
    selectFolderPath: (workspaceRoot) => path.join(workspaceRoot, "notes", "test-notes"),
    prepareSettings: async ({ settingsPath, userDataRoot, workspaceRoot }) => {
      await saveWorkspaceSettings(workspaceSettings(path.join(workspaceRoot, "notes", "test-notes")), {
        EXOGRAPH_SETTINGS_PATH: settingsPath,
        EXOGRAPH_USER_DATA_PATH: userDataRoot,
      });
    },
  });
  try {
    await first.page.getByTestId("workspace-menu-toggle").click();
    await first.page.getByTestId("workspace-menu-settings").click();
    await first.page.getByRole("button", { name: "Switch workspace" }).click();
    await first.page.getByTestId("workspace-picker-new").click();
    await first.page.getByTestId("onboarding-choose-notes").click();
    await first.page.getByTestId("onboarding-continue").click();
    await expect(first.page.getByRole("heading", { name: "Agent access" })).toBeVisible();

    await first.electronApp.close();
    const resumed = await relaunchExographWorkspaceFixture(first, {
      configured: false,
      workspaceRootEnv: false,
      runtimeRootEnv: false,
      expectOnboarding: true,
    });
    try {
      await expect(resumed.page.getByRole("heading", { name: "Agent access" })).toBeVisible();
      await resumed.page.getByRole("button", { name: "Back" }).click();
      await expect(resumed.page.getByTestId("onboarding-notes-folder"))
        .toContainText(path.join(first.workspaceRoot, "notes", "test-notes"));
    } finally {
      await resumed.cleanup();
    }
  } catch (error) {
    await first.cleanup();
    throw error;
  }
});

test("persists an explicit Note Root and edited recommended Commands across restart", async () => {
  const first = await launchExographWorkspaceFixture({
    configured: false,
    mutable: true,
    workspaceRootEnv: false,
    runtimeRootEnv: false,
    selectFolderPath: (workspaceRoot) => path.join(workspaceRoot, "notes", "test-notes"),
  });
  const selectedNoteRoot = path.join(first.workspaceRoot, "notes", "test-notes");

  await first.page.getByTestId("onboarding-choose-notes").click();
  await first.page.getByTestId("onboarding-continue").click();
  await continueFromContentPolicy(first.page);
  await first.page.getByRole("button", { name: "Set up CLI agents" }).click();
  const claudeInput = first.page.getByRole("textbox", { name: "Claude command" });
  const codexInput = first.page.getByRole("textbox", { name: "Codex command" });
  await expect(claudeInput).toHaveValue(/claude -p/);
  await expect(codexInput).toHaveValue(/codex exec/);
  expect((await claudeInput.boundingBox())?.width ?? 0).toBeGreaterThan(600);
  await claudeInput.fill(customClaudeCommand);
  await codexInput.fill(customCodexCommand);
  await first.page.getByTestId("onboarding-agents-config-add-custom").click();
  await first.page.getByRole("textbox", { name: "Custom command name" }).fill("Local");
  await first.page.getByRole("textbox", { name: "Custom command handle" }).fill("local");
  await first.page.getByRole("textbox", { name: "Custom command executable and arguments" }).fill(customLocalCommand);
  await first.page.getByTestId("onboarding-agents-config-confirm-custom").click();
  await first.page.getByRole("button", { name: "Open Exograph" }).click();

  await expect(first.page.getByTestId("sidebar")).toBeVisible();
  const workspaceRuntimeRoot = path.join(selectedNoteRoot, ".exograph");
  await expect.poll(() => readCommandDiscovery(workspaceRuntimeRoot)).toMatchObject({
    port: expect.any(Number),
    token: expect.any(String),
  });
  const firstSettings = JSON.parse(await readFile(first.settingsPath, "utf8")) as WorkspaceSettings;
  expect(firstSettings.noteRoots).toEqual([selectedNoteRoot]);
  expect(firstSettings.agentCommands?.map((command) => command.command)).toEqual([
    customClaudeCommand,
    customCodexCommand,
    customLocalCommand,
  ]);
  await first.electronApp.close();

  const restarted = await relaunchExographWorkspaceFixture(first, {
    configured: false,
    workspaceRootEnv: false,
    runtimeRootEnv: false,
  });
  await expect(restarted.page.getByTestId("onboarding")).toHaveCount(0);
  await expect(restarted.page.getByTestId("sidebar")).toBeVisible();
  await expect.poll(async () => restarted.page.evaluate(() => window.exograph.workspace.getSettings()))
    .toMatchObject({
      settings: {
        noteRoots: [selectedNoteRoot],
          agentCommands: [
            expect.objectContaining({ handle: "claude", command: customClaudeCommand }),
            expect.objectContaining({ handle: "codex", command: customCodexCommand }),
            expect.objectContaining({ handle: "local", command: customLocalCommand }),
          ],
        },
      });
  await restarted.page.getByTestId("workspace-menu-toggle").click();
  await restarted.page.getByTestId("workspace-menu-settings").click();
  await restarted.page.getByTestId("workspace-settings-tab-agents").click();
  await expect(restarted.page.getByTestId("workspace-settings-agents-config-command-custom")).toContainText("@local");
  await expect.poll(() => readCommandDiscovery(workspaceRuntimeRoot)).toMatchObject({
    port: expect.any(Number),
    token: expect.any(String),
  });

  await restarted.electronApp.close();
  await first.cleanup();
});

test("skips repository scope for a generic wiki", async () => {
  const { page, cleanup } = await launchExographWorkspaceFixture({
    configured: false,
    mutable: true,
    workspaceRootEnv: false,
    runtimeRootEnv: false,
    selectFolderPath: (workspaceRoot) => path.join(workspaceRoot, "notes", "test-notes"),
  });

  try {
    await page.getByTestId("onboarding-choose-notes").click();
    await page.getByTestId("onboarding-continue").click();

    await expect(page.getByRole("heading", { name: "Agent access" })).toBeVisible();
    await expect(page.getByTestId("onboarding-content-scope")).toHaveCount(0);
  } finally {
    await cleanup();
  }
});

test("recommends repository-safe Notes while preserving a manual All Markdown override", async () => {
  const first = await launchExographWorkspaceFixture({
    configured: false,
    mutable: true,
    workspaceRootEnv: false,
    runtimeRootEnv: false,
    prepareWorkspace: async (workspaceRoot) => {
      const repositoryRoot = path.join(workspaceRoot, "repository-wiki");
      await mkdir(repositoryRoot, { recursive: true });
      await Promise.all([
        writeFile(path.join(repositoryRoot, "README.md"), "# Repository wiki\n", "utf8"),
        writeFile(path.join(repositoryRoot, "package.json"), "{\"name\":\"repository-wiki\"}\n", "utf8"),
      ]);
    },
    selectFolderPath: (workspaceRoot) => path.join(workspaceRoot, "repository-wiki"),
  });
  const selectedNoteRoot = path.join(first.workspaceRoot, "repository-wiki");

  try {
    await first.page.getByTestId("onboarding-choose-notes").click();
    await first.page.getByTestId("onboarding-continue").click();

    await expect(first.page.getByRole("heading", { name: "Code repository detected" })).toBeVisible();
    await expect(first.page.getByText("Code files never become Notes.")).toBeVisible();
    await expect(first.page.getByText("Tool folders include build, dist, coverage, node_modules, release, and vendor.")).toBeVisible();
    await expect(first.page.getByTestId("onboarding-content-scope-notes")).toHaveAttribute("aria-pressed", "true");
    await expect(first.page.getByTestId("onboarding-content-scope-all")).toHaveAttribute("aria-pressed", "false");

    await first.page.getByTestId("onboarding-content-scope-all").click();
    await expect(first.page.getByTestId("onboarding-content-scope-all")).toHaveAttribute("aria-pressed", "true");
    await expect(first.page.getByTestId("onboarding-content-scope-notes")).toHaveAttribute("aria-pressed", "false");

    await continueFromContentPolicy(first.page);
    await first.page.getByRole("button", { name: "Set up CLI agents" }).click();
    await first.page.getByRole("button", { name: "Open Exograph" }).click();
    await expect(first.page.getByTestId("sidebar")).toBeVisible();
    await expect.poll(async () => first.page.evaluate(() => window.exograph.workspace.getSettings()))
      .toMatchObject({
        settings: {
          noteRoots: [selectedNoteRoot],
          contentPolicy: { excludedPaths: [], sourceVisibility: false },
        },
      });
  } finally {
    await first.cleanup();
  }
});

for (const viewport of [
  { label: "desktop", width: 1200, height: 800, agentsScroll: false },
  { label: "compact", width: 700, height: 560, agentsScroll: true },
] as const) {
  test(`keeps every onboarding page anchored with internal scrolling at the ${viewport.label} viewport`, async () => {
    const { page, cleanup } = await launchExographWorkspaceFixture({
      configured: false,
      mutable: true,
      workspaceRootEnv: false,
      runtimeRootEnv: false,
      selectFolderPath: (workspaceRoot) => path.join(workspaceRoot, "notes", "test-notes"),
    });

    try {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.getByTestId("onboarding-choose-notes").click();
      const expectedGeometry = await onboardingGeometry(
        page,
        page.getByTestId("onboarding-continue"),
      );

      await page.getByTestId("onboarding-continue").click();
      await expect(page.getByRole("heading", { name: "Agent access" })).toBeVisible();
      await expectOnboardingGeometry(
        page,
        page.getByRole("button", { name: "Set up CLI agents" }),
        expectedGeometry,
      );

      await expectInternalScroll(page.getByTestId("onboarding-card-body"));

      await page.getByRole("button", { name: "Set up CLI agents" }).click();
      await expect(page.getByRole("heading", { name: "Set up agents" })).toBeVisible();
      await expectOnboardingGeometry(
        page,
        page.getByRole("button", { name: "Open Exograph" }),
        expectedGeometry,
      );
      if (viewport.agentsScroll) {
        await expectInternalScroll(page.getByTestId("onboarding-card-body"));
      }
    } finally {
      await cleanup();
    }
  });
}

test("completes and restarts the real packaged first-run journey", async () => {
  const appBundle = process.env.EXOGRAPH_PACKAGED_APP_PATH;
  test.skip(!appBundle, "Set EXOGRAPH_PACKAGED_APP_PATH to a built Exograph.app to run packaged first-run proof.");
  const root = await mkdtemp(path.join(os.tmpdir(), "exograph-packaged-onboarding-"));
  const userDataRoot = path.join(root, "user-data");
  const runtimeRoot = path.join(root, "runtime");
  const homeRoot = path.join(root, "home");
  const noteRoot = path.join(root, "wiki");
  const evidenceRoot = process.env.EXOGRAPH_GATE_A_EVIDENCE_DIR
    ?? path.join(repoRoot, "artifacts", "gate-a-onboarding-package");
  await Promise.all([mkdir(userDataRoot, { recursive: true }), mkdir(runtimeRoot, { recursive: true }), mkdir(noteRoot, { recursive: true }), mkdir(evidenceRoot, { recursive: true })]);
  await writeFile(path.join(noteRoot, "welcome.md"), "# Welcome\n\nPackaged first-run fixture.\n", "utf8");
  await prepareFakeProviderCommands(homeRoot);
  const executablePath = appBundle!.endsWith(".app")
    ? path.join(appBundle!, "Contents", "MacOS", "Exograph")
    : appBundle!;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: homeRoot,
    PATH: "/usr/bin:/bin",
    EXOGRAPH_TEST: "1",
    EXOGRAPH_USER_DATA_PATH: userDataRoot,
    EXOGRAPH_SETTINGS_PATH: path.join(userDataRoot, "workspace-settings.json"),
    EXOGRAPH_RUNTIME_ROOT: runtimeRoot,
    EXOGRAPH_TEST_SELECT_FOLDER_PATH: noteRoot,
    EXOGRAPH_FORCE_THEME: "light",
  };

  let firstApp;
  let restartedApp;
  try {
    firstApp = await electron.launch({ executablePath, cwd: "/", env: definedEnvironment(env) });
    const page = firstApp.windows()[0] ?? await firstApp.firstWindow();
    await page.setViewportSize({ width: 700, height: 560 });
    expect(await firstApp.evaluate(({ app }) => app.getPath("exe"))).toBe(executablePath);
    expect(page.viewportSize()).toEqual({ width: 700, height: 560 });
    await expect(page.getByTestId("onboarding")).toContainText("Choose your main wiki");
    await page.screenshot({ path: path.join(evidenceRoot, "01-packaged-choose-wiki.png"), fullPage: true });
    await page.getByTestId("onboarding-choose-notes").click();
    await page.getByTestId("onboarding-continue").click();
    await expect(page.getByRole("heading", { name: "Agent access" })).toBeVisible();
    await expect(page.locator(".onboarding-cli-installation")).not.toContainText("Contents/Resources");
    await expect(page.locator(".onboarding-cli-installation")).toContainText("CLI not installed");
    await page.screenshot({ path: path.join(evidenceRoot, "02-packaged-agent-access.png"), fullPage: true });
    await page.getByRole("button", { name: "Install CLI" }).click();
    await expect(page.locator(".onboarding-cli-installation")).toContainText("CLI installed");
    await expect(page.locator(".onboarding-cli-installation")).toContainText("Available to Exograph and MCP");
    await expect(page.locator(".onboarding-cli-shell-path")).toContainText('export PATH="$HOME/.local/bin:$PATH"');
    await expect(readOptional(path.join(homeRoot, ".local", "bin", "exo"))).resolves.toContain("exograph-packaged-cli");
    await page.locator(".onboarding-provider-menu__item").filter({ hasText: "Codex" }).click();
    await page.getByRole("button", { name: "Install MCP" }).click();
    await expect(page.getByText("Added Exograph MCP to Claude.")).toBeVisible();
    await expect.poll(() => readOptional(path.join(homeRoot, "claude-mcp.log"))).toContain("mcp\nadd\n--scope\nuser\nexo");
    await expect(readOptional(path.join(homeRoot, "codex-mcp.log"))).resolves.toBeNull();
    await page.getByRole("button", { name: "Set up CLI agents" }).click();
    await page.getByRole("textbox", { name: "Claude command" }).fill(customClaudeCommand);
    await page.getByRole("textbox", { name: "Codex command" }).fill(customCodexCommand);
    await page.screenshot({ path: path.join(evidenceRoot, "03-packaged-commands.png"), fullPage: true });
    await page.getByRole("button", { name: "Open Exograph" }).click();
    await expect(page.getByTestId("sidebar")).toBeVisible();
    await page.screenshot({ path: path.join(evidenceRoot, "04-packaged-workspace.png"), fullPage: true });
    await firstApp.close();
    firstApp = undefined;

    restartedApp = await electron.launch({ executablePath, cwd: "/", env: definedEnvironment(env) });
    const restartedPage = restartedApp.windows()[0] ?? await restartedApp.firstWindow();
    await restartedPage.setViewportSize({ width: 700, height: 560 });
    expect(await restartedApp.evaluate(({ app }) => app.getPath("exe"))).toBe(executablePath);
    expect(restartedPage.viewportSize()).toEqual({ width: 700, height: 560 });
    await expect(restartedPage.getByTestId("onboarding")).toHaveCount(0);
    await expect(restartedPage.getByTestId("sidebar")).toBeVisible();
    await expect.poll(async () => restartedPage.evaluate(() => window.exograph.workspace.getSettings()))
      .toMatchObject({
        settings: {
          noteRoots: [noteRoot],
          agentCommands: [
            expect.objectContaining({ command: customClaudeCommand }),
            expect.objectContaining({ command: customCodexCommand }),
          ],
        },
      });
    await restartedPage.screenshot({ path: path.join(evidenceRoot, "05-packaged-restart.png"), fullPage: true });
  } finally {
    await restartedApp?.close().catch(() => undefined);
    await firstApp?.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

function workspaceSettings(noteRoot: string): WorkspaceSettings {
  return {
    workspaceRoot: noteRoot,
    defaultTerminalCwd: path.dirname(noteRoot),
    noteRoots: [noteRoot],
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
    agentCommands: [createDefaultClaudeAgentCommand(), createDefaultCodexAgentCommand()],
  };
}

function definedEnvironment(environment: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(environment).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}

async function prepareFakeProviderHome(homeRoot: string): Promise<void> {
  await prepareFakeProviderCommands(homeRoot);
  await writeExecutable(
    path.join(homeRoot, ".local", "bin", "exo"),
    "#!/bin/sh\n# exograph-packaged-cli\nexit 0\n",
  );
}

async function prepareFakeProviderCommands(homeRoot: string): Promise<void> {
  const bin = path.join(homeRoot, ".local", "bin");
  await mkdir(bin, { recursive: true });
  await Promise.all([
    writeExecutable(path.join(bin, "claude"), "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$HOME/claude-mcp.log\"\n"),
    writeExecutable(path.join(bin, "codex"), "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$HOME/codex-mcp.log\"\n"),
  ]);
}

async function writeExecutable(filePath: string, content: string): Promise<void> {
  await writeFile(filePath, content, "utf8");
  await chmod(filePath, 0o755);
}

async function readOptional(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function continueToAgents(page: import("@playwright/test").Page): Promise<void> {
  await page.getByTestId("onboarding-choose-notes").click();
  await page.getByTestId("onboarding-continue").click();
  await continueFromContentPolicy(page);
  await page.getByRole("button", { name: "Set up CLI agents" }).click();
}

async function readCommandDiscovery(runtimeRoot: string): Promise<{ port: number; token: string }> {
  return JSON.parse(await readFile(path.join(runtimeRoot, "server.json"), "utf8")) as { port: number; token: string };
}

async function continueFromContentPolicy(page: Page): Promise<void> {
  const scopeHeading = page.getByRole("heading", { name: "Code repository detected" });
  if (await scopeHeading.isVisible().catch(() => false)) {
    await page.getByRole("button", { name: "Continue to tools" }).click();
  }
  await expect(page.getByRole("heading", { name: "Agent access" })).toBeVisible();
}

interface OnboardingGeometry {
  frame: { x: number; y: number; width: number; height: number };
  primaryActionY: number;
  primaryActionRightInset: number;
}

async function onboardingGeometry(page: Page, primaryAction: Locator): Promise<OnboardingGeometry> {
  const [frame, action] = await Promise.all([
    page.getByTestId("onboarding-card").boundingBox(),
    primaryAction.boundingBox(),
  ]);
  expect(frame).not.toBeNull();
  expect(action).not.toBeNull();
  return {
    frame: frame!,
    primaryActionY: action!.y,
    primaryActionRightInset: frame!.x + frame!.width - action!.x - action!.width,
  };
}

async function expectOnboardingGeometry(
  page: Page,
  primaryAction: Locator,
  expected: OnboardingGeometry,
): Promise<void> {
  const current = await onboardingGeometry(page, primaryAction);
  for (const key of ["x", "y", "width", "height"] as const) {
    expect(Math.abs(current.frame[key] - expected.frame[key])).toBeLessThanOrEqual(1);
  }
  expect(Math.abs(current.primaryActionY - expected.primaryActionY)).toBeLessThanOrEqual(1);
  expect(Math.abs(current.primaryActionRightInset - expected.primaryActionRightInset)).toBeLessThanOrEqual(1);
}

async function expectInternalScroll(locator: Locator): Promise<void> {
  const result = await locator.evaluate((element) => {
    const maximum = element.scrollHeight - element.clientHeight;
    element.scrollTop = maximum;
    return { maximum, scrollTop: element.scrollTop };
  });
  expect(result.maximum).toBeGreaterThan(0);
  expect(result.scrollTop).toBeGreaterThan(0);
  await locator.evaluate((element) => {
    element.scrollTop = 0;
  });
}
