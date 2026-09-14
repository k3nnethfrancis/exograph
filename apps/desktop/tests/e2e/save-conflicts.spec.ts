import { expect, test } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { launchExographWorkspaceFixture } from "../helpers";

test("external edits survive autosave, quit, reload and Workspace replacement until explicit resolution", async () => {
  const fixture = await launchExographWorkspaceFixture({
    prepareWorkspace: async (root) => {
      await writeFile(path.join(root, "notes/test-notes/shared-save.md"), "# Shared\n\nOriginal\n");
    },
  });
  const { page, electronApp } = fixture;
  const filePath = path.join(fixture.workspaceRoot, "notes/test-notes/shared-save.md");
  const external = "# Shared\n\nExternal edit\n";
  try {
    await page.getByTestId("sidebar").getByRole("button", { name: "shared-save, file", exact: true }).click();
    await expect(page.getByTestId("editor-title")).toHaveText("shared-save");
    await page.locator(".editor-surface .cm-content").click();
    const edit = async (body: string) => page.evaluate((text) => {
      const content = document.querySelector(".editor-surface .cm-content") as (HTMLElement & { cmView?: { view?: any } }) | null;
      const view = content?.cmView?.view;
      if (!view) throw new Error("Missing editor");
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
    }, body);
    await edit("# Shared\n\nLocal edit\n");
    await writeFile(filePath, external);
    await expect(page.getByTestId("save-conflict-notice")).toBeVisible({ timeout: 8_000 });
    expect(await readFile(filePath, "utf8")).toBe(external);
    await edit("# Shared\n\nLatest local edit\n");

    const beforeSettings = await page.evaluate(() => window.exograph.workspace.getSettings());
    const settingsResult = await page.evaluate(async () => {
      const snapshot = await window.exograph.workspace.getSettings();
      try {
        await window.exograph.workspace.saveSettings({ expectedRevision: snapshot.revision, settings: { ...snapshot.settings, noteRoots: [] } });
        return "unexpected success";
      } catch (error) { return String(error); }
    });
    expect(settingsResult).toContain("Resolve");
    expect(await page.evaluate(() => window.exograph.workspace.getSettings())).toEqual(beforeSettings);

    await page.keyboard.press(process.platform === "darwin" ? "Meta+r" : "Control+r");
    await expect(page.getByTestId("save-conflict-notice")).toBeVisible();
    await expect(page.getByTestId("editor-panel")).toContainText("Latest local edit");
    await electronApp.evaluate(({ app }) => { app.quit(); });
    await expect(page.getByTestId("save-conflict-notice")).toBeVisible();
    expect(await readFile(filePath, "utf8")).toBe(external);

    await page.getByRole("button", { name: "Save a copy…", exact: true }).click();
    await page.getByTestId("workspace-dialog-input").fill("shared-save-copy");
    await page.getByTestId("workspace-dialog-confirm").click();
    await expect(page.getByTestId("workspace-dialog")).toBeHidden();
    expect(await readFile(path.join(path.dirname(filePath), "shared-save-copy.md"), "utf8")).toContain("Latest local edit");
    expect(await readFile(filePath, "utf8")).toBe(external);
    await expect(page.getByTestId("save-conflict-notice")).toBeHidden();

    await page.getByTestId("sidebar").getByRole("button", { name: "shared-save, file", exact: true }).click();
    await expect(page.getByTestId("editor-panel")).toContainText("External edit");
    await edit("# Shared\n\nAnother local edit\n");
    await writeFile(filePath, "# Shared\n\nSecond external edit\n");
    await expect(page.getByTestId("save-conflict-notice")).toBeVisible({ timeout: 8_000 });
    await page.getByRole("button", { name: "Discard local edits and reload", exact: true }).click();
    await expect(page.getByTestId("save-conflict-notice")).toBeHidden();
    await expect(page.getByTestId("editor-panel")).toContainText("Second external edit");
  } finally {
    // A failed assertion may deliberately leave a conflict that vetoes quit.
    // Kill only this isolated test process so cleanup cannot hang on its guard.
    if (!page.isClosed() && await page.getByTestId("save-conflict-notice").count().catch(() => 0)) electronApp.process().kill("SIGKILL");
    await fixture.cleanup();
  }
});
