import { expect, test, type Page, type Locator } from "@playwright/test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { launchExographWorkspaceFixture } from "../helpers";

async function drag(page: Page, from: Locator, to: Locator) {
  const source = (await from.boundingBox())!;
  const target = (await to.boundingBox())!;
  await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2);
  await page.mouse.down();
  await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 12 });
  await expect(to).toHaveClass(/tree-node--drop-target/);
  await page.screenshot({ path: test.info().outputPath("folder-drop.png") });
  await page.mouse.up();
}

for (const multiple of [false, true]) {
  test(`moves ${multiple ? "Shift-selected files" : "a single file"} into a folder`, async () => {
    let root = "";
    const fixture = await launchExographWorkspaceFixture({ mutable: true, initialNoteLabel: null,
      prepareWorkspace: async (workspace) => {
        root = path.join(workspace, "notes/test-notes");
        await mkdir(path.join(root, "Destination"));
        for (const name of ["alpha", "beta", "gamma"]) await writeFile(path.join(root, `${name}.md`), `# ${name}\n`);
      },
    });
    const { page, cleanup } = fixture;
    const row = (name: string) => page.locator(`[data-explorer-path="${path.join(root, name)}"]`);
    try {
      await row("alpha.md").click();
      if (multiple) {
        await row("gamma.md").click({ modifiers: ["Shift"] });
        for (const name of ["alpha", "beta", "gamma"]) await expect(row(`${name}.md`)).toHaveAttribute("aria-pressed", "true");
      }
      await drag(page, row("alpha.md"), row("Destination"));
      for (const name of multiple ? ["alpha", "beta", "gamma"] : ["alpha"]) {
        await expect.poll(() => readFile(path.join(root, "Destination", `${name}.md`), "utf8").catch(() => "missing")).toBe(`# ${name}\n`);
        await expect(row(`${name}.md`)).toHaveCount(0);
      }
      await row(multiple ? "Destination/beta.md" : "beta.md").click();
      await expect(page.getByTestId("editor-title")).toHaveText("beta");
    } finally { await cleanup(); }
  });
}

test("Command-click toggles individual files and a collision preserves both notes", async () => {
  let root = "";
  const { page, cleanup } = await launchExographWorkspaceFixture({ mutable: true, initialNoteLabel: null,
    prepareWorkspace: async (workspace) => {
      root = path.join(workspace, "notes/test-notes");
      await mkdir(path.join(root, "Destination"));
      for (const name of ["alpha", "beta", "gamma"]) await writeFile(path.join(root, `${name}.md`), `# ${name}\n`);
      await writeFile(path.join(root, "Destination/alpha.md"), "Existing note\n");
    },
  });
  const row = (name: string) => page.locator(`[data-explorer-path="${path.join(root, name)}"]`);
  try {
    await row("alpha.md").click();
    await row("gamma.md").click({ modifiers: ["Meta"] });
    await expect(row("alpha.md")).toHaveAttribute("aria-pressed", "true");
    await expect(row("beta.md")).toHaveAttribute("aria-pressed", "false");
    await expect(row("gamma.md")).toHaveAttribute("aria-pressed", "true");
    await row("gamma.md").click({ modifiers: ["Meta"] });
    await expect(row("gamma.md")).toHaveAttribute("aria-pressed", "false");
    await row("gamma.md").click({ modifiers: ["Meta"] });
    await drag(page, row("alpha.md"), row("Destination"));
    await expect(page.getByText("Destination already exists", { exact: true })).toBeVisible();
    expect(await readFile(path.join(root, "alpha.md"), "utf8")).toBe("# alpha\n");
    expect(await readFile(path.join(root, "Destination/alpha.md"), "utf8")).toBe("Existing note\n");
    expect(await readFile(path.join(root, "gamma.md"), "utf8")).toBe("# gamma\n");
  } finally { await cleanup(); }
});
