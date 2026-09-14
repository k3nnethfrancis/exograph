import { readFile } from "node:fs/promises";
import path from "node:path";

import { expect, test } from "@playwright/test";

import { launchExographWorkspaceFixture } from "../helpers";

test("toggles shell panels from the keyboard and exposes compact operator help", async () => {
  const fixture = await launchExographWorkspaceFixture();
  const modifier = process.platform === "darwin" ? "Meta" : "Control";

  try {
    const explorerToggle = fixture.page.getByTestId("workspace-titlebar-sidebar");
    await expect(explorerToggle).toHaveAttribute("aria-pressed", "true");
    await fixture.page.keyboard.press(`${modifier}+B`);
    await expect(explorerToggle).toHaveAttribute("aria-pressed", "false");
    await fixture.page.keyboard.press(`${modifier}+B`);
    await expect(explorerToggle).toHaveAttribute("aria-pressed", "true");

    const utilityToggle = fixture.page.getByTestId("utility-pane-toggle");
    await expect(utilityToggle).toHaveAttribute("aria-pressed", "false");
    await fixture.page.keyboard.press(`${modifier}+Alt+B`);
    await expect(utilityToggle).toHaveAttribute("aria-pressed", "true");
    await fixture.page.keyboard.press(`${modifier}+Alt+B`);
    await expect(utilityToggle).toHaveAttribute("aria-pressed", "false");

    await fixture.page.getByTestId("workspace-menu-toggle").click();
    const settingsRow = fixture.page.getByTestId("workspace-menu-settings");
    const helpRow = fixture.page.getByTestId("workspace-menu-help");
    const settingsBox = await settingsRow.boundingBox();
    const helpBox = await helpRow.boundingBox();
    expect(settingsBox).not.toBeNull();
    expect(helpBox).not.toBeNull();
    expect(helpBox!.y).toBeGreaterThan(settingsBox!.y);
    await fixture.page.getByTestId("workspace-menu-help").click();
    const help = fixture.page.getByTestId("workspace-help");
    await expect(help).toBeVisible();
    await expect(help).toContainText("Keyboard");
    await expect(help).toContainText("CLI");
    await expect(help).toContainText("App zoom");
    await expect(help).toContainText("exo status");
    await expect(help).toContainText(process.platform === "darwin" ? "⌘ B" : "Ctrl B");
    await fixture.page.keyboard.press("Escape");
    await fixture.page.getByTestId("workspace-menu-toggle").click();
    await expect(fixture.page.getByTestId("workspace-menu-settings")).toBeVisible();
    await expect(fixture.page.getByTestId("workspace-help")).toHaveCount(0);
  } finally {
    await fixture.cleanup();
  }
});

test("persists configured global shortcuts and uses the same binding in Help", async () => {
  const fixture = await launchExographWorkspaceFixture({ mutable: true });
  const modifier = process.platform === "darwin" ? "Meta" : "Control";

  try {
    await fixture.page.getByTestId("workspace-menu-toggle").click();
    await fixture.page.getByTestId("workspace-menu-settings").click();
    await fixture.page.getByTestId("workspace-settings-tab-shortcuts").click();
    const newNoteBinding = fixture.page.getByTestId("workspace-settings-shortcut-new-note");
    await newNoteBinding.focus();
    await fixture.page.keyboard.press(`${modifier}+K`);
    await expect(newNoteBinding).toHaveText(process.platform === "darwin" ? "⌘ K" : "Ctrl K");
    await expect(fixture.page.getByTestId("workspace-settings-status")).toHaveText("Settings saved.");
    await fixture.page.getByTestId("workspace-settings-close").click();

    await expect.poll(async () => JSON.parse(await readFile(fixture.settingsPath, "utf8"))).toMatchObject({
      shortcutBindings: { "new-note": { code: "KeyK" } },
    });
    await fixture.page.keyboard.press(`${modifier}+K`);
    await expect(fixture.page.getByTestId("editor-title")).toHaveText("untitled");
    await expect.poll(() => readFile(path.join(fixture.workspaceRoot, "notes/test-notes/untitled.md"), "utf8")).toContain("# untitled");

    await fixture.page.getByTestId("workspace-menu-toggle").click();
    await fixture.page.getByTestId("workspace-menu-help").click();
    await expect(fixture.page.getByTestId("workspace-help")).toContainText(process.platform === "darwin" ? "⌘ K" : "Ctrl K");
  } finally {
    await fixture.cleanup();
  }
});
