import { expect, test } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
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
