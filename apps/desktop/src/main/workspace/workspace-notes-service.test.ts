import { access, mkdtemp, mkdir, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";

import { repositoryWorkspaceContentPolicy, type GraphTraversalResult, type WorkspaceModel } from "@exograph/core";
import type { DerivedIndexClient } from "../indexing/derived-index-process";
import { WorkspaceNotesService } from "./workspace-notes-service";

describe("WorkspaceNotesService", () => {
  it("rejects traversal outside the active scope and discards late worker results after switching", async () => {
    const model = workspaceModel("/workspace", "/workspace/notes");
    const held = deferred<GraphTraversalResult>();
    let signal: AbortSignal | undefined;
    const graphTraverse = vi.fn((_model, _runtime, _request, activeSignal) => { signal = activeSignal; return held.promise; });
    const service = new WorkspaceNotesService({ getWorkspaceModel: () => model, getRuntimeRoot: () => "/runtime", derivedIndex: { graphTraverse } as unknown as DerivedIndexClient });
    await expect(service.traverseGraph({ workspaceRoot: "/other", start: "a" })).rejects.toThrow();
    expect(graphTraverse).not.toHaveBeenCalled();
    const result = service.traverseGraph({ workspaceRoot: "/workspace", start: "a" });
    const rejection = expect(result).rejects.toThrow();
    service.activateWorkspace({ model: workspaceModel("/other", "/other/notes"), runtimeRoot: "/other-runtime", generation: 1 });
    expect(signal?.aborted).toBe(true);
    held.resolve({ schemaVersion: "exograph.graph-traversal.v1", workspace: { root: "/workspace", noteRootIds: [] }, snapshotId: "s", status: "error", code: "missing-start", message: "Missing" });
    await rejection;
  });

  it("authorizes only existing files inside the active wiki for operator opens", async () => {
    const { service, noteRoot } = await workspaceNotesService();
    const notePath = path.join(noteRoot, "opened.md");
    const outsidePath = path.join(path.dirname(noteRoot), "outside.md");
    await writeFile(notePath, "# Opened\n", "utf8");
    await writeFile(outsidePath, "# Outside\n", "utf8");

    await expect(service.authorizeOpenFile(notePath)).resolves.toBe(notePath);
    await expect(service.authorizeOpenFile(outsidePath)).rejects.toThrow("outside configured note roots");
    await expect(service.authorizeOpenFile(noteRoot)).rejects.toThrow("only open an existing file");
  });

  it("authorizes exact existing folders for operator reveal without weakening file-only opens", async () => {
    const { service, noteRoot } = await workspaceNotesService();
    const folderPath = path.join(noteRoot, "project");
    await mkdir(folderPath);

    await expect(service.authorizeOpenPath(folderPath)).resolves.toEqual({ path: folderPath, kind: "directory" });
    await expect(service.authorizeOpenFile(folderPath)).rejects.toThrow("only open an existing file");
  });

  it("searches body and frontmatter tags across note roots", async () => {
    const { service, noteRoot } = await workspaceNotesService();
    await writeFile(path.join(noteRoot, "focus.md"), "---\ntags: [research]\n---\n# Focus\n\n#daily\n", "utf8");
    await writeFile(path.join(noteRoot, "other.md"), "# Other\n\nNo match.\n", "utf8");

    await expect(service.searchTag("#research")).resolves.toEqual([
      expect.objectContaining({ title: "Focus", snippet: "#research", kind: "tag" }),
    ]);
    await expect(service.searchTag("daily")).resolves.toEqual([
      expect.objectContaining({ title: "Focus", snippet: "#daily", kind: "tag" }),
    ]);
  });

  it("keeps policy-excluded Markdown out of Workspace search and link suggestions", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "exograph-notes-policy-"));
    const noteRoot = path.join(workspaceRoot, "notes");
    await mkdir(path.join(noteRoot, "release"), { recursive: true });
    const sourcePath = path.join(noteRoot, "source.md");
    await writeFile(sourcePath, "# Source\n", "utf8");
    await writeFile(
      path.join(noteRoot, "release", "generated.md"),
      "---\ntags: [generated]\n---\n# Generated\n",
      "utf8",
    );
    const model: WorkspaceModel = {
      ...workspaceModel(workspaceRoot, noteRoot),
      contentPolicy: repositoryWorkspaceContentPolicy(),
    };
    const service = new WorkspaceNotesService({ getWorkspaceModel: () => model });

    await expect(service.searchFilenames("generated")).resolves.toEqual({ notes: [], tags: [] });
    await expect(service.searchTag("generated")).resolves.toEqual([]);
    await expect(service.suggestTargets(sourcePath, "generated")).resolves.toEqual([]);

    await rm(workspaceRoot, { recursive: true, force: true });
  });

  it("drops warmed filename results immediately when Content Policy changes in place", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "exograph-notes-policy-cache-"));
    const noteRoot = path.join(workspaceRoot, "notes");
    await mkdir(path.join(noteRoot, "release"), { recursive: true });
    const generatedPath = path.join(noteRoot, "release", "generated.md");
    await writeFile(generatedPath, "# Generated\n", "utf8");
    const model = workspaceModel(workspaceRoot, noteRoot);
    const service = new WorkspaceNotesService({ getWorkspaceModel: () => model });

    await expect(service.searchFilenames("generated")).resolves.toMatchObject({
      notes: [{ filePath: generatedPath }],
    });

    service.applyWorkspaceModel({
      ...model,
      contentPolicy: repositoryWorkspaceContentPolicy(),
    });

    await expect(service.searchFilenames("generated")).resolves.toEqual({ notes: [], tags: [] });
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  it("resolves relative targets before falling back to note basename search", async () => {
    const { service, noteRoot } = await workspaceNotesService();
    const sourcePath = path.join(noteRoot, "folder", "source.md");
    const relativeTarget = path.join(noteRoot, "folder", "target.md");
    const basenameTarget = path.join(noteRoot, "elsewhere.md");
    await writeFile(sourcePath, "# Source\n", "utf8");
    await writeFile(relativeTarget, "# Target\n", "utf8");
    await writeFile(basenameTarget, "# Elsewhere\n", "utf8");

    await expect(service.resolveTarget(sourcePath, "target")).resolves.toBe(relativeTarget);
    await expect(service.resolveTarget(sourcePath, "elsewhere")).resolves.toBe(basenameTarget);
    await expect(service.resolveTarget(sourcePath, "https://example.com")).resolves.toBeNull();
  });

  it("resolves an existing in-root PDF exactly without creating a Markdown target", async () => {
    const { service, noteRoot } = await workspaceNotesService();
    const sourcePath = path.join(noteRoot, "folder", "source.md");
    const pdfPath = path.join(noteRoot, "folder", "report.pdf");
    await writeFile(sourcePath, "# Source\n\n[[report.pdf]]\n", "utf8");
    await writeFile(pdfPath, "%PDF-1.4\nfixture", "utf8");

    await expect(service.resolveTarget(sourcePath, "report.pdf")).resolves.toBe(pdfPath);
    await expect(service.ensureTarget(sourcePath, "report.pdf")).resolves.toBe(pdfPath);
    await expect(access(path.join(noteRoot, "folder", "report.pdf.md"))).rejects.toThrow();
  });

  it("never creates a missing PDF link target", async () => {
    const { service, noteRoot } = await workspaceNotesService();
    const sourcePath = path.join(noteRoot, "folder", "source.md");
    const missingPdf = path.join(noteRoot, "folder", "missing.pdf");
    await writeFile(sourcePath, "# Source\n\n[[missing.pdf]]\n", "utf8");

    await expect(service.ensureTarget(sourcePath, "missing.pdf")).rejects.toThrow("must be an existing file");
    await expect(access(missingPdf)).rejects.toThrow();
    await expect(access(`${missingPdf}.md`)).rejects.toThrow();
  });

  it("creates missing wiki targets next to the source note by default", async () => {
    const { service, noteRoot } = await workspaceNotesService();
    const sourcePath = path.join(noteRoot, "folder", "source.md");
    await writeFile(sourcePath, "# Source\n", "utf8");

    const createdPath = await service.ensureTarget(sourcePath, "new target");

    expect(createdPath).toBe(path.join(noteRoot, "folder", "new target.md"));
    await expect(readFile(createdPath, "utf8")).resolves.toMatch(/^---\ndate: \d{4}-\d{2}-\d{2}\ntags: \[\]\n---\n\n# new target\n$/);
  });

  it("creates ISO daily-note targets at the source Note Root", async () => {
    const { service, noteRoot } = await workspaceNotesService();
    const sourcePath = path.join(noteRoot, "folder", "source.md");
    await writeFile(sourcePath, "# Source\n", "utf8");

    const createdPath = await service.ensureTarget(sourcePath, "2026-07-22");

    expect(createdPath).toBe(path.join(noteRoot, "2026-07-22.md"));
    await expect(readFile(createdPath, "utf8")).resolves.toContain("# 2026-07-22");
  });

  it("rejects wiki targets that traverse outside the source note root", async () => {
    const { service, noteRoot } = await workspaceNotesService();
    const sourcePath = path.join(noteRoot, "folder", "source.md");
    const outsidePath = path.join(path.dirname(noteRoot), "outside.md");
    await writeFile(sourcePath, "# Source\n", "utf8");
    await writeFile(outsidePath, "# Outside\n", "utf8");

    await expect(service.resolveTarget(sourcePath, "../../outside")).rejects.toThrow(
      "outside configured note roots",
    );
  });

  it("resolves contained relative Markdown images without granting renderer path access", async () => {
    const { service, noteRoot } = await workspaceNotesService();
    const sourcePath = path.join(noteRoot, "folder", "source.md");
    const imagePath = path.join(noteRoot, "folder", "attachments", "chart one.png");
    await mkdir(path.dirname(imagePath), { recursive: true });
    await writeFile(sourcePath, "# Source\n", "utf8");
    await writeFile(imagePath, "not a real png", "utf8");

    const imageUrl = pathToFileURL(await realpath(imagePath)).toString();
    await expect(service.resolveMarkdownImage(sourcePath, "attachments/chart%20one.png")).resolves.toEqual({
      url: imageUrl,
    });
    await expect(service.resolveMarkdownImage(sourcePath, "/folder/attachments/chart one.png")).resolves.toEqual({
      url: imageUrl,
    });
  });

  it("resolves an Obsidian image embed by filename inside the source note root", async () => {
    const { service, noteRoot } = await workspaceNotesService();
    const sourcePath = path.join(noteRoot, "docs", "configuration.md");
    const imagePath = path.join(noteRoot, "docs", "images", "quartz transform pipeline.png");
    await mkdir(path.dirname(imagePath), { recursive: true });
    await writeFile(sourcePath, "# Configuration\n", "utf8");
    await writeFile(imagePath, "not a real png", "utf8");

    await expect(service.resolveMarkdownImage(sourcePath, "quartz transform pipeline.png", true)).resolves.toEqual({
      url: pathToFileURL(await realpath(imagePath)).toString(),
    });
  });

  it("resolves a site-root image from the nearest matching content ancestor", async () => {
    const { service, noteRoot } = await workspaceNotesService();
    const siteRoot = path.join(noteRoot, "kenneth-dot-computer", "garden");
    const sourcePath = path.join(siteRoot, "blog", "self-improving-business-systems.md");
    const imagePath = path.join(siteRoot, "images", "posts", "self-improving-business-systems", "loop-stack.png");
    await mkdir(path.dirname(sourcePath), { recursive: true });
    await mkdir(path.dirname(imagePath), { recursive: true });
    await writeFile(sourcePath, "# Self-Improving Business Systems\n", "utf8");
    await writeFile(imagePath, "not a real png", "utf8");

    await expect(
      service.resolveMarkdownImage(
        sourcePath,
        "/images/posts/self-improving-business-systems/loop-stack.png",
      ),
    ).resolves.toEqual({ url: pathToFileURL(await realpath(imagePath)).toString() });
  });

  it("prefers the nearest regular root-relative image and decodes its filename", async () => {
    const { service, noteRoot } = await workspaceNotesService();
    const siteRoot = path.join(noteRoot, "site");
    const sourcePath = path.join(siteRoot, "blog", "source.md");
    const siteImagePath = path.join(siteRoot, "images", "chart one.png");
    const noteRootImagePath = path.join(noteRoot, "images", "chart one.png");
    await mkdir(path.dirname(sourcePath), { recursive: true });
    await mkdir(path.dirname(siteImagePath), { recursive: true });
    await mkdir(path.dirname(noteRootImagePath), { recursive: true });
    await writeFile(sourcePath, "# Source\n", "utf8");
    await writeFile(siteImagePath, "nearest", "utf8");
    await writeFile(noteRootImagePath, "fallback", "utf8");

    await expect(service.resolveMarkdownImage(sourcePath, "/images/chart%20one.png")).resolves.toEqual({
      url: pathToFileURL(await realpath(siteImagePath)).toString(),
    });
  });

  it("skips a matching directory while searching for a root-relative regular file", async () => {
    const { service, noteRoot } = await workspaceNotesService();
    const siteRoot = path.join(noteRoot, "site");
    const sourcePath = path.join(siteRoot, "blog", "source.md");
    const directoryCandidate = path.join(siteRoot, "images", "diagram.png");
    const fileCandidate = path.join(noteRoot, "images", "diagram.png");
    await mkdir(path.dirname(sourcePath), { recursive: true });
    await mkdir(directoryCandidate, { recursive: true });
    await mkdir(path.dirname(fileCandidate), { recursive: true });
    await writeFile(sourcePath, "# Source\n", "utf8");
    await writeFile(fileCandidate, "fallback", "utf8");

    await expect(service.resolveMarkdownImage(sourcePath, "/images/diagram.png")).resolves.toEqual({
      url: pathToFileURL(await realpath(fileCandidate)).toString(),
    });
  });

  it("rejects escaped, remote, and missing Markdown image targets", async () => {
    const { service, noteRoot } = await workspaceNotesService();
    const sourcePath = path.join(noteRoot, "folder", "source.md");
    await writeFile(sourcePath, "# Source\n", "utf8");

    await expect(service.resolveMarkdownImage(sourcePath, "../../outside.png")).rejects.toThrow("outside configured note roots");
    await expect(service.resolveMarkdownImage(sourcePath, "/../../outside.png")).rejects.toThrow("outside configured note roots");
    await expect(service.resolveMarkdownImage(sourcePath, "file:///outside.png")).rejects.toThrow("not enabled");
    await expect(service.resolveMarkdownImage(sourcePath, "https://example.com/image.png")).rejects.toThrow("not enabled");
    await expect(service.resolveMarkdownImage(sourcePath, "missing.png")).rejects.toThrow();
  });

  it("rejects a Markdown image that escapes through an in-root symlink", async () => {
    const { service, noteRoot } = await workspaceNotesService();
    const sourcePath = path.join(noteRoot, "folder", "source.md");
    const outsideDirectory = path.join(path.dirname(noteRoot), "outside-images");
    await writeFile(sourcePath, "# Source\n", "utf8");
    await mkdir(outsideDirectory);
    await writeFile(path.join(outsideDirectory, "secret.png"), "outside", "utf8");
    await symlink(outsideDirectory, path.join(noteRoot, "folder", "attachments"));

    await expect(service.resolveMarkdownImage(sourcePath, "attachments/secret.png")).rejects.toThrow("outside configured note roots");
    await expect(service.resolveMarkdownImage(sourcePath, "/folder/attachments/secret.png")).rejects.toThrow("outside configured note roots");
  });

  it("creates a missing absolute wiki target at its requested in-root path", async () => {
    const { service, noteRoot } = await workspaceNotesService();
    const sourcePath = path.join(noteRoot, "folder", "source.md");
    const targetPath = path.join(noteRoot, "elsewhere", "absolute.md");
    await writeFile(sourcePath, "# Source\n", "utf8");

    const createdPath = await service.ensureTarget(sourcePath, targetPath);

    expect(createdPath).toBe(targetPath);
    await expect(readFile(targetPath, "utf8")).resolves.toMatch(/^---\ndate: \d{4}-\d{2}-\d{2}\ntags: \[\]\n---\n\n# absolute\n$/);
  });

  it("suggests exact target matches before partial matches", async () => {
    const { service, noteRoot } = await workspaceNotesService();
    const sourcePath = path.join(noteRoot, "source.md");
    await writeFile(sourcePath, "# Source\n", "utf8");
    await writeFile(path.join(noteRoot, "agent.md"), "# Agent\n", "utf8");
    await writeFile(path.join(noteRoot, "agent-notes.md"), "# Agent Notes\n", "utf8");

    const suggestions = await service.suggestTargets(sourcePath, "agent");

    expect(suggestions.map((suggestion) => suggestion.target)).toEqual(["agent", "agent-notes"]);
  });

  it("suggests one source-relative target without duplicating the Note Root", async () => {
    const { service, noteRoot } = await workspaceNotesService();
    const sourcePath = path.join(noteRoot, "folder", "source.md");
    const targetPath = path.join(noteRoot, "some-item.md");
    await writeFile(sourcePath, "# Source\n", "utf8");
    await writeFile(targetPath, "# Some Item\n", "utf8");

    const [suggestion] = await service.suggestTargets(sourcePath, "some");

    expect(suggestion).toMatchObject({
      filePath: targetPath,
      title: "some-item",
      target: "../some-item",
      snippet: "some-item",
    });
    expect(suggestion?.target).not.toMatch(/\/\//);
    await expect(service.resolveTarget(sourcePath, suggestion!.target)).resolves.toBe(targetPath);
  });

  it("keeps cross-Root suggestions resolvable from the source Note", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "exograph-cross-root-suggestion-"));
    const sourceRoot = path.join(workspaceRoot, "source-notes");
    const targetRoot = path.join(workspaceRoot, "research-notes");
    await mkdir(path.join(sourceRoot, "nested"), { recursive: true });
    await mkdir(targetRoot, { recursive: true });
    const sourcePath = path.join(sourceRoot, "nested", "source.md");
    const targetPath = path.join(targetRoot, "finding.md");
    await writeFile(sourcePath, "# Source\n", "utf8");
    await writeFile(targetPath, "# Finding\n", "utf8");
    const model: WorkspaceModel = {
      workspaceRoot,
      defaultTerminalCwd: workspaceRoot,
      noteRoots: [
        { id: "source", label: "Source", path: sourceRoot },
        { id: "research", label: "Research", path: targetRoot },
      ],
      indexedRoots: [],
      indexing: { enabled: false, mode: "off", backend: "qmd" },
    };
    const service = new WorkspaceNotesService({ getWorkspaceModel: () => model });

    try {
      const [suggestion] = await service.suggestTargets(sourcePath, "finding");
      expect(suggestion?.target).toBe("../../research-notes/finding");
      await expect(service.resolveTarget(sourcePath, suggestion!.target)).resolves.toBe(targetPath);
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("reads folder overviews without creating an index and hides index.md from children", async () => {
    const { service, noteRoot } = await workspaceNotesService();
    const folderPath = path.join(noteRoot, "projects");
    await mkdir(path.join(folderPath, "nested"), { recursive: true });
    await writeFile(path.join(folderPath, "index.md"), "---\ntags: [active]\n---\n# Projects\n", "utf8");
    await writeFile(path.join(folderPath, "alpha.md"), "# Alpha\n", "utf8");

    const indexed = await service.getFolderOverview(folderPath);

    expect(indexed).toMatchObject({
      directoryPath: folderPath,
      indexPath: path.join(folderPath, "index.md"),
      title: "Projects",
      frontmatter: { tags: ["active"] },
      indexExists: true,
      children: [
        { name: "nested", kind: "directory" },
        { name: "alpha.md", kind: "file" },
      ],
    });
    expect(indexed.children.map((entry) => entry.name)).not.toContain("index.md");

    const emptyFolder = path.join(noteRoot, "empty");
    await mkdir(emptyFolder);
    const unindexed = await service.getFolderOverview(emptyFolder);
    expect(unindexed).toMatchObject({ indexExists: false, title: "empty", children: [] });
    await expect(access(path.join(emptyFolder, "index.md"))).rejects.toThrow();

    await expect(service.ensureFolderIndex(emptyFolder)).resolves.toMatchObject({ created: true });
    await expect(service.getFolderOverview(emptyFolder)).resolves.toMatchObject({
      indexExists: true,
      title: "empty",
      children: [],
    });
  });

  it("invalidates cached folder and graph data after workspace changes", async () => {
    const { service, noteRoot } = await workspaceNotesService();
    const folderPath = path.join(noteRoot, "projects");
    const indexPath = path.join(folderPath, "index.md");
    await mkdir(folderPath, { recursive: true });
    await writeFile(indexPath, "# Projects\n", "utf8");

    const initialOverview = await service.getFolderOverview(folderPath);
    const initialGraph = await service.getGraphContext(indexPath);
    expect(initialOverview.children).toEqual([]);
    expect(initialGraph?.backlinks).toEqual([]);

    const backlinkPath = path.join(folderPath, "backlink.md");
    await writeFile(backlinkPath, "# Backlink\n\n[[index]]\n", "utf8");
    await service.handleWorkspaceChange({ rootPath: noteRoot, eventType: "rename", filePath: backlinkPath });

    const refreshedOverview = await service.getFolderOverview(folderPath);
    const refreshedGraph = await service.getGraphContext(indexPath);
    expect(refreshedOverview.children).toEqual([
      { path: backlinkPath, name: "backlink.md", kind: "file" },
    ]);
    expect(refreshedGraph?.backlinks.map((link) => link.target)).toEqual([backlinkPath]);
  });

  it("does not let a held graph refresh from A mutate the replacement Workspace", async () => {
    const workspaceA = await mkdtemp(path.join(os.tmpdir(), "exograph-notes-a-"));
    const workspaceB = await mkdtemp(path.join(os.tmpdir(), "exograph-notes-b-"));
    const noteA = path.join(workspaceA, "notes");
    const noteB = path.join(workspaceB, "notes");
    await Promise.all([mkdir(noteA), mkdir(noteB)]);
    const sourceA = path.join(noteA, "source.md");
    await writeFile(sourceA, "# A\n");
    const held = deferred<void>();
    let observedSignal: AbortSignal | undefined;
    const graphRefresh = vi.fn((_model: WorkspaceModel, _runtimeRoot: string, _filePath: string, signal?: AbortSignal) => {
      observedSignal = signal;
      return held.promise;
    });
    const derivedIndex = { graphRefresh, graphInvalidate: vi.fn().mockResolvedValue(undefined) } as unknown as DerivedIndexClient;
    const modelA = workspaceModel(workspaceA, noteA);
    const modelB = workspaceModel(workspaceB, noteB);
    const service = new WorkspaceNotesService({
      getWorkspaceModel: () => modelA,
      getRuntimeRoot: () => path.join(workspaceA, ".exograph"),
      derivedIndex,
    });

    const staleRefresh = service.handleWorkspaceChange({ rootPath: noteA, eventType: "change", filePath: sourceA });
    await Promise.resolve();
    service.activateWorkspace({ model: modelB, runtimeRoot: path.join(workspaceB, ".exograph"), generation: 1 });
    expect(observedSignal?.aborted).toBe(true);
    held.resolve();
    await staleRefresh;

    expect(graphRefresh).toHaveBeenCalledTimes(1);
    expect(graphRefresh).toHaveBeenLastCalledWith(modelA, path.join(workspaceA, ".exograph"), sourceA, expect.anything());
    await Promise.all([rm(workspaceA, { recursive: true, force: true }), rm(workspaceB, { recursive: true, force: true })]);
  });

  it("publishes non-authority model changes without replacing the graph client", async () => {
    const model = workspaceModel("/workspace", "/workspace/notes");
    const nextModel: WorkspaceModel = {
      ...model,
      indexing: { enabled: true, mode: "hybrid", backend: "qmd" },
      searchEngine: "qmd",
    };
    const graphTopology = vi.fn().mockRejectedValue(new Error("observed model"));
    const dispose = vi.fn();
    const service = new WorkspaceNotesService({
      getWorkspaceModel: () => model,
      getRuntimeRoot: () => "/workspace/.exograph",
      derivedIndex: { graphTopology, dispose } as unknown as DerivedIndexClient,
    });

    service.applyWorkspaceModel(nextModel);

    await expect(service.getGraphTopology()).rejects.toThrow("observed model");
    expect(graphTopology).toHaveBeenCalledWith(nextModel, "/workspace/.exograph", expect.anything());
    expect(dispose).not.toHaveBeenCalled();
  });

  it("authorizes and case-preserves graph concept file lookup within note roots", async () => {
    const { service, noteRoot } = await workspaceNotesService();
    const folder = path.join(noteRoot, "CasePreserved");
    await mkdir(folder, { recursive: true });
    const focusPath = path.join(folder, "Focus.md");
    await writeFile(focusPath, "# Focus\n", "utf8");
    const topology = await service.getGraphTopology();

    await expect(service.graphConceptLookup(
      { filePath: path.join(folder, "..", "CasePreserved", "Focus.md") },
      topology.sourceSnapshotId,
    )).resolves.toMatchObject({
      status: "ok",
      summary: { label: "Focus", filePath: focusPath },
    });
  });

  it("denies invalid and outside-root graph concept file lookup before graph dispatch", async () => {
    const { service, noteRoot } = await workspaceNotesService();
    const focusPath = path.join(noteRoot, "focus.md");
    const outsidePath = path.join(path.dirname(noteRoot), "outside.md");
    await writeFile(focusPath, "# Focus\n", "utf8");
    await writeFile(outsidePath, "# Outside\n", "utf8");
    const topology = await service.getGraphTopology();

    await expect(service.graphConceptLookup({ filePath: outsidePath }, topology.sourceSnapshotId))
      .rejects.toThrow("outside configured note roots");
    await expect(service.graphConceptLookup({} as never, topology.sourceSnapshotId)).rejects.toThrow("exactly one");
    await expect(service.graphConceptLookup({ conceptId: "note:x", filePath: focusPath } as never, topology.sourceSnapshotId))
      .rejects.toThrow("exactly one");
  });

  it("applies create, change, delete, and rename watcher events to a ready graph", async () => {
    const { service, noteRoot } = await workspaceNotesService();
    const focusPath = path.join(noteRoot, "focus.md");
    const oldPath = path.join(noteRoot, "old.md");
    const renamedPath = path.join(noteRoot, "renamed.md");
    await writeFile(focusPath, "# Focus\n", "utf8");
    await writeFile(oldPath, "# Old\n\n[[focus]]\n", "utf8");
    expect((await service.getGraphContext(focusPath))?.backlinks.map((link) => link.target)).toEqual([oldPath]);

    await writeFile(oldPath, "# Old\n", "utf8");
    await service.handleWorkspaceChange({ rootPath: noteRoot, eventType: "change", filePath: oldPath });
    expect((await service.getGraphContext(focusPath))?.backlinks).toEqual([]);

    await writeFile(oldPath, "# Old\n\n[[focus]]\n", "utf8");
    await rename(oldPath, renamedPath);
    await service.handleWorkspaceChange({ rootPath: noteRoot, eventType: "rename", filePath: oldPath });
    await service.handleWorkspaceChange({ rootPath: noteRoot, eventType: "rename", filePath: renamedPath });
    expect((await service.getGraphContext(focusPath))?.backlinks.map((link) => link.target)).toEqual([renamedPath]);

    await rm(renamedPath);
    await service.handleWorkspaceChange({ rootPath: noteRoot, eventType: "rename", filePath: renamedPath });
    expect((await service.getGraphContext(focusPath))?.backlinks).toEqual([]);
  });

  it("emits one graph change only after a successful reviewed Ontology Keep", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "exograph-notes-ontology-review-"));
    const noteRoot = path.join(workspaceRoot, "notes");
    await mkdir(noteRoot, { recursive: true });
    await writeFile(path.join(noteRoot, "focus.md"), "---\ntype: paper\n---\n# Focus\n");
    await writeFile(path.join(workspaceRoot, "ontology.yaml"), "ontology_schema: 1\nid: research\nversion: 1\ntypes:\n  paper: {}\n");
    const model: WorkspaceModel = {
      workspaceRoot,
      defaultTerminalCwd: workspaceRoot,
      noteRoots: [{ id: "notes", label: "Notes", path: noteRoot }],
      indexedRoots: [],
      indexing: { enabled: false, mode: "off", backend: "qmd" },
    };
    let graphChanged = 0;
    const service = new WorkspaceNotesService({
      getWorkspaceModel: () => model,
      getRuntimeRoot: () => path.join(workspaceRoot, ".exograph-test"),
      onGraphChanged: () => { graphChanged += 1; },
    });

    const preview = await service.previewOntology();
    expect(graphChanged).toBe(0);
    expect((await service.keepOntology(preview.guard)).status).toBe("applied");
    expect(graphChanged).toBe(1);
    expect((await service.keepOntology(preview.guard)).status).toBe("stale");
    expect(graphChanged).toBe(1);
    await writeFile(path.join(workspaceRoot, "ontology.yaml"), "ontology_schema: 1\nid: replacement\nversion: 2\n");
    const rejectedPreview = await service.previewOntology();
    expect((await service.rejectOntology(rejectedPreview.guard)).status).toBe("rejected");
    expect(graphChanged).toBe(1);
    await rm(workspaceRoot, { recursive: true, force: true });
  });
});

async function workspaceNotesService() {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "exograph-notes-service-"));
  const noteRoot = path.join(workspaceRoot, "notes");
  await mkdir(path.join(noteRoot, "folder"), { recursive: true });
  const model: WorkspaceModel = {
    workspaceRoot,
    defaultTerminalCwd: workspaceRoot,
    noteRoots: [{ id: "note-root-1", label: "notes", path: noteRoot }],
    indexedRoots: [],
    indexing: { enabled: false, mode: "off", backend: "qmd" },
  };
  return {
    noteRoot,
    service: new WorkspaceNotesService({ getWorkspaceModel: () => model }),
  };
}

function workspaceModel(workspaceRoot: string, noteRoot: string): WorkspaceModel {
  return {
    workspaceRoot,
    defaultTerminalCwd: workspaceRoot,
    noteRoots: [{ id: "notes", label: "notes", path: noteRoot }],
    indexedRoots: [],
    indexing: { enabled: false, mode: "off", backend: "qmd" },
  };
}

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((nextResolve) => { resolve = nextResolve; });
  return { promise, resolve };
}
