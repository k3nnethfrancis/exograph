import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { createWorkspaceFile, listMarkdownFiles, listRootTree, renameWorkspacePath, resolveNotePath, resolveWorkspaceModel, searchNotes, searchWorkspace } from "../workspace";
import { repositoryWorkspaceContentPolicy } from "../workspace-content-policy";

const fixtureWorkspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../fixtures/test-workspace");

describe("workspace", () => {
  it("initializes new Markdown files with core metadata and an editable H1", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "exograph-workspace-"));
    const target = path.join(root, "new-note.md");
    try {
      await createWorkspaceFile(target);
      await expect(readFile(target, "utf8")).resolves.toMatch(/^---\ndate: \d{4}-\d{2}-\d{2}\ntags: \[\]\n---\n\n# new-note\n$/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses to overwrite an existing workspace file", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "exograph-workspace-"));
    const target = path.join(root, "existing.md");
    try {
      await writeFile(target, "# Keep this\n", "utf8");
      await expect(createWorkspaceFile(target)).rejects.toThrow(`Destination already exists: ${target}`);
      await expect(readFile(target, "utf8")).resolves.toBe("# Keep this\n");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("allows exactly one concurrent create and preserves that writer's complete content", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "exograph-workspace-"));
    const target = path.join(root, "new-folder", "shared.md");
    const contents = ["first writer\n".repeat(1_000), "second writer\n".repeat(1_000)];
    try {
      const results = await Promise.allSettled(contents.map((content) => createWorkspaceFile(target, content)));
      const winners = results.flatMap((result, index) => result.status === "fulfilled" ? [index] : []);

      expect(winners).toHaveLength(1);
      await expect(readFile(target, "utf8")).resolves.toBe(contents[winners[0]!]);
      for (const result of results) {
        if (result.status === "fulfilled") expect(result.value).toBe(target);
        else expect(result.reason).toEqual(new Error(`Destination already exists: ${target}`));
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("resolves the default workspace model from env", () => {
    const model = resolveWorkspaceModel({
      EXOGRAPH_WORKSPACE_ROOT: fixtureWorkspaceRoot,
      EXOGRAPH_NOTE_ROOTS: path.join(fixtureWorkspaceRoot, "notes/test-notes"),
    });

    expect(model.workspaceRoot).toBe(fixtureWorkspaceRoot);
    expect(model.defaultTerminalCwd).toBe(fixtureWorkspaceRoot);
    expect(model.noteRoots).toHaveLength(1);
  });

  it("uses portable workspace defaults when env is absent", () => {
    const model = resolveWorkspaceModel({});

    expect(model.workspaceRoot).toBe(process.cwd());
    expect(model.defaultTerminalCwd).toBe(process.cwd());
    expect(model.noteRoots).toEqual([
      {
        id: "note-root-1",
        label: "notes",
        path: path.join(process.cwd(), "notes"),
      },
    ]);
    expect(model.indexedRoots).toEqual([]);
    expect(model.indexing).toEqual({ enabled: false, mode: "off", backend: "qmd" });
  });

  it("resolves indexed roots and indexing mode from env", () => {
    const indexPath = path.join(fixtureWorkspaceRoot, "notes/test-notes");
    const model = resolveWorkspaceModel({
      EXOGRAPH_WORKSPACE_ROOT: fixtureWorkspaceRoot,
      EXOGRAPH_NOTE_ROOTS: path.join(fixtureWorkspaceRoot, "notes/test-notes"),
      EXOGRAPH_INDEX_MODE: "hybrid",
      EXOGRAPH_INDEXED_ROOTS: JSON.stringify([{ id: "index-notes", label: "notes", path: indexPath, kind: "notes", pattern: "**/*.md" }]),
    });

    expect(model.indexing).toEqual({ enabled: true, mode: "hybrid", backend: "qmd" });
    expect(model.indexedRoots).toEqual([
      {
        id: "index-notes",
        label: "notes",
        path: indexPath,
        kind: "notes",
        pattern: "**/*.md",
        ignore: [],
        backend: "qmd",
      },
    ]);
  });

  it("lists markdown tree nodes", async () => {
    const nodes = await listRootTree(path.join(fixtureWorkspaceRoot, "notes/test-notes"), { markdownOnly: true });
    expect(nodes.some((node) => node.name === "focus-note.md")).toBe(true);
  });

  it("can expose PDF artifacts in a deliberately narrow tree without adding them to Markdown enumeration", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "exograph-pdf-tree-"));
    try {
      await writeFile(path.join(root, "note.md"), "# Note\n", "utf8");
      await writeFile(path.join(root, "paper.pdf"), "%PDF-1.4\nfixture", "utf8");
      await writeFile(path.join(root, "ignored.txt"), "not an artifact", "utf8");

      await expect(listRootTree(root, { allowedFileExtensions: [".md", ".pdf"] })).resolves.toEqual([
        expect.objectContaining({ name: "note.md", kind: "file" }),
        expect.objectContaining({ name: "paper.pdf", kind: "file" }),
      ]);
      await expect(listMarkdownFiles([root])).resolves.toEqual([path.join(root, "note.md")]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("prunes excluded content paths from a Markdown tree", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "exograph-content-tree-"));
    try {
      await mkdir(path.join(root, "docs"), { recursive: true });
      await mkdir(path.join(root, "release"), { recursive: true });
      await writeFile(path.join(root, "docs", "readme.md"), "# Readme\n", "utf8");
      await writeFile(path.join(root, "release", "generated.md"), "# Generated\n", "utf8");

      const nodes = await listRootTree(root, { markdownOnly: true, excludedPaths: ["release/**"] });

      expect(nodes.map((node) => node.name)).toEqual(["docs"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps excluded Markdown out of filesystem search", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "exograph-content-search-"));
    try {
      await mkdir(path.join(root, "release"), { recursive: true });
      await writeFile(path.join(root, "readme.md"), "# Readme\nneedle\n", "utf8");
      await writeFile(path.join(root, "release", "generated.md"), "# Generated\nneedle\n", "utf8");
      const workspace = {
        workspaceRoot: root,
        defaultTerminalCwd: root,
        noteRoots: [{ id: "notes", label: "Notes", path: root }],
        indexedRoots: [],
        indexing: { enabled: false, mode: "off" as const, backend: "qmd" as const },
        contentPolicy: repositoryWorkspaceContentPolicy(),
      };

      await expect(searchNotes(workspace, "needle")).resolves.toMatchObject([
        { filePath: path.join(root, "readme.md") },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("never follows nested Markdown symlinks outside a Note Root", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "exograph-note-search-symlink-"));
    const outside = await mkdtemp(path.join(os.tmpdir(), "exograph-note-search-outside-"));
    try {
      const notesRoot = path.join(root, "notes");
      const escapedNote = path.join(outside, "outside.md");
      await mkdir(notesRoot, { recursive: true });
      await writeFile(path.join(notesRoot, "inside.md"), "# Inside\ninside needle\n", "utf8");
      await writeFile(escapedNote, "# Outside\nTOP_SECRET_NEEDLE\n#private\n", "utf8");
      await symlink(escapedNote, path.join(notesRoot, "outside-link.md"));

      const workspace = resolveWorkspaceModel({
        EXOGRAPH_WORKSPACE_ROOT: root,
        EXOGRAPH_NOTE_ROOTS: notesRoot,
      });

      await expect(searchNotes(workspace, "TOP_SECRET_NEEDLE")).resolves.toEqual([]);
      await expect(searchWorkspace(workspace, "private")).resolves.toEqual({ notes: [], tags: [] });
      await expect(listMarkdownFiles([notesRoot])).resolves.toEqual([path.join(notesRoot, "inside.md")]);
      await expect(listRootTree(notesRoot, { markdownOnly: true })).resolves.toEqual([
        expect.objectContaining({ name: "inside.md", kind: "file" }),
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("can include empty directories in markdown-only trees", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "exograph-empty-notes-"));
    try {
      await mkdir(path.join(root, "empty-folder"));

      const hiddenNodes = await listRootTree(root, { markdownOnly: true });
      expect(hiddenNodes.some((node) => node.name === "empty-folder")).toBe(false);

      const visibleNodes = await listRootTree(root, { markdownOnly: true, includeEmptyDirectories: true });
      expect(visibleNodes).toContainEqual({
        id: path.join(root, "empty-folder"),
        name: "empty-folder",
        path: path.join(root, "empty-folder"),
        kind: "directory",
        children: [],
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("searches notes by title and path", async () => {
    const model = resolveWorkspaceModel({
      EXOGRAPH_WORKSPACE_ROOT: fixtureWorkspaceRoot,
      EXOGRAPH_NOTE_ROOTS: path.join(fixtureWorkspaceRoot, "notes/test-notes"),
    });

    const results = await searchNotes(model, "focus-note");
    expect(results.some((result) => result.title === "Focus Note")).toBe(true);
    expect(results.every((result) => result.kind === "note")).toBe(true);
  });

  it("searches notes by frontmatter title, body, and tags", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "exograph-note-search-"));
    try {
      await mkdir(path.join(root, "notes", "garden", "research"), { recursive: true });
      const notePath = path.join(root, "notes", "garden", "research", "sigmund.md");
      await writeFile(
        notePath,
        [
          "---",
          "title: Sigmund Lab",
          "tags: [behavioral-eval, cybernetics]",
          "---",
          "",
          "The Ashby framing belongs in the fallback corpus.",
          "",
        ].join("\n"),
        "utf8",
      );
      const model = resolveWorkspaceModel({
        EXOGRAPH_WORKSPACE_ROOT: root,
        EXOGRAPH_NOTE_ROOTS: path.join(root, "notes"),
      });

      const titleResults = await searchNotes(model, "Sigmund Lab");
      const bodyResults = await searchNotes(model, "Ashby");
      const tagResults = await searchNotes(model, "behavioral-eval");

      expect(titleResults[0]).toMatchObject({ filePath: notePath, title: "Sigmund Lab", snippet: "title: Sigmund Lab" });
      expect(bodyResults[0]).toMatchObject({ filePath: notePath, title: "Sigmund Lab" });
      expect(bodyResults[0].snippet).toContain("Ashby");
      expect(tagResults[0]).toMatchObject({ filePath: notePath, title: "Sigmund Lab", snippet: "#behavioral-eval" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("returns note-only workspace search results", async () => {
    const model = resolveWorkspaceModel({
      EXOGRAPH_WORKSPACE_ROOT: fixtureWorkspaceRoot,
      EXOGRAPH_NOTE_ROOTS: path.join(fixtureWorkspaceRoot, "notes/test-notes"),
    });

    const results = await searchWorkspace(model, "focus-note");
    expect(results.notes.length).toBeGreaterThan(0);
    expect(results.tags).toEqual([]);
  });

  it("returns workspace tag matches from note roots", async () => {
    const model = resolveWorkspaceModel({
      EXOGRAPH_WORKSPACE_ROOT: fixtureWorkspaceRoot,
      EXOGRAPH_NOTE_ROOTS: path.join(fixtureWorkspaceRoot, "notes/test-notes"),
    });

    const results = await searchWorkspace(model, "research");
    expect(results.tags.some((result) => result.snippet === "#research")).toBe(true);
  });

  it("resolves note-root-relative note paths", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "exograph-note-resolve-"));
    try {
      const notePath = path.join(root, "notes", "garden", "research", "ashby.md");
      await mkdir(path.dirname(notePath), { recursive: true });
      await writeFile(notePath, "# Ashby\n", "utf8");
      const model = resolveWorkspaceModel({
        EXOGRAPH_WORKSPACE_ROOT: root,
        EXOGRAPH_NOTE_ROOTS: path.join(root, "notes"),
      });

      expect(resolveNotePath(model, "garden/research/ashby.md", path.join(root, "outside"))).toBe(notePath);
      expect(() => resolveNotePath(model, path.join(root, "outside", "ashby.md"), root)).toThrow("outside configured note roots");
      expect(() => resolveNotePath(model, "../outside/ashby.md", root)).toThrow("not found inside configured note roots");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses to rename over an existing destination", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "exograph-workspace-test-"));
    try {
      const sourcePath = path.join(root, "source");
      const destinationPath = path.join(root, "destination");
      await mkdir(sourcePath);
      await mkdir(destinationPath);
      await writeFile(path.join(destinationPath, "existing.md"), "# Existing\n", "utf8");

      await expect(renameWorkspacePath(sourcePath, destinationPath)).rejects.toThrow(
        `Destination already exists: ${destinationPath}`,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
