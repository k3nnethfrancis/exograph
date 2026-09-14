import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { traverseKnowledgeGraph, parseGraphTraversalRequest, type GraphTraversalRequest, type GraphTraversalResult } from "../graph-traversal";
import type { KnowledgeGraphSnapshot, RelationEdge } from "../knowledge-graph";
import { WorkspaceGraph } from "../workspace-graph";

function snapshot(): KnowledgeGraphSnapshot {
  return {
    version: "0.4", snapshotId: "snapshot:one", generatedAt: "2026-09-12", scope: { workspaceRoot: "/wiki", noteRootIds: ["notes"], paths: ["/wiki/notes"] },
    activeFormat: { id: "generic-markdown", version: "1", label: "Markdown", source: "built-in", state: "active" }, activeOntology: { state: "generic" },
    concepts: ["a", "b", "c", "d"].map((id) => ({ id, noteId: id, label: id, filePath: `/wiki/notes/${id}.md`, relativePath: `${id}.md`, rootId: "notes", resolution: "resolved", conceptTypes: [], properties: {}, tags: [] })),
    relations: [edge("ab:0", "a", "b"), edge("ab:1", "a", "b"), edge("bc", "b", "c"), edge("ca", "c", "a"), edge("bd", "b", "d", "defines")], artifactReferences: [], findings: [],
  };
}
function edge(id: string, source: string, target: string, predicate = "references"): RelationEdge {
  return { id, source, target, predicate, family: "link", origin: "document", resolution: "resolved", directed: true, evidence: [{ kind: "source-span", noteId: source, sourceRange: { from: 2, to: 8 } }] };
}
const base: GraphTraversalRequest = { workspaceRoot: "/wiki", start: "a", direction: "outgoing", maxDepth: 2 };
function ok(result: GraphTraversalResult): Extract<GraphTraversalResult, { status: "ok" }> {
  expect(result.status).toBe("ok");
  if (result.status !== "ok") throw new Error(result.message);
  return result;
}

