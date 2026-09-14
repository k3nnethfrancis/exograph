import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test, expect } from "@playwright/test";

import {
  launchExographTerminalFixture,
  launchExographWorkspaceFixture,
} from "../helpers";
import {
  latencySummary,
  waitForTerminalInputEnabled,
  waitForTerminalText,
} from "../terminalQuality";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const initialMarkdownNotePattern = /^---\ndate: \d{4}-\d{2}-\d{2}\ntags: \[\]\n---\n\n# [^\n]+\n$/;

function boxesOverlap(a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }) {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

async function expectTestIdsDoNotOverlap(page: import("@playwright/test").Page, firstTestId: string, secondTestId: string) {
  const firstBox = await page.getByTestId(firstTestId).boundingBox();
  const secondBox = await page.getByTestId(secondTestId).boundingBox();
  expect(firstBox).not.toBeNull();
  expect(secondBox).not.toBeNull();
  expect(boxesOverlap(firstBox!, secondBox!)).toBe(false);
}

async function expectStableOuterFrame(
  locator: import("@playwright/test").Locator,
  before: { width: number; height: number },
) {
  const after = await locator.boundingBox();
  expect(after).not.toBeNull();
  expect(Math.abs(after!.width - before.width)).toBeLessThanOrEqual(1);
  expect(Math.abs(after!.height - before.height)).toBeLessThanOrEqual(1);
}

async function cycleAppearanceTo(page: import("@playwright/test").Page, targetMode: "system" | "light" | "dark") {
  if (await page.locator("html").getAttribute("data-appearance-mode") === targetMode) return;
  await page.getByTestId("workspace-menu-toggle").click();
  await page.getByTestId("workspace-menu-settings").click();
  await page.getByTestId("workspace-settings-tab-appearance").click();
  await page.getByTestId("workspace-settings-appearance").selectOption(targetMode);
  await expect(page.getByTestId("workspace-settings-status")).toContainText("Settings saved.");
  await page.getByTestId("workspace-settings-close").click();
}

async function pageShellSession(page: import("@playwright/test").Page) {
  const shell = await page.evaluate(async () => {
    const sessions = await window.exograph.terminals.list();
    return sessions.find((session) => session.kind === "shell") ?? null;
  });
  if (!shell) {
    throw new Error("Expected shell terminal session");
  }
  return shell;
}

async function dragBy(page: import("@playwright/test").Page, locator: import("@playwright/test").Locator, delta: { x: number; y: number }) {
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  const start = { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  for (let step = 1; step <= 8; step += 1) {
    await page.mouse.move(start.x + (delta.x * step) / 8, start.y + (delta.y * step) / 8);
    await expect(page.locator(".xterm-rows")).toContainText("preview-first-input");
  }
  await page.mouse.up();
  await page.waitForTimeout(50);
}

async function selectFocusedGraphNode(
  page: import("@playwright/test").Page,
  canvas: import("@playwright/test").Locator,
  detailTitle: import("@playwright/test").Locator,
  expectedTitle: string,
  filePath: string,
  inspectedFilePath: string,
) {
  let projected = await projectedGraphNode(canvas, filePath);
  for (let attempt = 0; projected.picked !== projected.index && attempt < 8; attempt += 1) {
    const frame = await canvas.boundingBox();
    expect(frame).not.toBeNull();
    const center = { x: frame!.x + frame!.width / 2, y: frame!.y + frame!.height / 2 };
    await page.mouse.move(center.x, center.y);
    await page.mouse.down();
    await page.mouse.move(center.x + 36, center.y + (attempt % 2 === 0 ? 8 : -8), { steps: 3 });
    await page.mouse.up();
    projected = await projectedGraphNode(canvas, filePath);
  }
  expect(projected.picked, `Expected ${filePath} to be pickable after orbit`).toBe(projected.index);
  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();
  await canvas.click({ position: { x: projected.x, y: projected.y } });
  await expect.poll(async () => canvas.evaluate((element) => {
    return (element as HTMLCanvasElement & { __exographGraphSnapshot?: () => { selected: number } }).__exographGraphSnapshot?.().selected ?? -1;
  })).toBe(projected.index);
  await expect.poll(async () => canvas.evaluate((element) => {
    return (element as HTMLCanvasElement & {
      __exographGraphSnapshot?: () => { inspectedFilePath: string | null };
    }).__exographGraphSnapshot?.().inspectedFilePath ?? null;
  })).toBe(inspectedFilePath);
  await expect(detailTitle).toHaveText(expectedTitle);
  return { x: box!.x + projected.x, y: box!.y + projected.y, localX: projected.x, localY: projected.y, index: projected.index };
}

async function projectedGraphNode(canvas: import("@playwright/test").Locator, filePath: string) {
  await expect.poll(async () => canvas.evaluate((element) => {
    return (element as HTMLCanvasElement & {
      __exographGraphSnapshot?: () => { pendingWork: number; moving: boolean };
    }).__exographGraphSnapshot?.();
  })).toMatchObject({ pendingWork: 0, moving: false });
  const projected = await canvas.evaluate(async (element, targetPath) => {
    const graphCanvas = element as HTMLCanvasElement & {
      __exographGraphSnapshot?: () => { sourceSnapshotId: string | null } | null;
      __exographGraphPointForIndex?: (index: number) => { x: number; y: number; visible: boolean } | null;
      __exographGraphPickAt?: (x: number, y: number) => number;
    };
    const sourceSnapshotId = graphCanvas.__exographGraphSnapshot?.()?.sourceSnapshotId;
    if (!sourceSnapshotId) return null;
    const lookup = await window.exograph.notes.graphConceptLookup(
      { filePath: targetPath },
      sourceSnapshotId,
    );
    if (lookup.status !== "ok" || !lookup.summary) return null;
    const point = graphCanvas.__exographGraphPointForIndex?.(lookup.summary.index) ?? null;
    if (!point) return null;
    return {
      ...point,
      index: lookup.summary.index,
      picked: graphCanvas.__exographGraphPickAt?.(point.x, point.y) ?? -1,
    };
  }, filePath);
  expect(projected, `Expected a projected point for ${filePath}`).not.toBeNull();
  expect(projected!.visible, `Expected ${filePath} to be visible`).toBe(true);
  return projected!;
}

function runGit(cwd: string, args: string[]) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `git ${args.join(" ")} failed`);
  }
}

test.describe.configure({ mode: "parallel" });

test("preserves unknown Workspace settings during startup", async () => {
  const fixture = await launchExographWorkspaceFixture({
    configured: false,
    expectOnboarding: false,
    initialNoteLabel: null,
    workspaceRootEnv: false,
    prepareSettings: async ({ settingsPath, workspaceRoot }) => {
      const primaryRoot = path.join(workspaceRoot, "notes/test-notes");
      await writeFile(settingsPath, JSON.stringify({
        workspaceRoot,
        defaultTerminalCwd: workspaceRoot,
        noteRoots: [primaryRoot],
        indexedRoots: [],
        indexing: { enabled: false, mode: "off", backend: "qmd" },
        appearanceMode: "dark",
        colorThemeId: "exograph-neutral",
        editorFontSize: 15,
        terminalFontSize: 13,
        explorerScale: 1,
        exploreIndexSearchOnEnter: false,
        indexUpdateStrategy: "on-save",
        futureWorkspaceMetadata: { retained: true },
      }), "utf8");
    },
  });

  try {
    const saved = JSON.parse(await readFile(fixture.settingsPath, "utf8"));
    expect(saved.noteRoots).toEqual([path.join(fixture.workspaceRoot, "notes/test-notes")]);
    expect(saved.futureWorkspaceMetadata).toEqual({ retained: true });
  } finally {
    await fixture.cleanup();
  }
});

