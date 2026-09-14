import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { launchExographWorkspaceFixture } from "../helpers";

test("graph surfaces follow pane resizing, metadata height and app zoom through Canvas fallback", async () => {
  const fixture = await launchExographWorkspaceFixture({
    mutable: true,
    initialNoteLabel: "viewport-plain",
    prepareWorkspace: async (root) => {
      const notes = path.join(root, "notes/test-notes");
      await writeFile(path.join(notes, "viewport-plain.md"), "# Viewport Plain\n\n[[viewport-rich]]\n");
      await writeFile(path.join(notes, "viewport-rich.md"), "---\ntitle: Viewport Rich\nowner: Synthetic Owner\nstatus: Test\nphase: Evaluation\ncategory: Synthetic\n---\n\n[[viewport-plain]]\n");
    },
  });
  const { page } = fixture;
  try {
    await page.getByTestId("editor-panel").hover();
    await page.getByTestId("open-note-graph").click();
    const viewport = page.locator(".spatial-graph__viewport");
    const canvas = page.locator(".spatial-graph__interaction");
    await expect(viewport).toHaveAttribute("data-scene-ready", "true");
    await expect(page.locator(".spatial-graph__detail-title")).toHaveText("Viewport Plain");
    await assertSurfaceParity(page);

    for (const shift of [-200, 280, -160, 100]) {
      const handle = await page.getByTestId("utility-pane-resizer").boundingBox();
      expect(handle).not.toBeNull();
      const x = handle!.x + handle!.width / 2;
      const y = handle!.y + 120;
      const widthBefore = (await viewport.boundingBox())!.width;
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x + shift, y, { steps: 8 });
      await page.mouse.up();
      await expect.poll(async () => Math.abs((await viewport.boundingBox())!.width - widthBefore)).toBeGreaterThan(10);
      await assertSurfaceParity(page);
    }

    await page.getByRole("button", { name: "Frame graph", exact: true }).click();
    const heightBefore = (await viewport.boundingBox())!.height;
    const richPoint = await canvas.evaluate(async (element) => {
      const debug = element as HTMLCanvasElement & {
        __exographGraphPointForIndex: (index: number) => { x: number; y: number; visible: boolean };
      };
      const topology = await window.exograph.notes.getGraphTopology();
      const result = await window.exograph.notes.getGraphConceptSummaries(
        Array.from({ length: topology.nodeCount }, (_, index) => index), topology.sourceSnapshotId,
      );
      const rich = result.summaries.find((summary) => summary.label === "Viewport Rich");
      if (!rich) throw new Error("Rich fixture concept missing");
      return debug.__exographGraphPointForIndex(rich.index);
    });
    expect(richPoint.visible).toBe(true);
    await canvas.click({ position: richPoint });
    await expect(page.locator(".spatial-graph__detail-title")).toHaveText("Viewport Rich");
    await expect(page.locator(".spatial-graph__detail-properties")).toBeHidden();
    await page.locator(".spatial-graph__detail summary").click();
    await expect(page.locator(".spatial-graph__detail-properties")).toBeVisible();
    await expect.poll(async () => (await viewport.boundingBox())!.height).toBeLessThan(heightBefore - 15);
    await assertSurfaceParity(page);

    await page.locator(".spatial-graph__detail summary").press("Enter");
    await expect(page.locator(".spatial-graph__detail-properties")).toBeHidden();
    await expect.poll(async () => (await viewport.boundingBox())!.height).toBeGreaterThan(heightBefore - 2);
    await assertSurfaceParity(page);

    await fixture.electronApp.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]!.webContents.setZoomFactor(1.1);
    });
    await assertSurfaceParity(page);
    await canvas.evaluate((element) => (element as HTMLCanvasElement & {
      __exographGraphForceCanvasFallback: () => void;
    }).__exographGraphForceCanvasFallback());
    await expect.poll(() => rendererKind(page)).toBe("canvas2d");
    await fixture.electronApp.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]!;
      const bounds = window.getBounds();
      window.setBounds({ width: bounds.width - 100, height: bounds.height - 80 });
    });
    await assertSurfaceParity(page);
  } finally {
    await fixture.cleanup();
  }
});

async function rendererKind(page: Page): Promise<string | null> {
  return page.locator(".spatial-graph__interaction").evaluate((element) => (element as HTMLCanvasElement & {
    __exographGraphSnapshot: () => { rendererKind: string | null };
  }).__exographGraphSnapshot().rendererKind);
}

async function assertSurfaceParity(page: Page): Promise<void> {
  await expect.poll(() => page.locator(".spatial-graph__viewport").evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const overlay = element.querySelector<HTMLCanvasElement>(".spatial-graph__interaction")!;
    const snapshot = (overlay as HTMLCanvasElement & {
      __exographGraphSnapshot: () => { rendererKind: string | null };
    }).__exographGraphSnapshot();
    const dpr = Math.min(3, Math.max(1, window.devicePixelRatio));
    return [...element.querySelectorAll("canvas")].every((canvas) => {
      const rect = canvas.getBoundingClientRect();
      const geometryMatches = Math.abs(rect.x - bounds.x) < 1 && Math.abs(rect.y - bounds.y) < 1
        && Math.abs(rect.width - bounds.width) < 1 && Math.abs(rect.height - bounds.height) < 1;
      // The inactive GPU surface retains its last backing store after fallback.
      const active = canvas === overlay || snapshot.rendererKind === "webgpu";
      return geometryMatches && (!active || (
        canvas.width === Math.max(1, Math.round(Math.round(bounds.width) * dpr))
        && canvas.height === Math.max(1, Math.round(Math.round(bounds.height) * dpr))
      ));
    });
  })).toBe(true);
}
