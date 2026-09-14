import { expect, test, type Page } from "@playwright/test";
import { launchExographWorkspaceFixture, relaunchExographWorkspaceFixture } from "../helpers";

test("shortcut capture stays modal, names conflicts, and persists a working binding", async () => {
  const fixture = await launchExographWorkspaceFixture({ mutable: true });
  let relaunched: Awaited<ReturnType<typeof relaunchExographWorkspaceFixture>> | null = null;
  try {
    const { page } = fixture;
    const explorer = page.locator('[aria-label="Show explorer"], [aria-label="Hide explorer"]');
    const before = await explorer.getAttribute("aria-label");
    await openShortcuts(page);
    await page.keyboard.press("Meta+b");
    await expect(explorer).toHaveAttribute("aria-label", before!);
    const capture = page.getByRole("button", { name: "Change Explorer shortcut", exact: true });
    await capture.click();
    await expect(capture).toHaveText("Press a shortcut…");
    await capture.press("Meta+g");
    await expect(page.getByRole("status")).toContainText("Reserved for a system or editor command");
    await capture.press("Escape");
    await expect(page.getByTestId("workspace-settings-dialog")).toBeVisible();
    await expect(capture).not.toHaveText("Press a shortcut…");
    await capture.click();
    await capture.press("Meta+Alt+e");
    await expect(capture).not.toHaveText("Press a shortcut…");
    await page.getByRole("button", { name: "Change Utility shortcut", exact: true }).click();
    await page.keyboard.press("Meta+Alt+e");
    await expect(page.getByRole("status")).toContainText("Already used by Explorer");
    await page.keyboard.press("Escape");
    await page.getByTestId("workspace-settings-close").click();
    await expect(page.getByTestId("workspace-settings-dialog")).toBeHidden();
    await expect.poll(() => page.evaluate(async () => (await window.exograph.workspace.getSettings()).settings.shortcutBindings))
      .toMatchObject({ explorer: { code: "KeyE", alt: true } });
    const editor = page.locator(".editor-surface .cm-content").first();
    await editor.focus();
    await expect(editor).toBeFocused();
    await page.keyboard.press("Meta+Alt+e");
    await expect(explorer).not.toHaveAttribute("aria-label", before!);

    await fixture.electronApp.close();
    relaunched = await relaunchExographWorkspaceFixture(fixture);
    await openShortcuts(relaunched.page);
    const restored = relaunched.page.getByRole("button", { name: "Change Explorer shortcut", exact: true });
    await expect(restored).toContainText("E");
    await relaunched.page.getByRole("button", { name: "Reset all", exact: true }).click();
    await expect(restored).toContainText("B");
    await relaunched.page.getByTestId("workspace-settings-close").click();
    await expect(relaunched.page.getByTestId("workspace-settings-dialog")).toBeHidden();
    await expect.poll(() => relaunched!.page.evaluate(async () => (await window.exograph.workspace.getSettings()).settings.shortcutBindings))
      .toEqual({});
    const toggle = relaunched.page.locator('[aria-label="Show explorer"], [aria-label="Hide explorer"]');
    const prior = await toggle.getAttribute("aria-label");
    await relaunched.page.keyboard.press("Meta+b");
    await expect(toggle).not.toHaveAttribute("aria-label", prior!);
  } finally {
    await relaunched?.electronApp.close().catch(() => {});
    await fixture.cleanup();
  }
});

async function openShortcuts(page: Page): Promise<void> {
  await page.getByTestId("workspace-menu-toggle").click();
  await page.getByTestId("workspace-menu-settings").click();
  await page.getByTestId("workspace-settings-tab-shortcuts").click();
}
