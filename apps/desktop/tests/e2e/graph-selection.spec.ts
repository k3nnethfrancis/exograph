import { unlink, writeFile } from "node:fs/promises";
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
  const point = await pointForLabel(canvas, "Wiring B");
  expect(point.visible).toBe(true);
  await canvas.click({ position: point });
  await expect(page.locator(".spatial-graph__detail-title")).toHaveText("Wiring B");
  return canvas;
}

async function pointForLabel(canvas: ReturnType<Page["locator"]>, label: string) {
  return canvas.evaluate(async (element, expectedLabel) => {
    const topology = await window.exograph.notes.getGraphTopology();
    const result = await window.exograph.notes.getGraphConceptSummaries(
      Array.from({ length: topology.nodeCount }, (_, index) => index), topology.sourceSnapshotId,
    );
    const node = result.summaries.find((summary) => summary.label === expectedLabel);
    if (!node) throw new Error(`Missing ${expectedLabel} fixture node`);
    return (element as HTMLCanvasElement & {
      __exographGraphPointForIndex: (index: number) => { x: number; y: number; visible: boolean };
    }).__exographGraphPointForIndex(node.index);
  }, label);
}

test("a mouse-selected graph receives keyboard navigation without programmatic focus", async () => {
  const fixture = await launchReviewGraph();
  try {
    const canvas = await clickB(fixture.page);
    await expect(canvas).toBeFocused();
    const a = await pointForLabel(canvas, "Wiring A");
    const b = await pointForLabel(canvas, "Wiring B");
    const key = Math.abs(a.x - b.x) >= Math.abs(a.y - b.y)
      ? (a.x > b.x ? "ArrowRight" : "ArrowLeft") : (a.y > b.y ? "ArrowDown" : "ArrowUp");
    const camera = await canvas.evaluate((element) => (element as any).__exographGraphSnapshot().camera);
    await fixture.page.keyboard.press(key);
    await expect(fixture.page.locator(".spatial-graph__detail-title")).toHaveText("Wiring A");
    await expect.poll(async () => {
      const point = await pointForLabel(canvas, "Wiring A");
      const box = await canvas.boundingBox();
      return Math.hypot(point.x - box!.width / 2, point.y - box!.height / 2);
    }).toBeLessThan(2);
    const after = await canvas.evaluate((element) => (element as any).__exographGraphSnapshot().camera);
    expect(after.yaw).toBe(camera.yaw);
    expect(after.pitch).toBe(camera.pitch);
    expect(after.distance).toBe(camera.distance);
    await fixture.page.keyboard.press("]");
    await fixture.page.keyboard.press("[");
    await expect(fixture.page.locator(".spatial-graph__detail-title")).toHaveText("Wiring A");
    const centeredA = await pointForLabel(canvas, "Wiring A");
    const neighborB = await pointForLabel(canvas, "Wiring B");
    await fixture.page.keyboard.press(Math.abs(neighborB.x - centeredA.x) >= Math.abs(neighborB.y - centeredA.y)
      ? (neighborB.x > centeredA.x ? "ArrowRight" : "ArrowLeft")
      : (neighborB.y > centeredA.y ? "ArrowDown" : "ArrowUp"));
    await expect(fixture.page.locator(".spatial-graph__detail-title")).toHaveText("Wiring B");
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

test("removing the selected node clears its stale detail after refresh", async () => {
  const fixture = await launchReviewGraph();
  try {
    await clickB(fixture.page);
    const previous = await fixture.page.evaluate(async () => (await window.exograph.notes.getGraphTopology()).sourceSnapshotId);
    await writeFile(path.join(fixture.noteDirectory, "wiring-a.md"), "# Wiring A\n");
    await unlink(path.join(fixture.noteDirectory, "wiring-b.md"));
    await expect.poll(() => fixture.page.evaluate(async () => (await window.exograph.notes.getGraphTopology()).sourceSnapshotId)).not.toBe(previous);
    await fixture.page.getByRole("button", { name: "Refresh graph", exact: true }).click();
    await expect.poll(() => fixture.page.locator(".spatial-graph__interaction").evaluate((element, previousSnapshot) => {
      const snapshot = (element as HTMLCanvasElement & {
        __exographGraphSnapshot: () => { sourceSnapshotId: string; pendingWork: number; selected: number };
      }).__exographGraphSnapshot();
      return snapshot.sourceSnapshotId !== previousSnapshot && snapshot.pendingWork === 0 && snapshot.selected === -1;
    }, previous)).toBe(true);
    await expect(fixture.page.locator(".spatial-graph__detail-title")).toHaveCount(0);
  } finally {
    await fixture.cleanup();
  }
});

test("a late detail response cannot replace a newer mouse selection", async () => {
  const fixture = await launchReviewGraph();
  try {
    const canvas = fixture.page.locator(".spatial-graph__interaction");
    await fixture.page.getByRole("button", { name: "Frame graph", exact: true }).click();
    const pointB = await pointForLabel(canvas, "Wiring B");
    const pointA = await pointForLabel(canvas, "Wiring A");
    const bIndex = await canvas.evaluate(async () => {
      const topology = await window.exograph.notes.getGraphTopology();
      const result = await window.exograph.notes.getGraphConceptSummaries(
        Array.from({ length: topology.nodeCount }, (_, index) => index), topology.sourceSnapshotId,
      );
      const node = result.summaries.find((summary) => summary.label === "Wiring B");
      if (!node) throw new Error("Missing Wiring B fixture node");
      return node.index;
    });
    await fixture.electronApp.evaluate(({ ipcMain }, heldIndex) => {
      const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...args: any[]) => Promise<unknown>> })._invokeHandlers;
      const original = handlers.get("notes:get-graph-concept-detail-by-index");
      if (!original) throw new Error("Missing graph detail handler");
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const state = { held: false, completed: false, release };
      (globalThis as unknown as { graphSelectionGate: typeof state }).graphSelectionGate = state;
      ipcMain.removeHandler("notes:get-graph-concept-detail-by-index");
      ipcMain.handle("notes:get-graph-concept-detail-by-index", async (event, index, sourceSnapshotId) => {
        const result = await original(event, index, sourceSnapshotId);
        if (index === heldIndex && !state.held) {
          state.held = true;
          await gate;
          state.completed = true;
        }
        return result;
      });
    }, bIndex);
    await canvas.click({ position: pointB });
    await expect.poll(() => fixture.electronApp.evaluate(() => (globalThis as unknown as { graphSelectionGate: { held: boolean } }).graphSelectionGate.held)).toBe(true);
    await canvas.click({ position: pointA });
    await expect(fixture.page.locator(".spatial-graph__detail-title")).toHaveText("Wiring A");
    await fixture.electronApp.evaluate(() => (globalThis as unknown as { graphSelectionGate: { release: () => void } }).graphSelectionGate.release());
    await expect.poll(() => fixture.electronApp.evaluate(() => (globalThis as unknown as { graphSelectionGate: { completed: boolean } }).graphSelectionGate.completed)).toBe(true);
    await expect(fixture.page.locator(".spatial-graph__detail-title")).toHaveText("Wiring A");
  } finally {
    await fixture.cleanup();
  }
});
