import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { expect, test, type Locator, type Page } from "@playwright/test";
import { GraphEdgeVisualClass } from "@exograph/core";

import { launchExographWorkspaceFixture, relaunchExographWorkspaceFixture } from "../helpers";

test("reviews Ontology effects before publishing one persistent graph change", async ({}, testInfo) => {
  const fixture = await launchExographWorkspaceFixture({
    mutable: true,
    initialNoteLabel: "ontology-source",
    prepareWorkspace: async (workspaceRoot) => {
      await writeFile(
        path.join(workspaceRoot, "notes/test-notes/ontology-source.md"),
        "---\ntype: paper\nsupports: [ontology-target]\nrefutes: [ontology-target]\n---\n# Ontology source\n",
        "utf8",
      );
      await writeFile(
        path.join(workspaceRoot, "notes/test-notes/ontology-target.md"),
        "---\ntype: claim\n---\n# Ontology target\n",
        "utf8",
      );
      await writeOntology(workspaceRoot, 1);
      await writeAlternativeOntology(workspaceRoot);
    },
    prepareSettings: async ({ settingsPath, workspaceRoot }) => {
      const noteRoot = path.join(workspaceRoot, "notes/test-notes");
      await writeFile(settingsPath, JSON.stringify({
        workspaceRoot,
        defaultTerminalCwd: workspaceRoot,
        noteRoots: [noteRoot],
        indexedRoots: [],
        indexing: { enabled: false, mode: "off", backend: "qmd" },
        agentCommands: [{
          id: "fixture",
          label: "Fixture",
          handle: "fixture",
          command: "/usr/bin/true",
          adapter: "generic",
          continuityPolicy: "fresh",
          cwdPolicy: "workspace_root",
          promptDelivery: "stdin",
          version: 1,
          enabled: true,
        }],
        appearanceMode: "system",
        colorThemeId: "exograph-neutral",
        editorFontSize: 15,
        terminalFontSize: 13,
        explorerScale: 1,
        exploreIndexSearchOnEnter: false,
        indexUpdateStrategy: "manual",
      }, null, 2), "utf8");
    },
  });
  let relaunched: Awaited<ReturnType<typeof relaunchExographWorkspaceFixture>> | null = null;
  const sourcePath = path.join(fixture.workspaceRoot, "notes/test-notes/ontology-source.md");
  const targetPath = path.join(fixture.workspaceRoot, "notes/test-notes/ontology-target.md");
  const noteRoot = path.join(fixture.workspaceRoot, "notes/test-notes");

  try {
    const originalBytes = await readFile(sourcePath, "utf8");
    const originalNoteBytes = await markdownByteMap(noteRoot);
    await expectGraphContext(fixture.page, sourcePath, { ontologyRelations: 0, outgoing: 0, backlinks: 0 });
    await expect.poll(() => ontologyEdgeCount(fixture.page)).toBe(0);
    await openUtilityGraph(fixture.page);
    await expect(fixture.page.getByTestId("graph-pane")).toBeVisible();
    await expect(fixture.page.locator(".spatial-graph__viewport")).toHaveAttribute("data-scene-ready", "true");
    const paneBounds = (await fixture.page.getByTestId("utility-pane").boundingBox())!;
    const handle = (await fixture.page.getByTestId("utility-pane-resizer").boundingBox())!;
    await fixture.page.mouse.move(handle.x + handle.width / 2, handle.y + 120);
    await fixture.page.mouse.down();
    await fixture.page.mouse.move(handle.x + handle.width / 2 + paneBounds.width - 240, handle.y + 120, { steps: 8 });
    await fixture.page.mouse.up();
    const compact = fixture.page.getByTestId("graph-ontology");
    const summary = compact.locator(":scope > summary");
    await expect(summary).toHaveText("Active: Generic");
    const selection = () => fixture.page.locator("canvas.spatial-graph__interaction").evaluate(element => {
      const snapshot = (element as HTMLCanvasElement & {
        __exographGraphSnapshot?: () => { selected: number } | null;
      }).__exographGraphSnapshot?.();
      if (!snapshot || !Number.isInteger(snapshot.selected)) throw new Error("Graph selection snapshot unavailable");
      return snapshot.selected;
    });
    await expect.poll(selection).toBeGreaterThanOrEqual(0);
    const selectedBefore = await selection();
    expect(selectedBefore).toBeGreaterThanOrEqual(0);
    await summary.click();
    await compact.getByRole("combobox", { name: "Preview ontology" }).selectOption({ label: "criticism" });
    await expect(compact).toContainText("Preview: criticism");
    await expect(summary).toHaveText("Active: Generic");
    expect(await ontologyEdgeCount(fixture.page)).toBe(0);
    const popup = fixture.page.getByTestId("graph-ontology-review");
    expect(await popup.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
    const popupFitsGraph = () => popup.evaluate(element => {
      const graph = element.closest(".spatial-graph")!;
      return element.getBoundingClientRect().bottom <= graph.getBoundingClientRect().bottom - 4;
    });
    await expect.poll(popupFitsGraph).toBe(true);
    // Exercise a short graph host as well as the normal utility height.
    const graphSurface = fixture.page.getByTestId("spatial-graph");
    await graphSurface.evaluate(element => { element.style.height = "200px"; });
    await expect.poll(popupFitsGraph).toBe(true);
    await graphSurface.evaluate(element => { element.style.removeProperty("height"); });
    await compact.getByRole("button", { name: "Activate ontology" }).focus();
    await fixture.page.keyboard.press("Escape");
    await expect(compact).not.toHaveAttribute("open", "");
    await expect(summary).toBeFocused();
    expect(await selection()).toBe(selectedBefore);
    await summary.click();
    const outsideEditor = fixture.page.locator(".editor-surface .cm-content").first();
    await expect(outsideEditor).toBeVisible();
    await outsideEditor.click({ position: { x: 8, y: 8 } });
    await expect(compact).not.toHaveAttribute("open", "");

    await openWorkspaceSettings(fixture.page);
    const row = fixture.page.getByTestId("workspace-settings-ontology");
    await expect(row).toContainText("Generic");
    const settingsPanel = fixture.page.locator(".workspace-settings-panel");
    const availableWidth = await settingsPanel.evaluate(element => {
      const style = getComputedStyle(element);
      return element.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    });
    expect((await row.boundingBox())!.width).toBeGreaterThanOrEqual(availableWidth - 2);
    await expect(row).toContainText("research");
    await expect(row).toContainText("2 typed");
    await expect(row).toContainText("+1 relations");
    await expect(row).toContainText("0 findings");
    await expect(row.getByRole("button", { name: "Activate ontology" })).toBeVisible();
    await expect(row).not.toContainText(fixture.workspaceRoot);
    await fixture.page.screenshot({ path: testInfo.outputPath("ontology-review-candidate.png") });

    const changedBytes = originalBytes.replace("# Ontology source", "# Ontology source changed");
    await writeFile(sourcePath, changedBytes, "utf8");
    await expect.poll(
      () => fixture.page.evaluate((filePath) => window.exograph.notes.getGraphContext(filePath).then((context) => context?.note.title), sourcePath),
      { timeout: 10_000 },
    ).toBe("Ontology source changed");

    await row.getByRole("button", { name: "Activate ontology" }).click();
    await expect(row).toContainText("Changed—review again");
    await expectGraphContext(fixture.page, sourcePath, { ontologyRelations: 0, outgoing: 0, backlinks: 0 });
    await expect.poll(() => ontologyEdgeCount(fixture.page)).toBe(0);

    await expect(row.getByRole("button", { name: "Activate ontology" })).toBeVisible();
    await row.getByRole("button", { name: "Activate ontology" }).click();
    await expect(row).toContainText("Activated");
    await expect(row.getByRole("button", { name: "Activate ontology" })).toHaveCount(0);
    await expectGraphContext(fixture.page, sourcePath, { ontologyRelations: 1, outgoing: 0, backlinks: 0 });
    await expectGraphContext(fixture.page, targetPath, { ontologyRelations: 1, outgoing: 0, backlinks: 0 });
    await expect.poll(() => ontologyEdgeCount(fixture.page)).toBe(1);
    const reviewedNoteBytes = new Map(originalNoteBytes);
    reviewedNoteBytes.set(path.relative(noteRoot, sourcePath), changedBytes);
    expect(await markdownByteMap(noteRoot)).toEqual(reviewedNoteBytes);
    const acceptedEvidence = await ontologyEvidence(fixture.page, sourcePath);
    expect(acceptedEvidence.relation).toMatchObject({
      origin: "ontology",
      predicate: "supports",
    });
    expect(acceptedEvidence.relation?.evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "ontology-rule" }),
    ]));
    expect(acceptedEvidence.ontology).toMatchObject({ state: "active", id: "research", version: "1" });

    await fixture.page.getByTestId("workspace-settings-close").click();
    const graphPane = fixture.page.getByTestId("graph-pane");
    await expect(graphPane.locator(".spatial-graph__count")).toHaveText(/\d+ · \d+/);
    await expectCanvasPixels(graphPane.locator('canvas[aria-label="Interactive knowledge graph"]'));
    await fixture.page.screenshot({ path: testInfo.outputPath("ontology-review-kept-graph.png") });

    await fixture.electronApp.close();
    relaunched = await relaunchExographWorkspaceFixture(fixture);
    await relaunched.page.getByRole("button", { name: "ontology-source" }).first().click();
    await expect(relaunched.page.getByTestId("editor-title")).toHaveText("ontology-source");
    await expectGraphContext(relaunched.page, sourcePath, { ontologyRelations: 1, outgoing: 0, backlinks: 0 });
    await expect.poll(() => ontologyEdgeCount(relaunched!.page)).toBe(1);
    const restartedEvidence = await ontologyEvidence(relaunched.page, sourcePath);
    expect(restartedEvidence.ontology).toEqual(acceptedEvidence.ontology);
    expect(await markdownByteMap(noteRoot)).toEqual(reviewedNoteBytes);

    await openUtilityGraph(relaunched.page);
    const restartedGraph = relaunched.page.getByTestId("graph-pane");
    await expect(restartedGraph.locator(".spatial-graph__count")).toHaveText(/\d+ · \d+/);
    await expectCanvasPixels(restartedGraph.locator('canvas[aria-label="Interactive knowledge graph"]'));

    await openWorkspaceSettings(relaunched.page);
    const restartedRow = relaunched.page.getByTestId("workspace-settings-ontology");
    await expect(restartedRow).toContainText("research");
    await expect(restartedRow.getByRole("button", { name: "Activate ontology" })).toHaveCount(0);

    await writeOntology(fixture.workspaceRoot, 2);
    await expect(restartedRow).toContainText("v2");
    await restartedRow.getByRole("button", { name: "Reject ontology" }).click();
    await expect(restartedRow).toContainText("Not applied");
    await expectGraphContext(relaunched.page, sourcePath, { ontologyRelations: 1, outgoing: 0, backlinks: 0 });
    await expect.poll(() => ontologyEdgeCount(relaunched!.page)).toBe(1);
    expect(await markdownByteMap(noteRoot)).toEqual(reviewedNoteBytes);
    const afterRejectEvidence = await ontologyEvidence(relaunched.page, sourcePath);
    expect(afterRejectEvidence.ontology).toEqual(acceptedEvidence.ontology);
    expect(afterRejectEvidence.sourceSnapshotId).toBe(restartedEvidence.sourceSnapshotId);

    const selector = restartedRow.getByRole("combobox", { name: "Preview ontology" });
    await selector.selectOption({ label: "criticism" });
    await expect(restartedRow).toContainText("Preview: criticism");
    await restartedRow.getByRole("button", { name: "Activate ontology" }).click();
    await expect.poll(async () => (await ontologyEvidence(relaunched!.page, sourcePath)).relation?.predicate).toBe("refutes");

    await selector.selectOption({ label: "Generic" });
    await expect(restartedRow).toContainText("Preview: Generic");
    await restartedRow.getByRole("button", { name: "Activate ontology" }).click();
    await expectGraphContext(relaunched.page, sourcePath, { ontologyRelations: 0, outgoing: 0, backlinks: 0 });
    await expect.poll(() => ontologyEdgeCount(relaunched!.page)).toBe(0);
    await relaunched.page.getByTestId("workspace-settings-close").click();
    await expect(restartedGraph.locator(".spatial-graph__count")).toHaveText(/\d+ · \d+/);

    await relaunched.page.getByTestId("open-note-graph").click();
    const activeGraphPane = relaunched.page.getByTestId("graph-pane");
    await expect(activeGraphPane.locator(".spatial-graph__detail-title")).toHaveText("Ontology source changed");
    const beforeGraphPreparation = await markdownByteMap(noteRoot);
    await activeGraphPane.locator(".spatial-graph__detail details > summary").click();
    await activeGraphPane.getByRole("button", { name: "Find relevant connections" }).click();
    await expect(relaunched.page.getByTestId("inline-agent-composer")).toHaveCount(1);
    await expect(relaunched.page.locator(".cm-content")).toContainText("Read and apply the Exograph-owned Skill");
    await expect(readFile(path.join(noteRoot, "skills/find-and-connect-relevant-context.md"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
    await expect.poll(() => markdownByteMap(noteRoot)).toEqual(beforeGraphPreparation);
  } finally {
    await relaunched?.electronApp.close().catch(() => {});
    await fixture.cleanup();
  }
});