test("boots the shell, opens notes, and creates terminals on demand", async () => {
  const { page, cleanup } = await launchExographWorkspaceFixture({ mutable: true });

  await expect(page.getByTestId("editor-title")).toHaveText("focus-note");
  await expect(page.getByTestId("editor-panel")).toContainText("Linked references:");
  await expect(page.getByTestId("editor-panel")).toContainText("agent-memory");
  await expect(page.getByTestId("editor-panel")).toContainText("#research");
  await page.getByTestId("editor-panel").hover();
  await expect(page.getByTestId("toggle-markdown-mode")).toBeVisible();
  await page.getByTestId("toggle-markdown-mode").click();
  await expect(page.getByTestId("editor-panel")).toContainText("[[agent-memory]]");

  await expect(page.getByTestId("terminal-tab-shell")).toHaveCount(0);
  const modifier = process.platform === "darwin" ? "Meta" : "Control";
  await page.keyboard.press(`${modifier}+T`);
  await expect(page.getByTestId("terminal-tab-shell")).toBeVisible();
  await expect(page.getByTestId("terminal-dock")).toBeVisible();
  await expect(page.getByTestId("utility-pane")).toBeVisible();
  await expect(page.locator('[data-testid="launch-claude"]')).toHaveCount(0);
  await expect(page.locator('[data-testid="launch-codex"]')).toHaveCount(0);
  await expect.poll(async () =>
    page.evaluate(async () => (await window.exograph.terminals.list()).map((session) => session.kind)),
  ).toEqual(["shell"]);

  await page.getByTestId("utility-pane-context").click();
  await page.getByTestId("connections-tab-links").click();
  await expect(page.getByTestId("utility-pane")).toBeVisible();
  const tag = page.locator('[data-testid="tags-panel"] .tag-pill').first();
  await expect(tag).toBeVisible();
  const tagName = (await tag.textContent())?.replace(/^#/, "") ?? "";
  await tag.click();
  // Tags now navigate like other knowledge links rather than opening a
  // second, competing results view inside Note context.
  await expect(page.getByTestId("editor-title")).toHaveText(tagName);

  // Restore the source note before exercising its Note context links.
  await page.locator(".tab-strip .chrome-tab", { hasText: "focus-note" }).click();
  await expect(page.getByTestId("editor-title")).toHaveText("focus-note");

  await page.getByTestId("connections-panel-links").getByRole("button", { name: "Related Note" }).first().click();
  await expect(page.getByTestId("editor-title")).toHaveText("related-note");

  await cleanup();
  expect(existsSync(path.join(repoRoot, "fixtures/test-workspace/notes/test-notes", `${tagName}.md`))).toBe(false);
});

test("keeps editor, full graph, and backlink-only Note context on one navigation contract", async () => {
  const { page, workspaceRoot, cleanup } = await launchExographWorkspaceFixture({
    mutable: true,
    initialNoteLabel: "graph-target",
    prepareWorkspace: async (workspaceRoot) => {
      const notes = path.join(workspaceRoot, "notes/test-notes");
      await writeFile(path.join(notes, "graph-target.md"), "# Graph Target\n\nA backlink-only target.\n", "utf8");
      await writeFile(path.join(notes, "graph-source.md"), "# Graph Source\n\n[[graph-target]]\n", "utf8");
      await writeFile(path.join(notes, "graph-unopened.md"), "# Graph Unopened\n\nA target opened from the graph.\n", "utf8");
    },
  });

  try {
    const graphSourcePath = path.join(workspaceRoot, "notes/test-notes/graph-source.md");
    const graphTargetPath = path.join(workspaceRoot, "notes/test-notes/graph-target.md");
    await page.getByTestId("editor-panel").hover();
    await page.getByTestId("open-note-graph").click();
    const graphPane = page.getByTestId("graph-pane");
    const graphCanvas = graphPane.locator('canvas[aria-label="Interactive knowledge graph"]');
    await expect(graphPane).toBeVisible();
    await expect(graphPane.locator(".spatial-graph__viewport")).toHaveAttribute("data-scene-ready", "true");
    await expect(graphPane.locator(".spatial-graph__detail-title")).toHaveText("Graph Target");
    await expect.poll(async () => graphCanvas.evaluate((canvas) => {
      return (canvas as HTMLCanvasElement & {
        __exographGraphSnapshot?: () => { camera: { pitch: number; distance: number }; pendingWork: number };
      }).__exographGraphSnapshot?.();
    })).toMatchObject({ camera: { pitch: 0.46, distance: expect.any(Number) }, pendingWork: 0 });
    await graphCanvas.focus();
    await page.keyboard.press("ArrowRight");
    const focusCandidate = await graphCanvas.evaluate((canvas) => {
      const debugCanvas = canvas as HTMLCanvasElement & {
        __exographGraphSnapshot?: () => { selected: number; camera: { yaw: number } };
        __exographGraphPointForIndex?: (index: number) => { x: number; y: number; visible: boolean } | null;
      };
      const snapshot = debugCanvas.__exographGraphSnapshot?.();
      const point = snapshot ? debugCanvas.__exographGraphPointForIndex?.(snapshot.selected) : null;
      return snapshot && point ? { selected: snapshot.selected, yaw: snapshot.camera.yaw, point } : null;
    });
    expect(focusCandidate?.point.visible).toBe(true);
    expect(focusCandidate?.yaw).not.toBeCloseTo(-0.42, 2);
    await graphCanvas.dblclick({ position: focusCandidate!.point });
    await expect.poll(async () => graphCanvas.evaluate((canvas) => {
      return (canvas as HTMLCanvasElement & {
        __exographGraphSnapshot?: () => { camera: { yaw: number }; moving: boolean; selected: number };
      }).__exographGraphSnapshot?.();
    })).toMatchObject({ camera: { yaw: -0.42 }, moving: false, selected: focusCandidate!.selected });
    await expect(graphPane.locator(".spatial-graph__detail-title")).toHaveText("Graph Target");
    await graphCanvas.focus();
    const initialKeyboardSelection = await graphCanvas.evaluate((canvas) => {
      return (canvas as HTMLCanvasElement & { __exographGraphSnapshot?: () => { selected: number } })
        .__exographGraphSnapshot?.().selected ?? -1;
    });
    await page.keyboard.press("]");
    await expect.poll(async () => graphCanvas.evaluate((canvas) => {
      return (canvas as HTMLCanvasElement & { __exographGraphSnapshot?: () => { selected: number } })
        .__exographGraphSnapshot?.().selected ?? -1;
    })).not.toBe(initialKeyboardSelection);
    await page.keyboard.press("[");
    await expect.poll(async () => graphCanvas.evaluate((canvas) => {
      return (canvas as HTMLCanvasElement & { __exographGraphSnapshot?: () => { selected: number } })
        .__exographGraphSnapshot?.().selected ?? -1;
    })).toBe(initialKeyboardSelection);
    await page.keyboard.press("Space");
    await expect(graphPane.locator(".spatial-graph__detail-title")).toHaveText("Graph Target");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("editor-title")).toHaveText("graph-target");
    await expect.poll(async () => graphCanvas.evaluate((canvas) => {
      return (canvas as HTMLCanvasElement & { __exographGraphSnapshot?: () => unknown }).__exographGraphSnapshot?.();
    })).toMatchObject({ pendingWork: 0, pendingFrame: false, moving: false });

    const beforeFallback = await graphCanvas.evaluate((canvas) => {
      const debug = canvas as HTMLCanvasElement & {
        __exographGraphSnapshot?: () => {
          selected: number;
          pathTarget: number;
          sourceSnapshotId: string | null;
          inspectedFilePath: string | null;
          rendererGeneration: number;
          rendererRecoveryState: string;
        };
      };
      return debug.__exographGraphSnapshot?.() ?? null;
    });
    expect(beforeFallback).not.toBeNull();

    const graphBox = await graphCanvas.boundingBox();
    expect(graphBox).not.toBeNull();
    const zoomPoint = {
      x: graphBox!.x + graphBox!.width / 2,
      y: graphBox!.y + graphBox!.height / 2,
    };
    const sourceBeforeZoom = await projectedGraphNode(graphCanvas, graphSourcePath);
    const targetBeforeZoom = await projectedGraphNode(graphCanvas, graphTargetPath);
    const pairDistanceBeforeZoom = Math.hypot(
      sourceBeforeZoom.x - targetBeforeZoom.x,
      sourceBeforeZoom.y - targetBeforeZoom.y,
    );
    await graphCanvas.evaluate((canvas, point) => {
      canvas.dispatchEvent(new WheelEvent("wheel", {
        bubbles: true,
        cancelable: true,
        clientX: point.x,
        clientY: point.y,
        deltaMode: WheelEvent.DOM_DELTA_PIXEL,
        deltaX: 18,
        deltaY: -120,
      }));
    }, zoomPoint);
    const sourceAfterZoom = await projectedGraphNode(graphCanvas, graphSourcePath);
    const targetAfterZoom = await projectedGraphNode(graphCanvas, graphTargetPath);
    expect(Math.hypot(
      sourceAfterZoom.x - targetAfterZoom.x,
      sourceAfterZoom.y - targetAfterZoom.y,
    )).toBeGreaterThan(pairDistanceBeforeZoom * 1.05);

    await page.keyboard.down("Shift");
    await page.mouse.move(zoomPoint.x, zoomPoint.y);
    await page.mouse.down();
    await page.mouse.move(zoomPoint.x + 36, zoomPoint.y + 24, { steps: 4 });
    await page.mouse.up();
    await page.keyboard.up("Shift");
    const sourceAfterPan = await projectedGraphNode(graphCanvas, graphSourcePath);
    expect(sourceAfterPan.x).toBeGreaterThan(sourceAfterZoom.x + 24);
    expect(sourceAfterPan.y).toBeGreaterThan(sourceAfterZoom.y + 16);

    const targetAfterPan = await projectedGraphNode(graphCanvas, graphTargetPath);
    const pairDistanceBeforeDolly = Math.hypot(
      sourceAfterPan.x - targetAfterPan.x,
      sourceAfterPan.y - targetAfterPan.y,
    );
    await page.mouse.move(zoomPoint.x, zoomPoint.y);
    await page.mouse.down({ button: "middle" });
    await page.mouse.move(zoomPoint.x, zoomPoint.y - 36, { steps: 4 });
    await page.mouse.up({ button: "middle" });
    const sourceAfterDolly = await projectedGraphNode(graphCanvas, graphSourcePath);
    const targetAfterDolly = await projectedGraphNode(graphCanvas, graphTargetPath);
    expect(Math.hypot(
      sourceAfterDolly.x - targetAfterDolly.x,
      sourceAfterDolly.y - targetAfterDolly.y,
    )).toBeGreaterThan(pairDistanceBeforeDolly * 1.04);

    await graphCanvas.evaluate(async (canvas) => {
      const debug = canvas as HTMLCanvasElement & { __exographGraphForceCanvasFallback?: () => Promise<void> };
      await debug.__exographGraphForceCanvasFallback?.();
    });
    await expect.poll(async () => graphCanvas.evaluate((canvas) => {
      return (canvas as HTMLCanvasElement & { __exographGraphSnapshot?: () => unknown }).__exographGraphSnapshot?.();
    })).toMatchObject({
      rendererKind: "canvas2d",
      rendererTransitionReason: "recovery-fallback",
      rendererRecoveryState: "fallback",
      selected: beforeFallback!.selected,
      pathTarget: beforeFallback!.pathTarget,
      sourceSnapshotId: beforeFallback!.sourceSnapshotId,
      inspectedFilePath: beforeFallback!.inspectedFilePath,
    });

    const canvasKeyboardSelection = await graphCanvas.evaluate((canvas) => {
      return (canvas as HTMLCanvasElement & { __exographGraphSnapshot?: () => { selected: number } })
        .__exographGraphSnapshot?.().selected ?? -1;
    });
    await graphCanvas.focus();
    await page.keyboard.press("]");
    await expect.poll(async () => graphCanvas.evaluate((canvas) => {
      return (canvas as HTMLCanvasElement & { __exographGraphSnapshot?: () => { selected: number } })
        .__exographGraphSnapshot?.().selected ?? -1;
    })).not.toBe(canvasKeyboardSelection);
    await page.keyboard.press("[");
    await expect.poll(async () => graphCanvas.evaluate((canvas) => {
      return (canvas as HTMLCanvasElement & { __exographGraphSnapshot?: () => { selected: number } })
        .__exographGraphSnapshot?.().selected ?? -1;
    })).toBe(canvasKeyboardSelection);

    const sourceBeforeCanvasZoom = await projectedGraphNode(graphCanvas, graphSourcePath);
    const targetBeforeCanvasZoom = await projectedGraphNode(graphCanvas, graphTargetPath);
    const pairDistanceBeforeCanvasZoom = Math.hypot(
      sourceBeforeCanvasZoom.x - targetBeforeCanvasZoom.x,
      sourceBeforeCanvasZoom.y - targetBeforeCanvasZoom.y,
    );
    await graphCanvas.evaluate((canvas, point) => {
      canvas.dispatchEvent(new WheelEvent("wheel", {
        bubbles: true,
        cancelable: true,
        clientX: point.x,
        clientY: point.y,
        deltaMode: WheelEvent.DOM_DELTA_PIXEL,
        deltaY: -100,
      }));
    }, zoomPoint);
    const sourceAfterCanvasZoom = await projectedGraphNode(graphCanvas, graphSourcePath);
    const targetAfterCanvasZoom = await projectedGraphNode(graphCanvas, graphTargetPath);
    expect(Math.hypot(
      sourceAfterCanvasZoom.x - targetAfterCanvasZoom.x,
      sourceAfterCanvasZoom.y - targetAfterCanvasZoom.y,
    )).toBeGreaterThan(pairDistanceBeforeCanvasZoom * 1.05);

    await page.mouse.move(zoomPoint.x, zoomPoint.y);
    await page.mouse.down({ button: "right" });
    await page.mouse.move(zoomPoint.x + 28, zoomPoint.y + 20, { steps: 4 });
    await page.mouse.up({ button: "right" });
    const sourceAfterCanvasPan = await projectedGraphNode(graphCanvas, graphSourcePath);
    expect(sourceAfterCanvasPan.x).toBeGreaterThan(sourceAfterCanvasZoom.x + 20);
    expect(sourceAfterCanvasPan.y).toBeGreaterThan(sourceAfterCanvasZoom.y + 14);
    expect(sourceAfterCanvasPan.picked).toBe(sourceAfterCanvasPan.index);
    expect(await graphCanvas.evaluate((canvas) => {
      return (canvas as HTMLCanvasElement & {
        __exographGraphSnapshot?: () => { selected: number; rendererKind: string | null };
      }).__exographGraphSnapshot?.() ?? null;
    })).toMatchObject({ selected: beforeFallback!.selected, rendererKind: "canvas2d" });

    const initialNodeCount = Number.parseInt((await graphPane.locator(".spatial-graph__count").textContent()) ?? "0", 10);
    await writeFile(path.join(workspaceRoot, "notes/test-notes/graph-live.md"), "# Graph Live\n\n[[graph-target]]\n", "utf8");
    await expect.poll(async () => Number.parseInt((await graphPane.locator(".spatial-graph__count").textContent()) ?? "0", 10))
      .toBeGreaterThan(initialNodeCount);
    await expect.poll(async () => graphCanvas.evaluate((canvas) => {
      return (canvas as HTMLCanvasElement & { __exographGraphSnapshot?: () => unknown }).__exographGraphSnapshot?.();
    })).toMatchObject({ pendingWork: 0, pendingFrame: false, moving: false });
    expect(await graphCanvas.evaluate((canvas) => {
      return (canvas as HTMLCanvasElement & { __exographGraphSnapshot?: () => { metadataCacheEntries: number } }).__exographGraphSnapshot?.().metadataCacheEntries ?? 0;
    })).toBeLessThanOrEqual(192);

    await page.getByTestId("sidebar").getByRole("button", { name: "graph-source" }).click();
    await expect(page.getByTestId("editor-title")).toHaveText("graph-source");
    await expect(graphPane.locator(".spatial-graph__detail-title")).toHaveText("Graph Source");

    const canvasBox = await graphCanvas.boundingBox();
    expect(canvasBox).not.toBeNull();
    const focusPoint = {
      x: canvasBox!.x + canvasBox!.width / 2,
      y: canvasBox!.y + canvasBox!.height / 2,
    };
    await page.mouse.click(focusPoint.x, focusPoint.y);
    await expect(graphPane.locator(".spatial-graph__detail-title")).toHaveText("Graph Target");
    await graphCanvas.evaluate((canvas, point) => {
      canvas.dispatchEvent(new WheelEvent("wheel", {
        bubbles: true,
        cancelable: true,
        clientX: point.x,
        clientY: point.y,
        ctrlKey: true,
        deltaMode: WheelEvent.DOM_DELTA_PIXEL,
        deltaY: -12,
      }));
    }, focusPoint);
    await page.mouse.click(focusPoint.x, focusPoint.y);
    await expect(graphPane.locator(".spatial-graph__detail-title")).toHaveText("Graph Target");
    await expect.poll(async () => graphCanvas.evaluate((canvas) => {
      return (canvas as HTMLCanvasElement & { __exographGraphSnapshot?: () => { moving: boolean; pendingFrame: boolean } }).__exographGraphSnapshot?.();
    })).toMatchObject({ moving: false, pendingFrame: false });
    await expect.poll(async () => graphCanvas.evaluate((canvas) => {
      return (canvas as HTMLCanvasElement & {
        __exographGraphSnapshot?: () => { graphReturnPath: string | null; inspectedFilePath: string | null };
      }).__exographGraphSnapshot?.();
    })).toMatchObject({
      graphReturnPath: path.join(workspaceRoot, "notes/test-notes/graph-source.md"),
      inspectedFilePath: path.join(workspaceRoot, "notes/test-notes/graph-source.md"),
    });
    await graphCanvas.focus();
    await page.keyboard.press("Escape");
    await expect.poll(async () => graphCanvas.evaluate((canvas) => {
      return (canvas as HTMLCanvasElement & {
        __exographGraphSnapshot?: () => { inspectedFilePath: string | null; moving: boolean };
      }).__exographGraphSnapshot?.();
    })).toMatchObject({
      inspectedFilePath: path.join(workspaceRoot, "notes/test-notes/graph-source.md"),
      moving: false,
    });
    await expect(graphPane.locator(".spatial-graph__detail-title")).toHaveText("Graph Source");
    const sourceRoutePoint = await projectedGraphNode(
      graphCanvas,
      path.join(workspaceRoot, "notes/test-notes/graph-source.md"),
    );
    const targetRoutePoint = await projectedGraphNode(
      graphCanvas,
      path.join(workspaceRoot, "notes/test-notes/graph-target.md"),
    );
    expect(await graphCanvas.evaluate((canvas) => {
      return (canvas as HTMLCanvasElement & { __exographGraphSnapshot?: () => { selected: number } }).__exographGraphSnapshot?.().selected ?? -1;
    })).toBe(sourceRoutePoint.index);
    expect(targetRoutePoint.picked).toBe(targetRoutePoint.index);
    await graphCanvas.click({ position: targetRoutePoint, modifiers: ["Shift"] });
    await expect(graphPane.getByTestId("graph-route-status")).toContainText("Route · 2");
    await graphCanvas.focus();
    await page.keyboard.press("Escape");
    await expect(graphPane.getByTestId("graph-route-status")).toHaveCount(0);
    await page.mouse.click(focusPoint.x, focusPoint.y);
    await expect(graphPane.locator(".spatial-graph__detail-title")).toHaveText("Graph Target");
    await expect(page.getByTestId("editor-title")).toHaveText("graph-source");

    await graphCanvas.focus();
    await page.keyboard.press("Escape");
    await expect(graphPane.locator(".spatial-graph__detail-title")).toHaveText("Graph Source");
    const reselectedCanvasBox = await graphCanvas.boundingBox();
    expect(reselectedCanvasBox).not.toBeNull();
    const reselectedFocusPoint = {
      x: reselectedCanvasBox!.x + reselectedCanvasBox!.width / 2,
      y: reselectedCanvasBox!.y + reselectedCanvasBox!.height / 2,
    };
    await page.mouse.click(reselectedFocusPoint.x, reselectedFocusPoint.y);
    await expect(graphPane.locator(".spatial-graph__detail-title")).toHaveText("Graph Target");

    const editorTabCount = await page.locator(".tab-strip__tab").count();
    await page.mouse.dblclick(reselectedFocusPoint.x, reselectedFocusPoint.y);
    await expect(page.getByTestId("editor-title")).toHaveText("graph-target");
    await expect(page.locator(".tab-strip__tab")).toHaveCount(editorTabCount);
    await expect(graphPane.locator(".spatial-graph__detail-title")).toHaveText("Graph Target");

    await page.mouse.dblclick(reselectedFocusPoint.x, reselectedFocusPoint.y);
    await expect(page.getByTestId("editor-title")).toHaveText("graph-target");
    await expect(graphPane.locator(".spatial-graph__detail-title")).toHaveText("Graph Target");

    await page.getByTestId("sidebar").getByRole("button", { name: "graph-unopened" }).click();
    await expect(page.getByTestId("editor-title")).toHaveText("graph-unopened");
    await page.getByTestId("editor-panel").hover();
    await page.getByTestId("open-note-graph").click();
    await expect(graphPane.locator(".spatial-graph__detail-title")).toHaveText("Graph Unopened");
    const tabCountWithUnopened = await page.locator(".tab-strip__tab").count();
    await page.getByRole("button", { name: "Close graph-unopened", exact: true }).click();
    await expect(page.locator(".tab-strip__tab")).toHaveCount(tabCountWithUnopened - 1);
    await expect(graphPane.locator(".spatial-graph__detail-title")).toHaveText("Graph Source");
    const unopenedPoint = await selectFocusedGraphNode(
      page,
      graphCanvas,
      graphPane.locator(".spatial-graph__detail-title"),
      "Graph Unopened",
      path.join(workspaceRoot, "notes/test-notes/graph-unopened.md"),
      path.join(workspaceRoot, "notes/test-notes/graph-source.md"),
    );
    await expect(page.getByTestId("editor-title")).toHaveText("graph-source");
    await page.mouse.dblclick(unopenedPoint.x, unopenedPoint.y);
    await expect(page.getByTestId("editor-title")).toHaveText("graph-unopened");
    await expect(page.locator(".tab-strip__tab")).toHaveCount(tabCountWithUnopened);
    await expect(graphPane.locator(".spatial-graph__detail-title")).toHaveText("Graph Unopened");
    await expect.poll(async () => graphCanvas.evaluate((canvas) => {
      return (canvas as HTMLCanvasElement & {
        __exographGraphSnapshot?: () => { selected: number; inspectedFilePath: string | null };
      }).__exographGraphSnapshot?.();
    })).toMatchObject({
      selected: unopenedPoint.index,
      inspectedFilePath: path.join(workspaceRoot, "notes/test-notes/graph-unopened.md"),
    });

    await graphPane.getByRole("button", { name: "Frame graph" }).click();
    await expect(graphPane.locator(".spatial-graph__detail-title")).toHaveText("Graph Unopened");
    await page.mouse.dblclick(canvasBox!.x + 4, canvasBox!.y + 4);
    await expect(graphPane.locator(".spatial-graph__detail-title")).toHaveText("Graph Unopened");

    await page.locator(".tab-strip__tab").filter({ hasText: "graph-target" }).click();
    await expect(page.getByTestId("editor-title")).toHaveText("graph-target");
    await expect(graphPane.locator(".spatial-graph__detail-title")).toHaveText("Graph Target");

    await page.getByTestId("utility-pane-context").click();
    await page.getByTestId("connections-tab-outline").click();
    await expect(page.getByTestId("connections-panel-outline")).toContainText("Graph Target");
    await page.getByTestId("connections-tab-links").click();
    await expect(page.getByTestId("connections-panel-links").getByRole("button", { name: "Graph Source" })).toBeVisible();
    await expect(page.getByTestId("connections-tab-graph")).toHaveCount(0);
    await page.getByTestId("utility-pane-graph").click();
    await expect(graphPane.locator(".spatial-graph__detail-title")).toHaveText("Graph Target");

    await graphPane.getByRole("button", { name: "Close graph" }).click();
    await expect(graphPane).not.toBeVisible();
    await expect(page.getByTestId("utility-pane-toggle")).toHaveAttribute("aria-pressed", "false");
    await expect(page.getByTestId("editor-title")).toHaveText("graph-target");
  } finally {
    await cleanup();
  }
});

