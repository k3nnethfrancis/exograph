import { expect, test } from "@playwright/test";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { launchExographWorkspaceFixture } from "../helpers";

test("keeps an expanded branch beyond the initial tree depth after an external rename-class refresh", async () => {
  let noteRoot = "";
  let changedPath = "";
  const { electronApp, page, cleanup } = await launchExographWorkspaceFixture({
    mutable: true,
    initialNoteLabel: null,
    prepareWorkspace: async (workspaceRoot) => {
      noteRoot = path.join(workspaceRoot, "notes/test-notes");
      const deepDirectory = path.join(noteRoot, "level-1", "level-2", "level-3", "level-4");
      changedPath = path.join(deepDirectory, "plan.md");
      await mkdir(deepDirectory, { recursive: true });
      await writeFile(changedPath, "# Plan\n", "utf8");
    },
  });

  try {
    for (const level of ["level-1", "level-2", "level-3", "level-4"]) {
      await page.getByRole("button", { name: `${level}, collapsed folder` }).click();
    }
    await expect(page.getByRole("button", { name: "plan" })).toBeVisible();

    await electronApp.evaluate(({ BrowserWindow }, event) => {
      BrowserWindow.getAllWindows()[0]?.webContents.send("workspace:changed", event);
    }, { rootPath: noteRoot, eventType: "rename", filePath: changedPath });

    await expect(page.getByRole("button", { name: "plan" })).toBeVisible();
  } finally {
    await cleanup();
  }
});

test("shows an open tab's file in the Explorer", async () => {
  let notePath = "";
  const { electronApp, page, cleanup } = await launchExographWorkspaceFixture({
    mutable: true,
    initialNoteLabel: null,
    prepareWorkspace: async (workspaceRoot) => {
      const noteRoot = path.join(workspaceRoot, "notes/test-notes");
      notePath = path.join(noteRoot, "one", "two", "three", "four", "reveal-me.md");
      await mkdir(path.dirname(notePath), { recursive: true });
      await writeFile(notePath, "# Reveal me\n", "utf8");
    },
  });

  try {
    await electronApp.evaluate(({ BrowserWindow }, targetPath) => {
      BrowserWindow.getAllWindows()[0]?.webContents.send("command:open-file", targetPath);
    }, notePath);
    const tab = page.locator(".tab-strip__tab").filter({ hasText: "reveal-me" });
    await tab.click({ button: "right" });
    await page.getByRole("button", { name: "Show in Explorer" }).click();
    const revealed = page.locator(`[data-explorer-path="${notePath}"]`);
    await expect(revealed).toBeVisible();
    await expect(revealed).toHaveClass(/tree-node--revealed/);
  } finally {
    await cleanup();
  }
});

test("refreshes the Explorer for external creates and renamed folders reported as change events", async () => {
  let noteRoot = "";
  let oldDirectory = "";
  let nextDirectory = "";
  let createdFile = "";
  const { electronApp, page, cleanup } = await launchExographWorkspaceFixture({
    mutable: true,
    initialNoteLabel: null,
    prepareWorkspace: async (workspaceRoot) => {
      noteRoot = path.join(workspaceRoot, "notes/test-notes");
      const implementationDirectory = path.join(noteRoot, "project", "research", "implementation");
      oldDirectory = path.join(implementationDirectory, "partner-traces");
      nextDirectory = path.join(implementationDirectory, "traces");
      createdFile = path.join(implementationDirectory, "new-external-note.md");
      await mkdir(oldDirectory, { recursive: true });
      await writeFile(path.join(oldDirectory, "README.md"), "# Partner traces\n", "utf8");
    },
  });

  const notifyChange = async (filePath: string) => {
    await electronApp.evaluate(({ BrowserWindow }, event) => {
      BrowserWindow.getAllWindows()[0]?.webContents.send("workspace:changed", event);
    }, { rootPath: noteRoot, eventType: "change", filePath });
  };

  try {
    for (const directory of ["project", "research", "implementation"]) {
      await page.getByRole("button", { name: `${directory}, collapsed folder` }).click();
    }
    await expect(page.getByRole("button", { name: "partner-traces, collapsed folder" })).toBeVisible();

    await writeFile(createdFile, "# New external note\n", "utf8");
    await notifyChange(createdFile);
    await expect(page.getByRole("button", { name: "new-external-note" })).toBeVisible();

    await rename(oldDirectory, nextDirectory);
    await notifyChange(nextDirectory);
    await expect(page.getByRole("button", { name: "partner-traces, collapsed folder" })).toHaveCount(0);
    await page.getByRole("button", { name: "traces, collapsed folder" }).click();
    await page.getByRole("button", { name: "README" }).click();
    await expect(page.getByTestId("editor-title")).toHaveText("README");
  } finally {
    await cleanup();
  }
});
