import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { useOpenDocuments } from "./useOpenDocuments";

const filePath = "/notes/save-close.md";
let root: ReactTestRenderer | undefined;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("document", { addEventListener() {}, removeEventListener() {} });
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function mountDocuments() {
  let releaseSave!: () => void;
  const firstSave = new Promise<void>((resolve) => { releaseSave = resolve; });
  let disk = { body: "v0", frontmatter: {} as Record<string, unknown> };
  const save = vi.fn(async (_path: string, frontmatter: Record<string, unknown>, body: string) => {
    if (save.mock.calls.length === 1) await firstSave;
    disk = { body, frontmatter };
    return { status: "saved", revision: "a".repeat(64) };
  });
  vi.stubGlobal("window", {
    setTimeout, clearTimeout, addEventListener() {}, removeEventListener() {},
    exograph: {
      workspace: { onGraphChanged: () => () => {} },
      notes: {
        read: async () => ({ revision: "a".repeat(64), filePath, title: "Save close", kind: "markdown", ...disk }),
        stat: async () => ({ size: disk.body.length, mtimeMs: save.mock.calls.length }),
        getGraphContext: async () => null,
        save,
      },
    },
  });
  let open = true;
  let controller!: ReturnType<typeof useOpenDocuments>;
  function Harness() {
    controller = useOpenDocuments({
      workspaceModel: null,
      activeDocumentPath: open ? filePath : null,
      getOpenEditorPaths: () => new Set(open ? [filePath] : []),
      getEditorScrollTopForPath: () => null,
    });
    return null;
  }
  await act(async () => { root = create(createElement(Harness)); });
  await act(async () => { await controller.ensureDocumentLoaded(filePath); });
  return {
    get controller() { return controller; },
    get disk() { return disk; },
    save,
    releaseSave,
    async close() {
      await act(async () => {
        open = false;
        root!.update(createElement(Harness));
        controller.pruneToOpenPaths(new Set());
      });
    },
  };
}

describe("closed document save ownership", () => {
  it.each(["body", "frontmatter"] as const)("saves newer %s edits after closing during an earlier save", async (edit) => {
    const fixture = await mountDocuments();
    await act(async () => { fixture.controller.updateBody(filePath, "v1"); });
    let saving!: Promise<void>;
    await act(async () => { saving = fixture.controller.saveDocument(filePath); });
    await act(async () => {
      if (edit === "body") fixture.controller.updateBody(filePath, "v2");
      else fixture.controller.updateFrontmatter(filePath, "status", "newer");
    });
    await fixture.close();
    await act(async () => { fixture.releaseSave(); await saving; });
    expect(fixture.controller.openDocuments[filePath]?.dirty).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(fixture.save).toHaveBeenCalledTimes(2);
    expect(fixture.disk).toEqual(edit === "body"
      ? { body: "v2", frontmatter: {} }
      : { body: "v1", frontmatter: { status: "newer" } });
    expect(fixture.controller.openDocuments[filePath]).toBeUndefined();
    await act(async () => { await fixture.controller.ensureDocumentLoaded(filePath); });
    expect(fixture.controller.openDocuments[filePath]).toMatchObject({ ...fixture.disk, dirty: false });
  });

  it("retires a closed document when its only edit finishes saving", async () => {
    const fixture = await mountDocuments();
    await act(async () => { fixture.controller.updateBody(filePath, "v1"); });
    let saving!: Promise<void>;
    await act(async () => { saving = fixture.controller.saveDocument(filePath); });
    await fixture.close();
    await act(async () => { fixture.releaseSave(); await saving; });
    expect(fixture.disk.body).toBe("v1");
    expect(fixture.controller.openDocuments[filePath]).toBeUndefined();
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(fixture.save).toHaveBeenCalledTimes(1);
  });
});
