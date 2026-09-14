import { expect, test, type Page } from "@playwright/test";
import { rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { launchExographWorkspaceFixture } from "../helpers";

test("refreshes an open clean document when it changes on disk", async () => {
  const { page, workspaceRoot, cleanup } = await launchExographWorkspaceFixture({
    mutable: true,
    prepareWorkspace: async (workspaceRoot) => {
      const target = path.join(workspaceRoot, "notes/test-notes/external-change-test.md");
      await writeFile(target, "# External Change Test\n\nbefore external update\n", "utf8");
    },
  });

  const target = path.join(workspaceRoot, "notes/test-notes/external-change-test.md");

  await page.getByRole("button", { name: /external-change-test/i }).first().click();
  await expect(page.getByTestId("editor-panel")).toContainText("before external update");

  await writeFile(target, "# External Change Test\n\nafter external update from agent\n", "utf8");

  await expect(page.getByTestId("editor-panel")).toContainText("after external update from agent", { timeout: 5000 });

  await cleanup();
});

test("preserves editor scroll when an open document refreshes from disk", async () => {
  const longBody = Array.from({ length: 140 }, (_value, index) => `line ${String(index + 1).padStart(3, "0")}`).join("\n");
  const { page, workspaceRoot, cleanup } = await launchExographWorkspaceFixture({
    mutable: true,
    prepareWorkspace: async (workspaceRoot) => {
      const target = path.join(workspaceRoot, "notes/test-notes/external-scroll-test.md");
      await writeFile(target, `# External Scroll Test\n\n${longBody}\n`, "utf8");
    },
  });

  const target = path.join(workspaceRoot, "notes/test-notes/external-scroll-test.md");

  await page.getByRole("button", { name: /external-scroll-test/i }).first().click();
  const scroller = page.locator(".editor-surface .cm-scroller").first();
  await expect.poll(() => scroller.evaluate((element) => element.scrollHeight > element.clientHeight + 900)).toBe(true);
  await scroller.evaluate((element) => {
    element.scrollTo(0, 1200);
  });
  await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBeGreaterThan(800);
  await page.waitForTimeout(350);

  const observedChange = waitForWorkspaceChange(page, target);
  await writeFile(target, `# External Scroll Test\n\n${longBody}\nagent appended line\n`, "utf8");
  await observedChange;

  await expect
    .poll(() =>
      page.evaluate(() => {
        const content = document.querySelector(".cm-content") as (HTMLElement & { cmView?: { view?: any } }) | null;
        return content?.cmView?.view?.state.doc.toString() ?? "";
      }),
    )
    .toContain("agent appended line");
  await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBeGreaterThan(800);

  await cleanup();
});

test("preserves editor cursor when an open document refreshes from disk", async () => {
  const { page, workspaceRoot, cleanup } = await launchExographWorkspaceFixture({
    mutable: true,
    prepareWorkspace: async (workspaceRoot) => {
      const target = path.join(workspaceRoot, "notes/test-notes/external-cursor-test.md");
      await writeFile(target, "# External Cursor Test\n\nfirst line\nsecond line\nthird line\n", "utf8");
    },
  });

  const target = path.join(workspaceRoot, "notes/test-notes/external-cursor-test.md");

  await page.getByRole("button", { name: /external-cursor-test/i }).first().click();
  await expect(page.getByTestId("editor-panel")).toContainText("third line");
  const selectionBefore = await page.evaluate(() => {
    const content = document.querySelector(".cm-content") as (HTMLElement & { cmView?: { view?: any } }) | null;
    const view = content?.cmView?.view;
    if (!view) {
      throw new Error("Unable to resolve CodeMirror view");
    }
    const target = view.state.doc.toString().indexOf("second line") + "second ".length;
    view.dispatch({ selection: { anchor: target } });
    view.focus();
    return view.state.selection.main.head;
  });
  expect(selectionBefore).toBeGreaterThan(0);

  await writeFile(target, "# External Cursor Test\n\nfirst line\nsecond line updated\nthird line\n", "utf8");
  await expect(page.getByTestId("editor-panel")).toContainText("second line updated", { timeout: 5000 });

  await expect
    .poll(() =>
      page.evaluate(() => {
        const content = document.querySelector(".cm-content") as (HTMLElement & { cmView?: { view?: any } }) | null;
        return content?.cmView?.view?.state.selection.main.head ?? 0;
      }),
    )
    .toBe(selectionBefore);

  await cleanup();
});

test("does not overwrite an unsaved document when the file changes on disk", async () => {
  const { page, workspaceRoot, cleanup } = await launchExographWorkspaceFixture({
    mutable: true,
    prepareWorkspace: async (workspaceRoot) => {
      const target = path.join(workspaceRoot, "notes/test-notes/external-dirty-test.md");
      await writeFile(target, "# External Dirty Test\n\noriginal clean body\n", "utf8");
    },
  });

  const target = path.join(workspaceRoot, "notes/test-notes/external-dirty-test.md");

  await page.getByRole("button", { name: /external-dirty-test/i }).first().click();
  await expect(page.getByTestId("editor-panel")).toContainText("original clean body");

  await page.locator(".cm-content").click();
  await page.evaluate(() => {
    const content = document.querySelector(".cm-content") as (HTMLElement & { cmView?: { view?: any } }) | null;
    const view = content?.cmView?.view;
    if (!view) {
      throw new Error("Unable to resolve CodeMirror view");
    }
    view.dispatch({
      changes: {
        from: view.state.doc.length,
        insert: "\nlocal unsaved line",
      },
    });
  });
  await expect(page.getByTestId("editor-panel")).toContainText("local unsaved line");
  await expect(page.locator(".status-dot--dirty")).toHaveCount(1);

  const observedChange = waitForWorkspaceChange(page, target);
  await writeFile(target, "# External Dirty Test\n\nexternal overwrite attempt\n", "utf8");
  await observedChange;

  await expect(page.getByTestId("editor-panel")).toContainText("local unsaved line");
  await expect(page.getByTestId("editor-panel")).not.toContainText("external overwrite attempt");

  await cleanup();
});

test("marks an open document as deleted while preserving its buffer and supports explicit recovery", async () => {
  const { electronApp, page, workspaceRoot, cleanup } = await launchExographWorkspaceFixture({
    mutable: true,
    prepareWorkspace: async (workspaceRoot) => {
      await writeFile(path.join(workspaceRoot, "notes/test-notes/deleted-state.md"), "# Deleted state\n\npreserved text\n", "utf8");
    },
  });
  const target = path.join(workspaceRoot, "notes/test-notes/deleted-state.md");

  try {
    await page.getByRole("button", { name: /deleted-state/i }).first().click();
    await expect(page.getByTestId("editor-panel")).toContainText("preserved text");
    await rm(target);
    await electronApp.evaluate(({ BrowserWindow }, event) => {
      BrowserWindow.getAllWindows()[0]?.webContents.send("workspace:changed", event);
    }, { rootPath: path.dirname(target), eventType: "rename", filePath: target });

    await expect(page.getByTestId("editor-deleted-notice")).toBeVisible();
    await expect(page.getByTestId("editor-panel")).toContainText("preserved text");
    await page.getByTestId("recover-deleted-document").click();
    await expect(page.getByTestId("editor-deleted-notice")).toHaveCount(0);
  } finally {
    await cleanup();
  }
});

function waitForWorkspaceChange(page: Page, targetPath: string): Promise<unknown> {
  return page.evaluate((expectedPath) => new Promise((resolve) => {
    const unsubscribe = window.exograph.workspace.onDidChange((event) => {
      if (event.filePath !== expectedPath) return;
      unsubscribe();
      resolve(event);
    });
  }), targetPath);
}