async function writeOntology(workspaceRoot: string, version: number): Promise<void> {
  await writeFile(path.join(workspaceRoot, "ontology.yaml"), [
    "ontology_schema: 1",
    "id: research",
    `version: ${version}`,
    "types:",
    "  paper: {}",
    "  claim: {}",
    "properties:",
    "  supports:",
    "    value: reference[]",
    "    predicate: supports",
  ].join("\n"), "utf8");
}

async function writeAlternativeOntology(workspaceRoot: string): Promise<void> {
  const library = path.join(workspaceRoot, "ontologies");
  await mkdir(library, { recursive: true });
  await writeFile(path.join(library, "criticism.yaml"), [
    "ontology_schema: 1",
    "id: criticism",
    "version: 1",
    "types:",
    "  paper: {}",
    "  claim: {}",
    "properties:",
    "  refutes:",
    "    value: reference[]",
    "    predicate: refutes",
  ].join("\n"), "utf8");
}

async function openWorkspaceSettings(page: Page): Promise<void> {
  await page.getByTestId("workspace-menu-toggle").click();
  await page.getByTestId("workspace-menu-settings").click();
  await expect(page.getByTestId("workspace-settings-dialog")).toBeVisible();
  await page.getByTestId("workspace-settings-tab-graph").click();
  await expect(page.getByTestId("workspace-settings-ontology").getByText("Previewing…")).toHaveCount(0, { timeout: 10_000 });
}

