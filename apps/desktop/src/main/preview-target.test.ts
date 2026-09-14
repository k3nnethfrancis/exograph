import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import type { WorkspaceSettings } from "@exograph/core";
import { readPdfFile, resolvePreviewTarget } from "./preview-target";

const tempPaths: string[] = [];

afterEach(async () => {
  await Promise.all(tempPaths.splice(0).map((target) => rm(target, { recursive: true, force: true })));
});

describe("resolvePreviewTarget", () => {
  it("turns absolute local HTML paths inside Note Roots into file URLs", async () => {
    const fixture = await previewFixture();
    const target = path.join(fixture.noteRoot, "artifacts", "preview.html");

    await expect(resolvePreviewTarget(target, fixture.settings)).resolves.toEqual({
      ok: true,
      url: pathToFileURL(await realpath(target)).toString(),
      source: "file",
      kind: "html",
    });
  });

  it("turns workspace-relative local HTML paths into file URLs", async () => {
    const fixture = await previewFixture();
    const relativeTarget = "notes/artifacts/preview.html";
    const absoluteTarget = path.join(fixture.workspaceRoot, relativeTarget);

    await expect(resolvePreviewTarget(relativeTarget, fixture.settings)).resolves.toEqual({
      ok: true,
      url: pathToFileURL(await realpath(absoluteTarget)).toString(),
      source: "file",
      kind: "html",
    });
  });

  it("validates file URLs through the same local preview path rules", async () => {
    const fixture = await previewFixture();
    const target = path.join(fixture.noteRoot, "artifacts", "preview.html");

    await expect(resolvePreviewTarget(pathToFileURL(target).toString(), fixture.settings)).resolves.toEqual({
      ok: true,
      url: pathToFileURL(await realpath(target)).toString(),
      source: "file",
      kind: "html",
    });
  });

  it("passes through localhost http and https URLs", async () => {
    const fixture = await previewFixture();

    await expect(resolvePreviewTarget("https://localhost:4443/report.html", fixture.settings)).resolves.toEqual({
      ok: true,
      url: "https://localhost:4443/report.html",
      source: "url",
      kind: "web",
    });
    await expect(resolvePreviewTarget("http://127.0.0.1:5173/report.html", fixture.settings)).resolves.toEqual({
      ok: true,
      url: "http://127.0.0.1:5173/report.html",
      source: "url",
      kind: "web",
    });
  });

  it("normalizes bare localhost targets to http URLs", async () => {
    const fixture = await previewFixture();

    await expect(resolvePreviewTarget("localhost:4321", fixture.settings)).resolves.toEqual({
      ok: true,
      url: "http://localhost:4321/",
      source: "url",
      kind: "web",
    });
    await expect(resolvePreviewTarget("127.0.0.1:5173/report.html", fixture.settings)).resolves.toEqual({
      ok: true,
      url: "http://127.0.0.1:5173/report.html",
      source: "url",
      kind: "web",
    });
  });

  it("rejects remote web URLs in trusted-only V1 preview mode", async () => {
    const fixture = await previewFixture();

    await expect(resolvePreviewTarget("https://example.com/report.html", fixture.settings)).rejects.toThrow(
      "Preview URLs are limited to localhost or local files in V1.",
    );
  });

  it("rejects javascript and data URLs", async () => {
    const fixture = await previewFixture();

    await expect(resolvePreviewTarget("javascript:alert(1)", fixture.settings)).rejects.toThrow(
      "Preview URL must use http, https, or file.",
    );
    await expect(resolvePreviewTarget("data:text/html,hello", fixture.settings)).rejects.toThrow(
      "Preview URL must use http, https, or file.",
    );
  });

  it("rejects local files outside configured roots", async () => {
    const fixture = await previewFixture();
    const outsideRoot = await mkdtemp(path.join(os.tmpdir(), "exograph-preview-outside-"));
    tempPaths.push(outsideRoot);
    const target = path.join(outsideRoot, "report.html");
    await writeFile(target, "<!doctype html><title>Outside</title>", "utf8");

    await expect(resolvePreviewTarget(target, fixture.settings)).rejects.toThrow(
      "Local preview files must be inside a configured Note Root.",
    );
  });

  it("rejects a local preview that escapes through an in-root symlink", async () => {
    const fixture = await previewFixture();
    const outsideRoot = await mkdtemp(path.join(os.tmpdir(), "exograph-preview-symlink-outside-"));
    tempPaths.push(outsideRoot);
    const outsideTarget = path.join(outsideRoot, "report.html");
    const linkedTarget = path.join(fixture.noteRoot, "artifacts", "linked-report.html");
    await writeFile(outsideTarget, "<!doctype html><title>Outside</title>", "utf8");
    await symlink(outsideTarget, linkedTarget);

    await expect(resolvePreviewTarget(linkedTarget, fixture.settings)).rejects.toThrow(
      "Local preview files must be inside a configured Note Root.",
    );
  });

  it("returns the canonical URL for an in-root preview symlink", async () => {
    const fixture = await previewFixture();
    const target = path.join(fixture.noteRoot, "artifacts", "preview.html");
    const linkedTarget = path.join(fixture.noteRoot, "artifacts", "linked-preview.html");
    await symlink(target, linkedTarget);

    await expect(resolvePreviewTarget(linkedTarget, fixture.settings)).resolves.toEqual({
      ok: true,
      url: pathToFileURL(await realpath(target)).toString(),
      source: "file",
      kind: "html",
    });
  });

  it("fails closed for a path that was formerly a Project Root", async () => {
    const fixture = await previewFixture();
    const target = path.join(fixture.projectRoot, "docs", "artifacts", "core-plugin-boundary.html");

    await expect(resolvePreviewTarget(target, fixture.settings)).rejects.toThrow(
      "Local preview files must be inside a configured Note Root.",
    );
  });

  it("classifies an in-root PDF explicitly and reads its bytes only after re-authorizing it", async () => {
    const fixture = await previewFixture();
    const target = path.join(fixture.noteRoot, "artifacts", "reader.pdf");
    await writeFile(target, "%PDF-1.4\nfixture", "utf8");

    await expect(resolvePreviewTarget(target, fixture.settings)).resolves.toEqual({
      ok: true,
      url: pathToFileURL(await realpath(target)).toString(),
      source: "file",
      kind: "pdf",
      filePath: target,
    });
    await expect(readPdfFile(target, fixture.settings)).resolves.toEqual(new Uint8Array(Buffer.from("%PDF-1.4\nfixture")).buffer);
  });

  it("rejects PDF reads outside a Note Root and through a symlink escape", async () => {
    const fixture = await previewFixture();
    const outsideRoot = await mkdtemp(path.join(os.tmpdir(), "exograph-pdf-outside-"));
    tempPaths.push(outsideRoot);
    const outsidePdf = path.join(outsideRoot, "outside.pdf");
    const escapedPdf = path.join(fixture.noteRoot, "artifacts", "escaped.pdf");
    await writeFile(outsidePdf, "%PDF-1.4\noutside", "utf8");
    await symlink(outsidePdf, escapedPdf);

    await expect(readPdfFile(outsidePdf, fixture.settings)).rejects.toThrow("Local PDF files must be inside a configured Note Root.");
    await expect(readPdfFile(escapedPdf, fixture.settings)).rejects.toThrow("Local PDF files must be inside a configured Note Root.");
  });
});

