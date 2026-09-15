import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { launchExographWorkspaceFixture } from "../helpers";

test.use({
  launchOptions: {
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  },
});

test("browser shares live notes, preserves conflicting edits, and renders the graph at pane width", async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const fixture = await launchExographWorkspaceFixture({
    mutable: true,
    initialNoteLabel: null,
  });
  const context = await browser.newContext({
    viewport: { width: 560, height: 850 },
  });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await expect
      .poll(async () => {
        try {
          await readFile(
            path.join(fixture.workspaceRoot, ".exograph", "server.json"),
          );
          return true;
        } catch {
          return false;
        }
      })
      .toBe(true);
    const server = JSON.parse(
      await readFile(
        path.join(fixture.workspaceRoot, ".exograph", "server.json"),
        "utf8",
      ),
    );
    const response = await fetch(`http://127.0.0.1:${server.port}/browser`, {
      method: "POST",
      headers: { Authorization: `Bearer ${server.token}` },
    });
    expect(response.status).toBe(200);
    const { url } = await response.json();
    await page.goto(url);
    await expect(page.getByText("Connected", { exact: true })).toBeVisible();
    await expect(
      page
        .getByRole("complementary", { name: "Notes navigation" })
        .getByRole("button", { name: "focus-note", exact: true }),
    ).toBeVisible();
    let releaseRead!: () => void;
    const heldRead = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    const isFocusRead = (request: import("@playwright/test").Request) =>
      request.url().endsWith("/api/read") &&
      request.postDataJSON()?.args?.[0]?.endsWith("/focus-note.md");
    await page.route("**/api/read", async (route) => {
      if (isFocusRead(route.request())) await heldRead;
      await route.continue();
    });
    const firstRead = page.waitForRequest(isFocusRead);
    await page
      .getByRole("complementary", { name: "Notes navigation" })
      .getByRole("button", { name: "focus-note", exact: true })
      .click();
    await firstRead;
    await page
      .getByRole("complementary", { name: "Notes navigation" })
      .getByRole("button", { name: "related-note", exact: true })
      .click();
    await expect(page.getByTestId("editor-title")).toHaveText("related-note");
    const delayedResponse = page.waitForResponse((response) =>
      isFocusRead(response.request()),
    );
    releaseRead();
    await (await delayedResponse).finished();
    await page.unroute("**/api/read");
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    await expect(page.getByTestId("editor-title")).toHaveText("related-note");
    await page
      .getByRole("button", { name: "Toggle notes", exact: true })
      .click();
    await page
      .getByRole("complementary", { name: "Notes navigation" })
      .getByRole("button", { name: "focus-note", exact: true })
      .click();
    await expect(page.getByTestId("editor-title")).toHaveText("focus-note");
    const editor = page.locator(".cm-content");
    await editor.click();
    await page.keyboard.press("Meta+End");
    await page.keyboard.insertText("\nBrowser workspace proof");
    await page.keyboard.press("Meta+s");
    const model = await fixture.page.evaluate(() =>
      window.exograph.workspace.getModel(),
    );
    const tree = await fixture.page.evaluate(
      (root) =>
        window.exograph.workspace.listTree(root, {
          markdownOnly: true,
          maxDepth: 5,
        }),
      model.noteRoots[0].path,
    );
    function find(nodes: typeof tree): string | undefined {
      for (const node of nodes) {
        if (node.name === "focus-note.md") return node.path;
        const child = find(node.children ?? []);
        if (child) return child;
      }
      return undefined;
    }
    const file = find(tree)!;
    expect(file).toBeTruthy();
    await expect
      .poll(() => readFile(file, "utf8"))
      .toContain("Browser workspace proof");
    await writeFile(
      file,
      (await readFile(file, "utf8")) + "\nExternal update proof\n",
    );
    await expect(editor).toContainText("External update proof");
    await editor.click();
    await page.keyboard.press("Meta+End");
    await page.keyboard.insertText("\nUnsaved browser change");
    await writeFile(
      file,
      (await readFile(file, "utf8")) + "\nConcurrent desktop edit\n",
    );
    await expect(
      page
        .getByText(
          /changed.*disk|changed.*outside|changed.*since|changed elsewhere/i,
        )
        .first(),
    ).toBeVisible();
    await expect(editor).toContainText("Unsaved browser change");
    expect(await readFile(file, "utf8")).not.toContain(
      "Unsaved browser change",
    );
    await page.getByRole("button", { name: "Graph", exact: true }).click();
    await expect(page.locator(".spatial-graph canvas").first()).toBeVisible();
    await expect(page.getByText("Building graph", { exact: true })).toHaveCount(
      0,
      { timeout: 30_000 },
    );
    await expect(
      page.getByText("Graph unavailable · retry", { exact: true }),
    ).toHaveCount(0);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    expect(
      (await page.locator(".spatial-graph__viewport").boundingBox())!.height,
    ).toBeGreaterThan(600);
    expect(
      (await page.locator(".spatial-graph__detail").boundingBox())!.height,
    ).toBeLessThan(120);
    await page.screenshot({ path: "/tmp/exo-browser-workspace-graph.png" });
    await rm(file);
    await page.getByRole("button", { name: "Notes", exact: true }).click();
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByTestId("save-conflict-notice")).toContainText(
      "This file was removed.",
    );
    await page
      .getByRole("button", {
        name: "Discard local edits and close",
        exact: true,
      })
      .click();
    await expect(
      page.getByText("Open a note or explore the graph.", { exact: true }),
    ).toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    await context.close();
    await fixture.cleanup();
  }
});