test("opens the production Graph utility focused on the active Note", async () => {
  const { page, cleanup } = await launchExographWorkspaceFixture({
    mutable: true,
    initialNoteLabel: "graph-target",
    prepareWorkspace: async (workspaceRoot) => {
      const notes = path.join(workspaceRoot, "notes/test-notes");
      await writeFile(path.join(notes, "graph-target.md"), "# Graph Target\n\nA backlink-only target.\n", "utf8");
      await writeFile(path.join(notes, "graph-source.md"), "# Graph Source\n\n[[graph-target]]\n", "utf8");
    },
  });

  try {
    await page.getByTestId("utility-pane-toggle").click();
    await page.getByTestId("utility-pane-graph").click();

    const graphPane = page.getByTestId("graph-pane");
    await expect(graphPane).toBeVisible();
    await expect(graphPane.locator(".spatial-graph__detail-title")).toHaveText("Graph Target");
  } finally {
    await cleanup();
  }
});

test("distinguishes ambiguous references from openable Notes", async () => {
  const { page, workspaceRoot, cleanup } = await launchExographWorkspaceFixture({
    mutable: true,
    initialNoteLabel: "ambiguous-source",
    prepareWorkspace: async (workspaceRoot) => {
      const notes = path.join(workspaceRoot, "notes/test-notes");
      await mkdir(path.join(notes, "one"), { recursive: true });
      await mkdir(path.join(notes, "two"), { recursive: true });
      await writeFile(path.join(notes, "ambiguous-source.md"), "# Ambiguous Source\n\n[[duplicate]]\n", "utf8");
      await writeFile(path.join(notes, "one/duplicate.md"), "# First Duplicate\n", "utf8");
      await writeFile(path.join(notes, "two/duplicate.md"), "# Second Duplicate\n", "utf8");
    },
  });

  try {
    await page.getByTestId("utility-pane-toggle").click();
    await page.getByTestId("utility-pane-graph").click();
    const graphPane = page.getByTestId("graph-pane");
    const graphCanvas = graphPane.locator('canvas[aria-label="Interactive knowledge graph"]');
    await expect(graphPane.locator(".spatial-graph__viewport")).toHaveAttribute("data-scene-ready", "true");
    const ambiguous = await graphCanvas.evaluate(async (canvas) => {
      const debug = canvas as HTMLCanvasElement & {
        __exographGraphSnapshot?: () => { sourceSnapshotId: string | null } | null;
        __exographGraphPointForIndex?: (index: number) => { x: number; y: number; visible: boolean } | null;
      };
      const sourceSnapshotId = debug.__exographGraphSnapshot?.()?.sourceSnapshotId;
      if (!sourceSnapshotId) return null;
      const count = Number.parseInt(document.querySelector(".spatial-graph__count")?.textContent ?? "0", 10);
      const result = await window.exograph.notes.getGraphConceptSummaries(
        Array.from({ length: count }, (_, index) => index),
        sourceSnapshotId,
      );
      const summary = result.summaries.find((candidate) => candidate.label === "duplicate" && !candidate.filePath);
      if (!summary) return null;
      const point = debug.__exographGraphPointForIndex?.(summary.index) ?? null;
      return point ? { ...point, index: summary.index } : null;
    });
    expect(ambiguous).not.toBeNull();
    await graphCanvas.click({ position: ambiguous! });
    await expect(graphPane.locator(".spatial-graph__detail-title--reference")).toHaveText("duplicate");
    await expect(graphPane.locator(".spatial-graph__detail-meta")).toContainText("Ambiguous reference");
    await graphCanvas.dblclick({ position: ambiguous! });
    await expect(page.getByTestId("editor-title")).toHaveText("ambiguous-source");
  } finally {
    await cleanup();
  }
});

test("recovers graph Canvas initialization without taking down the workspace", async () => {
  const { page, cleanup } = await launchExographWorkspaceFixture({ initialNoteLabel: "focus-note" });
  try {
    await page.evaluate(() => {
      const prototype = HTMLCanvasElement.prototype as HTMLCanvasElement["getContext"] extends never
        ? never
        : HTMLCanvasElement & { getContext: (...args: unknown[]) => unknown };
      const original = HTMLCanvasElement.prototype.getContext;
      let failGraphCanvasOnce = true;
      (prototype as unknown as { getContext: (...args: unknown[]) => unknown }).getContext = function getContext(
        this: HTMLCanvasElement,
        ...args: unknown[]
      ) {
        if (failGraphCanvasOnce && this.getAttribute("aria-label") === "Interactive knowledge graph") {
          failGraphCanvasOnce = false;
          return null;
        }
        return original.apply(this, args as Parameters<typeof original>);
      };
    });
    await page.getByTestId("editor-panel").hover();
    await page.getByTestId("open-note-graph").click();
    const graphPane = page.getByTestId("graph-pane");
    await expect(graphPane.getByRole("button", { name: /Graph unavailable/ })).toBeVisible();
    await graphPane.getByRole("button", { name: /Graph unavailable/ }).click();
    const graphCanvas = graphPane.locator('canvas[aria-label="Interactive knowledge graph"]');
    await expect(graphCanvas).toBeVisible();
    await expect(graphPane.locator(".spatial-graph__detail-title")).toHaveText("Focus Note");
    await expect.poll(async () => graphCanvas.evaluate((canvas) => {
      return (canvas as HTMLCanvasElement & { __exographGraphSnapshot?: () => unknown }).__exographGraphSnapshot?.();
    })).toMatchObject({ pendingWork: 0, pendingFrame: false, moving: false });
  } finally {
    await cleanup();
  }
});

