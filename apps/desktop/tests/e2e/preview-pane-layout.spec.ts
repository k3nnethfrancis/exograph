import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createServer as createViteServer } from "vite";

import { test, expect, type Page } from "@playwright/test";

import { launchExographWorkspaceFixture } from "../helpers";

test("renders visible content from a localhost preview", async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end("<!doctype html><html><body><h1>Preview content loaded</h1></body></html>");
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Preview fixture server did not expose a TCP port");
  }
  const url = `http://127.0.0.1:${address.port}/preview`;
  const { page, cleanup } = await launchExographWorkspaceFixture();

  try {
    await page.getByTestId("utility-pane-toggle").click();
    await page.getByTestId("utility-pane-preview").click();
    await page.getByRole("button", { name: "New preview" }).click();
    await page.getByTestId("browser-url-input").fill(url);
    const frameNavigation = page.waitForEvent("framenavigated", (frame) => frame.url() === url);
    await page.getByTestId("browser-url-input").press("Enter");

    const previewFrame = await frameNavigation;
    await expect(previewFrame.getByRole("heading", { name: "Preview content loaded" })).toBeVisible();
  } finally {
    await cleanup();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("reloads the current localhost URL and reports an unreachable server", async () => {
  let heading = "First response";
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(`<!doctype html><html><body><h1>${heading}</h1></body></html>`);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Preview fixture server did not expose a TCP port");
  }
  const url = `http://127.0.0.1:${address.port}/preview`;
  const { page, cleanup } = await launchExographWorkspaceFixture();

  try {
    await page.getByTestId("utility-pane-toggle").click();
    await page.getByTestId("utility-pane-preview").click();
    await page.getByRole("button", { name: "New preview" }).click();
    await page.getByTestId("browser-url-input").fill(url);
    await page.getByTestId("browser-url-input").press("Enter");
    const frame = page.frameLocator("[data-testid='browser-preview-frame']");
    await expect(frame.getByRole("heading", { name: "First response" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Open preview in default browser" })).toBeVisible();

    heading = "Second response";
    await page.getByRole("button", { name: "Reload preview" }).click();
    await expect(frame.getByRole("heading", { name: "Second response" })).toBeVisible();

    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await page.getByRole("button", { name: "Reload preview" }).click();
    await expect(page.getByRole("status", { name: "Preview failed" })).toBeVisible();
    await expect(page.getByRole("alert")).toContainText("Preview unavailable");
  } finally {
    await cleanup();
    if (server.listening) {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  }
});

test("keeps a Vite localhost preview live and interactive across edits and pane changes", async () => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "exograph-preview-vite-"));
  const scriptPath = path.join(fixtureRoot, "main.js");
  await writeFile(
    path.join(fixtureRoot, "index.html"),
    "<!doctype html><button id='count'>Count 0</button><strong id='version'></strong><script type='module' src='/main.js'></script>",
    "utf8",
  );
  const writeVersion = (version: string) => writeFile(scriptPath, `
    const count = document.querySelector('#count');
    const versionNode = document.querySelector('#version');
    count.addEventListener('click', () => {
      const next = Number(count.textContent.replace('Count ', '')) + 1;
      count.textContent = 'Count ' + next;
    });
    versionNode.textContent = '${version}';
    if (import.meta.hot) import.meta.hot.accept(() => location.reload());
  `, "utf8");
  await writeVersion("Version 1");
  const vite = await createViteServer({
    root: fixtureRoot,
    logLevel: "silent",
    server: { host: "127.0.0.1", port: 0, strictPort: true },
  });
  await vite.listen();
  const url = vite.resolvedUrls?.local[0];
  if (!url) throw new Error("Vite preview fixture did not expose a local URL");
  const { page, cleanup } = await launchExographWorkspaceFixture();

  try {
    await page.getByTestId("utility-pane-toggle").click();
    await page.getByTestId("utility-pane-preview").click();
    await page.getByRole("button", { name: "New preview" }).click();
    await page.getByTestId("browser-url-input").fill(url);
    await page.getByTestId("browser-url-input").press("Enter");

    const frame = page.frameLocator("[data-testid='browser-preview-frame']");
    await expect(frame.getByText("Version 1")).toBeVisible();
    await frame.getByRole("button", { name: "Count 0" }).click();
    await expect(frame.getByRole("button", { name: "Count 1" })).toBeVisible();

    await writeVersion("Version 2");
    await expect(frame.getByText("Version 2")).toBeVisible();

    await page.getByTestId("utility-pane-context").click();
    await page.getByTestId("utility-pane-preview").click();
    await expect(frame.getByText("Version 2")).toBeVisible();
    await frame.getByRole("button", { name: "Count 0" }).click();
    await expect(frame.getByRole("button", { name: "Count 1" })).toBeVisible();

    await writeVersion("Version 3");
    await page.getByRole("button", { name: "Reload preview" }).click();
    await expect(frame.getByText("Version 3")).toBeVisible();
  } finally {
    await cleanup();
    await vite.close();
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test("uses one full-width preview surface in the utility pane", async () => {
  const { page, cleanup } = await launchExographWorkspaceFixture();

  try {
    await page.getByTestId("utility-pane-toggle").click();
    await page.getByTestId("utility-pane-preview").click();
    await page.getByRole("button", { name: "New preview" }).click();
    await page.getByTestId("browser-url-input").fill("localhost:4321");
    await page.getByTestId("browser-load-url").click();
    await expect(page.getByTestId("browser-preview-frame")).toHaveAttribute("src", "http://localhost:4321/");

    const utilityPane = page.getByTestId("utility-pane");
    await expect(utilityPane.getByTestId("browser-pane")).toHaveCount(1);
    await expect(utilityPane.getByTestId("terminal-dock")).toHaveCount(0);
    const browserPane = utilityPane.getByTestId("browser-pane");
    await expect(browserPane).toBeVisible();
    const [utilityBox, browserBox] = await Promise.all([utilityPane.boundingBox(), browserPane.boundingBox()]);
    expect(utilityBox).not.toBeNull();
    expect(browserBox).not.toBeNull();
    expect(browserBox!.width).toBeGreaterThan(utilityBox!.width - 56);
  } finally {
    await cleanup();
  }
});

test("resizes the utility pane from its left edge", async () => {
  const { page, cleanup } = await launchExographWorkspaceFixture();

  try {
    await page.getByTestId("utility-pane-toggle").click();
    const utilityPane = page.getByTestId("utility-pane");
    const resizer = page.getByTestId("utility-pane-resizer");
    const before = await utilityPane.boundingBox();
    const handle = await resizer.boundingBox();
    expect(before).not.toBeNull();
    expect(handle).not.toBeNull();

    await page.mouse.move(handle!.x + handle!.width / 2, handle!.y + 120);
    await page.mouse.down();
    await page.mouse.move(handle!.x - 140, handle!.y + 120, { steps: 8 });
    await page.mouse.up();

    await expect.poll(async () => (await utilityPane.boundingBox())?.width ?? 0).toBeGreaterThan(before!.width + 100);
  } finally {
    await cleanup();
  }
});

test("opens absolute local HTML paths in the preview pane", async () => {
  const { page, workspaceRoot, cleanup } = await launchExographWorkspaceFixture({
    mutable: true,
    prepareWorkspace: async (root) => {
      const artifactRoot = path.join(root, "notes", "test-notes", "artifacts");
      await mkdir(artifactRoot, { recursive: true });
      await writeFile(
        path.join(artifactRoot, "overall-exograph-architecture.html"),
        `<!doctype html>
<html>
  <head>
    <title>Overall</title>
    <style>
      html,
      body {
        margin: 0;
        min-height: 100%;
      }

      .viewport-fit {
        position: fixed;
        inset: 0;
        display: grid;
        grid-template-rows: minmax(0, 1fr) 32px;
        background: #101820;
      }

      #viewport-bottom {
        background: #31d0aa;
      }
    </style>
  </head>
  <body>
    <main class="viewport-fit">
      <section>Preview body</section>
      <footer id="viewport-bottom">Viewport bottom marker</footer>
    </main>
  </body>
</html>`,
        "utf8",
      );
      await writeFile(
        path.join(artifactRoot, "core-plugin-boundary.html"),
        "<!doctype html><title>Core Boundary</title>",
        "utf8",
      );
    },
  });

  try {
    const firstPath = path.join(workspaceRoot, "notes", "test-notes", "artifacts", "overall-exograph-architecture.html");
    const secondPath = path.join(workspaceRoot, "notes", "test-notes", "artifacts", "core-plugin-boundary.html");
    const firstUrl = pathToFileURL(await realpath(firstPath)).toString();
    const secondUrl = pathToFileURL(await realpath(secondPath)).toString();

    await page.getByTestId("utility-pane-toggle").click();
    await page.getByTestId("utility-pane-preview").click();
    await page.getByRole("button", { name: "New preview" }).click();
    await page.getByTestId("browser-url-input").fill(firstPath);
    await page.getByTestId("browser-load-url").click();
    await expect(page.getByTestId("browser-preview-frame")).toHaveAttribute("src", firstUrl);
    await expect.poll(async () => getPreviewLayoutMetrics(page)).toMatchObject({
      title: "Overall",
      bottomMarkerVisibleAtViewportBottom: true,
      frameFillsPane: true,
      guestViewportMatchesElement: true,
    });

    await page.getByTestId("browser-url-input").fill(secondPath);
    await page.getByTestId("browser-load-url").click();
    await expect(page.getByTestId("utility-pane").getByTestId("browser-pane")).toHaveCount(1);
    await expect(page.getByTestId("browser-url-input")).toHaveValue(secondUrl);
    await expect(page.getByTestId("browser-preview-frame")).toHaveAttribute("src", secondUrl);

    await page.getByTestId("browser-url-input").fill(firstPath);
    await page.getByTestId("browser-load-url").click();
    await expect(page.getByTestId("browser-preview-frame")).toHaveAttribute("src", firstUrl);
    await expect.poll(async () => getPreviewLayoutMetrics(page)).toMatchObject({
      title: "Overall",
      bottomMarkerVisibleAtViewportBottom: true,
      frameFillsPane: true,
      guestViewportMatchesElement: true,
    });
  } finally {
    await cleanup();
  }
});

async function getPreviewLayoutMetrics(page: Page): Promise<{
  title: string;
  bottomMarkerVisibleAtViewportBottom: boolean;
  frameFillsPane: boolean;
  guestViewportMatchesElement: boolean;
  paneHeight: number;
  frameHeight: number;
  guestInnerHeight: number;
  bottomMarkerBottom: number;
}> {
  const shellMetrics = await page.evaluate(async () => {
    const pane = document.querySelector<HTMLElement>("[data-testid='browser-pane']");
    const frame = document.querySelector<HTMLIFrameElement>("[data-testid='browser-preview-frame']");
    if (!pane || !frame) {
      return {
        frameFillsPane: false,
        paneHeight: 0,
        frameHeight: 0,
      };
    }

    const paneRect = pane.getBoundingClientRect();
    const headerRect = pane.querySelector<HTMLElement>(".browser-pane__header")?.getBoundingClientRect();
    const frameRect = frame.getBoundingClientRect();
    const expectedFrameHeight = paneRect.height - (headerRect?.height ?? 0);

    return {
      frameFillsPane: frameRect.height >= expectedFrameHeight - 2,
      paneHeight: paneRect.height,
      frameHeight: frameRect.height,
    };
  });

  const frameHandle = await page.getByTestId("browser-preview-frame").elementHandle();
  const frame = await frameHandle?.contentFrame();
  if (!frame) {
    return {
      title: "",
      bottomMarkerVisibleAtViewportBottom: false,
      frameFillsPane: shellMetrics.frameFillsPane,
      guestViewportMatchesElement: false,
      paneHeight: shellMetrics.paneHeight,
      frameHeight: shellMetrics.frameHeight,
      guestInnerHeight: 0,
      bottomMarkerBottom: 0,
    };
  }

  const guest = await frame.evaluate(() => {
    const marker = document.getElementById("viewport-bottom");
    const markerRect = marker ? marker.getBoundingClientRect() : { bottom: 0 };
    return {
      title: document.title,
      innerHeight: window.innerHeight,
      bottomMarkerBottom: markerRect.bottom,
    };
  });

  return {
    title: guest.title,
    bottomMarkerVisibleAtViewportBottom: Math.abs(guest.bottomMarkerBottom - guest.innerHeight) <= 2,
    frameFillsPane: shellMetrics.frameFillsPane,
    guestViewportMatchesElement: Math.abs(guest.innerHeight - shellMetrics.frameHeight) <= 2,
    paneHeight: shellMetrics.paneHeight,
    frameHeight: shellMetrics.frameHeight,
    guestInnerHeight: guest.innerHeight,
    bottomMarkerBottom: guest.bottomMarkerBottom,
  };
}

test("keeps an empty preview destination isolated from the editor and terminal", async () => {
  const { page, cleanup } = await launchExographWorkspaceFixture();

  try {
    await page.getByTestId("utility-pane-toggle").click();
    await page.getByTestId("utility-pane-preview").click();
    await expect(page.getByTestId("preview-empty-state")).toBeVisible();
    await expect(page.getByTestId("utility-pane").getByTestId("browser-pane")).toHaveCount(0);
    await expect(page.getByTestId("utility-pane").getByTestId("terminal-dock")).toHaveCount(0);
    await expect(page.locator(".workspace-shell__canvas .pane-leaf--editor")).toHaveCount(1);
    await expect(page.locator(".workspace-shell__canvas .pane-leaf--browser")).toHaveCount(0);
  } finally {
    await cleanup();
  }
});

test("returns to the Preview empty state after its final tab closes", async () => {
  const { page, cleanup } = await launchExographWorkspaceFixture();

  try {
    await page.getByTestId("utility-pane-toggle").click();
    await page.getByTestId("utility-pane-preview").click();
    await page.getByRole("button", { name: "New preview" }).click();
    await page.getByTestId("browser-tab-preview").getByRole("button", { name: "Close preview pane" }).click();

    await expect(page.getByTestId("preview-empty-state")).toBeVisible();
    await expect(page.getByTestId("utility-pane-terminal")).toHaveAttribute("aria-pressed", "false");
  } finally {
    await cleanup();
  }
});

test("switches one utility pane between independent Preview, Terminal, Graph, and Note context destinations", async () => {
  const { page, cleanup } = await launchExographWorkspaceFixture();

  try {
    await expect.poll(async () => page.evaluate(() => window.exograph.terminals.list())).toEqual([]);

    await page.getByTestId("utility-pane-toggle").click();
    await page.getByTestId("utility-pane-preview").click();
    await page.getByRole("button", { name: "New preview" }).click();
    await page.getByTestId("browser-url-input").fill("http://localhost:8765/blog/self-improving-business-systems");
    await page.getByTestId("browser-url-input").press("Enter");
    await expect(page.getByTestId("browser-preview-frame")).toHaveAttribute(
      "src",
      "http://localhost:8765/blog/self-improving-business-systems",
    );

    await page.getByTestId("utility-pane-terminal").click();
    await expect(page.getByTestId("utility-pane-terminal")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("terminal-dock")).toBeVisible();
    await expect(page.getByTestId("browser-pane")).toHaveCount(0);
    await expect(page.getByTestId("terminal-tab-shell")).toHaveCount(0);
    await expect.poll(async () => page.evaluate(() => window.exograph.terminals.list())).toEqual([]);

    await page.getByTestId("new-terminal").click();
    await expect(page.getByTestId("terminal-tab-shell")).toHaveCount(1);
    await expect.poll(async () => page.evaluate(async () => (await window.exograph.terminals.list()).length)).toBe(1);

    await page.getByTestId("utility-pane-context").click();
    await expect(page.getByTestId("utility-pane-context")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("inspector-panel")).toBeVisible();
    await expect(page.getByTestId("browser-pane")).toHaveCount(0);
    await expect(page.getByTestId("terminal-dock")).toHaveCount(0);

    await page.getByTestId("utility-pane-graph").click();
    await expect(page.getByTestId("utility-pane-graph")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("graph-pane")).toBeVisible();
    await expect(page.getByTestId("inspector-panel")).toHaveCount(0);
    await expect(page.getByTestId("terminal-dock")).toHaveCount(0);

    await page.getByTestId("utility-pane-preview").click();
    await expect(page.getByTestId("utility-pane-preview")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("browser-url-input")).toHaveValue(
      "http://localhost:8765/blog/self-improving-business-systems",
    );
    await expect(page.getByTestId("terminal-dock")).toHaveCount(0);
    await expect(page.getByTestId("inspector-panel")).toHaveCount(0);
    await expect(page.getByTestId("graph-pane")).toHaveCount(0);

    await page.getByTestId("utility-pane-terminal").click();
    await expect(page.getByTestId("terminal-tab-shell")).toHaveCount(1);
    await expect(page.getByTestId("browser-pane")).toHaveCount(0);
    await expect(page.getByTestId("inspector-panel")).toHaveCount(0);
    await expect.poll(async () => page.evaluate(async () => (await window.exograph.terminals.list()).length)).toBe(1);
  } finally {
    await cleanup();
  }
});
