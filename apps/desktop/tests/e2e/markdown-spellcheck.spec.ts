import { expect, test } from "@playwright/test";

import { launchExographWorkspaceFixture } from "../helpers";

test("enables native spellchecking in the Markdown editor", async () => {
  const fixture = await launchExographWorkspaceFixture();

  try {
    await expect(fixture.page.locator(".editor-surface .cm-content")).toHaveAttribute("spellcheck", "true");
  } finally {
    await fixture.cleanup();
  }
});

test("opens the native editable-text menu from the Markdown editor", async () => {
  const fixture = await launchExographWorkspaceFixture();

  try {
    await fixture.electronApp.evaluate(({ Menu }) => {
      const popups: Array<{ roles: Array<string | null> }> = [];
      Object.assign(globalThis, { __exographNativeTextMenuPopups: popups });
      Menu.prototype.popup = function () {
        popups.push({ roles: this.items.map((item) => item.role ?? null) });
      };
    });

    await fixture.page.locator(".editor-surface .cm-content").click({ button: "right" });

    await expect.poll(() => fixture.electronApp.evaluate(() => {
      const popups = (globalThis as typeof globalThis & {
        __exographNativeTextMenuPopups?: Array<{ roles: Array<string | null> }>;
      }).__exographNativeTextMenuPopups;
      return popups?.at(-1) ?? null;
    })).toEqual({
      roles: expect.arrayContaining(["undo", "redo", "cut", "copy", "paste", "pasteandmatchstyle", "selectall"]),
    });
  } finally {
    await fixture.cleanup();
  }
});