test("shows a visible BrowserWindow on startup", async () => {
  const { electronApp, page, cleanup } = await launchExographWorkspaceFixture();

  const openWindows = await electronApp.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().filter((window) => !window.isDestroyed()).length,
  );

  expect(openWindows).toBeGreaterThan(0);
  await expect(page.getByTestId("sidebar")).toBeVisible();
  await expect(page.getByTestId("editor-panel")).toBeVisible();

  await cleanup();
});

test("starts with an empty editor when no saved layout chooses a note", async () => {
  const { page, cleanup } = await launchExographWorkspaceFixture({ initialNoteLabel: null });

  try {
    await expect(page.getByTestId("editor-empty")).toContainText("Open a note from the left sidebar to begin.");
    await expect(page.getByTestId("editor-title")).toHaveCount(0);
  } finally {
    await cleanup();
  }
});

test("restores a note chosen by the saved layout", async () => {
  const { page, workspaceRoot, cleanup } = await launchExographWorkspaceFixture({ initialNoteLabel: null });

  try {
    const notePath = path.join(workspaceRoot, "notes/test-notes/focus-note.md");
    const savedLayout = await page.evaluate(async (filePath) => {
      const snapshot = await window.exograph.workspace.getSettings();
      const saved = await window.exograph.workspace.saveSettings({
        settings: {
          ...snapshot.settings,
          layout: {
            version: 3,
            canvas: { kind: "leaf", id: "saved-editor", content: { kind: "editor", openPaths: [filePath], activePath: filePath } },
            sidebarCollapsed: false,
            sidebarWidth: 175,
            utilityWidth: 430,
          },
        },
        expectedRevision: snapshot.revision,
      });
      return saved.settings.layout ?? null;
    }, notePath);
    expect(savedLayout).not.toBeNull();
    await page.reload();
    await expect.poll(() => page.evaluate(async () => (await window.exograph.workspace.getSettings()).settings.layout ?? null)).not.toBeNull();
    await expect(page.getByTestId("editor-title")).toHaveText("focus-note");
  } finally {
    await cleanup();
  }
});

test("opens a browser preview in the utility destination", async () => {
  const { page, cleanup } = await launchExographWorkspaceFixture();

  await page.getByTestId("utility-pane-toggle").click();
  await page.getByTestId("utility-pane-preview").click();
  await expect(page.getByTestId("preview-empty-state")).toBeVisible();
  await page.getByRole("button", { name: "New preview" }).click();
  await expect(page.getByTestId("browser-pane")).toBeVisible();

  await page.getByTestId("browser-url-input").fill("localhost:4321");
  await page.getByTestId("browser-load-url").click();
  await expect(page.getByTestId("browser-url-input")).toHaveValue("http://localhost:4321/");
  await expect(page.getByTestId("browser-preview-frame")).toHaveAttribute("src", "http://localhost:4321/");
  await expect(page.locator(".workspace-shell__canvas .pane-leaf--browser")).toHaveCount(0);

  await cleanup();
});

test("creates, renames, and deletes notes from the explorer", async () => {
  const { page, workspaceRoot, cleanup } = await launchExographWorkspaceFixture({
    prepareWorkspace: async (root) => {
      await mkdir(path.join(root, "notes/test-notes/mutation-dir"), { recursive: true });
      await writeFile(path.join(root, "notes/test-notes/mutation-dir/existing.md"), "# Existing\n", "utf8");
    },
  });
  const notesRoot = path.join(workspaceRoot, "notes/test-notes");
  const mutationDirectoryPath = path.join(notesRoot, "mutation-dir");
  const createdPath = path.join(mutationDirectoryPath, "mutation-qa.md");
  const renamedPath = path.join(mutationDirectoryPath, "mutation-renamed.md");

  const mutationDirectory = page.locator(".tree-node--directory", { hasText: "mutation-dir" }).first();
  await mutationDirectory.click();
  await mutationDirectory.click({ button: "right" });
  await page.getByRole("button", { name: "New File" }).click();
  await expect(page.getByTestId("workspace-dialog")).toBeVisible();
  await page.getByTestId("workspace-dialog-input").fill("mutation-qa.md");
  await page.getByTestId("workspace-dialog-confirm").click();
  await expect(page.getByTestId("editor-title")).toHaveText("mutation-qa");
  await expect.poll(async () => readFile(createdPath, "utf8")).toMatch(initialMarkdownNotePattern);
  await expect(page.locator(".exograph-md-line--h1")).toContainText("# mutation-qa");
  await expect
    .poll(() =>
      page.evaluate(() => {
        const content = document.querySelector(".cm-content") as (HTMLElement & { cmView?: { view?: any } }) | null;
        const view = content?.cmView?.view;
        if (!view) return null;
        const text = view.state.doc.toString();
        return { text, selection: view.state.selection.main.head, atAuthoringLine: view.state.selection.main.head === text.length };
      }),
    )
    .toEqual(expect.objectContaining({
      atAuthoringLine: true,
    }));

  await page.getByTestId("sidebar").getByRole("button", { name: "mutation-qa" }).click({ button: "right" });
  await page.getByText("Rename").click();
  await page.getByTestId("workspace-dialog-input").fill("mutation-renamed.md");
  await page.getByTestId("workspace-dialog-confirm").click();
  await expect(page.getByTestId("editor-title")).toHaveText("mutation-renamed");
  await expect.poll(async () => readFile(renamedPath, "utf8")).toMatch(initialMarkdownNotePattern);
  await expect(access(createdPath)).rejects.toThrow();

  await page.getByTestId("sidebar").getByRole("button", { name: "mutation-renamed" }).click({ button: "right" });
  await page.getByText("Delete").click();
  await page.getByTestId("workspace-dialog-confirm").click();
  await expect(access(renamedPath)).rejects.toThrow();

  await cleanup();
});

test("handles global save, new-note, daily-note, and collision-safe creation keybindings", async () => {
  const { page, workspaceRoot, cleanup } = await launchExographWorkspaceFixture({ mutable: true });
  const modifier = process.platform === "darwin" ? "Meta" : "Control";
  const focusNotePath = path.join(workspaceRoot, "notes/test-notes/focus-note.md");
  const now = new Date();
  const dailyName = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;

  await page.evaluate(() => {
    const content = document.querySelector(".cm-content") as (HTMLElement & { cmView?: { view?: any } }) | null;
    const view = content?.cmView?.view;
    if (!view) {
      throw new Error("Unable to resolve CodeMirror view");
    }
    view.dispatch({
      changes: {
        from: view.state.doc.length,
        insert: "\n\nSaved with keybinding.",
      },
    });
  });
  await expect(page.getByTestId("editor-save-status")).toHaveText("Unsaved");
  await page.keyboard.press(`${modifier}+S`);
  await expect(page.getByTestId("editor-save-status")).toHaveText("Saved");
  await expect.poll(async () => readFile(focusNotePath, "utf8")).toContain("Saved with keybinding.");

  await page.keyboard.press(`${modifier}+N`);
  await expect(page.getByTestId("editor-title")).toHaveText("untitled");
  await expect.poll(async () => readFile(path.join(workspaceRoot, "notes/test-notes", "untitled.md"), "utf8")).toMatch(initialMarkdownNotePattern);
  await page.keyboard.press(`${modifier}+N`);
  await expect(page.getByTestId("editor-title")).toHaveText("untitled-2");
  await expect.poll(async () => readFile(path.join(workspaceRoot, "notes/test-notes", "untitled-2.md"), "utf8")).toMatch(initialMarkdownNotePattern);

  await page.keyboard.press(`${modifier}+Shift+N`);
  await expect(page.getByTestId("editor-title")).toHaveText(dailyName);
  await expect.poll(async () => readFile(path.join(workspaceRoot, "notes/test-notes", `${dailyName}.md`), "utf8")).toMatch(initialMarkdownNotePattern);
  await expect.poll(() => page.evaluate(() => {
    const content = document.querySelector(".cm-content") as (HTMLElement & { cmView?: { view?: any } }) | null;
    const view = content?.cmView?.view;
    return Boolean(view && view.state.selection.main.head === view.state.doc.length);
  })).toBe(true);

  await cleanup();
});

test("preserves selection when opening and revisiting an existing H1-only note", async () => {
  const { page, cleanup } = await launchExographWorkspaceFixture({
    mutable: true,
    initialNoteLabel: null,
    prepareWorkspace: async (workspaceRoot) => {
      await writeFile(path.join(workspaceRoot, "notes/test-notes/untouched-heading.md"), "# Untouched Heading\n", "utf8");
    },
  });

  const sidebar = page.getByTestId("sidebar");
  await sidebar.getByRole("button", { name: "untouched-heading" }).click();
  await expect.poll(() => page.evaluate(() => {
    const content = document.querySelector(".cm-content") as (HTMLElement & { cmView?: { view?: any } }) | null;
    return content?.cmView?.view?.state.selection.main.head ?? -1;
  })).toBe(0);

  await page.evaluate(() => {
    const content = document.querySelector(".cm-content") as (HTMLElement & { cmView?: { view?: any } }) | null;
    const view = content?.cmView?.view;
    if (!view) throw new Error("Unable to resolve CodeMirror view");
    view.dispatch({ selection: { anchor: 5 } });
  });
  await sidebar.getByRole("button", { name: "untouched-heading" }).click();
  await expect.poll(() => page.evaluate(() => {
    const content = document.querySelector(".cm-content") as (HTMLElement & { cmView?: { view?: any } }) | null;
    return content?.cmView?.view?.state.selection.main.head ?? -1;
  })).toBe(5);

  await cleanup();
});

test("reopens today's Note beside a terminal after closing the sole editor", async () => {
  const { page, workspaceRoot, cleanup } = await launchExographTerminalFixture({ mutable: true });
  const now = new Date();
  const dailyName = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const dailyPath = path.join(workspaceRoot, "notes/test-notes", `${dailyName}.md`);

  try {
    const terminalTab = await page.getByTestId("terminal-tab-shell").boundingBox();
    const editor = await page.locator(".workspace-shell__canvas .pane-leaf--editor").boundingBox();
    expect(terminalTab).not.toBeNull();
    expect(editor).not.toBeNull();

    await page.mouse.move(terminalTab!.x + terminalTab!.width / 2, terminalTab!.y + terminalTab!.height / 2);
    await page.mouse.down();
    await page.mouse.move(editor!.x + editor!.width / 2, editor!.y + editor!.height * 0.12, { steps: 8 });
    await page.mouse.up();

    await expect(page.locator(".workspace-shell__canvas .pane-leaf--terminal")).toHaveCount(1);
    await expect(page.locator(".workspace-shell__canvas .pane-leaf--editor")).toHaveCount(1);
    const editorLeaf = page.locator(".workspace-shell__canvas .pane-leaf--editor");
    await expect(editorLeaf).toBeVisible();
    await editorLeaf.dispatchEvent("mousedown");
    await expect(editorLeaf).toHaveClass(/pane-leaf--focused/);
    const closeFocusNote = editorLeaf.locator('.chrome-tab__close[aria-label="Close focus-note"]');
    await closeFocusNote.evaluate((element) => {
      const propsKey = Object.keys(element).find((key) => key.startsWith("__reactProps"));
      const props = propsKey ? (element as unknown as Record<string, unknown>)[propsKey] as Record<string, unknown> : null;
      const onClick = props?.onClick;
      if (typeof onClick !== "function") throw new Error("Unable to resolve close-tab handler");
      onClick({ stopPropagation() {} });
    });

    await expect(closeFocusNote).toHaveCount(0);
    await expect(page.locator(".workspace-shell__canvas .pane-leaf--terminal")).toHaveCount(1);
    await expect(page.locator(".workspace-shell__canvas .pane-leaf--editor")).toHaveCount(1);
    await expect(page.getByTestId("editor-title")).toHaveText(dailyName);
    await expect.poll(() => access(dailyPath).then(() => true, () => false)).toBe(true);
  } finally {
    await cleanup();
  }
});