async function openUtilityGraph(page: Page): Promise<void> {
  const utility = page.getByTestId("utility-pane");
  if (await utility.count() === 0 || !await utility.isVisible()) await page.getByTestId("utility-pane-toggle").click();
  await page.getByTestId("utility-pane-graph").click();
}

async function expectGraphContext(
  page: Page,
  filePath: string,
  expected: { ontologyRelations: number; outgoing: number; backlinks: number },
): Promise<void> {
  await expect.poll(async () => page.evaluate((target) => window.exograph.notes.getGraphContext(target).then((context) => ({
    ontologyRelations: context?.neighborhoodRelations.length ?? -1,
    outgoing: context?.outgoing.length ?? -1,
    backlinks: context?.backlinks.length ?? -1,
  })), filePath), { timeout: 10_000 }).toEqual(expected);
}

async function ontologyEdgeCount(page: Page): Promise<number> {
  return page.evaluate(async (ontologyClass) => {
    const topology = await window.exograph.notes.getGraphTopology();
    return Array.from(topology.edges.visualClasses).filter((visualClass) => visualClass === ontologyClass).length;
  }, GraphEdgeVisualClass.ontology);
}

async function ontologyEvidence(page: Page, filePath: string) {
  return page.evaluate(async (targetPath) => {
    const topology = await window.exograph.notes.getGraphTopology();
    const lookup = await window.exograph.notes.graphConceptLookup({ filePath: targetPath }, topology.sourceSnapshotId);
    if (lookup.status !== "ok" || !lookup.summary) throw new Error("Ontology source concept was not found.");
    const detail = await window.exograph.notes.getGraphConceptDetailByIndex(lookup.summary.index, topology.sourceSnapshotId);
    if (detail.status !== "ok" || !detail.detail) throw new Error("Ontology source detail was not available.");
    const relation = detail.detail.relations.find((item) => item.relation.origin === "ontology")?.relation ?? null;
    return { ontology: detail.detail.ontology, relation, sourceSnapshotId: topology.sourceSnapshotId };
  }, filePath);
}

async function markdownByteMap(root: string): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const filePath = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(filePath);
      else if (entry.isFile() && /\.md$/i.test(entry.name)) result.set(path.relative(root, filePath), await readFile(filePath, "utf8"));
    }
  }
  await visit(root);
  return result;
}

async function expectCanvasPixels(canvas: Locator): Promise<void> {
  await expect.poll(() => canvas.evaluate((element) => {
    const surface = element as HTMLCanvasElement;
    const context = surface.getContext("2d");
    if (!context || surface.width === 0 || surface.height === 0) return 0;
    const pixels = context.getImageData(0, 0, surface.width, surface.height).data;
    let visible = 0;
    for (let index = 3; index < pixels.length; index += 4) visible += Number((pixels[index] ?? 0) > 0);
    return visible;
  }), { timeout: 10_000 }).toBeGreaterThan(0);
}
