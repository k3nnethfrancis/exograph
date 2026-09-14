import { cp, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { _electron as electron, expect, type ElectronApplication, type Page } from "@playwright/test";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const fixtureRoot = path.join(repoRoot, "fixtures/test-workspace");
const mutableFixtureExcludedNames = new Set([
  ".exograph",
  ".git",
  ".turbo",
  ".vite",
  "coverage",
  "dist",
  "node_modules",
  "release",
]);

export function shouldCopyMutableFixturePath(sourceRoot: string, sourcePath: string): boolean {
  const relativePath = path.relative(sourceRoot, sourcePath);
  if (!relativePath || relativePath === ".") {
    return true;
  }
  return !relativePath.split(path.sep).some((part) => mutableFixtureExcludedNames.has(part));
}

export async function copyMutableFixtureWorkspace(sourceRoot: string, targetRoot: string): Promise<void> {
  await cp(sourceRoot, targetRoot, {
    recursive: true,
    filter: (sourcePath) => shouldCopyMutableFixturePath(sourceRoot, sourcePath),
  });
}

interface LaunchExographFixtureOptions {
  mutable?: boolean;
  env?: Record<string, string>;
  cwd?: string;
  prepareWorkspace?: (workspaceRoot: string) => Promise<void>;
  prepareHome?: (homeRoot: string) => Promise<void>;
  selectFolderPath?: (workspaceRoot: string) => string;
  initialNoteLabel?: string | null;
  configured?: boolean;
  workspaceRootEnv?: boolean;
  runtimeRootEnv?: boolean;
  expectOnboarding?: boolean;
  stripEnvironment?: readonly string[];
  prepareSettings?: (input: { settingsPath: string; userDataRoot: string; workspaceRoot: string }) => Promise<void>;
}

interface ExographFixture {
  electronApp: ElectronApplication;
  page: Page;
  workspaceRoot: string;
  settingsPath: string;
  runtimeRoot: string;
  homeRoot: string;
  cleanup: () => Promise<void>;
}

export function launchExographTerminalFixture(options?: LaunchExographFixtureOptions): Promise<ExographFixture> {
  return launchExographFixtureForJourney(options, true);
}

export function launchExographWorkspaceFixture(options?: LaunchExographFixtureOptions): Promise<ExographFixture> {
  return launchExographFixtureForJourney(options, false);
}

async function launchExographFixtureForJourney(
  options: LaunchExographFixtureOptions | undefined,
  openTerminalSurface: boolean,
): Promise<ExographFixture> {
  let workspaceRoot = fixtureRoot;
  let tempRoot: string | null = null;
  const settingsRoot = await mkdtemp(path.join(os.tmpdir(), "exograph-settings-"));
  const settingsPath = path.join(settingsRoot, "workspace-settings.json");
  const userDataRoot = await mkdtemp(path.join(os.tmpdir(), "exograph-userdata-"));
  const runtimeRoot = path.join(userDataRoot, "runtime");
  const homeRoot = await mkdtemp(path.join(os.tmpdir(), "exograph-home-"));
  let electronApp: ElectronApplication | null = null;
  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    await electronApp?.close().catch(() => {});
    await rm(settingsRoot, { recursive: true, force: true });
    await rm(userDataRoot, { recursive: true, force: true });
    await rm(homeRoot, { recursive: true, force: true });
    if (tempRoot) {
      await rm(tempRoot, { recursive: true, force: true });
    }
  };

  try {
  if (options?.prepareHome) {
    await options.prepareHome(homeRoot);
  }
  if (options?.mutable || options?.prepareWorkspace) {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), "exograph-fixture-"));
    workspaceRoot = path.join(tempRoot, "test-workspace");
    await copyMutableFixtureWorkspace(fixtureRoot, workspaceRoot);
  }

  if (options?.prepareWorkspace) {
    await options.prepareWorkspace(workspaceRoot);
  }

  if (options?.prepareSettings) {
    await options.prepareSettings({ settingsPath, userDataRoot, workspaceRoot });
  }

  const configured = options?.configured ?? true;
  const workspaceEnv = configured
    ? {
        EXOGRAPH_NOTE_ROOTS: path.join(workspaceRoot, "notes/test-notes"),
      }
    : {};

  const launchEnv: NodeJS.ProcessEnv = {
    ...process.env,
    EXOGRAPH_TEST: "1",
    EXOGRAPH_WORKSPACE_ROOT: workspaceRoot,
    EXOGRAPH_DEFAULT_TERMINAL_CWD: workspaceRoot,
    EXOGRAPH_SETTINGS_PATH: settingsPath,
    EXOGRAPH_USER_DATA_PATH: userDataRoot,
    EXOGRAPH_RUNTIME_ROOT: runtimeRoot,
    EXOGRAPH_FORCE_THEME: "dark",
    HOME: homeRoot,
    EXOGRAPH_SHELL: "/bin/sh",
    EXOGRAPH_SHELL_ARGS: "-lc,printf 'shell ready\\n'; cat",
    ...(options?.selectFolderPath ? { EXOGRAPH_TEST_SELECT_FOLDER_PATH: options.selectFolderPath(workspaceRoot) } : {}),
    ...workspaceEnv,
    ...options?.env,
  };
  for (const name of options?.stripEnvironment ?? []) delete launchEnv[name];

  if (options?.workspaceRootEnv === false) {
    delete launchEnv.EXOGRAPH_WORKSPACE_ROOT;
    delete launchEnv.EXOGRAPH_DEFAULT_TERMINAL_CWD;
    delete launchEnv.EXOGRAPH_NOTE_ROOTS;
  }
  if (options?.runtimeRootEnv === false) {
    delete launchEnv.EXOGRAPH_RUNTIME_ROOT;
  }

  const packagedAppPath = packagedExecutablePath(process.env.EXOGRAPH_PACKAGED_APP_PATH);
  electronApp = await electron.launch({
    ...(packagedAppPath ? { executablePath: packagedAppPath } : {}),
    args: packagedAppPath ? [] : [path.join(repoRoot, "apps/desktop/dist/main/index.js")],
    cwd: options?.cwd ?? repoRoot,
    env: definedEnvironment(launchEnv),
  });
  const page = electronApp.windows()[0] ?? await electronApp.firstWindow();
  if (!configured && options?.expectOnboarding !== false) {
    await expect(page.getByTestId("onboarding")).toBeVisible();
    return {
      electronApp,
      page,
      workspaceRoot,
      settingsPath,
      runtimeRoot,
      homeRoot,
      cleanup,
    };
  }

  await expect(page.getByTestId("sidebar")).toBeVisible();
  await expect(page.locator('[data-testid="editor-panel"], [data-testid="editor-empty"]')).toBeVisible();
  if (openTerminalSurface) {
    await page.getByTestId("utility-pane-toggle").click();
    await page.getByTestId("utility-pane-terminal").click();
    await expect(page.getByTestId("terminal-dock").first()).toBeVisible();
    await page.getByTestId("new-terminal").click();
    await expect(page.getByTestId("terminal-tab-shell")).toHaveCount(1);
  }
  if (options?.initialNoteLabel !== null) {
    const initialNoteLabel = options?.initialNoteLabel ?? "focus-note";
    const noteButton = page.getByRole("button", { name: initialNoteLabel });
    await noteButton.waitFor({ state: "visible", timeout: 5000 }).catch(() => {});
    if (await noteButton.count() > 0) {
      await noteButton.click();
      await expect(page.getByTestId("editor-title")).toHaveText(initialNoteLabel);
    }
  }

  return {
    electronApp,
    page,
    workspaceRoot,
    settingsPath,
    runtimeRoot,
    homeRoot,
    cleanup,
  };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