test("suppresses generated daily-note titles but preserves explicit H1s", async () => {
  const generatedDailyName = "2026-06-14";
  const explicitDailyName = "2026-06-15";
  const explicitNormalName = "explicit-heading";
  const { page, cleanup } = await launchExographWorkspaceFixture({
    prepareWorkspace: async (workspaceRoot) => {
      const noteRoot = path.join(workspaceRoot, "notes/test-notes");
      await writeFile(path.join(noteRoot, `${generatedDailyName}.md`), `# ${generatedDailyName}\n\nToday has notes.\n`);
      await writeFile(path.join(noteRoot, `${explicitDailyName}.md`), "# Daily Review\n\nThis heading is authored.\n");
      await writeFile(path.join(noteRoot, `${explicitNormalName}.md`), "# Explicit Heading\n\nThis heading is authored.\n");
    },
    initialNoteLabel: null,
  });

  const sidebar = page.getByTestId("sidebar");

  await sidebar.getByRole("button", { name: generatedDailyName }).click();
  await expect(page.getByTestId("editor-title")).toHaveText(generatedDailyName);
  await expect(page.locator(".exograph-md-line--h1", { hasText: generatedDailyName })).toHaveCount(0);
  await expect(page.getByTestId("editor-panel")).toContainText("Today has notes.");
  await expect(page.getByTestId("toggle-markdown-mode")).toBeVisible();
  await expect(page.getByTestId("editor-save")).toBeVisible();
  await expect(page.getByTestId("editor-save-status")).toBeVisible();
  await page.getByTestId("editor-panel").hover();
  await page.getByTestId("toggle-properties").click();
  await expect(page.getByTestId("properties-panel")).toBeVisible();

  await sidebar.getByRole("button", { name: explicitDailyName }).click();
  await expect(page.locator(".exograph-md-line--h1", { hasText: "Daily Review" })).toBeVisible();

  await sidebar.getByRole("button", { name: explicitNormalName }).click();
  await expect(page.locator(".exograph-md-line--h1", { hasText: "Explicit Heading" })).toBeVisible();

  await cleanup();
});

test("shows terminals created outside renderer controls", async () => {
  const { page, cleanup } = await launchExographTerminalFixture({
    env: {
      EXOGRAPH_SHELL: "/bin/sh",
      EXOGRAPH_SHELL_ARGS: "-lc,pwd; cat",
    },
  });

  const initialTabs = await page.getByTestId("terminal-tab-shell").count();
  await page.evaluate(async () => {
    await window.exograph.terminals.create({ terminalKind: "shell" });
  });

  await expect(page.getByTestId("terminal-tab-shell")).toHaveCount(initialTabs + 1);
  await expect(page.getByTestId("terminal-tab-shell").last()).toBeVisible();

  await cleanup();
});

test("matches system appearance by default and supports light mode override", async () => {
  const { page, cleanup } = await launchExographWorkspaceFixture();
  const systemTheme = await page.evaluate(() =>
    window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light",
  );

  await expect(page.locator("html")).toHaveAttribute("data-theme", /light|dark/);
  await cycleAppearanceTo(page, "light");
  await expect(page.locator("html")).toHaveAttribute("data-appearance-mode", "light");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await cycleAppearanceTo(page, "dark");
  await expect(page.locator("html")).toHaveAttribute("data-appearance-mode", "dark");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await cycleAppearanceTo(page, "system");
  await expect(page.locator("html")).toHaveAttribute("data-appearance-mode", "system");
  await expect(page.locator("html")).toHaveAttribute("data-theme", systemTheme);

  await cleanup();
});

test("accepts terminal keyboard input", async () => {
  const { page, cleanup } = await launchExographTerminalFixture({
    env: {
      EXOGRAPH_SHELL: "/bin/cat",
      EXOGRAPH_SHELL_ARGS: "",
    },
  });


  await page.getByTestId("terminal-surface").click();
  await page.keyboard.type("hello exograph");
  await expect(page.getByTestId("terminal-surface")).toContainText("hello exograph");

  await page.getByTestId("editor-panel").click();
  await page.getByTestId("terminal-surface").click();
  await page.keyboard.type(" after editor");
  await expect(page.getByTestId("terminal-surface")).toContainText("hello exograph after editor");

  await cleanup();
});

test("does not rehydrate an already rendered terminal when focusing its active tab", async () => {
  const { page, cleanup } = await launchExographTerminalFixture({
    env: {
      EXOGRAPH_SHELL: "/bin/cat",
      EXOGRAPH_SHELL_ARGS: "",
    },
  });

  await page.getByTestId("terminal-surface").click();
  await page.keyboard.type("stable terminal viewport");
  await expect(page.locator(".xterm-rows")).toContainText("stable terminal viewport");

  await page.evaluate(() => {
    const originalRead = window.exograph.terminals.read;
    let readCount = 0;
    window.exograph.terminals.read = ((...args: Parameters<typeof originalRead>) => {
      readCount += 1;
      return originalRead(...args);
    }) as typeof originalRead;
    Object.defineProperty(window, "__exographTerminalReadCount", {
      configurable: true,
      value: () => readCount,
    });
  });

  await page.getByTestId("terminal-tab-shell").click();
  await page.waitForTimeout(150);

  const readCount = await page.evaluate(() => (window as unknown as { __exographTerminalReadCount: () => number }).__exographTerminalReadCount());
  expect(readCount).toBe(0);

  await cleanup();
});

test("measures terminal input echo latency against p50 and p90 targets", async () => {
  const { page, cleanup } = await launchExographTerminalFixture({
    env: {
      EXOGRAPH_SHELL: "/bin/cat",
      EXOGRAPH_SHELL_ARGS: "",
    },
  });

  try {
    await page.getByTestId("terminal-surface").click();
    const samples: number[] = [];
    for (let index = 0; index < 20; index += 1) {
      const marker = `exograph-latency-${index}-${Date.now()}`;
      const startedAt = performance.now();
      await page.keyboard.type(`${marker}\n`);
      await waitForTerminalText(page, marker);
      samples.push(performance.now() - startedAt);
    }

    const summary = latencySummary(samples);
    expect(summary.p50, `terminal echo latency summary: ${JSON.stringify(summary)}`).toBeLessThan(75);
    expect(summary.p90, `terminal echo latency summary: ${JSON.stringify(summary)}`).toBeLessThan(150);
  } finally {
    await cleanup();
  }
});

test("keeps terminal input latency within targets while another terminal streams output", async () => {
  const { page, cleanup } = await launchExographTerminalFixture({
    env: {
      EXOGRAPH_SHELL: "/bin/sh",
      EXOGRAPH_SHELL_ARGS: "",
    },
  });

  try {
    const activeShellId = await page.evaluate(async () => {
      const shell = (await window.exograph.terminals.list()).find((session) => session.kind === "shell");
      if (!shell) {
        throw new Error("No shell terminal found");
      }
      return shell.id;
    });

    await page.getByTestId("terminal-surface").click();
    await waitForTerminalInputEnabled(page);
    await page.keyboard.type("cat\n");
    await page.evaluate(async () => {
      const streamingShell = await window.exograph.terminals.create({ terminalKind: "shell" });
      await window.exograph.terminals.write(
        streamingShell.id,
        "i=1; while [ $i -le 260 ]; do printf 'stream-latency-%03d\\n' \"$i\"; i=$((i+1)); sleep 0.01; done\n",
      );
    });
    await expect(page.getByTestId("terminal-tab-shell")).toHaveCount(2);
    await expect.poll(async () => {
      const sessions = await page.evaluate(() => window.exograph.terminals.list());
      const streamingShell = sessions.find((session) => session.kind === "shell" && session.id !== activeShellId);
      return streamingShell ? page.evaluate((id) => window.exograph.terminals.read(id), streamingShell.id) : "";
    }).toContain("stream-latency-010");

    await page.locator(`[data-tab-item-id="${activeShellId}"]`).click();
    await waitForTerminalInputEnabled(page);

    const samples: number[] = [];
    for (let index = 0; index < 20; index += 1) {
      const marker = `exograph-stream-latency-${index}-${Date.now()}`;
      const startedAt = performance.now();
      await page.keyboard.type(`${marker}\n`);
      await waitForTerminalText(page, marker);
      samples.push(performance.now() - startedAt);
    }

    const summary = latencySummary(samples);
    expect(summary.p50, `streaming terminal latency summary: ${JSON.stringify(summary)}`).toBeLessThan(100);
    expect(summary.p90, `streaming terminal latency summary: ${JSON.stringify(summary)}`).toBeLessThan(250);
  } finally {
    await cleanup();
  }
});

test("keeps terminal interactive after large output, tab switches, and semantic sends", async () => {
  const { page, cleanup } = await launchExographTerminalFixture({
    env: {
      EXOGRAPH_SHELL: "/bin/sh",
      EXOGRAPH_SHELL_ARGS: "",
    },
  });

  try {
    const shellId = await page.evaluate(async () => {
      const sessions = await window.exograph.terminals.list();
      const shell = sessions.find((session) => session.kind === "shell");
      if (!shell) {
        throw new Error("No shell terminal found");
      }
      return shell.id;
    });

    await page.evaluate(async (id) => {
      await window.exograph.terminals.write(
        id,
        "python3 - <<'PY'\nfor i in range(1500): print(f'qa-line-{i}')\nPY\n",
      );
    }, shellId);
    await expect.poll(async () => page.evaluate((id) => window.exograph.terminals.read(id), shellId)).toContain("qa-line-1499");

    await page.getByTestId("utility-pane-terminal").click();
    await expect(page.getByTestId("terminal-tab-shell")).toHaveCount(1);
    await page.getByTestId("terminal-tab-shell").first().click();
    await expect(page.getByTestId("terminal-surface")).toContainText("qa-line-1499");
    await page.getByTestId("terminal-tab-shell").last().click();
    await page.getByTestId("terminal-tab-shell").first().click();
    await expect(page.getByTestId("terminal-surface")).toContainText("qa-line-1499");

    await page.evaluate(async (id) => {
      await window.exograph.terminals.sendMessage(id, "printf 'semantic qa: %s\\n' 'one   two'", true);
    }, shellId);
    await expect.poll(async () => page.evaluate((id) => window.exograph.terminals.read(id), shellId)).toContain("semantic qa: one   two");
  } finally {
    await cleanup();
  }
});

test("hides and reopens the utility terminal without ending direct PTYs or losing tabs and tail", async () => {
  const { page, cleanup } = await launchExographTerminalFixture({
    env: {
      EXOGRAPH_SHELL: "/bin/sh",
      EXOGRAPH_SHELL_ARGS: "-lc,while IFS= read -r line; do printf 'alive:%s\\n' \"$line\"; done",
    },
  });

  try {
    await page.getByTestId("new-terminal").click();
    await expect(page.getByTestId("terminal-tab-shell")).toHaveCount(2);
    const sessionIds = await page.evaluate(async () => (await window.exograph.terminals.list()).map((session) => session.id));
    expect(sessionIds).toHaveLength(2);
    const activeSessionId = sessionIds.at(-1)!;

    await page.evaluate(async ({ ids, activeId }) => {
      await Promise.all(ids.map((id) => window.exograph.terminals.sendMessage(id, `before-hide-${id}`, true)));
      await window.exograph.terminals.sendMessage(activeId, "active-before-hide", true);
    }, { ids: sessionIds, activeId: activeSessionId });
    await expect.poll(async () => page.evaluate(
      async ({ ids }) => Promise.all(ids.map((id) => window.exograph.terminals.read(id))),
      { ids: sessionIds },
    )).toEqual(sessionIds.map((id) => expect.stringContaining(`alive:before-hide-${id}`)));

    await page.getByTestId("utility-pane-toggle").click();
    await expect(page.getByTestId("utility-pane")).toBeHidden();
    await page.evaluate(async (id) => {
      await window.exograph.terminals.sendMessage(id, "while-hidden", true);
    }, activeSessionId);
    await expect.poll(async () => page.evaluate(
      (id) => window.exograph.terminals.read(id),
      activeSessionId,
    )).toContain("alive:while-hidden");

    await page.getByTestId("utility-pane-toggle").click();
    await expect(page.getByTestId("utility-pane")).toBeVisible();
    await expect(page.getByTestId("terminal-tab-shell")).toHaveCount(2);
    await expect.poll(async () => page.evaluate(
      async () => (await window.exograph.terminals.list()).map((session) => session.id),
    )).toEqual(sessionIds);
    await expect(page.locator(".xterm-rows")).toContainText("alive:while-hidden");
  } finally {
    await cleanup();
  }
});

