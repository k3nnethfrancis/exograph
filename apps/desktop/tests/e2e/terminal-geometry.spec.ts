import path from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test, type Page } from "@playwright/test";

import { launchExographTerminalFixture } from "../helpers";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const fakeInkAgentPath = path.join(repoRoot, "apps/desktop/tests/fixtures/fake-ink-agent.sh");

test("keeps a direct-PTY fake TUI frame aligned at wide geometry", async () => {
  const { page, cleanup } = await launchWideTerminal();

  try {
    const shell = await pageShellSession(page);
    await startFakeInkAgent(page, shell.id);
    const baseline = await waitForCompleteGeometryFrame(page, { minCols: 120 }, shell.id);

    expect(baseline.frameCount).toBe(1);
    expect(baseline.rulerLength).toBe(baseline.cols);
    expect(baseline.boxLength).toBe(baseline.cols);
    expect(baseline.boxWrappedFragment).toBe(false);
  } finally {
    await cleanup();
  }
});

async function launchWideTerminal() {
  const fixture = await launchExographTerminalFixture({
    env: {
      EXOGRAPH_SHELL: "/bin/sh",
      EXOGRAPH_SHELL_ARGS: "",
    },
    initialNoteLabel: null,
  });
  await fixture.electronApp.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.webContents.setZoomFactor(0.5);
    window.setBounds({ x: 0, y: 0, width: 1800, height: 1100 });
  });
  await fixture.page.evaluate(async () => {
    const snapshot = await window.exograph.workspace.getSettings();
    await window.exograph.workspace.saveSettings({
      settings: { ...snapshot.settings, terminalFontSize: 10 },
      expectedRevision: snapshot.revision,
    });
  });
  await fixture.page.reload();
  await expect(fixture.page.getByTestId("sidebar")).toBeVisible();
  await fixture.page.getByTestId("utility-pane-toggle").click();
  await fixture.page.getByTestId("utility-pane-terminal").click();
  await expect(fixture.page.getByTestId("terminal-surface")).toBeVisible();
  if (!await fixture.page.locator(".workspace-shell").evaluate((element) => element.classList.contains("workspace-shell--sidebar-collapsed"))) {
    await fixture.page.getByTestId("workspace-titlebar-sidebar").click();
    await expect(fixture.page.locator(".workspace-shell")).toHaveClass(/workspace-shell--sidebar-collapsed/);
  }
  const utilityResizer = await fixture.page.getByTestId("utility-pane-resizer").boundingBox();
  expect(utilityResizer).not.toBeNull();
  await fixture.page.mouse.move(utilityResizer!.x + utilityResizer!.width / 2, utilityResizer!.y + 120);
  await fixture.page.mouse.down();
  await fixture.page.mouse.move(utilityResizer!.x - 720, utilityResizer!.y + 120, { steps: 8 });
  await fixture.page.mouse.up();
  await fixture.page.getByTestId("terminal-surface").click();
  return fixture;
}

async function pageShellSession(page: Page) {
  const shell = await page.evaluate(async () => {
    const sessions = await window.exograph.terminals.list();
    return sessions.find((session) => session.kind === "shell") ?? null;
  });
  if (!shell) {
    throw new Error("Expected shell terminal session.");
  }
  return shell;
}

async function startFakeInkAgent(page: Page, terminalId: string): Promise<void> {
  await waitForSettledRendererGeometry(page, terminalId, { minCols: 120 });
  await page.evaluate(async ({ id, command }) => {
    await window.exograph.terminals.write(id, `${command}\n`);
  }, {
    id: terminalId,
    command: `/usr/bin/env bash ${shellQuote(fakeInkAgentPath)}`,
  });
  await expect.poll(async () => currentGeometryFrame(page), { timeout: 5_000 }).toMatchObject({
    frameCount: 1,
  });
}

async function waitForSettledRendererGeometry(page: Page, terminalId: string, options: { minCols: number }): Promise<void> {
  const deadline = Date.now() + 5_000;
  let stableKey = "";
  let stableSince = 0;
  let lastSample: { rendererCols: number; rendererRows: number } | null = null;

  while (Date.now() < deadline) {
    const session = await page.evaluate(async (id) => {
      const sessions = await window.exograph.terminals.list();
      return sessions.find((candidate) => candidate.id === id) ?? null;
    }, terminalId);
    const rendererCols = session?.geometry?.source === "renderer-fit" ? session.geometry.cols : 0;
    const rendererRows = session?.geometry?.source === "renderer-fit" ? session.geometry.rows : 0;
    lastSample = { rendererCols, rendererRows };

    if (rendererCols >= options.minCols && rendererRows > 0) {
      const key = `${rendererCols}x${rendererRows}`;
      if (key !== stableKey) {
        stableKey = key;
        stableSince = Date.now();
      } else if (Date.now() - stableSince >= 250) {
        return;
      }
    } else {
      stableKey = "";
      stableSince = 0;
    }
    await page.waitForTimeout(50);
  }

  throw new Error(`Timed out waiting for settled renderer geometry: ${JSON.stringify(lastSample)}`);
}

async function waitForCompleteGeometryFrame(page: Page, options: { minCols: number }, terminalId: string): Promise<GeometryFrame> {
  const deadline = Date.now() + 5_000;
  let lastFrame: GeometryFrame | null = null;

  while (Date.now() < deadline) {
    const frame = await currentGeometryFrame(page);
    lastFrame = frame;
    if (
      frame.frameCount === 1
      && frame.cols >= options.minCols
      && frame.rulerLength === frame.cols
      && frame.boxLength === frame.cols
      && !frame.boxWrappedFragment
    ) {
      return frame;
    }
    await page.waitForTimeout(50);
  }

  const sourceTail = await page.evaluate(async (id) => window.exograph.terminals.read(id, { maxLines: 200 }), terminalId).catch((error) => String(error));
  throw new Error(`Timed out waiting for complete geometry frame:\n${JSON.stringify(lastFrame, null, 2)}\nsourceTail:\n${sourceTail}`);
}

async function currentGeometryFrame(page: Page): Promise<GeometryFrame> {
  const lines = await page.evaluate(() =>
    Array.from(document.querySelectorAll(".terminal-surface .xterm-rows > div"))
      .map((row) => row.textContent ?? "")
      .filter((line) => line.length > 0),
  );
  const visibleText = lines.join("\n");
  const header = lines.find((line) => line.includes("FAKE-INK v1 frame=")) ?? "";
  const cols = Number(header.match(/cols=(\d+)/)?.[1] ?? 0);
  const ruler = lines.find((line) => /^[-+\d]+$/.test(line) && line.includes("----+----1")) ?? "";
  const box = selectBoxLine(lines, cols);
  return {
    visibleText,
    frameCount: countOccurrences(visibleText, "frame="),
    cols,
    rulerLength: ruler.length,
    boxLength: box.length,
    boxWrappedFragment: lines.some((line) => line !== box && /^─*┐$/.test(line)),
  };
}

function selectBoxLine(lines: string[], expectedCols: number): string {
  const candidates = lines.filter((line) => line.startsWith("┌"));
  return candidates.find((line) => line.length === expectedCols)
    ?? candidates.sort((left, right) => right.length - left.length)[0]
    ?? "";
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function countOccurrences(text: string, fragment: string): number {
  return text.split(fragment).length - 1;
}

interface GeometryFrame {
  visibleText: string;
  frameCount: number;
  cols: number;
  rulerLength: number;
  boxLength: number;
  boxWrappedFragment: boolean;
}
