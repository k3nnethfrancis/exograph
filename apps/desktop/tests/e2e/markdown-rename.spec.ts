import { expect, test } from "@playwright/test";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { launchExographWorkspaceFixture } from "../helpers";

for (const directory of ["", "rename-nested"]) {
  test(`preserves Markdown across Explorer renames in ${directory || "the root"}`, async () => {
    const content = "# Rename preservation\n\nDo not lose this note.\n";
    const fixture = await launchExographWorkspaceFixture({
      prepareWorkspace: async (root) => {
        const folder = path.join(root, "notes/test-notes", directory);
        await mkdir(folder, { recursive: true });
        await writeFile(path.join(folder, "rename-original.md"), content);
      },
    });
    const { page } = fixture;
    try {
      if (directory) await page.locator(".tree-node--directory", { hasText: directory }).first().click();
      await page.getByTestId("sidebar").getByRole("button", { name: "rename-original, file", exact: true }).click();
      let previousName = "rename-original";
      let previousPath = path.join(fixture.workspaceRoot, "notes/test-notes", directory, `${previousName}.md`);
      for (const [input, filename] of [["rename-omitted", "rename-omitted.md"], ["rename-explicit.md", "rename-explicit.md"], ["rename-dotted.txt", "rename-dotted.txt.md"]]) {
        await page.getByTestId("sidebar").getByRole("button", { name: `${previousName}, file`, exact: true }).click({ button: "right" });
        await page.getByRole("button", { name: "Rename", exact: true }).click();
        await page.getByTestId("workspace-dialog-input").fill(input);
        await expect(page.getByTestId("workspace-dialog")).toContainText(`Filename: ${filename}`);
        await page.getByTestId("workspace-dialog-confirm").click();
        const nextPath = path.join(path.dirname(previousPath), filename);
        const title = filename.slice(0, -3);
        await expect(page.getByTestId("editor-title")).toHaveText(title);
        await expect(page.getByTestId("sidebar").getByRole("button", { name: `${title}, file`, exact: true })).toBeVisible();
        await expect.poll(() => readFile(nextPath, "utf8")).toBe(content);
        await expect(access(previousPath)).rejects.toThrow();
        await expect.poll(() => page.evaluate((query) => window.exograph.workspace.searchWorkspace(query), title))
          .toMatchObject({ notes: expect.arrayContaining([expect.objectContaining({ filePath: nextPath })]) });
        previousPath = nextPath;
        previousName = title;
      }
    } finally {
      await fixture.cleanup();
    }
  });
}

test("does not add a Markdown extension when renaming a folder ending in .md", async () => {
  const fixture = await launchExographWorkspaceFixture({
    prepareWorkspace: async (root) => {
      const folder = path.join(root, "notes/test-notes/folder.md");
      await mkdir(folder);
      await writeFile(path.join(folder, "child.md"), "# Child\n");
    },
  });
  try {
    const { page } = fixture;
    await page.locator(".tree-node--directory", { hasText: "folder.md" }).first().click({ button: "right" });
    await page.getByRole("button", { name: "Rename", exact: true }).click();
    await page.getByTestId("workspace-dialog-input").fill("renamed-folder");
    await page.getByTestId("workspace-dialog-confirm").click();
    await expect(readFile(path.join(fixture.workspaceRoot, "notes/test-notes/renamed-folder/child.md"), "utf8"))
      .resolves.toBe("# Child\n");
    await expect(access(path.join(fixture.workspaceRoot, "notes/test-notes/renamed-folder.md"))).rejects.toThrow();
  } finally {
    await fixture.cleanup();
  }
});