async function previewFixture(): Promise<{
  workspaceRoot: string;
  noteRoot: string;
  projectRoot: string;
  settings: WorkspaceSettings;
}> {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "exograph-preview-workspace-"));
  tempPaths.push(workspaceRoot);

  const noteRoot = path.join(workspaceRoot, "notes");
  const projectRoot = path.join(workspaceRoot, "projects", "exograph");
  const artifactRoot = path.join(projectRoot, "docs", "artifacts");
  await mkdir(noteRoot, { recursive: true });
  await mkdir(path.join(noteRoot, "artifacts"), { recursive: true });
  await mkdir(artifactRoot, { recursive: true });
  await writeFile(
    path.join(artifactRoot, "core-plugin-boundary.html"),
    "<!doctype html><title>Core Plugin Boundary</title>",
    "utf8",
  );
  await writeFile(path.join(noteRoot, "artifacts", "preview.html"), "<!doctype html><title>Preview</title>", "utf8");

  return {
    workspaceRoot,
    noteRoot,
    projectRoot,
    settings: {
      workspaceRoot,
      defaultTerminalCwd: workspaceRoot,
      noteRoots: [noteRoot],
      indexedRoots: [],
      indexing: { enabled: false, mode: "lexical", backend: "qmd" },
      appearanceMode: "system",
      colorThemeId: "exograph-neutral",
      editorFontSize: 15,
      terminalFontSize: 13,
      explorerScale: 1,
      graphInverseNavigation: true,
      graphShowOverflowLabels: true,
      exploreIndexSearchOnEnter: false,
      indexUpdateStrategy: "manual",
    },
  };
}
