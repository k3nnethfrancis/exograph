import { access, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "@playwright/test";

import { launchExographWorkspaceFixture } from "../helpers";

const fixturePdf = path.join(path.dirname(fileURLToPath(import.meta.url)), "../fixtures/tiny-reader.pdf.base64");
const realPdfPath = process.env.EXOGRAPH_REAL_PDF_PATH;

test("opens a contained PDF from a Markdown link without mutating the Note Root", async () => {
  const { page, workspaceRoot, cleanup } = await launchExographWorkspaceFixture({
    mutable: true,
    initialNoteLabel: null,
    prepareWorkspace: async (root) => {
      const noteRoot = path.join(root, "notes", "test-notes");
      const pdfBytes = Buffer.from((await readFile(fixturePdf, "utf8")).replaceAll(/\s/g, ""), "base64");
      await writeFile(path.join(noteRoot, "reader.pdf"), pdfBytes);
      await writeFile(path.join(noteRoot, "pdf-link.md"), "# PDF link\n\n[[reader.pdf]]\n", "utf8");
    },
  });
  const noteRoot = path.join(workspaceRoot, "notes", "test-notes");
  const pdfPath = path.join(noteRoot, "reader.pdf");
  const linkPath = path.join(noteRoot, "pdf-link.md");

  try {
    const [beforePdf, beforeLink] = await Promise.all([stat(pdfPath), stat(linkPath)]);
    await expect.poll(() => page.evaluate((filePath) => window.exograph.workspace.resolvePreviewTarget(filePath), pdfPath)).toMatchObject({ kind: "pdf" });

    await page.getByRole("button", { name: "pdf-link" }).first().click();
    await expect(page.getByTestId("editor-title")).toHaveText("pdf-link");
    const pdfLink = page.locator('[data-exograph-link-target="reader.pdf"]');
    await expect(pdfLink).toBeVisible();
    await pdfLink.click();
    await expect(page.getByTestId("pdf-document-view")).toBeVisible();
    await expect(page.getByLabel("Page 1 of 2")).toBeVisible();
    await page.screenshot({ path: "/tmp/exograph-pdf-reader-electron-proof.png" });

    const [afterPdf, afterLink] = await Promise.all([stat(pdfPath), stat(linkPath)]);
    expect(afterPdf.mtimeMs).toBe(beforePdf.mtimeMs);
    expect(afterPdf.size).toBe(beforePdf.size);
    expect(afterLink.mtimeMs).toBe(beforeLink.mtimeMs);
    expect(afterLink.size).toBe(beforeLink.size);
    await expect(access(`${pdfPath}.md`)).rejects.toThrow();
  } finally {
    await cleanup();
  }
});

test("opens a contained PDF from Explorer with reader controls and Preview-only mobility", async () => {
  const { page, workspaceRoot, cleanup } = await launchExographWorkspaceFixture({
    mutable: true,
    initialNoteLabel: null,
    prepareWorkspace: async (root) => {
      const noteRoot = path.join(root, "notes", "test-notes");
      const pdfBytes = Buffer.from((await readFile(fixturePdf, "utf8")).replaceAll(/\s/g, ""), "base64");
      await writeFile(path.join(noteRoot, "reader.pdf"), pdfBytes);
    },
  });
  const noteRoot = path.join(workspaceRoot, "notes", "test-notes");
  const pdfPath = path.join(noteRoot, "reader.pdf");

  try {
    const beforePdf = await stat(pdfPath);
    await page.getByRole("button", { name: "reader.pdf, file" }).click();
    await expect(page.getByTestId("utility-pane-preview")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("browser-pane")).toBeVisible();
    await expect(page.getByTestId("pdf-document-view")).toBeVisible();
    await expect(page.getByLabel("Page 1 of 2")).toBeVisible();
    await expect(page.getByLabel("Selectable PDF text")).toContainText("PDF fixture page one");

    await page.locator(".pdf-document-view__surface").click();
    await expect(page.getByTestId("pdf-document-view")).toBeFocused();
    await page.keyboard.press("ArrowLeft");
    await expect(page.getByLabel("Page 1 of 2")).toBeVisible();
    await page.keyboard.press("ArrowRight");
    await expect(page.getByLabel("Page 2 of 2")).toBeVisible();
    await page.keyboard.press("ArrowRight");
    await expect(page.getByLabel("Page 2 of 2")).toBeVisible();
    await page.keyboard.press("ArrowLeft");
    await expect(page.getByLabel("Page 1 of 2")).toBeVisible();

    const address = page.getByRole("textbox", { name: "Preview URL" });
    await address.focus();
    await page.keyboard.press("ArrowRight");
    await expect(page.getByLabel("Page 1 of 2")).toBeVisible();

    await page.getByRole("button", { name: "Zoom in" }).click();
    await expect(page.getByLabel("Zoom 120 percent")).toBeVisible();
    await page.getByRole("button", { name: "Next page" }).click();
    await expect(page.getByLabel("Page 2 of 2")).toBeVisible();
    await expect(page.getByLabel("Selectable PDF text")).toContainText("PDF fixture page two");
    await page.getByRole("button", { name: "Fit PDF to width" }).click();

    const previewTab = await page.getByTestId("browser-tab-preview").boundingBox();
    const editor = await page.locator(".workspace-shell__canvas .pane-leaf--editor").first().boundingBox();
    expect(previewTab).not.toBeNull();
    expect(editor).not.toBeNull();
    await drag(page, previewTab!, { x: editor!.x + editor!.width * 0.88, y: editor!.y + editor!.height / 2 });
    await expect(page.locator(".workspace-shell__canvas .pane-leaf--browser")).toHaveCount(1);
    await expect(page.getByTestId("utility-pane").getByTestId("pdf-document-view")).toHaveCount(0);

    const canvasPreviewTab = await page.locator(".workspace-shell__canvas .browser-tab").boundingBox();
    const terminalRail = await page.getByTestId("utility-pane-terminal").boundingBox();
    expect(canvasPreviewTab).not.toBeNull();
    expect(terminalRail).not.toBeNull();
    await drag(page, canvasPreviewTab!, { x: terminalRail!.x + terminalRail!.width / 2, y: terminalRail!.y + terminalRail!.height / 2 });
    await expect(page.locator(".workspace-shell__canvas .pane-leaf--browser")).toHaveCount(1);

    const previewRail = await page.getByTestId("utility-pane-preview").boundingBox();
    const canvasPreviewTabForReturn = await page.locator(".workspace-shell__canvas .browser-tab").boundingBox();
    expect(previewRail).not.toBeNull();
    expect(canvasPreviewTabForReturn).not.toBeNull();
    await drag(page, canvasPreviewTabForReturn!, { x: previewRail!.x + previewRail!.width / 2, y: previewRail!.y + previewRail!.height / 2 });
    await expect(page.locator(".workspace-shell__canvas .pane-leaf--browser")).toHaveCount(0);
    await expect(page.getByTestId("utility-pane").getByTestId("pdf-document-view")).toBeVisible();

    const afterPdf = await stat(pdfPath);
    expect(afterPdf.mtimeMs).toBe(beforePdf.mtimeMs);
    expect(afterPdf.size).toBe(beforePdf.size);
    await expect(access(`${pdfPath}.md`)).rejects.toThrow();
  } finally {
    await cleanup();
  }
});

test("renders a copied real safe PDF from an in-root attachment without mutation", async () => {
  test.skip(!realPdfPath, "Set EXOGRAPH_REAL_PDF_PATH to run the packaged real-PDF proof.");
  const sourcePdfPath = realPdfPath!;
  const sourceBefore = await stat(sourcePdfPath);
  const { page, workspaceRoot, cleanup } = await launchExographWorkspaceFixture({
    mutable: true,
    initialNoteLabel: null,
    prepareWorkspace: async (root) => {
      const noteRoot = path.join(root, "notes", "test-notes");
      await writeFile(path.join(noteRoot, "safe-real.pdf"), await readFile(sourcePdfPath));
    },
  });
  const copiedPdfPath = path.join(workspaceRoot, "notes", "test-notes", "safe-real.pdf");

  try {
    await page.getByRole("button", { name: "safe-real.pdf, file" }).click();
    await expect(page.getByTestId("pdf-document-view")).toBeVisible();
    await expect(page.getByLabel(/Page 1 of \d+/)).toBeVisible();
    await page.screenshot({ path: "/tmp/exograph-pdf-reader-packaged-real-proof.png" });

    const sourceAfter = await stat(sourcePdfPath);
    expect(sourceAfter.mtimeMs).toBe(sourceBefore.mtimeMs);
    expect(sourceAfter.size).toBe(sourceBefore.size);
  } finally {
    await cleanup();
  }
});

async function drag(page: import("@playwright/test").Page, source: { x: number; y: number; width: number; height: number }, target: { x: number; y: number }) {
  await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2);
  await page.mouse.down();
  await page.mouse.move(target.x, target.y, { steps: 8 });
  await page.mouse.up();
}
