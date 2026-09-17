import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { launchExographWorkspaceFixture } from "../helpers";

async function launchReviewGraph() {
  let noteDirectory = "";
  const fixture = await launchExographWorkspaceFixture({
    mutable: true,
    initialNoteLabel: "wiring-a",
    prepareWorkspace: async (root) => {
      noteDirectory = path.join(root, "notes/test-notes");
      await writeFile(path.join(noteDirectory, "wiring-a.md"), "# Wiring A\n\n[[wiring-b]]\n");
      await writeFile(path.join(noteDirectory, "wiring-b.md"), "# Wiring B\n\n[[wiring-a]]\n");
    },
  });
  await fixture.page.getByTestId("editor-panel").hover();
  await fixture.page.getByTestId("open-note-graph").click();
  await expect(fixture.page.locator(".spatial-graph__viewport")).toHaveAttribute("data-scene-ready", "true");
  await expect(fixture.page.locator(".spatial-graph__detail-title")).toHaveText("Wiring A");
  return { ...fixture, noteDirectory };
}

async function clickB(page: Page) {
  await page.getByRole("button", { name: "Frame graph", exact: true }).click();
  const canvas = page.locator(".spatial-graph__interaction");
  const point = await canvas.evaluate(async (element) => {
    const topology = await window.exograph.notes.getGraphTopology();
    const result = await window.exograph.notes.getGraphConceptSummaries(
      Array.from({ length: topology.nodeCount }, (_, index) => index), topology.sourceSnapshotId,
    );
    const node = result.summaries.find((summary) => summary.label === "Wiring B");
    if (!node) throw new Error("Missing Wiring B fixture node");
    return (element as HTMLCanvasElement & {
      __exographGraphPointForIndex: (index: number) => { x: number; y: number; visible: boolean };
    }).__exographGraphPointForIndex(node.index);
  });
  expect(point.visible).toBe(true);
  await canvas.click({ position: point });
  await expect(page.locator(".spatial-graph__detail-title")).toHaveText("Wiring B");
  return canvas;
}

test("a mouse-selected graph receives keyboard navigation without programmatic focus", async () => {
  const fixture = await launchReviewGraph();
  try {
    const canvas = await clickB(fixture.page);
    await expect(canvas).toBeFocused();
    await fixture.page.keyboard.press("]");
    await expect(fixture.page.locator(".spatial-graph__detail-title")).not.toHaveText("Wiring B");
  } finally {
    await fixture.cleanup();
  }
});

test("a fresh graph snapshot retains the node selected after opening from an editor", async () => {
  const fixture = await launchReviewGraph();
  try {
    await clickB(fixture.page);
    const previous = await fixture.page.evaluate(async () => (await window.exograph.notes.getGraphTopology()).sourceSnapshotId);
    await writeFile(path.join(fixture.noteDirectory, "wiring-unrelated.md"), "# Wiring Unrelated\n\n[[wiring-a]]\n");
    await expect.poll(() => fixture.page.evaluate(async () => (await window.exograph.notes.getGraphTopology()).sourceSnapshotId)).not.toBe(previous);
    await fixture.page.getByRole("button", { name: "Refresh graph", exact: true }).click();
    await expect.poll(() => fixture.page.locator(".spatial-graph__interaction").evaluate((element, previousSnapshot) => {
      const snapshot = (element as HTMLCanvasElement & {
        __exographGraphSnapshot: () => { sourceSnapshotId: string; pendingWork: number };
      }).__exographGraphSnapshot();
      return snapshot.sourceSnapshotId !== previousSnapshot && snapshot.pendingWork === 0;
    }, previous)).toBe(true);
    await expect(fixture.page.locator(".spatial-graph__detail-title")).toHaveText("Wiring B");
  } finally {
    await fixture.cleanup();
  }
});