test("removes the last terminal session without hiding the workspace", async () => {
  const { page, cleanup } = await launchExographTerminalFixture();

  await page.getByTestId("close-terminal-shell").click();
  await expect(page.getByTestId("terminal-tab-shell")).toHaveCount(0);
  await expect(page.getByTestId("terminal-surface")).toHaveCount(0);
  await expect(page.locator(".pane-leaf--editor")).toBeVisible();
  await expect(page.getByTestId("utility-pane-toggle")).toBeVisible();

  await cleanup();
});

test("replays bounded terminal history after renderer reload before input", async () => {
  const beforeReloadMarker = `before-reload-${Date.now()}`;
  const { page, cleanup } = await launchExographTerminalFixture({
    env: {
      EXOGRAPH_SHELL: "/bin/sh",
      EXOGRAPH_SHELL_ARGS: "-lc,while IFS= read -r line; do printf 'persist:%s\\n' \"$line\"; done",
    },
    initialNoteLabel: null,
  });

  try {
    const shell = await pageShellSession(page);
    await page.evaluate(
      async ({ id, marker }) => {
        await window.exograph.terminals.sendMessage(id, marker, true);
      },
      { id: shell.id, marker: beforeReloadMarker },
    );
    await expect.poll(async () => page.evaluate((id) => window.exograph.terminals.read(id), shell.id)).toContain(
      `persist:${beforeReloadMarker}`,
    );

    await page.reload();
    await expect(page.getByTestId("sidebar")).toBeVisible();
    await page.getByTestId("utility-pane-toggle").click();
    await page.getByTestId("utility-pane-terminal").click();
    await expect(page.getByTestId("terminal-tab-shell")).toHaveCount(1);
    await expect.poll(async () => page.evaluate((id) => window.exograph.terminals.read(id), shell.id)).toContain(
      `persist:${beforeReloadMarker}`,
    );
    await expect(
      page.locator(".xterm-rows"),
      "terminal history should render after reload without tab switching or input",
    ).toContainText(`persist:${beforeReloadMarker}`);

    await page.evaluate(async (id) => {
      await window.exograph.terminals.sendMessage(id, "after-reload", true);
    }, shell.id);
    await expect.poll(async () => page.evaluate((id) => window.exograph.terminals.read(id), shell.id)).toContain("persist:after-reload");
  } finally {
    await cleanup();
  }
});

test("lets you close editor tabs", async () => {
  const { page, cleanup } = await launchExographWorkspaceFixture();

  await page.getByTestId("utility-pane-toggle").click();
  await page.getByTestId("utility-pane-context").click();
  await page.getByTestId("connections-tab-links").click();
  await page.getByTestId("connections-panel-links").getByRole("button", { name: "Related Note" }).first().click();
  await expect(page.getByTestId("editor-title")).toHaveText("related-note");
  await page.getByLabel("Close related-note").click();
  await expect(page.getByTestId("editor-title")).toHaveText("focus-note");

  await cleanup();
});

test("renders inspector content when expanded", async () => {
  const { page, cleanup } = await launchExographWorkspaceFixture();

  await page.getByTestId("utility-pane-toggle").click();
  await page.getByTestId("utility-pane-context").click();

  await expect(page.getByTestId("inspector-panel")).toContainText("Note context");
  await expect(page.getByTestId("connections-tab-activity")).toHaveCount(0);
  await page.getByTestId("connections-tab-links").click();
  await expect(page.getByTestId("connections-panel-links")).toContainText(/Related Note|agent-memory|research/);
  await expect(page.getByTestId("connections-tab-graph")).toHaveCount(0);
  await page.getByTestId("utility-pane-graph").click();
  await expect(page.getByTestId("graph-pane")).toBeVisible();

  await cleanup();
});

test("opens an Outline heading at its exact editor line", async () => {
  const { page, cleanup } = await launchExographWorkspaceFixture({
    mutable: true,
    initialNoteLabel: "outline-note",
    prepareWorkspace: async (workspaceRoot) => {
      const filler = Array.from({ length: 60 }, (_, index) => `Paragraph ${index + 1}`).join("\n\n");
      await writeFile(
        path.join(workspaceRoot, "notes/test-notes/outline-note.md"),
        `# Outline Note\n\n## Repeated\n\nFirst section.\n\n${filler}\n\n## Repeated\n\nSecond section.\n`,
        "utf8",
      );
    },
  });

  try {
    await page.getByTestId("utility-pane-toggle").click();
    await page.getByTestId("utility-pane-context").click();
    const repeated = page.getByTestId("outline-panel").getByRole("button", { name: "Repeated" });
    await expect(repeated).toHaveCount(2);
    await repeated.nth(1).click();

    await expect.poll(async () => page.evaluate(() => {
      const content = document.querySelector(".cm-content") as (HTMLElement & { cmView?: { view?: any } }) | null;
      const view = content?.cmView?.view;
      if (!view) return null;
      const line = view.state.doc.lineAt(view.state.selection.main.head);
      return { text: line.text, line: line.number, focused: view.hasFocus, scrollTop: view.scrollDOM.scrollTop };
    })).toMatchObject({ text: "## Repeated", line: 127, focused: true });
    expect(await page.locator(".cm-scroller").evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  } finally {
    await cleanup();
  }
});

test("opens workspace settings from the workspace menu", async () => {
  const { page, cleanup } = await launchExographWorkspaceFixture({
    env: {
      EXOGRAPH_INDEX_ENABLED: "0",
      EXOGRAPH_INDEX_MODE: "off",
      EXOGRAPH_INDEXED_ROOTS: "[]",
    },
  });

  await expect(page.locator(".workspace-shell__canvas .pane-leaf--terminal")).not.toBeVisible();
  await page.getByTestId("workspace-menu-toggle").click();
  await page.getByTestId("workspace-menu-settings").click();
  await expect(page.getByTestId("workspace-settings-dialog")).toBeVisible();
  const settingsFrame = await page.getByTestId("workspace-settings-dialog").boundingBox();
  expect(settingsFrame).not.toBeNull();
  await expect(page.getByTestId("workspace-settings-note-roots")).toContainText("test-notes");
  await page.screenshot({ path: "/tmp/exograph-workspace-settings-workspace.png", fullPage: false });
  await page.getByTestId("workspace-settings-tab-index").click();
  await expectStableOuterFrame(page.getByTestId("workspace-settings-dialog"), settingsFrame!);
  await expect(page.getByTestId("workspace-settings-search-engine-simple")).toBeChecked();
  await expect(page.getByTestId("workspace-settings-search-engine-qmd")).not.toBeChecked();
  await expect(page.getByTestId("workspace-settings-simple-search-note")).toContainText("Simple search is active");
  await page.screenshot({ path: "/tmp/exograph-workspace-settings-index.png", fullPage: false });
  await page.getByTestId("workspace-settings-close").click();
  await expect(page.getByTestId("workspace-settings-dialog")).not.toBeVisible();

  await cleanup();
});

test("keeps workspace settings frame stable across tabs", async () => {
  const { page, cleanup } = await launchExographWorkspaceFixture({
    env: {
      EXOGRAPH_INDEX_ENABLED: "0",
      EXOGRAPH_INDEX_MODE: "off",
      EXOGRAPH_INDEXED_ROOTS: "[]",
    },
  });

  await page.setViewportSize({ width: 1200, height: 800 });
  await page.getByTestId("workspace-menu-toggle").click();
  await page.getByTestId("workspace-menu-settings").click();
  await expect(page.getByTestId("workspace-settings-dialog")).toBeVisible();
  const settingsFrame = await page.getByTestId("workspace-settings-dialog").boundingBox();
  expect(settingsFrame).not.toBeNull();

  for (const section of ["index", "appearance", "terminal", "agents", "workspace"]) {
    await page.getByTestId(`workspace-settings-tab-${section}`).click();
    await expectStableOuterFrame(page.getByTestId("workspace-settings-dialog"), settingsFrame!);
  }

  await page.screenshot({ path: "/tmp/exograph-issue-32-settings-tabs.png", fullPage: false });
  await cleanup();
});

test("stacks workspace settings cleanly in a narrow window", async () => {
  const { page, cleanup } = await launchExographWorkspaceFixture({
    env: {
      EXOGRAPH_INDEX_ENABLED: "0",
      EXOGRAPH_INDEX_MODE: "off",
      EXOGRAPH_INDEXED_ROOTS: "[]",
    },
  });

  await page.setViewportSize({ width: 700, height: 560 });
  await page.getByTestId("workspace-menu-toggle").click();
  await page.getByTestId("workspace-menu-settings").click();

  const dialog = page.getByTestId("workspace-settings-dialog");
  const navigation = dialog.getByRole("tablist");
  const panel = dialog.locator(".workspace-settings-panel");
  await expect(dialog).toBeVisible();
  const [dialogBox, navigationBox, panelBox] = await Promise.all([
    dialog.boundingBox(),
    navigation.boundingBox(),
    panel.boundingBox(),
  ]);
  expect(dialogBox).not.toBeNull();
  expect(navigationBox).not.toBeNull();
  expect(panelBox).not.toBeNull();
  expect(dialogBox!.width).toBeLessThanOrEqual(676);
  expect(panelBox!.y).toBeGreaterThanOrEqual(navigationBox!.y + navigationBox!.height);
  const scrollingSections: string[] = [];
  for (const section of ["workspace", "index", "appearance", "terminal", "agents"]) {
    await dialog.getByTestId(`workspace-settings-tab-${section}`).click();
    await expectStableOuterFrame(dialog, dialogBox!);
    const overflow = await panel.evaluate((element) => ({
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
    }));
    if (overflow.scrollHeight > overflow.clientHeight) {
      scrollingSections.push(section);
      await panel.evaluate((element) => {
        element.scrollTop = element.scrollHeight;
      });
      await expect.poll(() => panel.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
      await panel.evaluate((element) => {
        element.scrollTop = 0;
      });
    }
  }
  expect(scrollingSections).toContain("workspace");
  await page.screenshot({ path: "/tmp/exograph-workspace-settings-narrow.png", fullPage: false });

  await cleanup();
});

test("keeps the command server available while the window is hidden", async () => {
  const { electronApp, page, runtimeRoot, cleanup } = await launchExographTerminalFixture({
    env: {
      EXOGRAPH_SHELL: "/bin/cat",
      EXOGRAPH_SHELL_ARGS: "",
    },
  });

  const hidden = await electronApp.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.hide();
    return !window.isVisible();
  });
  expect(hidden).toBe(true);

  const serverInfo = JSON.parse(await readFile(path.join(runtimeRoot, "server.json"), "utf8")) as { port: number; token: string };
  const headers = { "x-exograph-command-token": serverInfo.token };
  const unauthorizedStatus = await fetch(`http://127.0.0.1:${serverInfo.port}/status`);
  expect(unauthorizedStatus.status).toBe(401);
  const statusResponse = await fetch(`http://127.0.0.1:${serverInfo.port}/status`, { headers });
  expect(statusResponse.ok).toBe(true);
  await expect(statusResponse.json()).resolves.toMatchObject({
    workspace: expect.objectContaining({ workspaceRoot: expect.any(String) }),
  });

  const showResponse = await fetch(`http://127.0.0.1:${serverInfo.port}/show`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: "{}",
  });
  expect(showResponse.ok).toBe(true);
  await expect.poll(async () =>
    electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isVisible() ?? false),
  ).toBe(true);
  await expect(page.getByTestId("sidebar")).toBeVisible();

  await electronApp.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.webContents.send("command:open-settings", { section: "terminal" });
  });
  await expect(page.getByTestId("workspace-settings-dialog")).toBeVisible();
  await expect(page.getByTestId("workspace-settings-tab-terminal")).toHaveClass(/settings-nav__button--active/);

  await cleanup();
});

function runExographCli(args: string[], env: NodeJS.ProcessEnv) {
  return spawnSync(path.join(repoRoot, "packages/cli/bin/exograph"), args, {
    cwd: repoRoot,
    env,
    encoding: "utf8",
  });
}

function stringEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}


