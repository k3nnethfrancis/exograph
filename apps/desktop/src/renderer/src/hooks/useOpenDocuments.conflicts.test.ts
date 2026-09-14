import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { act, createElement } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DocumentPersistence } from "@exograph/core";
import { useOpenDocuments } from "./useOpenDocuments";

let directory: string;
let filePath: string;
let root: ReactTestRenderer | undefined;
let controller: ReturnType<typeof useOpenDocuments>;
let openPaths: Set<string>;
let persistence: DocumentPersistence;
let bridge: { save: ReturnType<typeof vi.fn>; saveCopy: ReturnType<typeof vi.fn> };

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "exograph-editor-conflict-"));
  filePath = path.join(directory, "note.md");
  await writeFile(filePath, "---\nstatus: original\n---\nOriginal\n");
  persistence = new DocumentPersistence();
  openPaths = new Set([filePath]);
  bridge = {
    save: vi.fn(persistence.save.bind(persistence)),
    saveCopy: vi.fn(persistence.saveCopy.bind(persistence)),
  };
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("document", { addEventListener() {}, removeEventListener() {} });
  vi.stubGlobal("window", {
    setTimeout, clearTimeout, addEventListener() {}, removeEventListener() {},
    exograph: {
      workspace: { onGraphChanged: () => () => {} },
      notes: { ...bridge, read: persistence.read.bind(persistence), stat: async () => null, getGraphContext: async () => null },
    },
  });
  function Harness() {
    controller = useOpenDocuments({ workspaceModel: null, activeDocumentPath: filePath, getOpenEditorPaths: () => openPaths, getEditorScrollTopForPath: () => null });
    return null;
  }
  await act(async () => { root = create(createElement(Harness)); });
  await act(async () => { await controller.ensureDocumentLoaded(filePath); });
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  vi.unstubAllGlobals();
  await rm(directory, { recursive: true, force: true });
});

async function makeConflict() {
  await act(async () => { controller.updateBody(filePath, "Local"); });
  await writeFile(filePath, "External\n");
  await act(async () => { await expect(controller.saveDocument(filePath)).rejects.toThrow("changed outside"); });
}

describe("editor save conflicts through real files", () => {
  it("the actual autosave timer preserves an external edit and dirty local frontmatter/body", async () => {
    await act(async () => {
      controller.updateBody(filePath, "Local body");
      controller.updateFrontmatter(filePath, "status", "local");
    });
    await writeFile(filePath, "External body\n");
    // Real timers: exercise the production idle save, not a direct helper call.
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 2_200)); });
    expect(await readFile(filePath, "utf8")).toBe("External body\n");
    expect(controller.openDocuments[filePath]).toMatchObject({ body: "Local body", frontmatter: { status: "local" }, dirty: true, saveConflict: "changed" });
    expect(controller.documentSaveStatuses[filePath]).toBe("conflict");
    expect(bridge.save).toHaveBeenCalledOnce();
    await act(async () => { controller.updateBody(filePath, "Latest local body"); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 2_100)); });
    expect(bridge.save).toHaveBeenCalledOnce();
  }, 10_000);

  it("keeps a newer buffer after a late conflict on a closed tab and can reopen it without reading disk", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    bridge.save.mockImplementationOnce(async (...args: Parameters<DocumentPersistence["save"]>) => { await gate; return persistence.save(...args); });
    await act(async () => { controller.updateBody(filePath, "Local v1"); });
    let saving!: Promise<void>;
    await act(async () => { saving = controller.saveDocument(filePath); });
    await act(async () => {
      controller.updateBody(filePath, "Local v2");
      openPaths.clear();
      controller.pruneToOpenPaths(openPaths);
    });
    await rm(filePath);
    await act(async () => { release(); await expect(saving).rejects.toThrow("changed outside"); });
    await act(async () => { await controller.ensureDocumentLoaded(filePath); });
    expect(controller.openDocuments[filePath]).toMatchObject({ body: "Local v2", dirty: true, saveConflict: "missing" });
  });

  it("copies the latest conflict buffer exclusively, freezes edits while copying, and leaves disk unchanged", async () => {
    await makeConflict();
    await act(async () => { controller.updateBody(filePath, "Latest local"); controller.updateFrontmatter(filePath, "status", "latest-local"); });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    bridge.saveCopy.mockImplementationOnce(async (...args: Parameters<DocumentPersistence["saveCopy"]>) => { await gate; return persistence.saveCopy(...args); });
    const destination = path.join(directory, "copy.md");
    let copying!: Promise<void>;
    await act(async () => { copying = controller.saveConflictCopy(filePath, destination); });
    await act(async () => { controller.updateBody(filePath, "Edit during copy"); });
    await act(async () => { release(); await copying; });
    expect(await persistence.read(destination)).toMatchObject({ body: "Latest local", frontmatter: { status: "latest-local" } });
    expect(await readFile(filePath, "utf8")).toBe("External\n");
    expect(controller.openDocuments[filePath]).toBeUndefined();
    expect(controller.openDocuments[destination]).toMatchObject({ body: "Latest local", dirty: false });
  });

  it("keeps the conflict buffer if a copy would change its format or overwrite a destination", async () => {
    await makeConflict();
    await act(async () => { controller.updateFrontmatter(filePath, "status", "local-property"); });
    await act(async () => {
      await expect(controller.saveConflictCopy(filePath, path.join(directory, "backup"))).rejects.toThrow("Markdown filename");
      await expect(controller.saveConflictCopy(filePath, filePath)).rejects.toThrow("Destination already exists");
    });
    expect(controller.openDocuments[filePath]).toMatchObject({ dirty: true, saveConflict: "changed", resolvingConflict: false, frontmatter: { status: "local-property" } });
    expect(await readFile(filePath, "utf8")).toBe("External\n");
  });

  it("blocks document transitions until explicit reload resolves the conflict and establishes the new baseline", async () => {
    await makeConflict();
    await act(async () => { await expect(window.__exographPrepareDocumentTransition!()).rejects.toThrow("Resolve"); });
    expect(controller.transitionPending).toBe(false);
    await act(async () => { expect(await controller.discardSaveConflict(filePath)).toBe("reloaded"); });
    expect(controller.openDocuments[filePath]).toMatchObject({ body: "External\n", dirty: false });
    expect(controller.openDocuments[filePath].saveConflict).toBeUndefined();
    await act(async () => { controller.updateBody(filePath, "Edit on new baseline"); });
    await act(async () => { await window.__exographPrepareDocumentTransition!(); });
    expect(controller.transitionPending).toBe(true);
    await act(async () => { controller.updateBody(filePath, "Edit during transition"); });
    expect((await persistence.read(filePath)).body).toBe("Edit on new baseline");
    expect(controller.openDocuments[filePath].body).toBe("Edit on new baseline");
    await act(async () => { window.__exographFinishDocumentTransition!(); });
  });
});
