import { expect, test } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { launchExographWorkspaceFixture } from "../helpers";

test("saves edits made during an earlier save even after their tab closes", async () => {
  const fixture = await launchExographWorkspaceFixture({
    prepareWorkspace: async (root) => {
      await writeFile(path.join(root, "notes/test-notes/save-close.md"), "# Save close\n\nv0\n");
    },
  });
  const { page, electronApp } = fixture;
  const filePath = path.join(fixture.workspaceRoot, "notes/test-notes/save-close.md");
  try {
    // Hold the first real save's completion at IPC, after its bytes reach disk.
    // Subsequent saves still use the production handler and filesystem boundary.
    await electronApp.evaluate(({ ipcMain }, target) => {
      const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...args: any[]) => Promise<unknown>> })._invokeHandlers;
      const original = handlers.get("notes:save");
      if (!original) throw new Error("Missing notes:save handler");
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const state = { held: false, release };
      (globalThis as unknown as { saveCloseGate: typeof state }).saveCloseGate = state;
      ipcMain.removeHandler("notes:save");
      ipcMain.handle("notes:save", async (event, ...args) => {
        const result = await original(event, ...args);
        if (args[0] === target && !state.held) {
          state.held = true;
          await gate;
        }
        return result;
      });
    }, filePath);
    await page.getByTestId("sidebar").getByRole("button", { name: "save-close, file", exact: true }).click();
    await expect(page.getByTestId("editor-title")).toHaveText("save-close");
    await page.locator(".editor-surface .cm-content").click();
    const edit = async (version: string) => page.evaluate((text) => {
      const content = document.querySelector(".editor-surface .cm-content") as (HTMLElement & { cmView?: { view?: any } }) | null;
      const view = content?.cmView?.view;
      if (!view) throw new Error("Missing editor");
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: `# Save close\n\n${text}\n` } });
    }, version);
    await edit("v1");
    await page.keyboard.press(process.platform === "darwin" ? "Meta+s" : "Control+s");
    await expect.poll(() => electronApp.evaluate(() => (globalThis as unknown as { saveCloseGate: { held: boolean } }).saveCloseGate)).toMatchObject({ held: true });
    await edit("v2 survives closing");
    await expect(page.getByTestId("editor-panel")).toContainText("v2 survives closing");
    await page.getByLabel("Close save-close", { exact: true }).click();
    await electronApp.evaluate(() => (globalThis as unknown as { saveCloseGate: { release: () => void } }).saveCloseGate.release());
    await expect.poll(() => readFile(filePath, "utf8"), { timeout: 8_000 }).toContain("v2 survives closing");
    await page.getByTestId("sidebar").getByRole("button", { name: "save-close, file", exact: true }).click();
    await expect(page.getByTestId("editor-panel")).toContainText("v2 survives closing");
  } finally {
    await electronApp.evaluate(() => (globalThis as unknown as { saveCloseGate?: { release: () => void } }).saveCloseGate?.release()).catch(() => {});
    await fixture.cleanup();
  }
});
