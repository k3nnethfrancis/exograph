import { expect, test } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { launchExographWorkspaceFixture } from "../helpers";

test("renders path-only wikilinks as compact clickable labels in prose and tables", async () => {
  let sourcePath = "";
  const { electronApp, page, cleanup } = await launchExographWorkspaceFixture({
    mutable: true,
    initialNoteLabel: null,
    prepareWorkspace: async (workspaceRoot) => {
      const noteRoot = path.join(workspaceRoot, "notes/test-notes");
      sourcePath = path.join(noteRoot, "wikilink-contexts.md");
      await mkdir(path.join(noteRoot, "targets"), { recursive: true });
      await writeFile(path.join(noteRoot, "targets/plain-target.md"), "# Plain target\n", "utf8");
      await writeFile(path.join(noteRoot, "targets/table-target.md"), "# Table target\n", "utf8");
      await writeFile(sourcePath, [
        "# Wiki link contexts",
        "",
        "Paragraph: [[targets/plain-target]]",
        "",
        ...Array.from({ length: 60 }, () => "A spacer line keeps the table in a separately rendered viewport."),
        "",
        "| Source |",
        "| --- |",
        "| [[targets/table-target]] |",
      ].join("\n"), "utf8");
    },
  });

  async function openSourceAtTop() {
    await electronApp.evaluate(({ BrowserWindow }, targetPath) => {
      BrowserWindow.getAllWindows()[0]?.webContents.send("command:open-file", targetPath);
    }, sourcePath);
    await expect.poll(() => page.locator(".cm-content").evaluate((content) => {
      const view = (content as HTMLElement & { cmView?: { view?: any } }).cmView?.view;
      view?.dispatch({ selection: { anchor: 0 } });
      return view?.state.selection.main.head;
    })).toBe(0);
  }

  async function revealTableViewport() {
    await page.locator(".cm-scroller").hover();
    await page.mouse.wheel(0, 4_000);
    await expect.poll(() => page.locator(".cm-content").evaluate((content) => {
      const view = (content as HTMLElement & { cmView?: { view?: any } }).cmView?.view;
      view?.dispatch({ selection: { anchor: 1 } });
      view?.dispatch({ selection: { anchor: 0 } });
      return view?.state.selection.main.head;
    })).toBe(0);
  }

  try {
    await openSourceAtTop();
    const proseLink = page.locator(".cm-content .exograph-md-link[data-exograph-link-target='targets/plain-target']");
    await expect(proseLink).toHaveText("plain-target");
    await proseLink.click();
    await expect(page.getByTestId("editor-title")).toHaveText("plain-target");

    await openSourceAtTop();
    await revealTableViewport();
    await expect(page.locator(".cm-content")).toContainText("table-target");
    const tableLink = page.locator(".cm-content .exograph-md-link[data-exograph-link-target='targets/table-target']");
    await expect(tableLink).toHaveText("table-target");
    await tableLink.click();
    await expect(page.getByTestId("editor-title")).toHaveText("table-target");
  } finally {
    await cleanup();
  }
});
