import os from "node:os";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { expect, test } from "@playwright/test";

import { launchExographTerminalFixture } from "../helpers";

const RUN_REAL_MODEL_GATE = process.env.EXOGRAPH_REAL_EMBEDDING_GATE === "1";

test.skip(!RUN_REAL_MODEL_GATE, "Set EXOGRAPH_REAL_EMBEDDING_GATE=1 for the opt-in local-model convergence gate.");
test.setTimeout(240_000);

test("converges automatic embeddings without blocking canonical workspace surfaces", async () => {
  const fixture = await launchExographTerminalFixture({
    mutable: true,
    initialNoteLabel: "model-convergence",
    env: {
      // Keep CI network-independent. An operator opting into this gate may
      // point at an existing QMD model cache or allow QMD to populate it.
      XDG_CACHE_HOME: process.env.EXOGRAPH_REAL_EMBEDDING_CACHE_ROOT ?? path.join(os.homedir(), ".cache"),
    },
    prepareWorkspace: async (workspaceRoot) => {
      const noteRoot = path.join(workspaceRoot, "notes/model-gate");
      await mkdir(noteRoot, { recursive: true });
      await writeFile(path.join(noteRoot, "model-convergence.md"), "# Model convergence\n\nInitial indexed text. [[linked]]\n", "utf8");
      await writeFile(path.join(noteRoot, "linked.md"), "# Linked\n\nGraph neighbor.\n", "utf8");
    },
    prepareSettings: async ({ settingsPath, workspaceRoot }) => {
      const noteRoot = path.join(workspaceRoot, "notes/model-gate");
      await writeFile(settingsPath, JSON.stringify({
        workspaceRoot,
        defaultTerminalCwd: workspaceRoot,
        noteRoots: [noteRoot],
        indexedRoots: [{
          id: "index-model-gate",
          label: "model-gate",
          path: noteRoot,
          kind: "notes",
          pattern: "**/*.md",
          ignore: [],
          backend: "qmd",
        }],
        indexing: { enabled: true, mode: "hybrid", backend: "qmd" },
        searchEngine: "qmd",
        appearanceMode: "system",
        colorThemeId: "exograph-neutral",
        editorFontSize: 15,
        terminalFontSize: 13,
        explorerScale: 1,
        exploreIndexSearchOnEnter: true,
        indexUpdateStrategy: "on-save",
      }, null, 2), "utf8");
    },
  });

  try {
    const focusPath = path.join(fixture.workspaceRoot, "notes/model-gate/model-convergence.md");
    await fixture.page.evaluate((filePath) => {
      const scoped = window as typeof window & {
        __exographAutoEmbeddingEvents?: Array<{ state: string; reason: string; at: number }>;
        __exographAutoEmbeddingSurfaces?: Promise<{
          graphAvailable: boolean;
          searchSource: string;
          searchWarnings: string[];
          statusWarnings: string[];
          terminalAvailable: boolean;
        }>;
      };
      scoped.__exographAutoEmbeddingEvents = [];
      window.exograph.workspace.onIndexSyncState((event) => {
        scoped.__exographAutoEmbeddingEvents?.push({ state: event.state, reason: event.reason, at: performance.now() });
        if (event.state !== "running" || event.reason !== "automatic-embedding" || scoped.__exographAutoEmbeddingSurfaces) return;
        scoped.__exographAutoEmbeddingSurfaces = Promise.all([
          window.exograph.notes.getGraphContext(filePath),
          window.exograph.workspace.searchIndex("convergence sentinel", { limit: 5 }),
          window.exograph.workspace.getIndexStatus(),
          window.exograph.terminals.list().then(async ([terminal]) => {
            if (!terminal) return false;
            await window.exograph.terminals.write(terminal.id, "automatic-embedding-terminal-alive\n");
            return true;
          }),
        ]).then(([graph, search, status, terminalAvailable]) => ({
          graphAvailable: graph !== null,
          searchSource: search.source,
          searchWarnings: search.warnings,
          statusWarnings: status.warnings,
          terminalAvailable,
        }));
      });
    }, focusPath);

    await fixture.page.getByRole("button", { name: "linked" }).first().click();
    await expect(fixture.page.getByTestId("editor-title")).toHaveText("linked");
    await fixture.page.getByRole("button", { name: "model-convergence" }).first().click();
    await expect(fixture.page.getByTestId("editor-title")).toHaveText("model-convergence");

    const baseline = await fixture.page.evaluate(() => window.exograph.workspace.syncIndex());
    console.info(`Real-model baseline sync: ${JSON.stringify(baseline)}`);
    expect(baseline.status).toMatchObject({ hasVectorIndex: true, pendingEmbeddings: 0 });
    expect(baseline.status.errors).toEqual([]);

    await fixture.page.evaluate(async ({ filePath, body }) => {
      const document = await window.exograph.notes.read(filePath);
      return window.exograph.notes.save(filePath, {}, body, document.revision);
    }, {
      filePath: focusPath,
      body: "# Model convergence\n\nConvergence sentinel appears only after the automatic local embedding slice. [[linked]]\n",
    });

    const pendingObservedAt = Date.now();
    await expect.poll(
      () => fixture.page.evaluate(() => window.exograph.workspace.getIndexStatus().then((status) => status.pendingEmbeddings)),
      { timeout: 60_000, intervals: [250, 500, 1_000] },
    ).toBeGreaterThan(0);

    await fixture.page.waitForFunction(() => {
      const events = (window as typeof window & {
        __exographAutoEmbeddingEvents?: Array<{ state: string; reason: string }>;
      }).__exographAutoEmbeddingEvents ?? [];
      return events.some((event) => event.state === "running" && event.reason === "automatic-embedding");
    }, undefined, { timeout: 90_000, polling: 100 });

    const during = await fixture.page.evaluate(() => (
      window as typeof window & {
        __exographAutoEmbeddingSurfaces?: Promise<{
          graphAvailable: boolean;
          searchSource: string;
          searchWarnings: string[];
          statusWarnings: string[];
          terminalAvailable: boolean;
        }>;
      }
    ).__exographAutoEmbeddingSurfaces);
    expect(during).toMatchObject({ graphAvailable: true, searchSource: "filesystem", terminalAvailable: true });
    expect(during?.searchWarnings).toContain("Index maintenance is running; showing Simple search results until it completes.");
    expect(during?.statusWarnings).toContain("Index maintenance is running; showing the last available index status until it finishes.");
    expect(during?.statusWarnings.join(" ")).toContain("waiting for automatic catch-up");
    expect(during?.statusWarnings.join(" ")).not.toContain("exograph index sync");

    await fixture.page.waitForFunction(() => {
      const events = (window as typeof window & {
        __exographAutoEmbeddingEvents?: Array<{ state: string; reason: string }>;
      }).__exographAutoEmbeddingEvents ?? [];
      return events.some((event) => event.state === "idle" && event.reason === "automatic-embedding");
    }, undefined, { timeout: 60_000, polling: 100 });

    await expect.poll(
      () => fixture.page.evaluate(() => window.exograph.workspace.getIndexStatus().then((status) => status.pendingEmbeddings)),
      { timeout: 60_000, intervals: [250, 500, 1_000] },
    ).toBe(0);
    const converged = await fixture.page.evaluate(() => window.exograph.workspace.getIndexStatus());
    const events = await fixture.page.evaluate(() => (
      window as typeof window & {
        __exographAutoEmbeddingEvents?: Array<{ state: string; reason: string; at: number }>;
      }
    ).__exographAutoEmbeddingEvents ?? []);
    console.info(`Real-model automatic events: ${JSON.stringify(events)}`);
    expect(converged).toMatchObject({ hasVectorIndex: true, pendingEmbeddings: 0, errors: [] });
    expect(converged.recentJobs).toContainEqual(expect.objectContaining({
      kind: "embed",
      reason: "automatic-embedding",
      status: "completed",
      pendingEmbeddings: 0,
    }));
    const semantic = await fixture.page.evaluate(() => window.exograph.workspace.searchIndex(
      "convergence sentinel",
      { limit: 5, forceMode: "semantic" },
    ));
    expect(semantic.source).toBe("qmd");
    expect(semantic.warnings.join(" ")).not.toMatch(/not ready|using lexical/i);
    expect(semantic.results.map((result) => result.title)).toContain("Model convergence");

    console.info(`Real-model derived-work convergence: ${JSON.stringify({
      pendingAgeMs: Date.now() - pendingObservedAt,
      documentCount: converged.documentCount,
      pendingEmbeddings: converged.pendingEmbeddings,
      hasVectorIndex: converged.hasVectorIndex,
      during,
    })}`);
  } finally {
    await fixture.cleanup();
  }
});