test("switch workspace opens the workspace picker", async () => {
  const { page, cleanup } = await launchExographWorkspaceFixture();

  await page.getByTestId("workspace-menu-toggle").click();
  await page.getByTestId("workspace-menu-settings").click();
  await page.getByRole("button", { name: "Switch workspace" }).click();
  await expect(page.getByTestId("onboarding")).toContainText("Choose a wiki");
  await expect(page.getByTestId("workspace-picker-item").first()).toContainText("test-notes");
  await expect(page.getByTestId("workspace-picker-open")).toBeEnabled();
  await page.getByTestId("workspace-picker-new").click();
  await expect(page.getByTestId("onboarding")).toContainText("Choose a main wiki");
  await expect(page.getByTestId("onboarding-choose-notes")).toBeVisible();

  await cleanup();
});

test("shows first-run notes setup before the app shell", async () => {
  const { page, cleanup } = await launchExographWorkspaceFixture({
    configured: false,
    cwd: "/",
    workspaceRootEnv: false,
    runtimeRootEnv: false,
  });

  await expect(page.getByTestId("onboarding")).toContainText("Choose your main wiki");
  await expect(page.getByTestId("workspace-picker")).toHaveCount(0);
  await expect(page.getByTestId("workspace-picker-open")).toHaveCount(0);
  await expect(page.getByTestId("onboarding")).toContainText("Default terminal");
  await expect(page.getByTestId("onboarding")).not.toContainText("Advanced search provider");
  await expect(page.getByTestId("onboarding-notes-folder")).toContainText("No main wiki selected.");
  await expect(page.getByTestId("onboarding-continue")).toBeDisabled();
  await expect(page.getByTestId("sidebar")).toHaveCount(0);

  await cleanup();
});

test("shows first-run setup from a packaged-style launch without workspace env", async () => {
  const { page, cleanup, settingsPath } = await launchExographWorkspaceFixture({
    configured: false,
    cwd: "/",
    workspaceRootEnv: false,
    runtimeRootEnv: false,
  });

  await expect(page.getByTestId("onboarding")).toContainText("Choose your main wiki");
  await expect(page.getByTestId("workspace-picker-open")).toHaveCount(0);
  const model = await page.evaluate(() => window.exograph.workspace.getModel());
  expect(model.workspaceRoot).not.toBe("/");
  expect(model.noteRoots).toEqual([]);
  expect(existsSync(settingsPath)).toBe(false);
  expect(existsSync(path.join(path.dirname(settingsPath), "onboarding-notes"))).toBe(false);

  await cleanup();
});

test("opens an existing notes folder from first-run setup", async () => {
  const fixtureWorkspaceRoot = path.join(repoRoot, "fixtures/test-workspace");
  const notesFolder = path.join(fixtureWorkspaceRoot, "notes/test-notes");
  const { page, cleanup, workspaceRoot } = await launchExographWorkspaceFixture({
    configured: false,
    cwd: "/",
    workspaceRootEnv: false,
    runtimeRootEnv: false,
    env: {
      EXOGRAPH_TEST_SELECT_FOLDER_PATH: notesFolder,
    },
  });
  const expectedTerminalCwd = path.join(workspaceRoot, "notes");

  const firstRunFrame = await page.getByTestId("onboarding-card").boundingBox();
  expect(firstRunFrame).not.toBeNull();
  await page.getByTestId("onboarding-choose-notes").click();
  await expectStableOuterFrame(page.getByTestId("onboarding-card"), firstRunFrame!);
  await expect(page.getByTestId("onboarding-notes-folder")).toContainText(notesFolder);
  await expect(page.getByTestId("onboarding-terminal-folder")).toContainText(expectedTerminalCwd);

  await page.getByTestId("onboarding-continue").click();
  await page.getByRole("button", { name: "Continue to tools" }).click();
  await page.getByRole("button", { name: "Set up CLI agents" }).click();
  await page.getByRole("button", { name: "Open Exograph" }).click();
  await expect(page.getByTestId("sidebar")).toBeVisible();
  await expect(page.locator('[data-testid="editor-panel"], [data-testid="editor-empty"]')).toBeVisible();
  await page.getByTestId("utility-pane-toggle").click();
  await expect(page.getByTestId("utility-pane-terminal")).toBeVisible();
  await expect.poll(async () => page.evaluate(() => window.exograph.workspace.getSetupState()))
    .toMatchObject({
      complete: true,
      onboardingComplete: true,
      onboarding: {
        status: "complete",
        phase: "done",
      },
    });
  await expect.poll(async () => page.evaluate(() => window.exograph.workspace.getSettings()))
    .toMatchObject({
      settings: {
        noteRoots: [notesFolder],
        defaultTerminalCwd: expectedTerminalCwd,
      },
    });

  await cleanup();
});

test("collapses and reopens the workspace explorer", async () => {
  const { page, cleanup } = await launchExographWorkspaceFixture();

  await page.getByTestId("workspace-titlebar-sidebar").click();
  await expect(page.locator(".workspace-shell")).toHaveClass(/workspace-shell--sidebar-collapsed/);
  await expect(page.getByTestId("sidebar").getByRole("button", { name: "focus-note" })).toHaveCount(0);
  await expect.poll(async () => (await page.locator(".workspace-shell__canvas").boundingBox())?.x ?? -1).toBe(0);

  await page.getByTestId("workspace-titlebar-sidebar").click();
  await expect(page.locator(".workspace-shell")).not.toHaveClass(/workspace-shell--sidebar-collapsed/);
  await expect(page.getByTestId("sidebar").getByRole("button", { name: "focus-note" })).toBeVisible();

  await cleanup();
});

test("shows the editor beside the right-side terminal destination", async () => {
  const { page, cleanup } = await launchExographTerminalFixture();

  await expect(page.locator(".pane-leaf--editor")).toBeVisible();
  await expect(page.getByTestId("utility-pane").getByTestId("terminal-dock")).toBeVisible();
  await expect(page.locator(".workspace-shell__canvas .pane-leaf--terminal")).toHaveCount(0);
  await expect(page.getByTestId("terminal-tab-shell")).toBeVisible();
  await expect(page.getByTestId("utility-pane-terminal")).toBeVisible();

  await cleanup();
});

test("accepts terminal keyboard input in pane tree", async () => {
  const { page, cleanup } = await launchExographTerminalFixture({
    env: {
      EXOGRAPH_SHELL: "/bin/cat",
      EXOGRAPH_SHELL_ARGS: "",
    },
  });

  await page.getByTestId("terminal-surface").click();
  await page.keyboard.type("hello from exograph");
  await expect(page.locator(".xterm-rows")).toContainText("hello from exograph");

  await page.getByTestId("terminal-surface").click();
  await page.keyboard.type("\nsecond line");
  await expect(page.locator(".xterm-rows")).toContainText("second line");

  await cleanup();
});

test("keeps large terminal bursts available above the visible viewport", async () => {
  const { page, cleanup } = await launchExographTerminalFixture({
    env: {
      EXOGRAPH_SHELL: "/bin/sh",
      EXOGRAPH_SHELL_ARGS:
        "-c,i=1; while [ $i -le 900 ]; do printf 'scrollback-%03d-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\\n' \"$i\"; i=$((i+1)); done; sleep 30",
    },
  });

  try {
    await expect(page.locator(".xterm-rows")).toContainText("scrollback-900");
    await expect(page.locator(".xterm-rows")).not.toContainText("scrollback-001");

    await page.getByTestId("terminal-surface").hover();
    await page.mouse.wheel(0, -50000);

    await expect.poll(async () => page.locator(".xterm-rows").innerText()).toMatch(/scrollback-(00[1-9]|0[1-9][0-9]|[12][0-9]{2})-/);
  } finally {
    await cleanup();
  }
});

test("retains app terminal output within the bounded in-memory tail", async () => {
  const { page, cleanup } = await launchExographTerminalFixture({
    env: {
      EXOGRAPH_SHELL: "/bin/sh",
      EXOGRAPH_SHELL_ARGS:
        "-c,sleep 0.2; i=1; while [ $i -le 220 ]; do printf 'buffer-%03d-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\\n' \"$i\"; i=$((i+1)); done; sleep 5",
    },
  });

  try {
    await expect(page.locator(".xterm-rows")).toContainText("buffer-220");
    const buffer = await page.evaluate(async () => {
      const sessions = await window.exograph.terminals.list();
      return sessions[0] ? window.exograph.terminals.read(sessions[0].id) : "";
    });

    expect(buffer.length).toBeGreaterThan(12_000);
    expect(buffer).toContain("buffer-001");
  } finally {
    await cleanup();
  }
});

test("renders emoji-heavy terminal output without replacement glyph corruption", async () => {
  const { page, cleanup } = await launchExographTerminalFixture({
    env: {
      EXOGRAPH_SHELL: process.execPath,
      EXOGRAPH_SHELL_ARGS: '-e,process.stdout.write("── 🙂 terminal-border\\n"+"🙂".repeat(20000)+"\\nterminal-emoji-end\\n");process.stdin.resume()',
    },
  });

  try {
    await expect(page.locator(".xterm-rows")).toContainText("terminal-emoji-end");
    const buffer = await page.evaluate(async () => {
      const sessions = await window.exograph.terminals.list();
      return sessions[0] ? window.exograph.terminals.read(sessions[0].id) : "";
    });
    expect(buffer).toContain("── 🙂 terminal-border");
    await expect(page.locator(".xterm-rows")).not.toContainText("�");
  } finally {
    await cleanup();
  }
});

test("does not feed xterm device responses back into terminal input", async () => {
  const { page, cleanup } = await launchExographTerminalFixture({
    env: {
      EXOGRAPH_SHELL: "/bin/cat",
      EXOGRAPH_SHELL_ARGS: "",
    },
  });

  await page.evaluate(async () => {
    const sessions = await window.exograph.terminals.list();
    if (!sessions[0]) {
      throw new Error("Missing terminal session.");
    }
    await window.exograph.terminals.write(sessions[0].id, "\x1b[>c");
  });
  await page.waitForTimeout(300);

  const buffer = await page.evaluate(async () => {
    const sessions = await window.exograph.terminals.list();
    return sessions[0] ? window.exograph.terminals.read(sessions[0].id) : "";
  });
  expect(buffer).not.toContain("0;276;0c");
  expect(buffer).not.toContain("\x1b[>0;");

  await cleanup();
});

test("keeps nested list text and continuation lanes aligned", async () => {
  const { page, cleanup } = await launchExographWorkspaceFixture({
    prepareWorkspace: async (workspaceRoot) => {
      const notePath = path.join(workspaceRoot, "notes/test-notes/focus-note.md");
      await writeFile(
        notePath,
        `---\ntitle: Focus Note\n---\n\n# Probe\n\n- top item\n  - child item\n    - grandchild item\n  - sibling child\n    continuation line\n`,
      );
    },
  });

  const metrics = await page.evaluate(() => {
    const lines = Array.from(document.querySelectorAll<HTMLElement>(".cm-line.exograph-md-line--list-start, .cm-line.exograph-md-line--list-continuation"));

    return lines
      .map((line) => {
        const depth = Number(line.dataset.exographListDepth ?? "0");
        const guideXs = (line.dataset.exographGuideXs ?? "")
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean)
          .map(Number);
        const bulletStyle = getComputedStyle(line, "::before");
        const bulletLeft = Number.parseFloat(bulletStyle.left);
        const bulletWidth = Number.parseFloat(bulletStyle.width);
        const hasBullet = bulletStyle.content !== "none" && Number.isFinite(bulletLeft) && Number.isFinite(bulletWidth);
        const range = document.createRange();
        const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT, {
          acceptNode(node) {
            return node.textContent && node.textContent.trim().length > 0 ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
          },
        });
        let textNode: Text | null = null;
        while (walker.nextNode()) {
          const node = walker.currentNode as Text;
          const parent = node.parentElement;
          if (parent && !parent.classList.contains("exograph-md-list-prefix")) {
            textNode = node;
            break;
          }
        }

        if (textNode) {
          range.setStart(textNode, 0);
          range.setEnd(textNode, Math.min(1, textNode.textContent?.length ?? 1));
        }

        const lineRect = line.getBoundingClientRect();
        const textRect = textNode ? range.getBoundingClientRect() : null;

        return {
          text: line.textContent?.trim() ?? "",
          depth,
          guideXs,
          bulletCenterX: hasBullet ? bulletLeft + bulletWidth / 2 : null,
          bulletRightX: hasBullet ? bulletLeft + bulletWidth : null,
          textLeftX: textRect ? textRect.left - lineRect.left : null,
        };
      })
      .filter((line) => line.text.length > 0);
  });

  const topItem = metrics.find((entry) => entry.text.includes("top item"));
  const childItem = metrics.find((entry) => entry.text.includes("child item"));
  const grandchildItem = metrics.find((entry) => entry.text.includes("grandchild item"));
  const siblingItem = metrics.find((entry) => entry.text.includes("sibling child"));
  const continuationLine = metrics.find((entry) => entry.text.includes("continuation line"));

  expect(topItem?.bulletCenterX).not.toBeNull();
  expect(childItem?.bulletCenterX).not.toBeNull();
  expect(grandchildItem?.bulletCenterX).not.toBeNull();
  expect(siblingItem?.bulletCenterX).not.toBeNull();
  expect(continuationLine?.depth).toBe(siblingItem?.depth);
  expect((childItem?.textLeftX ?? 0) - (topItem?.textLeftX ?? 0)).toBeGreaterThan(20);
  expect((grandchildItem?.textLeftX ?? 0) - (childItem?.textLeftX ?? 0)).toBeGreaterThan(20);
  expect(Math.abs((continuationLine?.textLeftX ?? 0) - (siblingItem?.textLeftX ?? 0))).toBeLessThanOrEqual(1.5);

  expect(Math.round((topItem?.textLeftX ?? 0) - (topItem?.bulletRightX ?? 0))).toBeLessThanOrEqual(12);
  expect(Math.round((childItem?.textLeftX ?? 0) - (childItem?.bulletRightX ?? 0))).toBeLessThanOrEqual(12);

  await cleanup();
});

