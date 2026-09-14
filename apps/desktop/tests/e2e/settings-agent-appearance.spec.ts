import { expect, test, type Page } from "@playwright/test";
import { launchExographWorkspaceFixture, relaunchExographWorkspaceFixture } from "../helpers";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=", "base64");

test("custom command appearance uploads, persists, renders, and resets", async () => {
  const fixture = await launchExographWorkspaceFixture({ mutable: true });
  let relaunched: Awaited<ReturnType<typeof relaunchExographWorkspaceFixture>> | null = null;
  try {
    const { page } = fixture;
    await openAgents(page);
    await page.getByRole("button", { name: "Add Custom", exact: true }).click();
    await page.getByLabel("Custom command name", { exact: true }).fill("Local QA");
    await page.getByLabel("Custom command handle", { exact: true }).fill("localqa");
    await page.getByLabel("Custom command executable and arguments", { exact: true }).fill("/bin/echo");
    await page.getByLabel("Custom command color", { exact: true }).fill("#0088cc");
    await page.getByLabel("Custom command icon", { exact: true }).setInputFiles({ name: "icon.png", mimeType: "image/png", buffer: png });
    await expect(page.getByRole("button", { name: "Remove icon", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Add Custom", exact: true }).click();
    const icon = page.getByLabel("Local QA icon", { exact: true });
    const uploadedIcon = await page.locator(".agent-command-appearance img").getAttribute("src");
    await icon.setInputFiles({ name: "broken.png", mimeType: "image/png", buffer: Buffer.from("broken") });
    await expect(page.getByRole("alert")).toContainText("could not be opened");
    await expect(page.locator(".agent-command-appearance img")).toHaveAttribute("src", uploadedIcon!);
    await expect(page.getByRole("button", { name: "Remove icon", exact: true })).toBeVisible();
    await page.getByTestId("workspace-settings-close").click();
    await expect.poll(() => savedAppearance(page)).toMatchObject({ color: "#0088cc", iconDataUrl: expect.stringContaining("data:image/png;base64,") });
    const saved = await savedAppearance(page);
    const editor = page.locator(".editor-surface .cm-content").first();
    // Establish the same exact document/selection boundary as the invocation
    // journeys. Keyboard.type with literal newlines does not guarantee a
    // CodeMirror line break, and platform End bindings vary.
    await editor.evaluate((content) => {
      const view = (content as HTMLElement & { cmView?: { view?: { state: { doc: { length: number } }; dispatch: (transaction: unknown) => void; focus: () => void } } }).cmView?.view;
      if (!view) throw new Error("Unable to resolve the fixture editor");
      const insert = "\n\n@localqa";
      const end = view.state.doc.length;
      view.dispatch({ changes: { from: end, insert }, selection: { anchor: end + insert.length } });
      view.focus();
    });
    const suggestion = page.getByTestId("agent-suggestion-localqa");
    await expect(suggestion).toBeVisible();
    await expect(suggestion.locator("img")).toHaveAttribute("src", saved!.iconDataUrl!);
    await page.keyboard.press("Enter");
    const send = page.getByRole("button", { name: "Send message to @localqa", exact: true });
    await expect(send.locator("img")).toHaveAttribute("src", saved!.iconDataUrl!);
    await openAgents(page);
    await page.getByLabel("Local QA color", { exact: true }).fill("#cc5500");
    await page.getByTestId("workspace-settings-close").click();
    await expect(send.locator(".agent-command-icon")).toHaveCSS("color", "rgb(204, 85, 0)");
    await editor.focus();
    await page.keyboard.type("Check appearance.");
    await send.click();
    const authorization = page.getByRole("dialog", { name: "Run Local QA?" });
    await expect(authorization.locator("img")).toHaveAttribute("src", saved!.iconDataUrl!);
    await authorization.getByRole("button", { name: "Cancel", exact: true }).click();

    await fixture.electronApp.close();
    relaunched = await relaunchExographWorkspaceFixture(fixture);
    await openAgents(relaunched.page);
    await expect(relaunched.page.getByLabel("Local QA color", { exact: true })).toHaveValue("#cc5500");
    await expect(relaunched.page.getByRole("button", { name: "Remove icon", exact: true })).toBeVisible();
    await relaunched.page.getByRole("button", { name: "Remove icon", exact: true }).click();
    await relaunched.page.getByRole("button", { name: "Reset color", exact: true }).click();
    await relaunched.page.getByTestId("workspace-settings-close").click();
    await expect.poll(() => savedAppearance(relaunched!.page)).toBeUndefined();
  } finally {
    await relaunched?.electronApp.close().catch(() => {});
    await fixture.cleanup();
  }
});

async function openAgents(page: Page) {
  await page.getByTestId("workspace-menu-toggle").click();
  await page.getByTestId("workspace-menu-settings").click();
  await page.getByTestId("workspace-settings-tab-agents").click();
}
async function savedAppearance(page: Page) {
  return page.evaluate(async () => (await window.exograph.workspace.getSettings()).settings.agentCommands?.find((command) => command.handle === "localqa")?.appearance);
}
