import { expect, test, type Locator } from "@playwright/test";
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { launchExographWorkspaceFixture } from "../helpers";

const onePixelPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z7KkAAAAASUVORK5CYII=",
  "base64",
);
const sibsSvgFiles = [
  "organizational-ecology-v4.svg",
  "levels-of-agentic-work-v1.svg",
  "agent-human-loops-v4.svg",
  "future-of-work-v2.svg",
];
const viewBoxOnlySvg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 520"><rect width="1200" height="520" fill="#7b8f84"/></svg>';

test("loads a root-relative site image through the Electron notes resolver", async ({}, testInfo) => {
  let notePath = "";
  const { electronApp, page, cleanup } = await launchExographWorkspaceFixture({
    mutable: true,
    initialNoteLabel: null,
    prepareWorkspace: async (workspaceRoot) => {
      const siteRoot = path.join(workspaceRoot, "notes/test-notes/kenneth-dot-computer/garden");
      notePath = path.join(siteRoot, "blog/self-improving-business-systems.md");
      const imagePath = path.join(siteRoot, "images/posts/self-improving-business-systems/loop-stack.png");
      const relativeImagePath = path.join(siteRoot, "blog/attachments/relative.png");
      const embeddedImagePath = path.join(siteRoot, "blog/images/embedded.png");
      const vectorImagePath = path.join(siteRoot, "blog/attachments/vector.svg");
      const noteRootImagePath = path.join(workspaceRoot, "notes/test-notes/images/root-control.png");
      await mkdir(path.dirname(notePath), { recursive: true });
      await mkdir(path.dirname(imagePath), { recursive: true });
      await mkdir(path.dirname(relativeImagePath), { recursive: true });
      await mkdir(path.dirname(embeddedImagePath), { recursive: true });
      await mkdir(path.dirname(noteRootImagePath), { recursive: true });
      await writeFile(
        notePath,
        "# Self-Improving Business Systems\n\n![Relative control](attachments/relative.png)\n\n![Vector control](attachments/vector.svg)\n\n![Note root control](/images/root-control.png)\n\n![The nested agentic work loop and human governance loop](/images/posts/self-improving-business-systems/loop-stack.png)\n\n![[embedded.png|640]]\n\n![Remote control](https://assets.example.test/exograph.png)\n",
        "utf8",
      );
      await writeFile(imagePath, onePixelPng);
      await writeFile(relativeImagePath, onePixelPng);
      await writeFile(vectorImagePath, '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 120"><rect width="320" height="120" fill="#2f716c"/></svg>', "utf8");
      await writeFile(embeddedImagePath, onePixelPng);
      await writeFile(noteRootImagePath, onePixelPng);
    },
  });

  try {
    await page.route("https://assets.example.test/exograph.png", (route) => route.fulfill({
      body: onePixelPng,
      contentType: "image/png",
    }));
    await electronApp.evaluate(({ BrowserWindow }, targetPath) => {
      BrowserWindow.getAllWindows()[0]?.webContents.send("command:open-file", targetPath);
    }, notePath);

    const relativeControl = page.getByLabel("Relative control");
    const vectorControl = page.getByLabel("Vector control");
    const noteRootControl = page.getByLabel("Note root control");
    const imageWidget = page.getByLabel("The nested agentic work loop and human governance loop");
    const embeddedImage = page.getByLabel("embedded.png");
    const remoteControl = page.getByLabel("Remote control");
    await expect(relativeControl).toBeVisible();
    await expect(vectorControl).toBeVisible();
    await expect(noteRootControl).toBeVisible();
    await expect(imageWidget).toBeVisible();
    await expect(embeddedImage).toBeVisible();
    await expect(remoteControl).toBeVisible();
    await expect.poll(() => loadedWidth(relativeControl)).toBeGreaterThan(0);
    await expect.poll(() => loadedWidth(vectorControl)).toBeGreaterThan(0);
    await expect.poll(() => renderedWidth(vectorControl)).toBeGreaterThan(0);
    await page.locator("html").evaluate((root) => {
      root.dataset.theme = "dark";
    });
    await expect(vectorControl.locator("img")).toHaveCSS("background-color", "rgb(253, 246, 227)");
    await expect.poll(() => loadedWidth(noteRootControl)).toBeGreaterThan(0);
    await expect
      .poll(() => loadedWidth(imageWidget))
      .toBeGreaterThan(0);
    await expect.poll(() => loadedWidth(embeddedImage)).toBeGreaterThan(0);
    await expect.poll(() => loadedWidth(remoteControl)).toBeGreaterThan(0);
    await expect(imageWidget.locator("img")).toHaveCSS("border-radius", "8px");
    await expect(imageWidget).not.toHaveClass(/exograph-md-image--missing/);
    await expect(remoteControl).not.toHaveClass(/exograph-md-image--missing/);
    await page.screenshot({ path: testInfo.outputPath("markdown-images-loaded.png"), fullPage: true });
  } finally {
    await cleanup();
  }
});

