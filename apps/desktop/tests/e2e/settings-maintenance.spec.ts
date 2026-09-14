import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { launchExographWorkspaceFixture } from "../helpers";

test("Search maintenance help expands with the keyboard and fits a narrow settings pane", async () => {
  const fixture = await launchExographWorkspaceFixture({
    mutable: true,
    prepareSettings: async ({ settingsPath, workspaceRoot }) => {
      await writeFile(settingsPath, JSON.stringify({
        workspaceRoot, defaultTerminalCwd: workspaceRoot,
        noteRoots: [path.join(workspaceRoot, "notes/test-notes")],
        indexedRoots: [], indexing: { enabled: true, mode: "lexical", backend: "qmd" },
        searchEngine: "qmd",
      }));
    },
  });
  try {
    const { page } = fixture;
    await fixture.electronApp.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]!.setBounds({ width: 680, height: 660 });
    });
    await page.getByTestId("workspace-menu-toggle").click();
    await page.getByTestId("workspace-menu-settings").click();
    await page.getByTestId("workspace-settings-tab-index").click();
    const summary = page.locator(".settings-maintenance > summary");
    const help = page.locator(".settings-maintenance .settings-search__action small").first();
    await expect(help).toBeHidden();
    await summary.focus();
    await summary.press("Enter");
    await expect(help).toBeVisible();
    await expect(help).toHaveText("Refresh document changes without building embeddings.");
    await help.scrollIntoViewIfNeeded();
    const bounds = await help.boundingBox();
    const dialog = await page.getByTestId("workspace-settings-dialog").boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(dialog!.x);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(dialog!.x + dialog!.width);
    expect(await help.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await expect(page.getByTestId("workspace-settings-embed-index")).toBeDisabled();
    await summary.press("Enter");
    await expect(help).toBeHidden();
  } finally {
    await fixture.cleanup();
  }
});
