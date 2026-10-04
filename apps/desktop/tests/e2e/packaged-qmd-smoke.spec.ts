import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { expect, test } from "@playwright/test";

import { launchExographWorkspaceFixture } from "../helpers";

test.skip(!process.env.EXOGRAPH_PACKAGED_APP_PATH, "Requires an exact packaged Exograph executable.");

test("indexes and retrieves a Note through packaged QMD lexical search", async () => {
  const exactPaths = ["client engagement.md", "client-engagement.md", "_archive/note_one.md", "Café 🐘.md", "part___one.md"];
  const fixture = await launchExographWorkspaceFixture({
    mutable: true,
    initialNoteLabel: "qmd-focus",
    prepareWorkspace: async (workspaceRoot) => {
      const noteRoot = path.join(workspaceRoot, "notes/qmd-smoke");
      await mkdir(noteRoot, { recursive: true });
      await writeFile(
        path.join(noteRoot, "qmd-focus.md"),
        "# QMD focus\n\nPackaged lexical sentinel northstar-coriander.\n",
        "utf8",
      );
      await writeFile(path.join(noteRoot, "neighbor.md"), "# Neighbor\n\nA second indexed Note.\n", "utf8");
      for (const [index, relativePath] of exactPaths.entries()) {
        const filePath = path.join(noteRoot, relativePath);
        await mkdir(path.dirname(filePath), { recursive: true });
        await writeFile(filePath, `# Exact path ${index}\n\nExactpathsentinel body ${index}.\n`, "utf8");
      }
    },
    prepareSettings: async ({ settingsPath, workspaceRoot }) => {
      const noteRoot = path.join(workspaceRoot, "notes/qmd-smoke");
      await writeFile(settingsPath, JSON.stringify({
        workspaceRoot,
        defaultTerminalCwd: workspaceRoot,
        noteRoots: [noteRoot],
        indexedRoots: [{
          id: "packaged-qmd-smoke",
          label: "QMD smoke",
          path: noteRoot,
          kind: "notes",
          pattern: "**/*.md",
          ignore: [],
          backend: "qmd",
        }],
        indexing: { enabled: true, mode: "lexical", backend: "qmd" },
        searchEngine: "qmd",
        appearanceMode: "system",
        colorThemeId: "exograph-neutral",
        editorFontSize: 15,
        terminalFontSize: 13,
        explorerScale: 1,
        exploreIndexSearchOnEnter: true,
        indexUpdateStrategy: "manual",
      }, null, 2), "utf8");
    },
  });

  try {
    const sync = await fixture.page.evaluate(() => window.exograph.workspace.syncIndex());
    expect(sync.status).toMatchObject({
      backend: "qmd",
      mode: "lexical",
      documentCount: 2 + exactPaths.length,
      errors: [],
    });

    const result = await fixture.page.evaluate(() => window.exograph.workspace.searchIndex(
      "northstar-coriander",
      { limit: 5, forceMode: "lexical" },
    ));
    expect(result).toMatchObject({ source: "qmd", mode: "lexical", warnings: [] });
    expect(result.results.map((entry) => entry.title)).toContain("QMD focus");

    const paths = await fixture.page.evaluate(() => window.exograph.workspace.searchIndex(
      "Exactpathsentinel", { limit: 10, forceMode: "lexical" },
    ));
    expect(paths).toMatchObject({ source: "qmd", mode: "lexical", warnings: [] });
    expect(paths.results).toHaveLength(exactPaths.length);
    for (const [index, relativePath] of exactPaths.entries()) {
      expect(paths.results.find((entry) => entry.filePath.endsWith(`/notes/qmd-smoke/${relativePath}`)))
        .toMatchObject({ title: `Exact path ${index}`, snippet: expect.stringContaining(`Exactpathsentinel body ${index}`) });
    }
  } finally {
    await fixture.cleanup();
  }
});
