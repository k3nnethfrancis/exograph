import { expect, test } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { launchExographWorkspaceFixture } from "../helpers";

test("an external open reactivates an already-open background tab", async () => {
  let firstNotePath = "";
  let secondNotePath = "";
  const { electronApp, page, cleanup } = await launchExographWorkspaceFixture({
    mutable: true,
    initialNoteLabel: null,
    prepareWorkspace: async (workspaceRoot) => {
      const noteRoot = path.join(workspaceRoot, "notes/test-notes");
      firstNotePath = path.join(noteRoot, "command-first.md");
      secondNotePath = path.join(noteRoot, "command-second.md");
      await mkdir(noteRoot, { recursive: true });
      await writeFile(firstNotePath, "# Command first\n", "utf8");
      await writeFile(secondNotePath, "# Command second\n", "utf8");
    },
  });

  const openFromCommand = async (filePath: string) => {
    await electronApp.evaluate(({ BrowserWindow }, targetPath) => {
      BrowserWindow.getAllWindows()[0]?.webContents.send("command:open-file", targetPath);
    }, filePath);
  };

  const expectActiveNote = async (fileName: string, heading: string) => {
    await expect(page.getByTestId("editor-title").getByText(fileName, { exact: true })).toHaveCount(1);
    await expect(page.locator(".editor-surface .cm-content")).toContainText(heading);
  };

  try {
    await openFromCommand(firstNotePath);
    await expectActiveNote("command-first", "Command first");

    await openFromCommand(secondNotePath);
    await expectActiveNote("command-second", "Command second");

    await openFromCommand(firstNotePath);
    await expectActiveNote("command-first", "Command first");
  } finally {
    await cleanup();
  }
});

test("an external folder open reveals that exact folder overview", async () => {
  let folderPath = "";
  const { electronApp, page, cleanup } = await launchExographWorkspaceFixture({
    mutable: true,
    initialNoteLabel: null,
    prepareWorkspace: async (workspaceRoot) => {
      folderPath = path.join(workspaceRoot, "notes/test-notes/project");
      await mkdir(folderPath, { recursive: true });
      await writeFile(path.join(folderPath, "plan.md"), "# Plan\n", "utf8");
    },
  });

  try {
    await electronApp.evaluate(({ BrowserWindow }, targetPath) => {
      BrowserWindow.getAllWindows()[0]?.webContents.send("command:open-folder", targetPath);
    }, folderPath);

    const overview = page.getByTestId("folder-overview");
    await expect(overview).toHaveAttribute("data-folder-loaded", "true");
    await expect(overview.getByRole("heading", { name: "project" })).toBeVisible();
  } finally {
    await cleanup();
  }
});

test("opens a Markdown file delivered by the macOS open-file event", async () => {
  let notePath = "";
  const { electronApp, page, cleanup } = await launchExographWorkspaceFixture({
    mutable: true,
    initialNoteLabel: null,
    prepareWorkspace: async (workspaceRoot) => {
      notePath = path.join(workspaceRoot, "notes/test-notes/finder-open.md");
      await writeFile(notePath, "# Finder open\n", "utf8");
    },
  });

  try {
    await electronApp.evaluate(({ app }, filePath) => {
      app.emit("open-file", { preventDefault() {} }, filePath);
    }, notePath);
    await expect(page.getByTestId("editor-title").getByText("finder-open", { exact: true })).toHaveCount(1);
    await expect(page.locator(".editor-surface .cm-content")).toContainText("Finder open");
  } finally {
    await cleanup();
  }
});
