import { expect, test } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { launchExographWorkspaceFixture } from "../helpers";

test("moving out of a wikilink query cancels its completion", async () => {
  const fixture = await launchExographWorkspaceFixture({
    mutable: true,
    initialNoteLabel: null,
    prepareWorkspace: async (root) => {
      await writeFile(path.join(root, "notes/test-notes/wiring-completion.md"), "# Wiring completion\n\nOrdinary paragraph.\n\n", "utf8");
      await writeFile(path.join(root, "notes/test-notes/customer-alpha.md"), "# Customer Alpha\n", "utf8");
    },
  });
  const { electronApp, page } = fixture;
  try {
    await electronApp.evaluate(({ ipcMain }) => {
      const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...args: any[]) => Promise<unknown>> })._invokeHandlers;
      const original = handlers.get("notes:suggest-targets");
      if (!original) throw new Error("Missing notes:suggest-targets handler");
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const state = { held: false, release };
      (globalThis as unknown as { wiringCompletionGate: typeof state }).wiringCompletionGate = state;
      ipcMain.removeHandler("notes:suggest-targets");
      ipcMain.handle("notes:suggest-targets", async (event, ...args) => {
        const result = await original(event, ...args);
        if (!state.held) {
          state.held = true;
          await gate;
        }
        return result;
      });
    });
    await page.getByRole("button", { name: /wiring-completion/i }).first().click();
    await page.locator(".cm-content").click();
    await page.evaluate(() => {
      const view = (document.querySelector(".cm-content") as any).cmView.view;
      view.dispatch({ selection: { anchor: view.state.doc.length } });
      view.focus();
    });
    await page.keyboard.type("[[cus");
    await expect.poll(() => electronApp.evaluate(() => (globalThis as unknown as { wiringCompletionGate: { held: boolean } }).wiringCompletionGate.held)).toBe(true);
    for (let index = 0; index < 5; index++) await page.keyboard.press("ArrowLeft");
    await electronApp.evaluate(() => (globalThis as unknown as { wiringCompletionGate: { release: () => void } }).wiringCompletionGate.release());
    await expect(page.getByTestId("wikilink-suggestions")).toHaveCount(0);
    await page.keyboard.press("Enter");
    const body = await page.locator(".cm-content").evaluate((content) => (content as any).cmView.view.state.doc.toString());
    expect(body).not.toContain("[[customer-alpha]]");
    expect(body).toContain("[[cus");
  } finally { await fixture.cleanup(); }
});

test("selection-only cursor movement also cancels agent completion", async () => {
  const fixture = await launchExographWorkspaceFixture({ mutable: true });
  const { page } = fixture;
  try {
    await page.locator(".editor-surface .cm-content").click();
    await page.keyboard.press("Meta+End");
    await page.keyboard.type("@claude");
    await expect(page.getByTestId("agent-suggestions")).toBeVisible();
    for (let index = 0; index < "@claude".length; index++) await page.keyboard.press("ArrowLeft");
    await expect(page.getByTestId("agent-suggestions")).toHaveCount(0);
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("inline-agent-composer")).toHaveCount(0);
  } finally { await fixture.cleanup(); }
});

test("custom Save remains active in the focused editor", async () => {
  const fixture = await launchExographWorkspaceFixture({ mutable: true });
  const { electronApp, page } = fixture;
  try {
    await page.getByTestId("workspace-menu-toggle").click();
    await page.getByTestId("workspace-menu-settings").click();
    await page.getByTestId("workspace-settings-tab-shortcuts").click();
    const saveBinding = page.getByRole("button", { name: "Change Save shortcut", exact: true });
    await saveBinding.click();
    await saveBinding.press("Meta+Alt+k");
    await expect(saveBinding).not.toHaveText("Press a shortcut…");
    await page.getByTestId("workspace-settings-close").click();

    await electronApp.evaluate(({ ipcMain }) => {
      const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...args: any[]) => Promise<unknown>> })._invokeHandlers;
      const original = handlers.get("notes:save");
      if (!original) throw new Error("Missing notes:save handler");
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const state = { armed: false, held: false, calls: 0, armedCalls: 0, release };
      (globalThis as unknown as { wiringSaveGate: typeof state }).wiringSaveGate = state;
      ipcMain.removeHandler("notes:save");
      ipcMain.handle("notes:save", async (event, ...args) => {
        const result = await original(event, ...args);
        state.calls += 1;
        if (state.armed) {
          state.armedCalls += 1;
          if (!state.held) {
            state.held = true;
            await gate;
          }
        }
        return result;
      });
    });

    const editor = page.locator(".editor-surface .cm-content").first();
    await editor.click();
    await page.keyboard.type("custom save");
    await expect(page.getByTestId("editor-save-status")).toHaveText("Unsaved");
    await electronApp.evaluate(() => { (globalThis as unknown as { wiringSaveGate: { armed: boolean } }).wiringSaveGate.armed = true; });
    await page.keyboard.press("Meta+Alt+k");
    await expect.poll(() => electronApp.evaluate(() => (globalThis as unknown as { wiringSaveGate: { held: boolean; armedCalls: number } }).wiringSaveGate)).toMatchObject({ held: true, armedCalls: 1 });
    await electronApp.evaluate(() => (globalThis as unknown as { wiringSaveGate: { release: () => void } }).wiringSaveGate.release());
    await expect(page.getByTestId("editor-save-status")).toHaveText("Saved");
    await expect.poll(() => page.evaluate(async () => (await window.exograph.workspace.getSettings()).settings.shortcutBindings))
      .toMatchObject({ save: { code: "KeyK", alt: true } });
  } finally { await fixture.cleanup(); }
});
