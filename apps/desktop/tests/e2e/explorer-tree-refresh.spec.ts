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