test("toggles markdown task checkboxes from live preview", async () => {
  const { page, cleanup } = await launchExographWorkspaceFixture({
    prepareWorkspace: async (workspaceRoot) => {
      const notePath = path.join(workspaceRoot, "notes/test-notes/focus-note.md");
      await writeFile(
        notePath,
        `---\ntitle: Focus Note\n---\n\n# Tasks\n\n- [ ] Pull IRS SOI ZIP Code\n- [x] test\n`,
      );
    },
  });

  async function editorText() {
    return page.evaluate(() => {
      const content = document.querySelector(".cm-content") as (HTMLElement & { cmView?: { view?: any } }) | null;
      const view = content?.cmView?.view;
      if (!view) {
        throw new Error("Unable to resolve CodeMirror view");
      }
      return view.state.doc.toString();
    });
  }

  await expect(page.locator(".exograph-md-checkbox")).toHaveCount(2);
  await page.locator(".exograph-md-checkbox").first().click();
  await expect.poll(editorText).toContain("- [x] Pull IRS SOI ZIP Code");

  await page.locator(".exograph-md-checkbox").nth(1).click();
  await expect.poll(editorText).toContain("- [ ] test");

  await cleanup();
});

test("keeps list text aligned when editing a bullet marker", async () => {
  const { page, cleanup } = await launchExographWorkspaceFixture({
    prepareWorkspace: async (workspaceRoot) => {
      const notePath = path.join(workspaceRoot, "notes/test-notes/focus-note.md");
      await writeFile(
        notePath,
        `---\ntitle: Focus Note\n---\n\n# Probe\n\n- journal\n  - today\n  - \n`,
      );
    },
  });

  async function setCursorOnLineContaining(text: string, offset: number) {
    await page.evaluate(({ lineText, nextOffset }) => {
      const content = document.querySelector(".cm-content") as (HTMLElement & { cmView?: { view?: any } }) | null;
      const view = content?.cmView?.view;
      if (!view) {
        throw new Error("Unable to resolve CodeMirror view");
      }
      let line = null;
      for (let lineNumber = 1; lineNumber <= view.state.doc.lines; lineNumber += 1) {
        const candidate = view.state.doc.line(lineNumber);
        if (candidate.text === lineText) {
          line = candidate;
          break;
        }
      }
      if (!line) {
        for (let lineNumber = 1; lineNumber <= view.state.doc.lines; lineNumber += 1) {
          const candidate = view.state.doc.line(lineNumber);
          if (candidate.text.includes(lineText)) {
            line = candidate;
            break;
          }
        }
      }
      if (!line) {
        throw new Error(`Unable to find ${lineText} line in CodeMirror state`);
      }
      view.dispatch({ selection: { anchor: line.from + nextOffset }, scrollIntoView: true });
      view.focus();
    }, { lineText: text, nextOffset: offset });
  }

  async function lineMetrics(text: string) {
    return page.evaluate((lineText) => {
      const line = Array.from(document.querySelectorAll<HTMLElement>(".cm-line"))
        .find((element) => element.textContent?.includes(lineText));
      if (!line) {
        throw new Error(`Unable to find ${lineText} line`);
      }

      const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          const parent = node.parentElement;
          if (parent?.closest(".exograph-md-syntax-hidden, .exograph-md-list-prefix")) {
            return NodeFilter.FILTER_SKIP;
          }
          return node.textContent?.includes(lineText) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
        },
      });
      const textNode = walker.nextNode() as Text | null;
      if (!textNode) {
        throw new Error(`Unable to find ${lineText} text node`);
      }

      const start = textNode.textContent?.indexOf(lineText) ?? 0;
      const range = document.createRange();
      range.setStart(textNode, start);
      range.setEnd(textNode, start + 1);

      const lineRect = line.getBoundingClientRect();
      const textRect = range.getBoundingClientRect();
      return {
        raw: line.classList.contains("exograph-md-line--list-raw"),
        rawMarkerText: line.querySelector(".exograph-md-list-marker-raw")?.textContent ?? null,
        hasBullet: line.classList.contains("exograph-md-line--list") && !line.classList.contains("exograph-md-line--list-raw"),
        textLeftX: textRect.left - lineRect.left,
      };
    }, text);
  }

  async function cursorLocation() {
    return page.evaluate(() => {
      const content = document.querySelector(".cm-content") as (HTMLElement & { cmView?: { view?: any } }) | null;
      const view = content?.cmView?.view;
      if (!view) {
        throw new Error("Unable to resolve CodeMirror view");
      }
      const pos = view.state.selection.main.head;
      const line = view.state.doc.lineAt(pos);
      return {
        lineText: line.text,
        offset: pos - line.from,
      };
    });
  }

  await setCursorOnLineContaining("today", 5);
  const preview = await lineMetrics("today");
  expect(preview.raw).toBe(false);
  expect(preview.hasBullet).toBe(true);

  await setCursorOnLineContaining("today", 3);
  const raw = await lineMetrics("today");
  expect(raw.raw).toBe(true);
  expect(raw.rawMarkerText).toBe("-");
  expect(raw.hasBullet).toBe(false);
  expect(Math.abs(raw.textLeftX - preview.textLeftX)).toBeLessThanOrEqual(3);

  await setCursorOnLineContaining("today", 4);
  await page.keyboard.press("ArrowLeft");
  await expect.poll(cursorLocation).toEqual({ lineText: "  - today", offset: 3 });
  await expect.poll(async () => (await lineMetrics("today")).rawMarkerText).toBe("-");

  await page.keyboard.press("ArrowLeft");
  await expect.poll(cursorLocation).toEqual({ lineText: "  - today", offset: 2 });

  await page.keyboard.press("ArrowLeft");
  await expect.poll(cursorLocation).toEqual({ lineText: "- journal", offset: 9 });

  await page.keyboard.press("ArrowRight");
  await expect.poll(cursorLocation).toMatchObject({ lineText: "  - today" });
  await expect.poll(async () => (await lineMetrics("today")).hasBullet).toBe(true);
  await page.keyboard.press("ArrowRight");
  await expect.poll(cursorLocation).toMatchObject({ lineText: "  - today" });
  await expect.poll(async () => (await lineMetrics("today")).hasBullet).toBe(true);
  await page.keyboard.press("ArrowRight");
  await expect.poll(cursorLocation).toMatchObject({ lineText: "  - today" });

  await setCursorOnLineContaining("  - ", 3);
  await expect(page.locator(".cm-line .exograph-md-list-marker-raw")).toHaveText("-");

  await setCursorOnLineContaining("  - ", 4);
  await page.keyboard.type("draft");
  const insertedLine = await page.evaluate(() => {
    const content = document.querySelector(".cm-content") as (HTMLElement & { cmView?: { view?: any } }) | null;
    const view = content?.cmView?.view;
    if (!view) {
      throw new Error("Unable to resolve CodeMirror view");
    }
    for (let lineNumber = 1; lineNumber <= view.state.doc.lines; lineNumber += 1) {
      const line = view.state.doc.line(lineNumber);
      if (line.text.includes("draft")) {
        return line.text;
      }
    }
    return "";
  });
  expect(insertedLine).toBe("  - draft");
  await expect(page.locator(".cm-line").filter({ hasText: /draft/ })).toContainText("draft");

  await cleanup();
});

test("outdents blank list continuation lines in live preview", async () => {
  const { page, cleanup } = await launchExographWorkspaceFixture({
    prepareWorkspace: async (workspaceRoot) => {
      const notePath = path.join(workspaceRoot, "notes/test-notes/focus-note.md");
      await writeFile(
        notePath,
        `---\ntitle: Focus Note\n---\n\n# Probe\n\n- working on\n  - transformation workshop\n  - evals deck/blog post\n  \nnotes\n`,
      );
    },
  });

  async function setCursorOnExactLine(text: string, offset: number) {
    await page.evaluate(({ lineText, nextOffset }) => {
      const content = document.querySelector(".cm-content") as (HTMLElement & { cmView?: { view?: any } }) | null;
      const view = content?.cmView?.view;
      if (!view) {
        throw new Error("Unable to resolve CodeMirror view");
      }
      for (let lineNumber = 1; lineNumber <= view.state.doc.lines; lineNumber += 1) {
        const line = view.state.doc.line(lineNumber);
        if (line.text === lineText) {
          view.dispatch({ selection: { anchor: line.from + nextOffset }, scrollIntoView: true });
          view.focus();
          return;
        }
      }
      throw new Error(`Unable to find exact line ${JSON.stringify(lineText)}`);
    }, { lineText: text, nextOffset: offset });
  }

  async function cursorLocation() {
    return page.evaluate(() => {
      const content = document.querySelector(".cm-content") as (HTMLElement & { cmView?: { view?: any } }) | null;
      const view = content?.cmView?.view;
      if (!view) {
        throw new Error("Unable to resolve CodeMirror view");
      }
      const pos = view.state.selection.main.head;
      const line = view.state.doc.lineAt(pos);
      return {
        lineText: line.text,
        offset: pos - line.from,
      };
    });
  }

  await setCursorOnExactLine("  ", 2);
  const blankLineClassList = await page.evaluate(() => {
    const content = document.querySelector(".cm-content") as (HTMLElement & { cmView?: { view?: any } }) | null;
    const view = content?.cmView?.view;
    if (!view) {
      throw new Error("Unable to resolve CodeMirror view");
    }
    const pos = view.state.selection.main.head;
    const line = view.state.doc.lineAt(pos);
    const lineIndex = line.number - 1;
    const element = document.querySelectorAll<HTMLElement>(".cm-line")[lineIndex];
    return Array.from(element?.classList ?? []);
  });
  expect(blankLineClassList).not.toContain("exograph-md-line--list-continuation");

  await page.keyboard.press("Enter");
  await expect.poll(cursorLocation).toEqual({ lineText: "", offset: 0 });

  await cleanup();
});

test("keeps the inspector pinned while long notes scroll", async () => {
  const longDocument = Array.from({ length: 120 }, (_, index) => `- line ${index + 1}`).join("\n");
  const longFixture = await launchExographWorkspaceFixture({
    prepareWorkspace: async (workspaceRoot) => {
      const notePath = path.join(workspaceRoot, "notes/test-notes/focus-note.md");
      await writeFile(
        notePath,
        `---\ntitle: Focus Note\n---\n\n# Long note\n\n${longDocument}\n`,
      );
    },
  });

  await longFixture.page.getByTestId("utility-pane-toggle").click();
  await longFixture.page.getByTestId("utility-pane-context").click();
  const before = await longFixture.page.getByTestId("inspector-panel").boundingBox();
  await longFixture.page.locator(".editor-surface .cm-scroller").evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect
    .poll(() => longFixture.page.locator(".editor-surface .cm-scroller").evaluate((element) => Math.round(element.scrollTop)))
    .toBeGreaterThan(100);
  const after = await longFixture.page.getByTestId("inspector-panel").boundingBox();

  expect(before).not.toBeNull();
  expect(after).not.toBeNull();
  expect(Math.abs((after?.x ?? 0) - (before?.x ?? 0))).toBeLessThan(2);
  expect(Math.abs((after?.y ?? 0) - (before?.y ?? 0))).toBeLessThan(2);

  await longFixture.cleanup();
});
