import { chromium, expect, test, type Page } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { launchExographWorkspaceFixture } from "../helpers";

async function launchListWorkspace(browserMode: boolean, options: Parameters<typeof launchExographWorkspaceFixture>[0]) {
  const fixture = await launchExographWorkspaceFixture(options);
  if (!browserMode) return fixture;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH });
    const page = await browser.newPage({ viewport: { width: 560, height: 850 } });
    const serverPath = path.join(fixture.workspaceRoot, ".exograph", "server.json");
    await expect.poll(() => readFile(serverPath, "utf8").then(() => true, () => false)).toBe(true);
    const server = JSON.parse(await readFile(serverPath, "utf8"));
    const response = await fetch(`http://127.0.0.1:${server.port}/browser`, {
      method: "POST", headers: { Authorization: `Bearer ${server.token}` },
    });
    expect(response.status).toBe(200);
    await page.goto((await response.json()).url);
    await expect(page.getByText("Connected", { exact: true })).toBeVisible();
    return { ...fixture, page, cleanup: async () => { await browser?.close(); await fixture.cleanup(); } };
  } catch (error) {
    await browser?.close();
    await fixture.cleanup();
    throw error;
  }
}

async function focusLineEnd(page: Page, text: string) {
  await expect(page.locator(".cm-content")).toContainText(text);
  await page.evaluate((text) => {
    const content = document.querySelector(".cm-content") as HTMLElement & { cmView?: { view?: any } };
    const view = content.cmView?.view;
    const start = view.state.doc.toString().indexOf(text);
    view.dispatch({ selection: { anchor: start + text.length } });
    view.focus();
  }, text);
}

for (const mode of ["desktop", "browser"] as const) {
  test.describe(mode, () => {
    test("folds nested bullets and tasks independently without hiding siblings", async () => {
      const source = [
        "- Parent", "  - Nested parent", "    Continuation text", "    - Grandchild", "  - Sibling",
        "  - [ ] Task parent", "    - Task child", "- After", "", "Plain text",
      ].join("\n");
      const { page, cleanup } = await launchListWorkspace(mode === "browser", {
        mutable: true,
        prepareWorkspace: async (root) => {
          await writeFile(path.join(root, "notes/test-notes/nested-folds.md"), source);
        },
      });
      try {
        await page.getByRole("button", { name: /nested-folds/i }).first().click();
        await focusLineEnd(page, "Plain text");
        const line = (text: string) => page.locator(".cm-line").filter({ hasText: text });
        const nested = line("Nested parent").getByRole("button", { name: "Collapse section" });
        await line("Nested parent").hover();
        await expect(nested).toHaveCSS("opacity", "1");
        await expect(line("Grandchild")).not.toHaveCSS("background-image", "none");
        await expect(line("Continuation text")).not.toHaveCSS("background-image", "none");
        await expect(line("After")).not.toHaveCSS("background-image", "none");
        await expect(line("Plain text")).toHaveCSS("background-image", "none");
        await page.screenshot({ path: test.info().outputPath("nested-guides.png") });
        await nested.click();
        await expect(line("Grandchild")).toBeHidden();
        await expect(line("Continuation text")).toBeHidden();
        await expect(line("Sibling")).toBeVisible();
        await page.locator('[data-exograph-fold-anchor="0"]').click();
        await expect(line("Nested parent")).toBeHidden();
        await expect(line("After")).toBeVisible();
        await expect(line("After")).toHaveCSS("background-image", "none");
        await page.locator('[data-exograph-fold-anchor="0"]').click();
        await expect(line("Grandchild")).toBeHidden();
        await line("Nested parent").getByRole("button", { name: "Expand section" }).click();
        await expect(line("Grandchild")).toBeVisible();
        await line("Task parent").hover();
        await line("Task parent").getByRole("button", { name: "Collapse section" }).click();
        await expect(line("Task child")).toBeHidden();
        await expect(line("After")).toBeVisible();
        await line("Task parent").getByRole("button", { name: "Expand section" }).click();
        await expect(line("Task child")).toBeVisible();
        await expect.poll(() => page.evaluate(() => {
          const content = document.querySelector(".cm-content") as HTMLElement & { cmView?: { view?: any } };
          return content.cmView?.view?.state.doc.toString();
        })).toBe(source);
      } finally { await cleanup(); }
    });

    test("keeps empty bullet and task carets the same height as typed text", async () => {
      const { page, cleanup } = await launchListWorkspace(mode === "browser", {
        mutable: true,
        prepareWorkspace: async (root) => {
          await writeFile(path.join(root, "notes/test-notes/list-carets.md"), "- Bullet\n\n- [ ] Task\n");
        },
      });
      try {
        await page.getByRole("button", { name: /list-carets/i }).first().click();
        const cursorHeight = () => page.locator(".cm-cursor").first().evaluate((cursor) => cursor.getBoundingClientRect().height);
        for (const text of ["Bullet", "Task"]) {
          await focusLineEnd(page, text);
          await expect(page.locator(".cm-cursor").first()).toBeAttached();
          await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
          await expect.poll(cursorHeight).toBeGreaterThan(0);
          const typed = await cursorHeight();
          await page.keyboard.press("Enter");
          await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
          await expect.poll(async () => Math.abs(await cursorHeight() - typed)).toBeLessThanOrEqual(1);
          await page.screenshot({ path: test.info().outputPath(`empty-${text.toLowerCase()}.png`) });
          await page.keyboard.type("Next");
          await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
          await expect.poll(async () => Math.abs(await cursorHeight() - typed)).toBeLessThanOrEqual(1);
          await expect(page.locator(".cm-content")).toContainText("Next");
        }
        await expect.poll(() => page.evaluate(() => {
          const content = document.querySelector(".cm-content") as HTMLElement & { cmView?: { view?: any } };
          return content.cmView?.view?.state.doc.toString();
        })).toBe("- Bullet\n- Next\n\n- [ ] Task\n- [ ] Next\n");
      } finally { await cleanup(); }
    });

  });
}
