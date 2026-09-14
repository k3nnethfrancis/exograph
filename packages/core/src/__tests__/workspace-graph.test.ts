import { writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { GRAPH_CONCEPT_SUMMARY_MAX_BYTES } from "../graph-projection";
import { NOTE_ROOT_FORMAT_ID } from "../note-root-format";
import { WorkspaceGraph, workspaceNoteId } from "../workspace-graph";
import { repositoryWorkspaceContentPolicy } from "../workspace-content-policy";
import { WorkspaceOntologyStore } from "../workspace-ontology";
import { listMarkdownFiles, listRootTree, searchNotes } from "../workspace";
import type { TreeNode, WorkspaceModel } from "../types";

const roots: string[] = [];
const mixedRepositoryFixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "repository-workspace");
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("WorkspaceGraph", () => {
  it.each(["[[nested/Cedar|Cedar alias]]", "[[ nested/Cedar#Overview | Cedar alias ]]"])("joins aliased and bare wikilinks to one existing Note Concept: %s", async (aliasedLink) => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "exograph-workspace-graph-alias-"));
    roots.push(workspace);
    const notes = path.join(workspace, "notes");
    await mkdir(path.join(notes, "nested"), { recursive: true });
    const atlasPath = path.join(notes, "Atlas.md");
    const cedarPath = path.join(notes, "nested", "Cedar.md");
    const atlasBody = `# Atlas\n\n🧠 ${aliasedLink}\n`;
    await writeFile(atlasPath, atlasBody);
    await writeFile(path.join(notes, "Borealis.md"), "# Borealis\n\n[[nested/Cedar]]\n");
    await writeFile(cedarPath, "# Cedar\n\n## Overview\n");
    const graph = new WorkspaceGraph(model(workspace, notes));
    const context = await graph.contextForNote(atlasPath);
    expect(context?.outgoing).toHaveLength(1);
    expect(context?.outgoing[0]).toMatchObject({ target: "nested/Cedar", label: "Cedar alias", resolution: "resolved", note: { filePath: cedarPath } });
    const range = context!.outgoing[0].sourceRange!;
    expect(atlasBody.slice(range.from, range.to)).toBe(aliasedLink);
    const snapshot = await graph.knowledgeSnapshot();
    expect(snapshot.concepts.map((concept) => concept.label).sort()).toEqual(["Atlas", "Borealis", "Cedar"]);
    expect(snapshot.relations).toHaveLength(2);
    expect(snapshot.relations.every((relation) => relation.resolution === "resolved" && relation.target === context?.outgoing[0].note?.id)).toBe(true);
    expect(snapshot.findings).toEqual([]);
    const cedarContext = await graph.contextForNote(cedarPath);
    expect(cedarContext?.backlinks).toHaveLength(2);
  });

  it("assigns unique stable relation IDs to differently labeled links from the same Note", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "exograph-workspace-graph-alias-occurrences-"));
    roots.push(workspace);
    const notes = path.join(workspace, "notes");
    await mkdir(path.join(notes, "one"), { recursive: true });
    const sourcePath = path.join(notes, "Atlas.md");
    const links = ["[[one/Cedar]]", "[[one/Cedar|alias]]", "[Another label](one/Cedar.md)"];
    const body = `# Atlas\n\n🧠 ${links.join(" ")}\n`;
    await writeFile(sourcePath, body);
    await writeFile(path.join(notes, "one", "Cedar.md"), "# Cedar\n");
    const graph = new WorkspaceGraph(model(workspace, notes));
    const snapshot = await graph.knowledgeSnapshot();
    const relations = snapshot.relations;
    expect(relations).toHaveLength(3);
    expect(new Set(relations.map((relation) => relation.id)).size).toBe(3);
    expect(new Set(relations.map((relation) => relation.target)).size).toBe(1);
    expect(relations.every((relation) => relation.resolution === "resolved")).toBe(true);
    expect(relations.map((relation) => relation.label).sort()).toEqual(["Another label", "alias", "one/Cedar"]);
    const spans = relations.flatMap((relation) => relation.evidence.flatMap((evidence) => evidence.kind === "source-span" && evidence.sourceRange ? [evidence.sourceRange] : []));
    expect(spans).toHaveLength(3);
    expect(new Set(spans.map((span) => span.from)).size).toBe(3);
    expect(spans.map((span) => body.slice(span.from, span.to)).sort()).toEqual([...links].sort());
    await graph.rebuild();
    expect((await graph.knowledgeSnapshot()).relations).toEqual(relations);
  });

  it("does not project Markdown beneath excluded repository paths", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "exograph-workspace-graph-policy-"));
    roots.push(workspace);
    const notes = path.join(workspace, "notes");
    await mkdir(path.join(notes, "release"), { recursive: true });
    await writeFile(path.join(notes, "readme.md"), "# Readme\n");
    await writeFile(path.join(notes, "release", "generated.md"), "# Generated\n");

    const graph = new WorkspaceGraph({ ...model(workspace, notes), contentPolicy: repositoryWorkspaceContentPolicy() });

    await expect(graph.rebuild()).resolves.toMatchObject({ noteCount: 1 });
    await expect(graph.contextForNote(path.join(notes, "release", "generated.md"))).resolves.toBeNull();
  });

  it("keeps code and attachment links as evidenced Artifact references, not graph Notes", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "exograph-workspace-artifacts-"));
    roots.push(workspace);
    const notes = path.join(workspace, "notes");
    await mkdir(path.join(notes, "src"), { recursive: true });
    const sourcePath = path.join(notes, "overview.md");
    await writeFile(sourcePath, "# Overview\n\n[Runtime](src/runtime.ts)\n[Diagram](assets/graph.png)\n[[missing]]\n");
    await writeFile(path.join(notes, "src", "runtime.ts"), "export const runtime = true;\n");

    const graph = new WorkspaceGraph(model(workspace, notes));
    const [snapshot, context, topology] = await Promise.all([
      graph.knowledgeSnapshot(),
      graph.contextForNote(sourcePath),
      graph.graphTopology(),
    ]);

    expect(snapshot.concepts.map((concept) => concept.label)).toEqual(["Overview", "missing"]);
    expect(snapshot.concepts.map((concept) => concept.label)).not.toContain("Runtime");
    expect(snapshot.relations).toHaveLength(1);
    expect(snapshot.relations[0]).toMatchObject({ resolution: "unresolved", target: expect.stringContaining("missing") });
    expect(snapshot.artifactReferences).toEqual([
      expect.objectContaining({ source: "note:notes:overview.md", target: "assets/graph.png", kind: "attachment" }),
      expect.objectContaining({ source: "note:notes:overview.md", target: "src/runtime.ts", kind: "source-file" }),
    ]);
    expect(context?.outgoing.map((link) => link.resolution)).toEqual(["unresolved", "artifact", "artifact"]);
    expect(topology.nodeCount).toBe(2); // the unresolved authored link remains inspectable; Artifacts do not enter topology.
  });

  it("keeps one included Markdown set across Explorer, filesystem search, and graph projection", async () => {
    const policy = {
      ...repositoryWorkspaceContentPolicy(),
      excludedPaths: [...repositoryWorkspaceContentPolicy().excludedPaths, "generated-docs/**"],
    };
    const workspaceModel = {
      ...model(mixedRepositoryFixture, mixedRepositoryFixture),
      contentPolicy: policy,
    };
    const graph = new WorkspaceGraph(workspaceModel);
    const [tree, markdownFiles, searchResults, snapshot, topology] = await Promise.all([
      listRootTree(mixedRepositoryFixture, { markdownOnly: true, excludedPaths: policy.excludedPaths }),
      listMarkdownFiles([mixedRepositoryFixture], policy),
      searchNotes(workspaceModel, "scope proof"),
      graph.knowledgeSnapshot(),
      graph.graphTopology(),
    ]);
    const expectedMarkdown = [
      "docs/guide.md",
      "docs/index.md",
      "docs/reference.md",
      "readme.md",
      "tests/fixtures/expected.md",
    ];

    expect(relativeTreeMarkdown(tree)).toEqual(expectedMarkdown);
    expect(relativeMarkdownPaths(markdownFiles)).toEqual(expectedMarkdown);
    expect(relativeMarkdownPaths(searchResults.map((result) => result.filePath))).toEqual(expectedMarkdown);
    expect(snapshot.concepts.map((concept) => concept.relativePath).filter(Boolean)).toEqual(expectedMarkdown);

    expect(snapshot.artifactReferences).toEqual([
      expect.objectContaining({ target: "../assets/architecture.svg", kind: "attachment" }),
      expect.objectContaining({ target: "../src/runtime.ts", kind: "source-file" }),
    ]);
    expect(snapshot.relations).toContainEqual(expect.objectContaining({ resolution: "unresolved", label: "missing-note" }));
    expect(snapshot.relations).toContainEqual(expect.objectContaining({
      resolution: "external",
      target: "external:https://exograph.md",
    }));
    expect(topology.nodeCount).toBe(snapshot.concepts.length);

    for (const excludedPath of [
      "build/generated.md",
      "generated-docs/api.md",
      "vendor/dependency/readme.md",
    ]) {
      expect(relativeMarkdownPaths(markdownFiles)).not.toContain(excludedPath);
      expect(snapshot.concepts.map((concept) => concept.relativePath)).not.toContain(excludedPath);
    }
  });

  it("rejects structural Format injection at construction", () => {
    expect(() => new WorkspaceGraph(model("/workspace", "/workspace/notes"), {
      noteRootFormat: {
        status: { id: "injected", version: "1", label: "Injected", source: "built-in", state: "active" },
        absoluteMarkdownLinkBase: "source-document",
        includesConcept: () => true,
        conceptTypes: () => [],
        validate: () => [],
      },
    } as never)).toThrow("Unknown WorkspaceGraph option: noteRootFormat");
    expect(() => WorkspaceGraph.forInteroperabilityFormat(
      model("/workspace", "/workspace/notes"),
      { id: "okf" } as never,
    )).toThrow("Unknown Note Root Format: [object Object]");
  });

  it("resolves root-relative links and refuses duplicate basename guessing", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "exograph-workspace-graph-"));
    roots.push(workspace);
    const notes = path.join(workspace, "notes");
    await mkdir(path.join(notes, "one"), { recursive: true });
    await mkdir(path.join(notes, "two"), { recursive: true });
    await writeFile(path.join(notes, "index.md"), "[[one/duplicate]] [[duplicate]] [[missing]]\n[index](one/duplicate.md)");
    await writeFile(path.join(notes, "one", "duplicate.md"), "# One");
    await writeFile(path.join(notes, "two", "duplicate.md"), "# Two");
    const graph = new WorkspaceGraph(model(workspace, notes));
    const context = await graph.contextForNote(path.join(notes, "index.md"));
    expect(context?.note.id).toBe("note:notes:index.md");
    expect(context?.outgoing.map((link) => link.resolution)).toEqual(["resolved", "ambiguous", "unresolved", "resolved"]);
    expect(context?.outgoing[0]?.note?.id).toBe("note:notes:one/duplicate.md");
    expect((await graph.backlinks(path.join(notes, "one", "duplicate.md"))).length).toBe(2);
    expect((await graph.status()).noteCount).toBe(3);
  });

  it("labels backlinks with the linking note title while preserving its target", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "exograph-workspace-graph-"));
    roots.push(workspace);
    const notes = path.join(workspace, "notes");
    await mkdir(notes, { recursive: true });
    await writeFile(path.join(notes, "focus.md"), "# Focus\n");
    await writeFile(path.join(notes, "related.md"), "---\ntitle: Related Note\n---\n[[focus]]\n");
    const context = await new WorkspaceGraph(model(workspace, notes)).contextForNote(path.join(notes, "focus.md"));
    expect(context?.backlinks).toEqual([
      expect.objectContaining({
        label: "Related Note",
        target: path.join(notes, "related.md"),
        note: expect.objectContaining({ filePath: path.join(notes, "related.md") }),
      }),
    ]);
    expect(context?.neighborhood.map((note) => note.filePath)).toEqual([
      path.join(notes, "focus.md"),
      path.join(notes, "related.md"),
    ]);
  });

  it("includes a backlink-only source in the target note neighborhood", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "exograph-workspace-graph-"));
    roots.push(workspace);
    const notes = path.join(workspace, "notes");
    await mkdir(notes, { recursive: true });
    const targetPath = path.join(notes, "target.md");
    const sourcePath = path.join(notes, "source.md");
    await writeFile(targetPath, "# Target\n");
    await writeFile(sourcePath, "# Source\n\n[[target]]\n");

    const context = await new WorkspaceGraph(model(workspace, notes)).contextForNote(targetPath);

    expect(context?.outgoing).toEqual([]);
    expect(context?.backlinks).toHaveLength(1);
    expect(context?.backlinks[0]).toMatchObject({
      source: "note:notes:source.md",
      target: sourcePath,
      note: { id: "note:notes:source.md", filePath: sourcePath },
    });
    expect(context?.neighborhood.map((note) => note.id)).toEqual([
      "note:notes:source.md",
      "note:notes:target.md",
    ]);
  });

  it("refreshes only the changed note in an existing snapshot", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "exograph-workspace-graph-"));
    roots.push(workspace);
    const notes = path.join(workspace, "notes");
    await mkdir(notes, { recursive: true });
    const focusPath = path.join(notes, "focus.md");
    const firstTargetPath = path.join(notes, "first.md");
    const secondTargetPath = path.join(notes, "second.md");
    const unrelatedPath = path.join(notes, "unrelated.md");
    await writeFile(focusPath, "# Focus\n\n[[first]]\n");
    await writeFile(firstTargetPath, "# First\n");
    await writeFile(secondTargetPath, "# Second\n");
    await writeFile(unrelatedPath, "# Unrelated\n");
    const graph = new WorkspaceGraph(model(workspace, notes));

    expect((await graph.contextForNote(focusPath))?.outgoing[0]?.note?.filePath).toBe(firstTargetPath);
    await rm(unrelatedPath);
    await writeFile(focusPath, "# Focus\n\n[[second]]\n");

    await graph.refreshFile(focusPath);

    expect((await graph.contextForNote(focusPath))?.outgoing[0]?.note?.filePath).toBe(secondTargetPath);
    expect(await graph.contextForNote(unrelatedPath)).not.toBeNull();
    await expect(graph.status()).resolves.toMatchObject({ state: "ready", noteCount: 4 });
  });

  it("applies a file refresh that arrives while a rebuild is in flight", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "exograph-workspace-graph-"));
    roots.push(workspace);
    const notes = path.join(workspace, "notes");
    await mkdir(notes, { recursive: true });
    const focusPath = path.join(notes, "focus.md");
    const targetPath = path.join(notes, "target.md");
    await writeFile(focusPath, "# Focus\n");
    await writeFile(targetPath, "# Target\n");
    const graph = new WorkspaceGraph(model(workspace, notes));
    await graph.contextForNote(focusPath);

    const rebuild = graph.rebuild();
    await expect(graph.status()).resolves.toMatchObject({ state: "building" });
    writeFileSync(focusPath, "# Focus\n\n[[target]]\n", "utf8");
    const refresh = graph.refreshFile(focusPath);
    await Promise.all([rebuild, refresh]);

    expect((await graph.contextForNote(focusPath))?.outgoing[0]?.note?.filePath).toBe(targetPath);
    await expect(graph.status()).resolves.toMatchObject({ state: "ready", noteCount: 2 });
  });

  it("projects open concepts, lossless properties, authored evidence, and deterministic identity", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "exograph-workspace-graph-"));
    roots.push(workspace);
    const notes = path.join(workspace, "notes");
    await mkdir(notes, { recursive: true });
    await writeFile(
      path.join(notes, "metric.md"),
      [
        "---",
        "title: Activation",
        "type: [Metric, NorthStar]",
        "unknown:",
        "  nested:",
        "    - keep",
        "    - 7",
        "tags: [growth]",
        "---",
        "",
        "[[source]] [[missing]]",
      ].join("\n"),
    );
    await writeFile(path.join(notes, "source.md"), "---\ntype: Evidence\n---\n# Source\n");
    const graph = new WorkspaceGraph(model(workspace, notes));

    const snapshot = await graph.knowledgeSnapshot();
    const second = await graph.knowledgeSnapshot();
    const metric = snapshot.concepts.find((concept) => concept.label === "Activation");

    expect(snapshot.version).toBe("0.4");
    expect(snapshot.snapshotId).toBe(second.snapshotId);
    expect(metric).toMatchObject({
      conceptTypes: ["Metric", "NorthStar"],
      properties: { unknown: { nested: ["keep", 7] } },
    });
    expect(snapshot.concepts).toContainEqual(expect.objectContaining({ id: "tag:growth", conceptTypes: ["tag"] }));
    expect(snapshot.relations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        family: "link",
        origin: "document",
        resolution: "resolved",
        evidence: [expect.objectContaining({ kind: "source-span", detail: "source" })],
      }),
      expect.objectContaining({ family: "tag-membership", predicate: "has-tag", origin: "document" }),
    ]));
    expect(snapshot.findings).toContainEqual(expect.objectContaining({ code: "relation.unresolved" }));
  });

  it("interprets OKF permissively while reporting its missing type requirement", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "exograph-workspace-graph-"));
    roots.push(workspace);
    const notes = path.join(workspace, "notes");
    await mkdir(notes, { recursive: true });
    await writeFile(path.join(notes, "typed.md"), "---\ntype: CustomThing\nproducer_field: keep\n---\n# Typed\n");
    await writeFile(path.join(notes, "untyped.md"), "---\nunknown: survives\n---\n# Untyped\n");

    const snapshot = await WorkspaceGraph.forInteroperabilityFormat(
      model(workspace, notes),
      NOTE_ROOT_FORMAT_ID.okf,
    ).knowledgeSnapshot();

    expect(snapshot.activeFormat).toMatchObject({ id: "okf", version: "0.1" });
    expect(snapshot.concepts.find((concept) => concept.label === "Typed")?.properties).toMatchObject({ producer_field: "keep" });
    expect(snapshot.findings).toContainEqual(expect.objectContaining({ code: "okf.missing-type", conceptIds: ["note:notes:untyped.md"] }));
  });

  it("uses only an explicitly kept Ontology and ignores later candidate edits", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "exograph-workspace-ontology-"));
    roots.push(workspace);
    const notes = path.join(workspace, "notes");
    const runtimeRoot = path.join(workspace, ".exograph-test");
    await mkdir(notes);
    const sourcePath = path.join(notes, "source.md");
    const sourceBytes = "---\ntype: paper\nsupports: [missing]\n---\n# Source\n";
    await writeFile(sourcePath, sourceBytes);
    await writeFile(path.join(workspace, "ontology.yaml"), [
      "ontology_schema: 1",
      "id: research",
      "version: 1",
      "types:",
      "  paper: {}",
      "properties:",
      "  supports:",
      "    value: reference[]",
      "    predicate: supports",
    ].join("\n"));

    const beforeKeep = await new WorkspaceGraph(model(workspace, notes), { runtimeRoot }).knowledgeSnapshot();
    expect(beforeKeep.activeOntology).toEqual({ state: "generic" });
    expect(beforeKeep.relations.some((relation) => relation.origin === "ontology")).toBe(false);

    const store = new WorkspaceOntologyStore({ workspaceRoot: workspace, runtimeRoot });
    const candidate = await store.inspectCandidate();
    await store.keepCandidate(candidate.sourceRevision ?? "");
    const activeGraph = new WorkspaceGraph(model(workspace, notes), { runtimeRoot });
    const active = await activeGraph.knowledgeSnapshot();
    const activeTopology = await activeGraph.graphTopology();
    expect(active.activeOntology).toMatchObject({ state: "active", id: "research" });
    expect(active.relations).toContainEqual(expect.objectContaining({ origin: "ontology", resolution: "unresolved" }));
    const ids = new Set(active.concepts.map((concept) => concept.id));
    expect(active.relations.every((relation) => ids.has(relation.source) && ids.has(relation.target))).toBe(true);

    await writeFile(path.join(workspace, "ontology.yaml"), "ontology_schema: 1\nid: replacement\nversion: 2\n");
    const candidateGraph = new WorkspaceGraph(model(workspace, notes), { runtimeRoot });
    const candidateOnly = await candidateGraph.knowledgeSnapshot();
    const candidateTopology = await candidateGraph.graphTopology();
    expect(candidateOnly.snapshotId).toBe(active.snapshotId);
    expect(candidateOnly.activeOntology).toEqual(active.activeOntology);
    expect(candidateTopology.topologyHash).toBe(activeTopology.topologyHash);
    expect(candidateTopology.layoutEpochId).toBe(activeTopology.layoutEpochId);
    expect(await readFile(sourcePath, "utf8")).toBe(sourceBytes);
  });

  it.each([
    ["Generic Markdown", NOTE_ROOT_FORMAT_ID.genericMarkdown],
    ["OKF 0.1", NOTE_ROOT_FORMAT_ID.okf],
  ] as const)("preserves active Ontology, cache, and stale cold-read behavior for %s", async (_label, formatId) => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "exograph-workspace-format-parity-"));
    roots.push(workspace);
    const notes = path.join(workspace, "notes");
    const runtimeRoot = path.join(workspace, ".exograph-test");
    await mkdir(notes);
    const sourcePath = path.join(notes, "source.md");
    await writeFile(sourcePath, "---\ntype: Claim\nsupports: target.md\n---\n# Source\n");
    await writeFile(path.join(notes, "target.md"), "---\ntype: Evidence\n---\n# Target\n");
    await writeFile(path.join(workspace, "ontology.yaml"), [
      "ontology_schema: 1",
      "id: parity",
      "version: 1",
      "properties:",
      "  supports: { value: reference, predicate: supports }",
    ].join("\n"));
    const store = new WorkspaceOntologyStore({ workspaceRoot: workspace, runtimeRoot });
    const candidate = await store.inspectCandidate();
    await store.keepCandidate(candidate.sourceRevision ?? "");
    const workspaceModel = model(workspace, notes);
    const graph = formatId === NOTE_ROOT_FORMAT_ID.genericMarkdown
      ? new WorkspaceGraph(workspaceModel, { runtimeRoot })
      : WorkspaceGraph.forInteroperabilityFormat(workspaceModel, formatId, { runtimeRoot });

    const firstSnapshot = await graph.knowledgeSnapshot();
    const secondSnapshot = await graph.knowledgeSnapshot();
    const firstTopology = await graph.graphTopology();
    const secondTopology = await graph.graphTopology();
    expect(secondSnapshot).toBe(firstSnapshot);
    expect(secondTopology.nodes.identityKeys).toBe(firstTopology.nodes.identityKeys);
    expect(firstSnapshot.activeFormat.id).toBe(formatId);
    expect(firstSnapshot.activeOntology).toMatchObject({ state: "active", id: "parity" });
    expect(firstSnapshot.relations).toContainEqual(expect.objectContaining({
      source: "note:notes:source.md",
      target: "note:notes:target.md",
      predicate: "supports",
      origin: "ontology",
      resolution: "resolved",
    }));

    const lookup = await graph.graphConceptLookup({ filePath: sourcePath }, firstTopology.sourceSnapshotId);
    expect(lookup).toMatchObject({ status: "ok", summary: { label: "Source" } });
    const index = lookup.summary?.index ?? -1;
    await expect(graph.graphConceptSummaries([index], firstTopology.sourceSnapshotId))
      .resolves.toMatchObject({ status: "ok", summaries: [expect.objectContaining({ label: "Source" })] });
    await expect(graph.graphConceptDetailByIndex(index, firstTopology.sourceSnapshotId))
      .resolves.toMatchObject({
        status: "ok",
        detail: {
          format: { id: formatId },
          ontology: { state: "active", id: "parity" },
          relations: expect.arrayContaining([expect.objectContaining({
            relation: expect.objectContaining({ origin: "ontology", predicate: "supports" }),
          })]),
        },
      });

    await writeFile(sourcePath, "---\ntype: Claim\n---\n# Changed\n");
    await graph.refreshFile(sourcePath);
    await expect(graph.graphConceptSummaries([index], firstTopology.sourceSnapshotId)).resolves.toMatchObject({ status: "stale" });
    await expect(graph.graphConceptLookup({ filePath: sourcePath }, firstTopology.sourceSnapshotId)).resolves.toMatchObject({ status: "stale" });
    await expect(graph.graphConceptDetailByIndex(index, firstTopology.sourceSnapshotId)).resolves.toMatchObject({ status: "stale" });
  });

  it("preserves stable relation identity when a different link is inserted earlier", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "exograph-workspace-graph-"));
    roots.push(workspace);
    const notes = path.join(workspace, "notes");
    await mkdir(notes, { recursive: true });
    const sourcePath = path.join(notes, "source.md");
    await writeFile(path.join(notes, "other.md"), "# Other\n");
    await writeFile(path.join(notes, "target.md"), "# Target\n");
    await writeFile(sourcePath, "[[target]]\n");
    const graph = new WorkspaceGraph(model(workspace, notes));
    const before = await graph.knowledgeSnapshot();
    const relationBefore = before.relations.find((relation) => relation.target.endsWith(":target.md"));

    await writeFile(sourcePath, "[[other]]\n[[target]]\n");
    await graph.refreshFile(sourcePath);
    const after = await graph.knowledgeSnapshot();
    const relationAfter = after.relations.find((relation) => relation.target.endsWith(":target.md"));

    expect(relationAfter?.id).toBe(relationBefore?.id);
  });

  it("preserves path case in concept identity", () => {
    expect(workspaceNoteId("notes", "Folder/Foo.md")).not.toBe(workspaceNoteId("notes", "folder/foo.md"));
  });

  it("rejects bounded concept detail from a stale graph epoch", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "exograph-workspace-graph-"));
    roots.push(workspace);
    const notes = path.join(workspace, "notes");
    await mkdir(notes, { recursive: true });
    const notePath = path.join(notes, "focus.md");
    await writeFile(notePath, "# Focus\n");
    const graph = new WorkspaceGraph(model(workspace, notes));
    const first = await graph.graphTopology();
    await writeFile(notePath, "# Changed\n");
    await graph.refreshFile(notePath);

    await expect(graph.graphConceptDetailByIndex(0, first.sourceSnapshotId)).resolves.toMatchObject({
      status: "stale",
      index: 0,
    });
  });

  it("serves cold summaries and bounded evidenced detail by topology index", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "exograph-workspace-graph-"));
    roots.push(workspace);
    const notes = path.join(workspace, "notes");
    await mkdir(notes, { recursive: true });
    const properties = Array.from({ length: 70 }, (_, index) => `property_${String(index).padStart(2, "0")}: value-${index}`);
    const links = [
      ...Array.from({ length: 140 }, () => "[[target]]"),
      ...Array.from({ length: 70 }, () => "[[missing]]"),
    ].join(" ");
    const focusPath = path.join(notes, "focus.md");
    await writeFile(focusPath, ["---", "title: Focus", "type: Document", ...properties, "---", links].join("\n"));
    await writeFile(path.join(notes, "target.md"), "# Target\n");
    const graph = WorkspaceGraph.forInteroperabilityFormat(model(workspace, notes), NOTE_ROOT_FORMAT_ID.okf);

    const firstTopology = await graph.graphTopology();
    const secondTopology = await graph.graphTopology();
    expect(firstTopology.nodes.identityKeys.byteLength).toBeGreaterThan(0);
    expect(firstTopology.nodes.identityKeys).toBe(secondTopology.nodes.identityKeys);
    expect(firstTopology.transportHash).toBe(secondTopology.transportHash);
    const summaries = await graph.graphConceptSummaries(
      Array.from({ length: firstTopology.nodeCount }, (_, index) => index),
      firstTopology.sourceSnapshotId,
    );
    expect(summaries.status).toBe("ok");
    const focusIndex = summaries.summaries.find((summary) => summary.label === "Focus")?.index;
    expect(focusIndex).toBeTypeOf("number");
    const detail = await graph.graphConceptDetailByIndex(focusIndex ?? -1, firstTopology.sourceSnapshotId);

    expect(detail.status).toBe("ok");
    expect(detail.payloadBytes).toBeLessThanOrEqual(256 * 1024);
    expect(detail.detail?.format).toMatchObject({ id: "okf", version: "0.1" });
    expect(detail.detail?.properties).toHaveLength(64);
    expect(detail.detail?.relations).toHaveLength(128);
    expect(detail.detail?.findings).toHaveLength(64);
    expect(detail.detail?.omitted).toMatchObject({ properties: 8, relations: 82, findings: 6, evidence: 88 });
    expect(detail.detail?.relations[0]).toMatchObject({
      direction: "outgoing",
      relation: {
        origin: "document",
        evidence: [expect.objectContaining({ kind: "source-span", noteId: "note:notes:focus.md" })],
      },
    });

    await expect(graph.graphConceptSummaries([999], firstTopology.sourceSnapshotId)).resolves.toMatchObject({ status: "missing" });
    await expect(graph.graphConceptSummaries(Array.from({ length: 65 }, (_, index) => index), firstTopology.sourceSnapshotId))
      .rejects.toThrow("limited to 64 nodes");

    await writeFile(focusPath, "# Changed\n");
    await graph.refreshFile(focusPath);
    await expect(graph.graphConceptDetailByIndex(focusIndex ?? -1, firstTopology.sourceSnapshotId))
      .resolves.toMatchObject({ status: "stale" });
    await expect(graph.graphConceptSummaries([focusIndex ?? -1], firstTopology.sourceSnapshotId))
      .resolves.toMatchObject({ status: "stale" });
  });

  it("reports an oversized cold summary explicitly without leaking it into topology", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "exograph-workspace-graph-"));
    roots.push(workspace);
    const notes = path.join(workspace, "notes");
    await mkdir(notes, { recursive: true });
    const hugeTitle = `secret-${"x".repeat(70 * 1024)}`;
    await writeFile(path.join(notes, "huge.md"), `---\ntitle: ${hugeTitle}\n---\n`);
    const graph = new WorkspaceGraph(model(workspace, notes));
    const topology = await graph.graphTopology();

    expect(JSON.stringify(topology)).not.toContain("secret-");
    await expect(graph.graphConceptSummaries([0], topology.sourceSnapshotId)).resolves.toMatchObject({
      status: "too-large",
      summaries: [],
    });
  });

  it("looks up cold concept identity by id or normalized file path in one cached topology epoch", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "exograph-workspace-graph-"));
    roots.push(workspace);
    const notes = path.join(workspace, "notes");
    const folder = path.join(notes, "Folder");
    await mkdir(folder, { recursive: true });
    const focusPath = path.join(folder, "Focus.md");
    await writeFile(focusPath, "# Focus\n");
    const graph = new WorkspaceGraph(model(workspace, notes));
    const topology = await graph.graphTopology();
    const conceptId = workspaceNoteId("notes", "folder/focus.md");

    const byId = await graph.graphConceptLookup({ conceptId }, topology.sourceSnapshotId);
    const byPath = await graph.graphConceptLookup(
      { filePath: path.join(folder, "..", "Folder", "Focus.md") },
      topology.sourceSnapshotId,
    );

    expect(byId).toMatchObject({ status: "ok", summary: { index: 0, label: "Focus", filePath: focusPath } });
    expect(byPath).toEqual(byId);
    expect(byId.payloadBytes).toBe(Buffer.byteLength(JSON.stringify(byId), "utf8"));
    await expect(graph.graphConceptLookup({ conceptId: "missing" }, topology.sourceSnapshotId))
      .resolves.toMatchObject({ status: "missing" });
    await expect(graph.graphConceptLookup({ filePath: path.join(notes, "missing.md") }, topology.sourceSnapshotId))
      .resolves.toMatchObject({ status: "missing" });
    await expect(graph.graphConceptLookup({} as never, topology.sourceSnapshotId)).rejects.toThrow("exactly one");
    await expect(graph.graphConceptLookup({ conceptId, filePath: focusPath } as never, topology.sourceSnapshotId)).rejects.toThrow("exactly one");
    await expect(graph.graphConceptLookup({ conceptId: "" }, topology.sourceSnapshotId)).rejects.toThrow("must not be empty");

    await writeFile(focusPath, "# Changed\n");
    await graph.refreshFile(focusPath);
    await expect(graph.graphConceptLookup({ conceptId }, topology.sourceSnapshotId))
      .resolves.toMatchObject({ status: "stale" });
    const refreshedTopology = await graph.graphTopology();
    await expect(graph.graphConceptLookup({ conceptId }, refreshedTopology.sourceSnapshotId))
      .resolves.toMatchObject({ status: "ok", summary: { label: "Changed" } });
  });

  it("enforces the exact cold concept lookup payload byte cap", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "exograph-workspace-graph-"));
    roots.push(workspace);
    const notes = path.join(workspace, "notes");
    await mkdir(notes, { recursive: true });
    const hugePath = path.join(notes, "huge.md");
    await writeFile(hugePath, "---\ntitle: x\n---\n");
    const graph = new WorkspaceGraph(model(workspace, notes));
    let topology = await graph.graphTopology();
    const baseline = await graph.graphConceptLookup({ filePath: hugePath }, topology.sourceSnapshotId);
    expect(baseline.status).toBe("ok");
    let titleLength = GRAPH_CONCEPT_SUMMARY_MAX_BYTES;
    for (let iteration = 0; iteration < 4; iteration += 1) {
      const candidate = { ...baseline, summary: { ...baseline.summary, label: "x".repeat(titleLength) }, payloadBytes: 0 };
      let bytes = Buffer.byteLength(JSON.stringify(candidate), "utf8");
      for (let sizeIteration = 0; sizeIteration < 3; sizeIteration += 1) {
        candidate.payloadBytes = bytes;
        bytes = Buffer.byteLength(JSON.stringify(candidate), "utf8");
      }
      titleLength -= bytes - GRAPH_CONCEPT_SUMMARY_MAX_BYTES;
    }

    await writeFile(hugePath, `---\ntitle: ${"x".repeat(titleLength)}\n---\n`);
    await graph.refreshFile(hugePath);
    topology = await graph.graphTopology();
    const atLimit = await graph.graphConceptLookup({ filePath: hugePath }, topology.sourceSnapshotId);
    expect(atLimit.payloadBytes).toBe(GRAPH_CONCEPT_SUMMARY_MAX_BYTES);

    await writeFile(hugePath, `---\ntitle: ${"x".repeat(titleLength + 1)}\n---\n`);
    await graph.refreshFile(hugePath);
    topology = await graph.graphTopology();
    await expect(graph.graphConceptLookup({ filePath: hugePath }, topology.sourceSnapshotId))
      .rejects.toThrow("65536-byte limit");
  });

  it("stages reviewed Ontology effects, rejects stale Keeps, and publishes exactly the staged graph", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "exograph-ontology-review-"));
    roots.push(workspace);
    const notes = path.join(workspace, "notes");
    const runtimeRoot = path.join(workspace, ".exograph-test");
    await mkdir(notes, { recursive: true });
    const sourcePath = path.join(notes, "source.md");
    const initialNote = "---\ntype: paper\nsupports: [target]\n---\n# Source\n";
    await writeFile(sourcePath, initialNote);
    await writeFile(path.join(notes, "target.md"), "---\ntype: claim\n---\n# Target\n");
    await writeFile(path.join(workspace, "ontology.yaml"), [
      "ontology_schema: 1",
      "id: research",
      "version: 1",
      "types:",
      "  paper: {}",
      "  claim: {}",
      "properties:",
      "  supports:",
      "    value: reference[]",
      "    predicate: supports",
    ].join("\n"));
    const graph = new WorkspaceGraph(model(workspace, notes), { runtimeRoot });
    const activeBefore = await graph.knowledgeSnapshot();
    expect((await graph.contextForNote(sourcePath))?.neighborhoodRelations).toEqual([]);
    const preview = await graph.previewOntology();

    expect(preview).toMatchObject({
      active: { state: "generic" },
      candidate: { state: "valid", id: "research" },
      effects: { before: { ontologyRelations: 0 }, after: { ontologyRelations: 1 } },
    });
    expect((await graph.knowledgeSnapshot()).snapshotId).toBe(activeBefore.snapshotId);
    expect(await readFile(sourcePath, "utf8")).toBe(initialNote);

    const changedNote = `${initialNote}\nChanged while reviewing.\n`;
    await writeFile(sourcePath, changedNote);
    const stale = await graph.keepOntology(preview.guard);
    expect(stale.status).toBe("stale");
    expect((await graph.knowledgeSnapshot()).activeOntology.state).toBe("generic");

    const refreshed = stale.review;
    await graph.refreshFile(sourcePath);
    const kept = await graph.keepOntology(refreshed.guard);
    expect(kept.status).toBe("applied");
    expect((await graph.knowledgeSnapshot()).snapshotId).toBe(refreshed.effects?.candidateSnapshotId);
    expect((await graph.knowledgeSnapshot()).activeOntology).toMatchObject({ state: "active", id: "research" });
    expect((await graph.contextForNote(sourcePath))?.outgoing).toEqual([]);
    expect((await graph.contextForNote(sourcePath))?.backlinks).toEqual([]);
    expect((await graph.contextForNote(sourcePath))?.neighborhoodRelations).toEqual([
      expect.objectContaining({
        origin: "ontology",
        predicate: "supports",
        source: "note:notes:source.md",
        target: "note:notes:target.md",
      }),
    ]);
    expect((await graph.contextForNote(sourcePath))?.neighborhood.map((note) => note.title)).toContain("Target");
    expect((await graph.contextForNote(path.join(notes, "target.md")))?.neighborhoodRelations).toEqual([
      expect.objectContaining({
        origin: "ontology",
        predicate: "supports",
        source: "note:notes:source.md",
        target: "note:notes:target.md",
      }),
    ]);
    expect((await graph.contextForNote(path.join(notes, "target.md")))?.neighborhood.map((note) => note.title)).toContain("Source");
    expect(await readFile(sourcePath, "utf8")).toBe(changedNote);

    const restarted = new WorkspaceGraph(model(workspace, notes), { runtimeRoot });
    expect((await restarted.knowledgeSnapshot()).snapshotId).toBe(refreshed.effects?.candidateSnapshotId);
    const activationPath = new WorkspaceOntologyStore({ workspaceRoot: workspace, runtimeRoot }).activationPath;
    const checkpoint = await readFile(activationPath, "utf8");
    await writeFile(activationPath, "{\"broken\":true}\n");
    expect((await restarted.knowledgeSnapshot()).activeOntology).toMatchObject({ state: "active", id: "research" });
    expect((await new WorkspaceGraph(model(workspace, notes), { runtimeRoot }).knowledgeSnapshot()).activeOntology.state).toBe("invalid-state");
    await writeFile(activationPath, checkpoint);
    await writeFile(path.join(workspace, "ontology.yaml"), "ontology_schema: 1\nid: replacement\nversion: 2\n");
    const later = await restarted.previewOntology();
    const activeId = (await restarted.knowledgeSnapshot()).snapshotId;
    const rejectChangedNote = `${changedNote}\nChanged while deciding to reject.\n`;
    await writeFile(sourcePath, rejectChangedNote);
    const staleReject = await restarted.rejectOntology(later.guard);
    expect(staleReject.status).toBe("stale");
    expect(staleReject.review.candidate.rejected).toBe(false);
    expect((await restarted.rejectOntology(staleReject.review.guard)).status).toBe("rejected");
    expect((await restarted.knowledgeSnapshot()).snapshotId).toBe(activeId);

    await unlink(path.join(workspace, "ontology.yaml"));
    const deactivate = await restarted.previewOntology();
    expect(deactivate).toMatchObject({ candidate: { state: "absent" }, effects: { after: { ontologyRelations: 0 } } });
    expect((await restarted.rejectOntology(deactivate.guard)).status).toBe("rejected");
    expect((await restarted.knowledgeSnapshot()).activeOntology.state).toBe("active");
    const reopenedDeactivate = await restarted.previewOntology();
    expect(reopenedDeactivate.candidate.rejected).toBe(true);
    expect((await restarted.keepOntology(reopenedDeactivate.guard)).status).toBe("applied");
    expect((await restarted.knowledgeSnapshot()).activeOntology.state).toBe("generic");
    expect((await restarted.contextForNote(sourcePath))?.neighborhoodRelations).toEqual([]);
    expect(await readFile(sourcePath, "utf8")).toBe(rejectChangedNote);
  });

  it("keeps the common no-candidate Ontology preview off the graph build path", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "exograph-ontology-quiet-"));
    roots.push(workspace);
    const notes = path.join(workspace, "notes");
    await mkdir(notes, { recursive: true });
    await writeFile(path.join(notes, "note.md"), "# Note\n");
    const graph = new WorkspaceGraph(model(workspace, notes), { runtimeRoot: path.join(workspace, ".exograph-test") });

    expect(await graph.status()).toEqual({ state: "stale", noteCount: 0, edgeCount: 0 });
    await expect(graph.previewOntology()).resolves.toMatchObject({
      active: { state: "generic" },
      candidate: { state: "absent", pending: false },
      guard: { baseSnapshotId: "not-pending" },
    });
    expect(await graph.status()).toEqual({ state: "stale", noteCount: 0, edgeCount: 0 });
  });

  it("previews Ontology effects for repository-style mixed-case paths", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "exograph-ontology-repository-paths-"));
    roots.push(workspace);
    await writeFile(path.join(workspace, "README.md"), "# Product\n");
    await writeFile(path.join(workspace, "apps.md"), "# Apps\n");
    await writeFile(path.join(workspace, "ontology.yaml"), [
      "ontology_schema: 1",
      "id: repository",
      "version: 1",
      "types:",
      "  product-context:",
      "    paths: [README.md]",
    ].join("\n"));

    const graph = new WorkspaceGraph(model(workspace, workspace), {
      runtimeRoot: path.join(workspace, ".exograph-test"),
    });

    await expect(graph.previewOntology()).resolves.toMatchObject({
      active: { state: "generic" },
      candidate: { state: "valid", id: "repository" },
    });
  });

  it("switches one reviewed library Ontology at a time and can return to Generic", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "exograph-ontology-library-"));
    roots.push(workspace);
    const notes = path.join(workspace, "notes");
    const runtimeRoot = path.join(workspace, ".exograph-test");
    await mkdir(path.join(workspace, "ontologies"), { recursive: true });
    await mkdir(notes);
    await writeFile(path.join(notes, "note.md"), "---\ntype: project\n---\n# Note\n");
    await writeFile(path.join(workspace, "ontologies", "projects.yaml"), [
      "ontology_schema: 1",
      "id: projects",
      "version: 1",
      "types:",
      "  project: {}",
    ].join("\n"));
    const graph = new WorkspaceGraph(model(workspace, notes), { runtimeRoot });

    const preview = await graph.previewOntology("ontologies/projects.yaml");
    expect(preview).toMatchObject({
      library: [{ sourcePath: "ontologies/projects.yaml", id: "projects" }],
      candidate: { sourcePath: "ontologies/projects.yaml", pending: true },
      guard: { candidateSourcePath: "ontologies/projects.yaml" },
      effects: { after: { typedConcepts: 1 } },
    });
    expect((await graph.keepOntology(preview.guard)).status).toBe("applied");
    await expect(graph.previewOntology()).resolves.toMatchObject({
      active: { state: "active", sourcePath: "ontologies/projects.yaml", id: "projects" },
      candidate: { sourcePath: "ontologies/projects.yaml", pending: false },
    });

    const generic = await graph.previewOntology(null);
    expect(generic).toMatchObject({
      candidate: { sourcePath: null, pending: true },
      effects: { after: { ontologyRelations: 0 } },
    });
    expect((await graph.keepOntology(generic.guard)).status).toBe("applied");
    expect((await graph.knowledgeSnapshot()).activeOntology.state).toBe("generic");
  });
});

function model(workspaceRoot: string, notes: string): WorkspaceModel {
  return { workspaceRoot, defaultTerminalCwd: workspaceRoot, noteRoots: [{ id: "notes", label: "Notes", path: notes }], indexedRoots: [], indexing: { enabled: false, mode: "off", backend: "qmd" } };
}

function relativeMarkdownPaths(filePaths: readonly string[]): string[] {
  return filePaths
    .map((filePath) => path.relative(mixedRepositoryFixture, filePath).replaceAll(path.sep, "/").toLowerCase())
    .sort();
}

function relativeTreeMarkdown(nodes: readonly TreeNode[]): string[] {
  const filePaths: string[] = [];
  const visit = (entries: readonly TreeNode[]) => {
    for (const entry of entries) {
      if (entry.kind === "file") {
        filePaths.push(entry.path);
      } else {
        visit(entry.children ?? []);
      }
    }
  };
  visit(nodes);
  return relativeMarkdownPaths(filePaths);
}