interface RelaunchExographFixtureInput {
  workspaceRoot: string;
  settingsPath: string;
  runtimeRoot: string;
  homeRoot: string;
}

interface RelaunchExographFixtureOptions {
  env?: Record<string, string>;
  cwd?: string;
  configured?: boolean;
  workspaceRootEnv?: boolean;
  runtimeRootEnv?: boolean;
  expectOnboarding?: boolean;
  stripEnvironment?: readonly string[];
}

interface RelaunchedExographFixture {
  electronApp: ElectronApplication;
  page: Page;
  cleanup: () => Promise<void>;
}

export function relaunchExographTerminalFixture(
  previous: RelaunchExographFixtureInput,
  options?: RelaunchExographFixtureOptions,
): Promise<RelaunchedExographFixture> {
  return relaunchExographFixtureForJourney(previous, options, true);
}

export function relaunchExographWorkspaceFixture(
  previous: RelaunchExographFixtureInput,
  options?: RelaunchExographFixtureOptions,
): Promise<RelaunchedExographFixture> {
  return relaunchExographFixtureForJourney(previous, options, false);
}

async function relaunchExographFixtureForJourney(
  previous: RelaunchExographFixtureInput,
  options: RelaunchExographFixtureOptions | undefined,
  openTerminalSurface: boolean,
): Promise<RelaunchedExographFixture> {
  const userDataRoot = path.dirname(previous.runtimeRoot);
  let electronApp: ElectronApplication | null = null;
  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    await electronApp?.close().catch(() => {});
    await rm(path.dirname(previous.settingsPath), { recursive: true, force: true });
    await rm(userDataRoot, { recursive: true, force: true });
    await rm(previous.homeRoot, { recursive: true, force: true });
  };

  try {
  const configured = options?.configured ?? true;
  const launchEnv: NodeJS.ProcessEnv = {
    ...process.env,
    EXOGRAPH_TEST: "1",
    EXOGRAPH_WORKSPACE_ROOT: previous.workspaceRoot,
    EXOGRAPH_DEFAULT_TERMINAL_CWD: previous.workspaceRoot,
    EXOGRAPH_SETTINGS_PATH: previous.settingsPath,
    EXOGRAPH_USER_DATA_PATH: userDataRoot,
    EXOGRAPH_RUNTIME_ROOT: previous.runtimeRoot,
    EXOGRAPH_FORCE_THEME: "dark",
    HOME: previous.homeRoot,
    ...(configured ? {
      EXOGRAPH_NOTE_ROOTS: path.join(previous.workspaceRoot, "notes/test-notes"),
    } : {}),
    EXOGRAPH_SHELL: "/bin/sh",
    EXOGRAPH_SHELL_ARGS: "-lc,printf 'shell ready\\n'; cat",
    ...options?.env,
  };
  for (const name of options?.stripEnvironment ?? []) delete launchEnv[name];

  if (options?.workspaceRootEnv === false) {
    delete launchEnv.EXOGRAPH_WORKSPACE_ROOT;
    delete launchEnv.EXOGRAPH_DEFAULT_TERMINAL_CWD;
    delete launchEnv.EXOGRAPH_NOTE_ROOTS;
  }
  if (options?.runtimeRootEnv === false) {
    delete launchEnv.EXOGRAPH_RUNTIME_ROOT;
  }

  const packagedAppPath = packagedExecutablePath(process.env.EXOGRAPH_PACKAGED_APP_PATH);
  electronApp = await electron.launch({
    ...(packagedAppPath ? { executablePath: packagedAppPath } : {}),
    args: packagedAppPath ? [] : [path.join(repoRoot, "apps/desktop/dist/main/index.js")],
    cwd: options?.cwd ?? repoRoot,
    env: definedEnvironment(launchEnv),
  });
  const page = electronApp.windows()[0] ?? await electronApp.firstWindow();
  if (options?.expectOnboarding) {
    await expect(page.getByTestId("onboarding")).toBeVisible();
    return {
      electronApp,
      page,
      cleanup,
    };
  }
  await expect(page.getByTestId("sidebar")).toBeVisible();
  await expect(page.locator('[data-testid="editor-panel"], [data-testid="editor-empty"]')).toBeVisible();
  if (openTerminalSurface) {
    await page.getByTestId("utility-pane-toggle").click();
    await page.getByTestId("utility-pane-terminal").click();
    await expect(page.getByTestId("terminal-dock").first()).toBeVisible();
    await page.getByTestId("new-terminal").click();
    await expect(page.getByTestId("terminal-tab-shell")).toHaveCount(1);
  }

  return {
    electronApp,
    page,
    cleanup,
  };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

function definedEnvironment(environment: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(environment).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}

function packagedExecutablePath(appPath: string | undefined): string | undefined {
  return appPath?.endsWith(".app")
    ? path.join(appPath, "Contents", "MacOS", "Exograph")
    : appPath;
}