describe("bounded canonical graph traversal", () => {
  it("uses deterministic BFS, retains parallel edge occurrences and cites original evidence", () => {
    const result = ok(traverseKnowledgeGraph(snapshot(), base));
    expect(result.nodes.map((node) => node.id)).toEqual(["a", "b", "c", "d"]);
    expect(result.edges.map((edge) => edge.id)).toEqual(["ab:0", "ab:1", "bc", "bd"]);
    expect(result.events.filter((event) => event.type === "follow")).toHaveLength(4);
    expect(result.events.filter((event) => event.type === "visit")).toHaveLength(4);
    expect(result.evidence[0]).toMatchObject({ edgeId: "ab:0", index: 0, noteId: "a", rootId: "notes", relativePath: "a.md", evidence: snapshot().relations[0].evidence[0] });
    expect(new Set(result.evidence.map((item) => item.id)).size).toBe(4);
    const reversed = snapshot(); reversed.relations = [...reversed.relations].reverse(); reversed.concepts = [...reversed.concepts].reverse();
    expect(ok(traverseKnowledgeGraph(reversed, base)).events).toEqual(result.events);
  });

  it("preserves canonical source/target when following incoming edges and filters exact predicates", () => {
    const incoming = ok(traverseKnowledgeGraph(snapshot(), { ...base, start: "b", direction: "incoming", maxDepth: 1 }));
    expect(incoming.nodes.map((node) => node.id)).toEqual(["b", "a"]);
    expect(incoming.edges[0]).toMatchObject({ source: "a", target: "b" });
    expect(incoming.events[1]).toMatchObject({ type: "follow", fromNodeId: "b", nodeId: "a", direction: "incoming" });
    expect(ok(traverseKnowledgeGraph(snapshot(), { ...base, start: "b", predicate: "defines" })).nodes.map((node) => node.id)).toEqual(["b", "d"]);
    expect(ok(traverseKnowledgeGraph(snapshot(), { ...base, predicate: "Defines" })).nodes.map((node) => node.id)).toEqual(["a"]);
  });

  it("resolves a returned path through snapshot identity rather than frontmatter ID", () => {
    const graph = snapshot(); graph.concepts[0].properties = { id: "authored-id" };
    expect(ok(traverseKnowledgeGraph(graph, { workspaceRoot: "/wiki", startPath: "/wiki/notes/a.md" })).request.start).toBe("a");
    expect(traverseKnowledgeGraph(graph, { ...base, start: "authored-id" })).toMatchObject({ status: "error", code: "missing-start" });
    expect(traverseKnowledgeGraph(graph, { workspaceRoot: "/wiki", startPath: "/outside/a.md" })).toMatchObject({ status: "error", code: "missing-start" });
  });

  it("does not expand unresolved, ambiguous, external, absent, or Artifact endpoints", () => {
    const graph = snapshot();
    graph.relations = [edge("bad", "a", "missing"), { ...edge("unresolved", "a", "b"), resolution: "unresolved" }, { ...edge("ambiguous", "a", "c"), resolution: "ambiguous" }, { ...edge("external", "a", "d"), resolution: "external" }];
    graph.artifactReferences = [{ id: "pdf", source: "a", target: "file.pdf", kind: "attachment", label: "PDF", evidence: [] }];
    expect(ok(traverseKnowledgeGraph(graph, base)).nodes.map((node) => node.id)).toEqual(["a"]);
  });

  it("counts the start in node budgets, terminates cycles, and truthfully caps edges", () => {
    const one = ok(traverseKnowledgeGraph(snapshot(), { ...base, maxResults: 1 }));
    expect(one.nodes).toHaveLength(1); expect(one.completion.reason).toBe("max-results");
    const cycle = ok(traverseKnowledgeGraph(snapshot(), { ...base, maxDepth: 3 }));
    expect(cycle.nodes).toHaveLength(4); expect(cycle.edges.map((e) => e.id)).toContain("ca");
    const dense = snapshot(); dense.relations = Array.from({ length: 1001 }, (_, i) => edge(String(i).padStart(4, "0"), "a", "b"));
    const limited = ok(traverseKnowledgeGraph(dense, base));
    expect(limited.edges).toHaveLength(1000); expect(limited.completion.reason).toBe("edge-limit");
  });

  it("paginates nodes while reporting all actually replayed visits and occurrence edges", () => {
    const request = { ...base, limit: 2 };
    const first = ok(traverseKnowledgeGraph(snapshot(), request));
    const second = ok(traverseKnowledgeGraph(snapshot(), { ...request, cursor: first.nextCursor! }));
    expect([...first.nodes, ...second.nodes].map((n) => n.id)).toEqual(["a", "b", "c", "d"]);
    expect(first.events).toEqual(second.events);
    expect(first.traversalId).not.toBe(second.traversalId);
    expect(second.execution).toEqual({ kind: "deterministic-replay", visitedCount: 4, returnedOffset: 2 });
    expect(second.nextCursor).toBeNull(); expect(first.completion.reason).toBe("page-limit");
    expect(traverseKnowledgeGraph({ ...snapshot(), snapshotId: "new" }, { ...request, cursor: first.nextCursor! })).toMatchObject({ code: "stale-cursor" });
    expect(traverseKnowledgeGraph(snapshot(), { ...request, direction: "both", cursor: first.nextCursor! })).toMatchObject({ code: "invalid-cursor" });
    expect(traverseKnowledgeGraph(snapshot(), { ...request, workspaceRoot: "/other" })).toMatchObject({ code: "scope-mismatch" });
  });

  it("rejects malformed budgets, cursors, duplicate identities and oversized results", () => {
    for (const patch of [{ maxDepth: 4 }, { maxResults: 101 }, { limit: 0 }, { direction: "sideways" }, { extra: true }, { startPath: "/wiki/a.md" }]) expect(() => parseGraphTraversalRequest({ ...base, ...patch })).toThrow();
    expect(traverseKnowledgeGraph(snapshot(), { ...base, cursor: "not-json" })).toMatchObject({ code: "invalid-cursor" });
    const duplicate = snapshot(); duplicate.relations = [duplicate.relations[0], duplicate.relations[0]];
    expect(traverseKnowledgeGraph(duplicate, base)).toMatchObject({ code: "invalid-graph" });
    const huge = snapshot(); huge.concepts[0].properties = { body: "x".repeat(1_048_576) };
    expect(traverseKnowledgeGraph(huge, base)).toMatchObject({ code: "too-large" });
  });

  it("preserves differently labelled link occurrences through WorkspaceGraph and rejects stale cursors", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "exo-traverse-"));
    try {
      const notes = path.join(root, "notes"); await mkdir(notes);
      const startPath = path.join(notes, "a.md");
      await writeFile(startPath, "# A\n[one](b.md) [two](b.md)"); await writeFile(path.join(notes, "b.md"), "# B\n");
      const model = { workspaceRoot: root, defaultTerminalCwd: root, noteRoots: [{ id: "notes", label: "Notes", path: notes }], indexedRoots: [], indexing: { enabled: false, mode: "off" as const, backend: "qmd" as const } };
      const request = { workspaceRoot: root, startPath, limit: 1 };
      const first = ok(await new WorkspaceGraph(model).traverse(request));
      expect(first.request.start).toBe("note:notes:a.md"); expect(first.edges).toHaveLength(2);
      expect(new Set(first.edges.map((edge) => edge.id)).size).toBe(2);
      expect(first.edges.map((edge) => edge.label)).toEqual(["one", "two"]);
      expect(first.evidence.map((e) => e.relativePath)).toEqual(["a.md", "a.md"]);
      await writeFile(startPath, "# A changed\n[[b]]");
      expect(await new WorkspaceGraph(model).traverse({ ...request, cursor: first.nextCursor! })).toMatchObject({ code: "stale-cursor" });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