test("recovers when a local image becomes available during resolution", async () => {
  let notePath = "";
  let imagePath = "";
  const { electronApp, page, cleanup } = await launchExographWorkspaceFixture({
    mutable: true,
    initialNoteLabel: null,
    prepareWorkspace: async (root) => {
      const noteRoot = path.join(root, "notes/test-notes");
      notePath = path.join(noteRoot, "transient-image.md");
      imagePath = path.join(noteRoot, "attachments/transient.png");
      await mkdir(path.dirname(notePath), { recursive: true });
      await mkdir(path.dirname(imagePath), { recursive: true });
      await writeFile(notePath, "# Transient image\n\n![Retry image](attachments/transient.png)\n", "utf8");
      const outsideImagePath = path.join(root, "transient-outside.png");
      await writeFile(outsideImagePath, onePixelPng);
      await symlink(outsideImagePath, imagePath);
    },
  });

  try {
    await electronApp.evaluate(({ BrowserWindow }, targetPath) => {
      BrowserWindow.getAllWindows()[0]?.webContents.send("command:open-file", targetPath);
    }, notePath);
    const image = page.getByLabel("Retry image");
    await expect(image).toBeVisible();
    await new Promise((resolve) => setTimeout(resolve, 80));
    await rm(imagePath);
    await writeFile(imagePath, onePixelPng);
    await expect.poll(() => loadedWidth(image), { timeout: 3000 }).toBeGreaterThan(0);
    await expect(image).not.toHaveClass(/exograph-md-image--missing/);
  } finally {
    await cleanup();
  }
});

test("renders every root-relative SVG used by Self-Improving Business Systems", async ({}, testInfo) => {
  let notePath = "";
  const { electronApp, page, cleanup } = await launchExographWorkspaceFixture({
    mutable: true,
    initialNoteLabel: null,
    prepareWorkspace: async (workspaceRoot) => {
      const siteRoot = path.join(workspaceRoot, "notes/test-notes/kenneth-dot-computer/garden");
      notePath = path.join(siteRoot, "blog/self-improving-business-systems.md");
      await mkdir(path.dirname(notePath), { recursive: true });
      await writeFile(notePath, [
        "# Self-Improving Business Systems",
        "",
        "![Organization ecology](/images/posts/self-improving-business-systems/organizational-ecology-v4.svg)",
        "",
        "![Levels of agentic work](/images/posts/self-improving-business-systems/levels-of-agentic-work-v1.svg)",
        "",
        "![Agent and human loops](/images/posts/self-improving-business-systems/agent-human-loops-v4.svg)",
        "",
        "![Future of work](/images/posts/self-improving-business-systems/future-of-work-v2.svg)",
        "",
      ].join("\n"), "utf8");
      await Promise.all(sibsSvgFiles.map(async (filename) => {
        const imagePath = path.join(siteRoot, "images/posts/self-improving-business-systems", filename);
        await mkdir(path.dirname(imagePath), { recursive: true });
        await writeFile(imagePath, viewBoxOnlySvg);
      }));
    },
  });

  try {
    await electronApp.evaluate(({ BrowserWindow }, targetPath) => {
      BrowserWindow.getAllWindows()[0]?.webContents.send("command:open-file", targetPath);
    }, notePath);
    await expect(page.getByTestId("editor-title")).toHaveText("self-improving-business-systems");
    for (const label of ["Organization ecology", "Levels of agentic work", "Agent and human loops", "Future of work"]) {
      const image = page.getByLabel(label);
      await image.scrollIntoViewIfNeeded();
      await expect(image).toBeVisible();
      await expect.poll(() => loadedWidth(image)).toBeGreaterThan(0);
      await expect(image).not.toHaveClass(/exograph-md-image--missing/);
    }
    await page.screenshot({ path: testInfo.outputPath("self-improving-business-systems-images.png"), fullPage: true });
  } finally {
    await cleanup();
  }
});

function loadedWidth(widget: Locator): Promise<number> {
  return widget.locator("img").evaluateAll((images) => (images[0] as HTMLImageElement | undefined)?.naturalWidth ?? 0);
}

function renderedWidth(widget: Locator): Promise<number> {
  return widget.locator("img").evaluateAll((images) => images[0]?.getBoundingClientRect().width ?? 0);
}
