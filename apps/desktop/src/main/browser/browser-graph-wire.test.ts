import { expect, it } from "vitest";
import { WorkspaceGraph } from "@exograph/core";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { encodeBrowserGraph, decodeBrowserGraph } from "../../shared/browser-graph-wire";
it("preserves the production graph through JSON including every typed buffer", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "exo-graph-wire-"));
  try {
    await writeFile(path.join(root, "a.md"), "# A\n[[b]]");
    await writeFile(path.join(root, "b.md"), "# B");
    const graph = new WorkspaceGraph({
      workspaceRoot: root,
      defaultTerminalCwd: root,
      indexedRoots: [],
      indexing: { enabled: false, mode: "off", backend: "qmd" },
      noteRoots: [{ id: "notes", label: "Notes", path: root }],
    });
    const topology = await graph.graphTopology();
    const wire = JSON.parse(JSON.stringify(encodeBrowserGraph(topology)));
    expect(decodeBrowserGraph(wire)).toEqual(topology);
    wire.nodes.seeds[0] = -1;
    expect(() => decodeBrowserGraph(wire)).toThrow("buffer");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
