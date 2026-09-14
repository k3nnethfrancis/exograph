import { access, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { qmdSearchProvider } from "../search-providers/qmd-provider";
import { createIndexedRoot, resolveWorkspaceModel } from "../workspace";
import { repositoryWorkspaceContentPolicy } from "../workspace-content-policy";
import { WorkspaceFiles } from "../workspace-files";

const { readFileMock } = vi.hoisted(() => ({ readFileMock: vi.fn() }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  readFileMock.mockImplementation(actual.readFile);
  return { ...actual, readFile: readFileMock };
});

const stores: MockStore[] = [];
const tempPaths: string[] = [];
let createStoreError: Error | null = null;
let updateError: Error | null = null;
let searchLexResultsOverride: unknown[] | null = null;
const searchLexResultsByCollection = new Map<string, unknown[]>();
let searchVectorResultsOverride: unknown[] | null = null;
let hybridSearchError: Error | null = null;
let documentPathOverride: string | null = null;
let existingQmdCollections: Array<{ name: string; pwd: string }> = [];
let existingQmdDocumentCollections: string[] = [];
interface MockQmdStatus {
  totalDocuments: number;
  needsEmbedding: number;
  hasVectorIndex: boolean;
  collections: Array<{ name: string; documents: number; lastUpdated: string }>;
}
let storeStatusOverride: MockQmdStatus | null = null;

vi.mock("@tobilu/qmd", () => ({
  createStore: vi.fn(async (options: { config?: { collections?: Record<string, { path: string; ignore?: string[] }> } }) => {
    if (createStoreError) {
      throw createStoreError;
    }
    const store = new MockStore(options);
    stores.push(store);
    return store;
  }),
}));

afterEach(async () => {
  vi.restoreAllMocks();
  stores.splice(0);
  createStoreError = null;
  updateError = null;
  searchLexResultsOverride = null;
  searchLexResultsByCollection.clear();
  searchVectorResultsOverride = null;
  hybridSearchError = null;
  documentPathOverride = null;
  existingQmdCollections = [];
  existingQmdDocumentCollections = [];
  readFileMock.mockClear();
  storeStatusOverride = null;
  await Promise.all(tempPaths.splice(0).map((target) => rm(target, { recursive: true, force: true })));
});

describe("QMD index adapter", () => {
  it("exposes QMD search-provider metadata", () => {
    expect(qmdSearchProvider.metadata).toMatchObject({
      id: "qmd",
      label: "QMD search",
      description: expect.stringContaining("Bundled local Markdown search provider"),
      lifecycle: "built-in",
      backend: "qmd",
    });
  });

  it("uses filesystem search when the index is off", async () => {
    const root = await fixtureRoot();
    const model = resolveWorkspaceModel({
      EXOGRAPH_WORKSPACE_ROOT: root,
      EXOGRAPH_NOTE_ROOTS: path.join(root, "notes"),
    });

    const result = await qmdSearchProvider.search(model, path.join(root, ".exograph"), "focus");

    expect(result.source).toBe("filesystem");
    expect(result.warnings[0]).toBe("QMD is unavailable; showing Simple search results.");
    expect(result.results.some((entry) => entry.title === "Focus")).toBe(true);
  });

  it.each(["disabled QMD", "QMD-open failure"] as const)("keeps exact Indexed Root scope during %s filesystem fallback", async (failureMode) => {
    const root = await fixtureRoot();
    const docsPath = path.join(root, "docs");
    const extraPath = path.join(root, "extra");
    await Promise.all([mkdir(docsPath), mkdir(extraPath)]);
    const notePath = path.join(root, "notes", "scope-note.md");
    const docPath = path.join(docsPath, "scope-doc.md");
    const extraFilePath = path.join(extraPath, "scope-extra.md");
    await Promise.all([
      writeFile(notePath, "# Fallback scope\nselected notes\n", "utf8"),
      writeFile(docPath, "# Fallback scope\nselected docs\n", "utf8"),
      writeFile(extraFilePath, "# Fallback scope\nnot indexed\n", "utf8"),
    ]);
    const model = {
      ...resolveWorkspaceModel({
        EXOGRAPH_WORKSPACE_ROOT: root,
        EXOGRAPH_NOTE_ROOTS: [path.join(root, "notes"), docsPath, extraPath].join(path.delimiter),
      }),
      indexedRoots: [
        createIndexedRoot(path.join(root, "notes"), { id: "index-notes", label: "notes", kind: "notes" }),
        createIndexedRoot(docsPath, { id: "index-docs", label: "docs", kind: "docs" }),
      ],
      indexing: failureMode === "disabled QMD"
        ? { enabled: false, mode: "off" as const, backend: "qmd" as const }
        : { enabled: true, mode: "lexical" as const, backend: "qmd" as const },
    };
    if (failureMode === "QMD-open failure") {
      createStoreError = new Error("simulated QMD open failure");
    }
    const cases = [
      { rootIds: undefined, expected: [docPath, notePath] },
      { rootIds: ["index-docs"], expected: [docPath] },
      { rootIds: [] as string[], expected: [] as string[] },
      { rootIds: ["missing"], expected: [] as string[] },
      { rootIds: ["missing", "index-notes"], expected: [notePath] },
    ];

    for (const { rootIds, expected } of cases) {
      const result = await qmdSearchProvider.search(model, path.join(root, ".exograph"), "Fallback scope", { rootIds });
      expect(result.source).toBe("filesystem");
      expect(result.results.map((entry) => entry.filePath).sort()).toEqual(expected.slice().sort());
      expect(result.results.map((entry) => entry.filePath)).not.toContain(extraFilePath);
    }
  });

  it("keeps selected-root scope when QMD hydration failure falls back to filesystem search", async () => {
    const root = await fixtureRoot();
    const docsPath = path.join(root, "docs");
    await mkdir(docsPath);
    const docPath = path.join(docsPath, "focus-doc.md");
    await writeFile(docPath, "# Focus docs\n", "utf8");
    const model = {
      ...resolveWorkspaceModel({
        EXOGRAPH_WORKSPACE_ROOT: root,
        EXOGRAPH_NOTE_ROOTS: [path.join(root, "notes"), docsPath].join(path.delimiter),
      }),
      indexedRoots: [
        createIndexedRoot(path.join(root, "notes"), { id: "index-notes", label: "notes", kind: "notes" }),
        createIndexedRoot(docsPath, { id: "index-docs", label: "docs", kind: "docs" }),
      ],
      indexing: { enabled: true, mode: "lexical" as const, backend: "qmd" as const },
    };
    searchLexResultsOverride = [qmdResult("qmd://notes/focus.md")];
    readFileMock.mockRejectedValueOnce(new Error("simulated hydration read failure"));

    const result = await qmdSearchProvider.search(model, path.join(root, ".exograph"), "focus", {
      rootIds: ["index-notes"],
      includeContent: true,
    });

    expect(result.source).toBe("filesystem");
    expect(result.warnings).toEqual([
      "QMD search failed (simulated hydration read failure); using degraded filesystem search.",
    ]);
    expect(result.results.map((entry) => entry.filePath)).toEqual([path.join(root, "notes", "focus.md")]);
    expect(result.results.map((entry) => entry.filePath)).not.toContain(docPath);
  });

  it("applies Workspace Content Policy exclusions to every QMD collection", async () => {
    const root = await fixtureRoot();
    const notesPath = path.join(root, "notes");
    const repositoryPolicy = repositoryWorkspaceContentPolicy();
    const model = {
      ...indexedModel(root, "lexical"),
      contentPolicy: {
        ...repositoryPolicy,
        excludedPaths: [...repositoryPolicy.excludedPaths, "generated-docs/**"],
      },
    };

    await qmdSearchProvider.search(model, path.join(root, ".exograph"), "focus");

    const configuredStore = stores.find((store) => Object.keys(store.config.collections).length > 0)!;
    const collection = Object.values(configuredStore.config.collections)
      .find((entry) => entry.path === notesPath)!;
    expect(collection.ignore).toEqual(expect.arrayContaining([
      "build/**",
      "generated-docs/**",
      "vendor/**",
    ]));
  });

  it("routes lexical search through QMD collections", async () => {
    const root = await fixtureRoot();
    const indexedRoot = createIndexedRoot(path.join(root, "notes"), { id: "index-notes", label: "notes", kind: "notes" });
    const model = {
      ...resolveWorkspaceModel({
        EXOGRAPH_WORKSPACE_ROOT: root,
        EXOGRAPH_NOTE_ROOTS: path.join(root, "notes"),
      }),
      indexedRoots: [indexedRoot],
      indexing: { enabled: true, mode: "lexical" as const, backend: "qmd" as const },
    };

    const result = await qmdSearchProvider.search(model, path.join(root, ".exograph"), "focus");

    expect(result.source).toBe("qmd");
    expect(stores[0].searchLexCalls).toEqual([{ query: "focus", collection: configuredCollectionForPath(stores[0], path.join(root, "notes")), limit: 12 }]);
    expect(stores[0].updateOptions).toEqual([]);
    expect(result.results[0]).toMatchObject({ title: "Focus", source: "qmd" });
  });

  it("does not reindex an existing empty QMD database", async () => {
    const root = await fixtureRoot();
    const model = indexedModel(root, "lexical");
    await mkdir(path.join(root, ".exograph", "qmd"), { recursive: true });
    await writeFile(path.join(root, ".exograph", "qmd", "index.sqlite"), "", "utf8");

    await qmdSearchProvider.search(model, path.join(root, ".exograph"), "focus");

    expect(stores).toHaveLength(2);
    expect(stores[1].updateOptions).toEqual([]);
    expect(await fileExists(pendingQmdCollectionReindexPath(root))).toBe(false);
  });

  it("rejects duplicate collection identities instead of collapsing root policies", async () => {
    const root = await fixtureRoot();
    const notesPath = path.join(root, "notes");
    const first = createIndexedRoot(notesPath, { id: "first", label: "first", kind: "notes", pattern: "**/*.md", ignore: ["first/**"] });
    const second = createIndexedRoot(notesPath, { id: "second", label: "second", kind: "docs", pattern: "**/*.md", ignore: ["second/**"] });
    const model = { ...indexedModel(root, "lexical"), indexedRoots: [first, second] };

    await expect(qmdSearchProvider.search(model, path.join(root, ".exograph"), "focus")).rejects.toThrow("QMD physical root identity");
    await expect(qmdSearchProvider.update(model, path.join(root, ".exograph"))).rejects.toThrow("QMD physical root identity");
    expect(stores).toEqual([]);
  });

  it("rejects current symlink aliases of the same physical QMD root", async () => {
    const root = await fixtureRoot();
    const physicalPath = path.join(root, "notes");
    const aliasPath = path.join(root, "notes-alias");
    await symlink(physicalPath, aliasPath);
    const physical = createIndexedRoot(physicalPath, { id: "physical", label: "physical", kind: "notes" });
    const alias = createIndexedRoot(aliasPath, { id: "alias", label: "alias", kind: "docs" });
    const model = { ...indexedModel(root, "lexical"), indexedRoots: [physical, alias] };

    await expect(qmdSearchProvider.search(model, path.join(root, ".exograph"), "focus")).rejects.toThrow("QMD physical root identity");
    await expect(qmdSearchProvider.update(model, path.join(root, ".exograph"))).rejects.toThrow("QMD physical root identity");
    expect(stores).toEqual([]);
  });

  it("repairs a stale physical collection after the current root becomes a symlink alias", async () => {
    const root = await fixtureRoot();
    const physicalPath = path.join(root, "notes");
    const aliasPath = path.join(root, "notes-alias");
    await symlink(physicalPath, aliasPath);
    await mkdir(path.join(root, ".exograph", "qmd"), { recursive: true });
    await writeFile(path.join(root, ".exograph", "qmd", "index.sqlite"), "", "utf8");
    existingQmdCollections = [{ name: "stale-physical", pwd: physicalPath }];
    existingQmdDocumentCollections = ["stale-physical"];
    const aliasRoot = createIndexedRoot(aliasPath, { id: "index-notes", label: "notes", kind: "notes" });
    const model = { ...indexedModel(root, "lexical"), indexedRoots: [aliasRoot] };

    const first = await qmdSearchProvider.search(model, path.join(root, ".exograph"), "focus");

    const repairedStore = stores[1];
    const aliasCollection = configuredCollectionForPath(repairedStore, aliasPath);
    expect(repairedStore.updateOptions).toEqual([{ collections: [aliasCollection] }]);
    expect(repairedStore.visibleDocumentCollectionsBeforeUpdates).toEqual([[]]);
    expect(first.results.map((entry) => entry.filePath)).toEqual([path.join(aliasPath, "focus.md")]);

    await qmdSearchProvider.search(model, path.join(root, ".exograph"), "focus");

    expect(stores[3].updateOptions).toEqual([]);
  });

  it("retries an interrupted reindex repair against all current roots and clears its marker", async () => {
    const root = await fixtureRoot();
    const physicalPath = path.join(root, "notes");
    const aliasPath = path.join(root, "notes-alias");
    const docsPath = path.join(root, "docs");
    const projectsPath = path.join(root, "projects");
    await symlink(physicalPath, aliasPath);
    await Promise.all([mkdir(docsPath), mkdir(projectsPath)]);
    await mkdir(path.join(root, ".exograph", "qmd"), { recursive: true });
    await writeFile(path.join(root, ".exograph", "qmd", "index.sqlite"), "", "utf8");
    existingQmdCollections = [{ name: "stale-physical", pwd: physicalPath }];
    const aliasRoot = createIndexedRoot(aliasPath, { id: "index-notes", label: "notes", kind: "notes" });
    const aliasModel = { ...indexedModel(root, "lexical"), indexedRoots: [aliasRoot] };
    updateError = new Error("simulated reindex failure");

    const failed = await qmdSearchProvider.search(aliasModel, path.join(root, ".exograph"), "focus");
    expect(failed.source).toBe("filesystem");
    expect(stores[1].updateCalls).toBe(1);
    expect(await fileExists(pendingQmdCollectionReindexPath(root))).toBe(true);

    const docsRoot = createIndexedRoot(docsPath, { id: "index-docs", label: "docs", kind: "docs" });
    const projectsRoot = createIndexedRoot(projectsPath, { id: "index-projects", label: "projects", kind: "docs" });
    const currentModel = { ...indexedModel(root, "lexical"), indexedRoots: [docsRoot, projectsRoot] };

    updateError = null;
    const retried = await qmdSearchProvider.search(currentModel, path.join(root, ".exograph"), "focus");
    expect(retried.source).toBe("qmd");
    expect(stores[3].updateOptions).toEqual([{
      collections: [
        configuredCollectionForPath(stores[3], docsPath),
        configuredCollectionForPath(stores[3], projectsPath),
      ],
    }]);
    expect(await fileExists(pendingQmdCollectionReindexPath(root))).toBe(false);

    await qmdSearchProvider.search(currentModel, path.join(root, ".exograph"), "focus");
    expect(stores[5].updateCalls).toBe(0);
  });

  it("keeps colliding root IDs independently configured, searchable, updatable, and resolvable", async () => {
    const root = await fixtureRoot();
    const firstPath = path.join(root, "first");
    const secondPath = path.join(root, "second");
    const punctuationPath = path.join(root, "punctuation");
    const lowerCasePunctuationPath = path.join(root, "punctuation-lower");
    await Promise.all([mkdir(firstPath), mkdir(secondPath), mkdir(punctuationPath), mkdir(lowerCasePunctuationPath)]);
    await Promise.all([
      writeFile(path.join(firstPath, "focus.md"), "# First\n", "utf8"),
      writeFile(path.join(secondPath, "focus.md"), "# Second\n", "utf8"),
      writeFile(path.join(punctuationPath, "focus.md"), "# Punctuation\n", "utf8"),
      writeFile(path.join(lowerCasePunctuationPath, "focus.md"), "# Lower punctuation\n", "utf8"),
    ]);
    const first = createIndexedRoot(firstPath, { id: "x", label: "first", kind: "notes" });
    const second = createIndexedRoot(secondPath, { id: "index-x", label: "second", kind: "docs" });
    const punctuation = createIndexedRoot(punctuationPath, { id: "Case /!?é", label: "punctuation", kind: "mixed" });
    const lowerCasePunctuation = createIndexedRoot(lowerCasePunctuationPath, { id: "case /!?é", label: "punctuation lower", kind: "mixed" });
    const model = {
      ...resolveWorkspaceModel({
        EXOGRAPH_WORKSPACE_ROOT: root,
        EXOGRAPH_NOTE_ROOTS: path.join(root, "notes"),
      }),
      indexedRoots: [first, second, punctuation, lowerCasePunctuation],
      indexing: { enabled: true, mode: "lexical" as const, backend: "qmd" as const },
    };

    const firstResult = await qmdSearchProvider.search(model, path.join(root, ".exograph"), "focus", { rootIds: [first.id] });
    const firstSearchStore = stores.find((store) => Object.keys(store.config.collections).length > 0)!;
    const firstConfig = firstSearchStore.config.collections;
    const [firstCollection, secondCollection, punctuationCollection, lowerCasePunctuationCollection] = [first, second, punctuation, lowerCasePunctuation].map((indexedRoot) =>
      Object.entries(firstConfig).find(([, config]) => config.path === indexedRoot.path)?.[0],
    );

    expect(firstCollection).toBeTruthy();
    expect(secondCollection).toBeTruthy();
    expect(punctuationCollection).toBeTruthy();
    expect(lowerCasePunctuationCollection).toBeTruthy();
    expect(new Set([firstCollection, secondCollection, punctuationCollection, lowerCasePunctuationCollection]).size).toBe(4);
    expect(Object.keys(firstConfig)).toHaveLength(4);
    expect(firstCollection).toMatch(/^exograph-root-[0-9a-f]+$/);
    expect(secondCollection).toMatch(/^exograph-root-[0-9a-f]+$/);
    expect(punctuationCollection).toMatch(/^exograph-root-[0-9a-f]+$/);
    expect(lowerCasePunctuationCollection).toMatch(/^exograph-root-[0-9a-f]+$/);
    expect(punctuationCollection).not.toBe(lowerCasePunctuationCollection);
    expect(firstResult.results.map((entry) => entry.filePath)).toEqual([path.join(firstPath, "focus.md")]);
    expect(firstSearchStore.searchLexCalls.map((call) => call.collection)).toEqual([firstCollection]);

    const secondResult = await qmdSearchProvider.search(model, path.join(root, ".exograph"), "focus", { rootIds: [second.id] });
    expect(secondResult.results.map((entry) => entry.filePath)).toEqual([path.join(secondPath, "focus.md")]);
    expect(stores.filter((store) => Object.keys(store.config.collections).length > 0).at(-1)?.searchLexCalls.map((call) => call.collection)).toEqual([secondCollection]);

    await qmdSearchProvider.update(model, path.join(root, ".exograph"), { rootIds: [first.id] });
    await qmdSearchProvider.update(model, path.join(root, ".exograph"), { rootIds: [second.id] });
    const updatedCollections = stores
      .flatMap((store) => store.updateOptions)
      .flatMap((options) => (options as { collections?: string[] }).collections ?? []);
    expect(updatedCollections).toEqual(expect.arrayContaining([firstCollection, secondCollection]));
  });

  it("keeps duplicate root IDs at distinct paths independently configured, selected, updated, and resolved", async () => {
    const root = await fixtureRoot();
    const firstPath = path.join(root, "duplicate-first");
    const secondPath = path.join(root, "duplicate-second");
    await Promise.all([mkdir(firstPath), mkdir(secondPath)]);
    await Promise.all([
      writeFile(path.join(firstPath, "focus.md"), "# First duplicate\n", "utf8"),
      writeFile(path.join(secondPath, "focus.md"), "# Second duplicate\n", "utf8"),
    ]);
    const first = createIndexedRoot(firstPath, { id: "index-duplicate", label: "first", kind: "notes" });
    const second = createIndexedRoot(secondPath, { id: "index-duplicate", label: "second", kind: "docs" });
    const model = {
      ...indexedModel(root, "lexical"),
      indexedRoots: [first, second],
    };

    const result = await qmdSearchProvider.search(model, path.join(root, ".exograph"), "focus", { rootIds: [first.id] });

    const configuredStore = stores[0];
    const collectionEntries = Object.entries(configuredStore.config.collections);
    const firstCollection = collectionEntries.find(([, config]) => config.path === firstPath)?.[0];
    const secondCollection = collectionEntries.find(([, config]) => config.path === secondPath)?.[0];
    expect(firstCollection).toMatch(/^exograph-root-[0-9a-f]{64}$/);
    expect(secondCollection).toMatch(/^exograph-root-[0-9a-f]{64}$/);
    expect(firstCollection).not.toBe(secondCollection);
    expect(Object.keys(configuredStore.config.collections)).toHaveLength(2);
    expect(configuredStore.searchLexCalls.map((call) => call.collection)).toEqual([firstCollection, secondCollection]);
    expect(result.results.map((entry) => entry.filePath).sort()).toEqual([
      path.join(firstPath, "focus.md"),
      path.join(secondPath, "focus.md"),
    ].sort());

    await qmdSearchProvider.update(model, path.join(root, ".exograph"), { rootIds: [first.id] });

    const updatingStore = stores[1];
    expect(updatingStore.updateOptions).toEqual([{ collections: [firstCollection, secondCollection] }]);
  });

  it("keeps a surviving root collection stable when a colliding sibling is added and removed", async () => {
    const root = await fixtureRoot();
    const firstPath = path.join(root, "first");
    const secondPath = path.join(root, "second");
    await Promise.all([mkdir(firstPath), mkdir(secondPath)]);
    const first = createIndexedRoot(firstPath, { id: "x", label: "first", kind: "notes" });
    const second = createIndexedRoot(secondPath, { id: "index-x", label: "second", kind: "docs" });
    const initialModel = { ...indexedModel(root, "lexical"), indexedRoots: [first] };

    await qmdSearchProvider.search(initialModel, path.join(root, ".exograph"), "focus");

    const initialStore = stores[0];
    const firstCollection = configuredCollectionForPath(initialStore, firstPath);
    await mkdir(path.join(root, ".exograph", "qmd"), { recursive: true });
    await writeFile(path.join(root, ".exograph", "qmd", "index.sqlite"), "", "utf8");

    await qmdSearchProvider.search({ ...initialModel, indexedRoots: [first, second] }, path.join(root, ".exograph"), "focus");

    const addedSiblingStore = stores[2];
    expect(configuredCollectionForPath(addedSiblingStore, firstPath)).toBe(firstCollection);
    expect(addedSiblingStore.updateOptions).toEqual([]);

    await qmdSearchProvider.search(initialModel, path.join(root, ".exograph"), "focus");

    const removedSiblingStore = stores[4];
    expect(configuredCollectionForPath(removedSiblingStore, firstPath)).toBe(firstCollection);
    expect(removedSiblingStore.updateOptions).toEqual([]);
  });

  it("reconfigures a stale collection-name collision once before serving newly distinct roots", async () => {
    const root = await fixtureRoot();
    const firstPath = path.join(root, "first");
    const secondPath = path.join(root, "second");
    await Promise.all([mkdir(firstPath), mkdir(secondPath)]);
    const first = createIndexedRoot(firstPath, { id: "index-duplicate", label: "first", kind: "notes" });
    const second = createIndexedRoot(secondPath, { id: "index-duplicate", label: "second", kind: "docs" });
    existingQmdCollections = [{ name: "duplicate", pwd: secondPath }];
    existingQmdDocumentCollections = ["duplicate"];
    await mkdir(path.join(root, ".exograph", "qmd"), { recursive: true });
    await writeFile(path.join(root, ".exograph", "qmd", "index.sqlite"), "", "utf8");
    const model = {
      ...indexedModel(root, "lexical"),
      indexedRoots: [first, second],
    };

    await qmdSearchProvider.search(model, path.join(root, ".exograph"), "focus");

    const configuredStore = stores[1];
    expect(configuredStore.updateOptions).toEqual([{
      collections: [
        configuredCollectionForPath(configuredStore, firstPath),
        configuredCollectionForPath(configuredStore, secondPath),
      ],
    }]);
    expect(configuredCollectionForPath(configuredStore, secondPath)).not.toBe("duplicate");
    expect(configuredStore.visibleDocumentCollectionsBeforeUpdates).toEqual([[]]);
    expect(existingQmdCollections.map((collection) => collection.name)).toEqual(Object.keys(configuredStore.config.collections));

    await qmdSearchProvider.search(model, path.join(root, ".exograph"), "focus");

    const secondConfiguredStore = stores[3];
    expect(secondConfiguredStore.updateOptions).toEqual([]);
  });

  it("orders score ties by canonical identity beyond the first provider prefix", async () => {
    const root = await fixtureRoot();
    const notePaths = ["a.md", "b.md", "c.md", "d.md"].map((name) => path.join(root, "notes", name));
    await Promise.all(notePaths.map((filePath) => writeFile(filePath, "# Result\n", "utf8")));
    searchLexResultsOverride = [
      qmdResult(notePaths[1], 1),
      qmdResult(notePaths[2], 1),
      qmdResult(notePaths[0], 1),
      qmdResult(notePaths[3], 0.5),
    ];

    const result = await qmdSearchProvider.search(indexedModel(root, "lexical"), path.join(root, ".exograph"), "result", { limit: 2 });

    expect(result.results.map((entry) => entry.filePath)).toEqual(notePaths.slice(0, 2));
    expect(result.hasMore).toBe(true);
    expect(stores[0].searchLexCalls.map((call) => call.limit)).toEqual([4]);
  });

  it("deduplicates canonical identities across lexical and vector cursor pages", async () => {
    const root = await fixtureRoot();
    const notePaths = ["a.md", "b.md", "c.md", "d.md", "e.md", "f.md", "g.md", "h.md", "i.md", "j.md", "k.md"].map((name) => path.join(root, "notes", name));
    await Promise.all(notePaths.map((filePath) => writeFile(filePath, "# Result\n", "utf8")));
    const aliasPath = path.join(root, "notes", "alias-a.md");
    await symlink(notePaths[0], aliasPath);
    searchLexResultsOverride = [
      qmdResult(aliasPath, 0.95),
      qmdResult(notePaths[2], 0.9),
      qmdResult(notePaths[3], 0.88),
      qmdResult(notePaths[4], 0.8),
      qmdResult(notePaths[5], 0.7),
      qmdResult(notePaths[6], 0.6),
    ];
    searchVectorResultsOverride = [
      qmdResult(notePaths[0], 0.94),
      qmdResult(notePaths[1], 0.92),
      qmdResult(notePaths[7], 0.87),
      qmdResult(notePaths[8], 0.79),
      qmdResult(notePaths[9], 0.69),
      qmdResult(notePaths[10], 0.59),
    ];
    storeStatusOverride = {
      totalDocuments: 11,
      needsEmbedding: 0,
      hasVectorIndex: true,
      collections: [{ name: "notes", documents: 11, lastUpdated: "2026-05-15T00:00:00.000Z" }],
    };

    const model = indexedModel(root, "semantic");
    const firstPage = await qmdSearchProvider.search(model, path.join(root, ".exograph"), "result", { limit: 2 });
    const secondPage = await qmdSearchProvider.search(model, path.join(root, ".exograph"), "result", {
      limit: 2,
      offset: firstPage.results.length,
    });
    expect(firstPage.results.map((entry) => entry.filePath)).toEqual([aliasPath, notePaths[1]]);
    expect(firstPage.results[0].score).toBe(0.95);
    expect(firstPage.hasMore).toBe(true);
    expect(secondPage.results.map((entry) => entry.filePath)).toEqual([notePaths[2], notePaths[3]]);
    expect(secondPage.hasMore).toBe(true);
    const combined = [...firstPage.results, ...secondPage.results];
    expect(new Set(combined.map((entry) => entry.filePath === aliasPath ? notePaths[0] : entry.filePath)).size).toBe(4);
    expect(stores.flatMap((store) => store.searchCalls)).toEqual([]);
    expect(stores[0].searchLexCalls.map((call) => call.limit)).toEqual([4]);
    expect(stores[0].searchVectorCalls.map((call) => call.limit)).toEqual([4]);
    expect(stores[1].searchLexCalls.map((call) => call.limit)).toEqual([6]);
    expect(stores[1].searchVectorCalls.map((call) => call.limit)).toEqual([6]);
  });

  it("returns the available terminal semantic page from QMD's short vector horizon", async () => {
    const root = await fixtureRoot();
    const notePaths = ["a.md", "b.md", "c.md"].map((name) => path.join(root, "notes", name));
    await Promise.all(notePaths.map((filePath) => writeFile(filePath, "# Result\n", "utf8")));
    searchLexResultsOverride = [qmdResult(notePaths[0], 0.9)];
    searchVectorResultsOverride = [
      qmdResult(notePaths[1], 0.8),
      qmdResult(notePaths[2], 0.7),
    ];
    storeStatusOverride = {
      totalDocuments: 3,
      needsEmbedding: 0,
      hasVectorIndex: true,
      collections: [{ name: "notes", documents: 3, lastUpdated: "2026-05-15T00:00:00.000Z" }],
    };

    const result = await qmdSearchProvider.search(indexedModel(root, "semantic"), path.join(root, ".exograph"), "result", {
      limit: 2,
      offset: 2,
    });

    expect(result.results.map((entry) => entry.filePath)).toEqual([notePaths[2]]);
    expect(result.hasMore).toBe(false);
    expect(stores[0].searchLexCalls.map((call) => call.limit)).toEqual([6]);
    expect(stores[0].searchVectorCalls.map((call) => call.limit)).toEqual([6]);
  });

  it("refills a successful hybrid stream before computing pagination", async () => {
    const root = await fixtureRoot();
    const notePaths = ["a.md", "b.md", "c.md", "d.md"].map((name) => path.join(root, "notes", name));
    await Promise.all(notePaths.map((filePath) => writeFile(filePath, "# Result\n", "utf8")));
    searchLexResultsOverride = [
      qmdResult(path.join(root, "notes", "stale.md"), 1),
      ...notePaths.map((filePath, index) => qmdResult(filePath, 0.9 - index / 10)),
    ];
    storeStatusOverride = {
      totalDocuments: 4,
      needsEmbedding: 0,
      hasVectorIndex: true,
      collections: [{ name: "notes", documents: 4, lastUpdated: "2026-05-15T00:00:00.000Z" }],
    };

    const result = await qmdSearchProvider.search(indexedModel(root, "hybrid"), path.join(root, ".exograph"), "result", { limit: 2 });

    expect(result.mode).toBe("hybrid");
    expect(result.results.map((entry) => entry.filePath)).toEqual(notePaths.slice(0, 2));
    expect(result.hasMore).toBe(true);
    expect(result.warnings).toEqual(["Dropped 1 invalid or stale QMD result."]);
    expect(stores[0].searchCalls.map((call) => call.limit)).toEqual([4, 8]);
  });

  it.each(["semantic", "hybrid"] as const)("refills a fresh lexical stream when %s search falls back", async (mode) => {
    const root = await fixtureRoot();
    const notePaths = ["a.md", "b.md", "c.md", "d.md"].map((name) => path.join(root, "notes", name));
    await Promise.all(notePaths.map((filePath) => writeFile(filePath, "# Result\n", "utf8")));
    searchLexResultsOverride = [
      qmdResult(path.join(root, "notes", "stale.md"), 1),
      ...notePaths.map((filePath, index) => qmdResult(filePath, 0.9 - index / 10)),
    ];
    storeStatusOverride = {
      totalDocuments: 4,
      needsEmbedding: 0,
      hasVectorIndex: true,
      collections: [{ name: "notes", documents: 4, lastUpdated: "2026-05-15T00:00:00.000Z" }],
    };
    hybridSearchError = mode === "hybrid" ? new Error("no vectors") : null;

    const result = await qmdSearchProvider.search(indexedModel(root, mode), path.join(root, ".exograph"), "result", { limit: 2 });

    expect(result.mode).toBe("lexical");
    expect(result.results.map((entry) => entry.filePath)).toEqual(notePaths.slice(0, 2));
    expect(result.hasMore).toBe(true);
    expect(result.warnings).toEqual([
      `${mode[0].toUpperCase()}${mode.slice(1)} search is not ready (no vectors); using lexical search.`,
      "Dropped 1 invalid or stale QMD result.",
    ]);
    expect(stores[0].searchLexCalls.map((call) => call.limit)).toEqual(mode === "semantic" ? [4, 4, 8] : [4, 8]);
    if (mode === "semantic") {
      expect(stores[0].searchVectorCalls.map((call) => call.limit)).toEqual([4]);
    } else {
      expect(stores[0].searchCalls.map((call) => call.limit)).toEqual([4]);
    }
  });

  it.each(["lexical", "hybrid"] as const)("enforces selected-root authority during %s search", async (mode) => {
    const root = await fixtureRoot();
    const docsPath = path.join(root, "docs");
    const secretPath = path.join(docsPath, "secret.md");
    await mkdir(docsPath);
    await writeFile(secretPath, "# Secret\n", "utf8");
    const model = {
      ...indexedModel(root, mode),
      indexedRoots: [
        createIndexedRoot(path.join(root, "notes"), { id: "index-notes", label: "notes", kind: "notes" }),
        createIndexedRoot(docsPath, { id: "index-docs", label: "docs", kind: "docs" }),
      ],
    };
    hybridSearchError = mode === "hybrid" ? new Error("no vectors") : null;
    searchLexResultsOverride = [
      qmdResult("qmd://notes/focus.md", 0.9),
      qmdResult("qmd://docs/secret.md", 0.8),
      qmdResult(secretPath, 0.7),
    ];

    const result = await qmdSearchProvider.search(model, path.join(root, ".exograph"), "focus", {
      rootIds: ["index-notes"],
      includeContent: true,
    });

    expect(result.results.map((entry) => entry.filePath)).toEqual([path.join(root, "notes", "focus.md")]);
    expect(result.warnings).toContain("Dropped 2 invalid or stale QMD results.");
    expect(stores[0].searchLexCalls.every((call) => call.collection === configuredCollectionForPath(stores[0], path.join(root, "notes")))).toBe(true);
    if (mode === "hybrid") {
      expect(stores[0].searchCalls).toEqual([expect.objectContaining({ collections: [configuredCollectionForPath(stores[0], path.join(root, "notes"))] })]);
    }
    expect(readFileMock).toHaveBeenCalledTimes(1);
    expect(readFileMock).not.toHaveBeenCalledWith(secretPath, "utf8");
  });

  it.each([false, true])("refills limit-truncated %scontent search after initial authorization rejection", async (includeContent) => {
    const root = await fixtureRoot();
    const stalePath = path.join(root, "notes", "stale.md");
    const notePaths = ["a.md", "b.md", "c.md", "d.md"].map((name) => path.join(root, "notes", name));
    await Promise.all(notePaths.map((filePath, index) => writeFile(filePath, `# Result ${index + 1}\n`, "utf8")));
    searchLexResultsOverride = [
      qmdResult(stalePath, 1),
      ...notePaths.map((filePath, index) => qmdResult(filePath, 0.9 - index / 10)),
    ];

    const firstPage = await qmdSearchProvider.search(indexedModel(root, "lexical"), path.join(root, ".exograph"), "result", {
      includeContent,
      limit: 2,
      offset: 0,
    });
    const secondPage = await qmdSearchProvider.search(indexedModel(root, "lexical"), path.join(root, ".exograph"), "result", {
      includeContent,
      limit: 2,
      offset: firstPage.results.length,
    });

    expect(firstPage.results.map((entry) => entry.filePath)).toEqual(notePaths.slice(0, 2));
    expect(firstPage.hasMore).toBe(true);
    expect(secondPage.results.map((entry) => entry.filePath)).toEqual(notePaths.slice(2));
    expect(secondPage.hasMore).toBe(false);
    expect(new Set([...firstPage.results, ...secondPage.results].map((entry) => entry.filePath)).size).toBe(4);
    expect(firstPage.warnings.filter((warning) => warning.includes("invalid or stale QMD"))).toEqual(["Dropped 1 invalid or stale QMD result."]);
    expect(secondPage.warnings.filter((warning) => warning.includes("invalid or stale QMD"))).toEqual(["Dropped 1 invalid or stale QMD result."]);
    expect(stores[0].searchLexCalls.map((call) => call.limit)).toEqual([4, 8]);
    expect(stores[1].searchLexCalls.map((call) => call.limit)).toEqual([6]);
    expect(readFileMock).not.toHaveBeenCalledWith(stalePath, "utf8");
    expect(firstPage.results.every((entry) => includeContent ? typeof entry.content === "string" : entry.content === undefined)).toBe(true);
  });

  it("paginates over the post-hydration result set without duplicates or skipped rows", async () => {
    const root = await fixtureRoot();
    const notePaths = ["a.md", "b.md", "c.md", "d.md", "e.md"].map((name) => path.join(root, "notes", name));
    await Promise.all(notePaths.map((filePath, index) => writeFile(filePath, `# Result ${index + 1}\n`, "utf8")));
    searchLexResultsOverride = notePaths.map((filePath, index) => qmdResult(filePath, 1 - index / 10));

    const originalExistingIdentity = WorkspaceFiles.prototype.existingIdentity;
    const authorityCalls = new Map<string, number>();
    vi.spyOn(WorkspaceFiles.prototype, "existingIdentity").mockImplementation(async function (this: WorkspaceFiles, targetPath: string) {
      const callCount = (authorityCalls.get(targetPath) ?? 0) + 1;
      authorityCalls.set(targetPath, callCount);
      if (targetPath === notePaths[1] && callCount % 2 === 0) {
        throw new Error("simulated path change before hydration");
      }
      return originalExistingIdentity.call(this, targetPath);
    });

    const firstPage = await qmdSearchProvider.search(indexedModel(root, "lexical"), path.join(root, ".exograph"), "result", {
      includeContent: true,
      limit: 2,
      offset: 0,
    });
    authorityCalls.clear();
    const secondPage = await qmdSearchProvider.search(indexedModel(root, "lexical"), path.join(root, ".exograph"), "result", {
      includeContent: true,
      limit: 2,
      offset: firstPage.results.length,
    });

    expect(firstPage.results.map((entry) => entry.filePath)).toEqual([notePaths[0], notePaths[2]]);
    expect(firstPage.hasMore).toBe(true);
    expect(secondPage.results.map((entry) => entry.filePath)).toEqual([notePaths[3], notePaths[4]]);
    expect(secondPage.hasMore).toBe(false);
    expect(new Set([...firstPage.results, ...secondPage.results].map((entry) => entry.filePath)).size).toBe(4);
    expect(firstPage.warnings.filter((warning) => warning.includes("invalid or stale QMD"))).toEqual(["Dropped 1 invalid or stale QMD result."]);
    expect(secondPage.warnings.filter((warning) => warning.includes("invalid or stale QMD"))).toEqual(["Dropped 1 invalid or stale QMD result."]);
    expect(stores[0].searchLexCalls.map((call) => call.limit)).toEqual([4, 8]);
    expect(stores[1].searchLexCalls.map((call) => call.limit)).toEqual([6]);
    expect(readFileMock).not.toHaveBeenCalledWith(notePaths[1], "utf8");
  });

  it("stops refilling when the selected provider stream proves exhaustion", async () => {
    const root = await fixtureRoot();
    const notePaths = ["a.md", "b.md"].map((name) => path.join(root, "notes", name));
    await Promise.all(notePaths.map((filePath, index) => writeFile(filePath, `# Result ${index + 1}\n`, "utf8")));
    searchLexResultsOverride = notePaths.map((filePath, index) => qmdResult(filePath, 1 - index / 10));

    const result = await qmdSearchProvider.search(indexedModel(root, "lexical"), path.join(root, ".exograph"), "result", { limit: 2 });

    expect(result.results.map((entry) => entry.filePath)).toEqual(notePaths);
    expect(result.hasMore).toBe(false);
    expect(result.warnings).toEqual([]);
    expect(stores[0].searchLexCalls.map((call) => call.limit)).toEqual([4]);
  });

  it("preserves deep cursor offsets beyond the post-filter refill slack", async () => {
    const root = await fixtureRoot();
    const notePaths = Array.from({ length: 122 }, (_, index) => path.join(root, "notes", `deep-${String(index).padStart(3, "0")}.md`));
    await Promise.all(notePaths.map((filePath) => writeFile(filePath, "# Deep result\n", "utf8")));
    searchLexResultsOverride = notePaths.map((filePath, index) => qmdResult(filePath, 1 - index / 1000));
    const model = indexedModel(root, "lexical");

    const sixthPage = await qmdSearchProvider.search(model, path.join(root, ".exograph"), "deep", { limit: 20, offset: 100 });
    const seventhPage = await qmdSearchProvider.search(model, path.join(root, ".exograph"), "deep", { limit: 20, offset: 120 });

    expect(sixthPage.results.map((entry) => entry.filePath)).toEqual(notePaths.slice(100, 120));
    expect(sixthPage.hasMore).toBe(true);
    expect(seventhPage.results.map((entry) => entry.filePath)).toEqual(notePaths.slice(120));
    expect(seventhPage.hasMore).toBe(false);
    expect(stores[0].searchLexCalls.map((call) => call.limit)).toEqual([122]);
    expect(stores[1].searchLexCalls.map((call) => call.limit)).toEqual([142]);
  });

  it("returns authorized partial results when a provider stream reaches its refill limit", async () => {
    const root = await fixtureRoot();
    const cappedPaths = Array.from({ length: 104 }, (_, index) => path.join(root, "notes", `capped-${index}.md`));
    await Promise.all(cappedPaths.slice(0, 2).map((filePath) => writeFile(filePath, "# Authorized\n", "utf8")));
    searchLexResultsOverride = cappedPaths.map((filePath, index) => qmdResult(filePath, 1 - index / 1000));

    const result = await qmdSearchProvider.search(indexedModel(root, "lexical"), path.join(root, ".exograph"), "result", {
      limit: 2,
    });

    expect(result.results.map((entry) => entry.filePath)).toEqual(cappedPaths.slice(0, 2));
    expect(result.hasMore).toBe(true);
    expect(result.incomplete).toEqual({
      reason: "authorization_refill_limit",
      requested: 2,
      returned: 2,
    });
    expect(result.warnings).toContain("QMD reached its authorization scan limit; returning the authorized results found so far.");
    expect(stores[0].searchLexCalls.map((call) => call.limit)).toEqual([4, 8, 16, 32, 64, 103]);
    expect(readFileMock).not.toHaveBeenCalled();
  });

  it("returns an empty partial result when the refill limit finds no authorized paths", async () => {
    const root = await fixtureRoot();
    const stalePaths = Array.from({ length: 104 }, (_, index) => path.join(root, "notes", `stale-${index}.md`));
    searchLexResultsOverride = stalePaths.map((filePath, index) => qmdResult(filePath, 1 - index / 1000));

    const result = await qmdSearchProvider.search(indexedModel(root, "lexical"), path.join(root, ".exograph"), "result", {
      limit: 2,
    });

    expect(result.results).toEqual([]);
    expect(result.hasMore).toBe(true);
    expect(result.incomplete).toEqual({
      reason: "authorization_refill_limit",
      requested: 2,
      returned: 0,
    });
    expect(result.warnings).toContain("QMD reached its authorization scan limit; returning the authorized results found so far.");
  });

  it("preserves global score ordering while refilling bounded collection streams", async () => {
    const root = await fixtureRoot();
    const docsPath = path.join(root, "docs");
    await mkdir(docsPath);
    const stalePaths = [
      path.join(root, "notes", "stale-a.md"),
      path.join(root, "notes", "stale-b.md"),
    ];
    const notesResults = [
      [stalePaths[0], 1],
      [stalePaths[1], 0.98],
      [path.join(root, "notes", "note-a.md"), 0.95],
      [path.join(root, "notes", "note-b.md"), 0.9],
      [path.join(root, "notes", "note-c.md"), 0.85],
    ] as const;
    const docsResults = [
      [path.join(docsPath, "doc-a.md"), 0.8],
      [path.join(docsPath, "doc-b.md"), 0.7],
      [path.join(docsPath, "doc-c.md"), 0.6],
    ] as const;
    await Promise.all([...notesResults.slice(2), ...docsResults].map(([filePath]) => writeFile(filePath, "# Result\n", "utf8")));
    searchLexResultsByCollection.set("notes", notesResults.map(([filePath, score]) => qmdResult(filePath, score)));
    searchLexResultsByCollection.set("docs", docsResults.map(([filePath, score]) => qmdResult(filePath, score)));
    const model = {
      ...indexedModel(root, "lexical"),
      indexedRoots: [
        createIndexedRoot(path.join(root, "notes"), { id: "index-notes", label: "notes", kind: "notes" }),
        createIndexedRoot(docsPath, { id: "index-docs", label: "docs", kind: "docs" }),
      ],
    };

    const firstPage = await qmdSearchProvider.search(model, path.join(root, ".exograph"), "result", { limit: 2 });
    const secondPage = await qmdSearchProvider.search(model, path.join(root, ".exograph"), "result", {
      limit: 2,
      offset: firstPage.results.length,
    });
    const thirdPage = await qmdSearchProvider.search(model, path.join(root, ".exograph"), "result", {
      limit: 2,
      offset: firstPage.results.length + secondPage.results.length,
    });

    expect(firstPage.results.map((entry) => entry.filePath)).toEqual([notesResults[2][0], notesResults[3][0]]);
    expect(firstPage.hasMore).toBe(true);
    expect(secondPage.results.map((entry) => entry.filePath)).toEqual([notesResults[4][0], docsResults[0][0]]);
    expect(secondPage.hasMore).toBe(true);
    expect(thirdPage.results.map((entry) => entry.filePath)).toEqual([docsResults[1][0], docsResults[2][0]]);
    expect(thirdPage.hasMore).toBe(false);
    expect(firstPage.warnings).toEqual(["Dropped 2 invalid or stale QMD results."]);
    expect(secondPage.warnings).toEqual(["Dropped 2 invalid or stale QMD results."]);
    expect(thirdPage.warnings).toEqual(["Dropped 2 invalid or stale QMD results."]);
    expect(stores[0].searchLexCalls).toEqual([
      { query: "result", collection: configuredCollectionForPath(stores[0], path.join(root, "notes")), limit: 4 },
      { query: "result", collection: configuredCollectionForPath(stores[0], docsPath), limit: 4 },
      { query: "result", collection: configuredCollectionForPath(stores[0], path.join(root, "notes")), limit: 8 },
    ]);
    expect(stores[1].searchLexCalls).toEqual([
      { query: "result", collection: configuredCollectionForPath(stores[1], path.join(root, "notes")), limit: 6 },
      { query: "result", collection: configuredCollectionForPath(stores[1], docsPath), limit: 6 },
    ]);
    expect(stores[2].searchLexCalls).toEqual([
      { query: "result", collection: configuredCollectionForPath(stores[2], path.join(root, "notes")), limit: 8 },
      { query: "result", collection: configuredCollectionForPath(stores[2], docsPath), limit: 8 },
    ]);
  });

  it.each([
    { label: "empty", rootIds: [] as string[], collections: [] as string[], expectedPaths: [] as string[] },
    { label: "unknown-only", rootIds: ["missing"], collections: [] as string[], expectedPaths: [] as string[] },
    { label: "mixed known and unknown", rootIds: ["missing", "index-notes"], collections: ["notes"], expectedPaths: ["focus.md"] },
  ])("treats $label search root IDs as an exact known-ID intersection", async ({ rootIds, collections, expectedPaths }) => {
    const root = await fixtureRoot();
    const docsPath = path.join(root, "docs");
    await mkdir(docsPath);
    await writeFile(path.join(docsPath, "secret.md"), "# Secret\n", "utf8");
    const model = {
      ...indexedModel(root, "lexical"),
      indexedRoots: [
        createIndexedRoot(path.join(root, "notes"), { id: "index-notes", label: "notes", kind: "notes" }),
        createIndexedRoot(docsPath, { id: "index-docs", label: "docs", kind: "docs" }),
      ],
    };
    searchLexResultsOverride = [
      qmdResult("qmd://notes/focus.md", 0.9),
      qmdResult("qmd://docs/secret.md", 0.8),
    ];

    const result = await qmdSearchProvider.search(model, path.join(root, ".exograph"), "focus", { rootIds, includeContent: true });

    expect(result.results.map((entry) => path.basename(entry.filePath))).toEqual(expectedPaths);
    expect(stores[0].searchLexCalls.map((call) => call.collection)).toEqual(collections.map((collection) =>
      configuredCollectionForPath(stores[0], collection === "notes" ? path.join(root, "notes") : docsPath)));
    expect(readFileMock).toHaveBeenCalledTimes(expectedPaths.length);
  });

  it("drops an absolute QMD path outside configured indexed roots", async () => {
    const root = await fixtureRoot();
    const outsidePath = path.join(root, "outside.md");
    await writeFile(outsidePath, "# Outside\n", "utf8");
    searchLexResultsOverride = [qmdResult(outsidePath)];

    const result = await qmdSearchProvider.search(indexedModel(root, "lexical"), path.join(root, ".exograph"), "focus");

    expect(result.results).toEqual([]);
    expect(result.warnings).toContain("Dropped 1 invalid or stale QMD result.");
  });

  it("drops a QMD result whose path escapes through a symlink", async () => {
    const root = await fixtureRoot();
    const outsidePath = path.join(root, "outside.md");
    await writeFile(outsidePath, "# Outside\n", "utf8");
    await symlink(outsidePath, path.join(root, "notes", "escape.md"));
    searchLexResultsOverride = [qmdResult("qmd://notes/escape.md")];

    const result = await qmdSearchProvider.search(indexedModel(root, "lexical"), path.join(root, ".exograph"), "focus");

    expect(result.results).toEqual([]);
    expect(result.warnings).toContain("Dropped 1 invalid or stale QMD result.");
  });

  it("drops a QMD traversal result even when it lands in another indexed root", async () => {
    const root = await fixtureRoot();
    await mkdir(path.join(root, "docs"));
    await writeFile(path.join(root, "docs", "outside.md"), "# Outside\n", "utf8");
    const model = {
      ...indexedModel(root, "lexical"),
      indexedRoots: [
        createIndexedRoot(path.join(root, "notes"), { id: "index-notes", label: "notes", kind: "notes" }),
        createIndexedRoot(path.join(root, "docs"), { id: "index-docs", label: "docs", kind: "docs" }),
      ],
    };
    searchLexResultsOverride = [qmdResult("qmd://notes/../docs/outside.md")];

    const result = await qmdSearchProvider.search(model, path.join(root, ".exograph"), "focus");

    expect(result.results).toEqual([]);
    expect(result.warnings).toContain("Dropped 2 invalid or stale QMD results.");
  });

  it("returns a contained QMD result and hydrates its content", async () => {
    const root = await fixtureRoot();
    searchLexResultsOverride = [qmdResult("qmd://notes/focus.md")];

    const result = await qmdSearchProvider.search(indexedModel(root, "lexical"), path.join(root, ".exograph"), "focus", { includeContent: true });

    expect(result.results).toEqual([expect.objectContaining({
      filePath: path.join(root, "notes", "focus.md"),
      content: "# Focus\nalpha\nbeta\n",
    })]);
  });

  it("does not read rejected QMD targets when hydrating content", async () => {
    const root = await fixtureRoot();
    const outsidePath = path.join(root, "outside.md");
    await writeFile(outsidePath, "secret\n", "utf8");
    searchLexResultsOverride = [qmdResult(outsidePath)];
    const result = await qmdSearchProvider.search(indexedModel(root, "lexical"), path.join(root, ".exograph"), "focus", { includeContent: true });

    expect(result.results).toEqual([]);
    expect(readFileMock).not.toHaveBeenCalled();
  });

  it("falls back to filesystem title and body search when QMD cannot open", async () => {
    const root = await fixtureRoot();
    const notePath = path.join(root, "notes", "sigmund.md");
    await writeFile(
      notePath,
      [
        "---",
        "title: Sigmund Lab",
        "tags: [cybernetics]",
        "---",
        "",
        "Ashby shows up only in the note body.",
        "",
      ].join("\n"),
      "utf8",
    );
    const model = indexedModel(root, "hybrid");
    createStoreError = new Error("The module was compiled against a different Node.js version using NODE_MODULE_VERSION 127");

    const bodyResult = await qmdSearchProvider.search(model, path.join(root, ".exograph"), "Ashby");
    const titleResult = await qmdSearchProvider.search(model, path.join(root, ".exograph"), "Sigmund Lab");

    expect(bodyResult.source).toBe("filesystem");
    expect(bodyResult.warnings[0]).toContain("QMD native ABI mismatch");
    expect(bodyResult.results[0]).toMatchObject({ filePath: notePath, title: "Sigmund Lab", source: "filesystem" });
    expect(bodyResult.results[0].snippet).toContain("Ashby");
    expect(titleResult.results[0]).toMatchObject({ filePath: notePath, title: "Sigmund Lab", snippet: "title: Sigmund Lab" });
  });

  it("reports an exact managed-runtime recovery when QMD status hits an ABI mismatch", async () => {
    const root = await fixtureRoot();
    const model = indexedModel(root, "hybrid");
    createStoreError = new Error("The module was compiled against a different Node.js version using NODE_MODULE_VERSION 127");

    const status = await qmdSearchProvider.getStatus(model, path.join(root, ".exograph"));

    expect(status.errors[0]).toContain("NODE_MODULE_VERSION 127");
    expect(status.warnings).toContain(
      "QMD native ABI mismatch. Reinstall the packaged app from a checkout with `./scripts/install-mac-app --with-cli`; Exograph runs QMD in its managed desktop runtime.",
    );
  });

  it("reports missing vec0 separately when degraded search is used", async () => {
    const root = await fixtureRoot();
    const model = indexedModel(root, "hybrid");
    createStoreError = new Error("SQLITE_ERROR: no such module: vec0");

    const result = await qmdSearchProvider.search(model, path.join(root, ".exograph"), "focus");

    expect(result.source).toBe("filesystem");
    expect(result.warnings[0]).toContain("QMD vec0 extension is unavailable");
  });

  it("runs hybrid search against every selected indexed root", async () => {
    const root = await fixtureRoot();
    const model = {
      ...resolveWorkspaceModel({
        EXOGRAPH_WORKSPACE_ROOT: root,
        EXOGRAPH_NOTE_ROOTS: path.join(root, "notes"),
      }),
      indexedRoots: [
        createIndexedRoot(path.join(root, "notes"), { id: "index-notes", label: "notes", kind: "notes" }),
        createIndexedRoot(path.join(root, "docs"), { id: "index-docs", label: "docs", kind: "docs" }),
      ],
      indexing: { enabled: true, mode: "hybrid" as const, backend: "qmd" as const },
    };

    await qmdSearchProvider.search(model, path.join(root, ".exograph"), "focus");

    expect(stores[0].searchCalls.map((call) => call.collections)).toEqual([
      [configuredCollectionForPath(stores[0], path.join(root, "notes"))],
      [configuredCollectionForPath(stores[0], path.join(root, "docs"))],
    ]);
  });

  it("reports status and delegates update/embed", async () => {
    const root = await fixtureRoot();
    const model = indexedModel(root, "hybrid");

    const status = await qmdSearchProvider.getStatus(model, path.join(root, ".exograph"));
    expect(status.dbPath).toContain(path.join(".exograph", "qmd", "index.sqlite"));
    expect(status.documentCount).toBe(1);
    expect(status.pendingEmbeddings).toBe(1);
    expect(status.warnings.join(" ")).not.toContain("exograph index sync");

    await qmdSearchProvider.update(model, path.join(root, ".exograph"));
    await qmdSearchProvider.embed(model, path.join(root, ".exograph"));

    expect(stores.some((store) => store.updateCalls === 1)).toBe(true);
    expect(stores.some((store) => store.embedCalls === 1)).toBe(true);
  });

  it("distinguishes an empty semantic index from a missing non-empty vector index", async () => {
    const root = await fixtureRoot();
    const model = indexedModel(root, "hybrid");
    storeStatusOverride = {
      totalDocuments: 0,
      needsEmbedding: 0,
      hasVectorIndex: false,
      collections: [{ name: "notes", documents: 0, lastUpdated: "2026-05-15T00:00:00.000Z" }],
    };
    const empty = await qmdSearchProvider.getStatus(model, path.join(root, ".exograph"));
    expect(empty.warnings).not.toContainEqual(expect.stringContaining("Semantic vector index is unavailable"));

    storeStatusOverride = {
      ...storeStatusOverride,
      totalDocuments: 1,
      collections: [{ name: "notes", documents: 1, lastUpdated: "2026-05-15T00:00:00.000Z" }],
    };
    const inconsistent = await qmdSearchProvider.getStatus(model, path.join(root, ".exograph"));
    expect(inconsistent.warnings).toContain("Semantic vector index is unavailable even though no embeddings are pending. Build embeddings to repair it.");
  });

  it("passes total-work bounds to automatic embedding without changing explicit defaults", async () => {
    const root = await fixtureRoot();
    const model = indexedModel(root, "hybrid");

    await qmdSearchProvider.embed(model, path.join(root, ".exograph"), {
      maxDocuments: 4,
      maxDocsPerBatch: 1,
      maxDurationMs: 15_000,
    });
    await qmdSearchProvider.embed(model, path.join(root, ".exograph"));

    const embeddingStores = stores.filter((store) => store.embedCalls > 0);
    expect(embeddingStores.map((store) => store.embedOptions[0])).toEqual([
      { maxDocuments: 4, maxDocsPerBatch: 1, maxDurationMs: 15_000 },
      undefined,
    ]);
  });

  it("warns when derived Exograph state in a Git workspace is not ignored", async () => {
    const root = await fixtureRoot();
    await mkdir(path.join(root, ".git"));
    const status = await qmdSearchProvider.getStatus(indexedModel(root, "lexical"), path.join(root, ".exograph"));

    expect(status.warnings).toContain("This Workspace is a Git repository and .exograph/ is not ignored. Add .exograph/ to .gitignore; Exograph will not modify repository files automatically.");

    await writeFile(path.join(root, ".gitignore"), "/.exograph/\n", "utf8");
    const ignoredStatus = await qmdSearchProvider.getStatus(indexedModel(root, "lexical"), path.join(root, ".exograph"));

    expect(ignoredStatus.warnings).not.toContain("This Workspace is a Git repository and .exograph/ is not ignored. Add .exograph/ to .gitignore; Exograph will not modify repository files automatically.");
  });

  it("can scope updates to selected indexed roots", async () => {
    const root = await fixtureRoot();
    const model = indexedModel(root, "hybrid");

    await qmdSearchProvider.update(model, path.join(root, ".exograph"), { rootIds: ["index-notes"] });

    expect(stores.some((store) => JSON.stringify(store.updateOptions[0]) === JSON.stringify({ collections: [configuredCollectionForPath(store, path.join(root, "notes"))] }))).toBe(true);
  });

  it.each([
    { label: "undefined", rootIds: undefined, expectedRootLabels: ["notes", "docs"] },
    { label: "empty", rootIds: [] as string[], expectedRootLabels: null },
    { label: "unknown-only", rootIds: ["missing"], expectedRootLabels: null },
    { label: "mixed known and unknown", rootIds: ["missing", "index-notes"], expectedRootLabels: ["notes"] },
  ])("treats $label update root IDs as an exact known-ID intersection", async ({ rootIds, expectedRootLabels }) => {
    const root = await fixtureRoot();
    const docsPath = path.join(root, "docs");
    await mkdir(docsPath);
    const model = {
      ...indexedModel(root, "hybrid"),
      indexedRoots: [
        createIndexedRoot(path.join(root, "notes"), { id: "index-notes", label: "notes", kind: "notes" }),
        createIndexedRoot(docsPath, { id: "index-docs", label: "docs", kind: "docs" }),
      ],
    };

    await qmdSearchProvider.update(model, path.join(root, ".exograph"), { rootIds });

    const updatingStores = stores.filter((store) => store.updateCalls > 0);
    if (expectedRootLabels) {
      expect(updatingStores).toHaveLength(1);
      expect(updatingStores[0].updateOptions).toEqual([{
        collections: expectedRootLabels.map((label) => configuredCollectionForPath(
          updatingStores[0],
          label === "notes" ? path.join(root, "notes") : docsPath,
        )),
      }]);
    } else {
      expect(updatingStores).toEqual([]);
    }
  });

  it("syncs lexical indexes without embeddings", async () => {
    const root = await fixtureRoot();
    const model = indexedModel(root, "lexical");

    const result = await qmdSearchProvider.sync(model, path.join(root, ".exograph"));

    expect(result.phases).toEqual([
      { name: "update", status: "completed", message: "Indexed documents refreshed." },
      { name: "embed", status: "skipped", message: "Embeddings are not needed in lexical mode." },
    ]);
    expect(stores.some((store) => store.updateCalls === 1)).toBe(true);
    expect(stores.some((store) => store.embedCalls === 1)).toBe(false);
  });

  it("syncs hybrid indexes and embeddings", async () => {
    const root = await fixtureRoot();
    const model = indexedModel(root, "hybrid");

    const result = await qmdSearchProvider.sync(model, path.join(root, ".exograph"));

    expect(result.phases.map((phase) => `${phase.name}:${phase.status}`)).toEqual(["update:completed", "embed:completed"]);
    expect(stores.some((store) => store.updateCalls === 1)).toBe(true);
    expect(stores.some((store) => store.embedCalls === 1)).toBe(true);
  });

  it("reads filesystem paths with line ranges", async () => {
    const root = await fixtureRoot();
    const filePath = path.join(root, "notes", "focus.md");
    const model = resolveWorkspaceModel({
      EXOGRAPH_WORKSPACE_ROOT: root,
      EXOGRAPH_NOTE_ROOTS: path.join(root, "notes"),
    });

    const result = await qmdSearchProvider.read(model, path.join(root, ".exograph"), filePath, { fromLine: 2, maxLines: 1 });

    expect(result.body).toBe("alpha");
  });

  it("resolves QMD docids to filesystem paths", async () => {
    const root = await fixtureRoot();
    const model = indexedModel(root, "lexical");

    const result = await qmdSearchProvider.read(model, path.join(root, ".exograph"), "#abc123", { fromLine: 1, maxLines: 2 });

    expect(result.filePath).toBe(path.join(root, "notes", "focus.md"));
    expect(result.source).toBe("qmd");
  });

  it("authorizes a resolved QMD path before reading its body", async () => {
    const root = await fixtureRoot();
    const model = indexedModel(root, "lexical");

    await expect(
      qmdSearchProvider.readAuthorized(
        model,
        path.join(root, ".exograph"),
        "#abc123",
        {},
        async () => {
          throw new Error("path rejected");
        },
      ),
    ).rejects.toThrow("path rejected");
    expect(stores[0].getDocumentBodyCalls).toBe(0);
  });

  it("rejects stale QMD docids outside configured indexed roots", async () => {
    const root = await fixtureRoot();
    const model = {
      ...indexedModel(root, "lexical"),
      indexedRoots: [createIndexedRoot(path.join(root, "docs"), { id: "index-docs", label: "docs", kind: "docs" })],
    };

    await expect(qmdSearchProvider.read(model, path.join(root, ".exograph"), "#abc123")).rejects.toThrow(
      "outside configured indexed roots",
    );
  });

  it("does not read a QMD docid body through a symlink escape", async () => {
    const root = await fixtureRoot();
    const outsidePath = path.join(root, "outside.md");
    await writeFile(outsidePath, "# Outside\n", "utf8");
    await symlink(outsidePath, path.join(root, "notes", "escape.md"));
    documentPathOverride = "qmd://notes/escape.md";

    await expect(qmdSearchProvider.read(indexedModel(root, "lexical"), path.join(root, ".exograph"), "#abc123")).rejects.toThrow(
      "outside configured indexed roots",
    );
    expect(stores[0].getDocumentBodyCalls).toBe(0);
  });
});

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "exograph-qmd-test-"));
  tempPaths.push(root);
  await mkdir(path.join(root, "notes"), { recursive: true });
  await writeFile(path.join(root, "notes", "focus.md"), "# Focus\nalpha\nbeta\n", "utf8");
  return root;
}

function indexedModel(root: string, mode: "lexical" | "semantic" | "hybrid") {
  return {
    ...resolveWorkspaceModel({
      EXOGRAPH_WORKSPACE_ROOT: root,
      EXOGRAPH_NOTE_ROOTS: path.join(root, "notes"),
    }),
    indexedRoots: [createIndexedRoot(path.join(root, "notes"), { id: "index-notes", label: "notes", kind: "notes" })],
    indexing: { enabled: true, mode, backend: "qmd" as const },
  };
}

class MockStore {
  readonly config: { collections: Record<string, { path: string; ignore?: string[] }> };
  searchLexCalls: Array<{ query: string; collection?: string; limit?: number }> = [];
  searchVectorCalls: Array<{ query: string; collection?: string; limit?: number }> = [];
  searchCalls: Array<{ query?: string; collections?: string[]; limit?: number }> = [];
  updateOptions: unknown[] = [];
  updateCalls = 0;
  embedCalls = 0;
  embedOptions: unknown[] = [];
  getDocumentBodyCalls = 0;
  visibleDocumentCollectionsBeforeUpdates: string[][] = [];

  constructor(options: { config?: { collections?: Record<string, { path: string; ignore?: string[] }> } }) {
    this.config = { collections: options.config?.collections ?? {} };
    if (options.config) {
      existingQmdCollections = Object.entries(this.config.collections).map(([name, collection]) => ({ name, pwd: collection.path }));
    }
  }

  async listCollections() {
    return existingQmdCollections;
  }

  async getStatus(): Promise<MockQmdStatus> {
    return storeStatusOverride ?? {
      totalDocuments: 1,
      needsEmbedding: 1,
      hasVectorIndex: false,
      collections: [{ name: "notes", documents: 1, lastUpdated: "2026-05-15T00:00:00.000Z" }],
    };
  }

  async searchLex(query: string, options: { collection?: string; limit?: number }) {
    this.searchLexCalls.push({ query, collection: options.collection, limit: options.limit });
    const collectionAlias = options.collection ? path.basename(this.config.collections[options.collection]?.path ?? "") : "";
    const results = searchLexResultsByCollection.get(options.collection ?? "")
      ?? searchLexResultsByCollection.get(collectionAlias)
      ?? searchLexResultsOverride
      ?? [{
      file: `qmd://${options.collection}/focus.md`,
      title: "Focus",
      snippet: "alpha",
      score: 0.8,
      docid: "abc123",
      }];
    return results.map((result) => this.normalizeQmdResult(result)).slice(0, options.limit ?? results.length);
  }

  async searchVector(query: string, options: { collection?: string; limit?: number }) {
    this.searchVectorCalls.push({ query, collection: options.collection, limit: options.limit });
    if (!searchVectorResultsOverride) {
      throw new Error("no vectors");
    }
    return searchVectorResultsOverride
      .map((result) => this.normalizeQmdResult(result))
      .slice(0, options.limit ?? searchVectorResultsOverride.length);
  }

  async search(options: { query?: string; collections?: string[]; limit?: number }) {
    this.searchCalls.push(options);
    if (hybridSearchError) {
      throw hybridSearchError;
    }
    return this.searchLex(options.query ?? "hybrid", { collection: options.collections?.[0] ?? "notes", limit: options.limit ?? 10 });
  }

  async get() {
    return this.normalizeQmdResult({
      filepath: documentPathOverride ?? `qmd://${Object.keys(this.config.collections)[0] ?? "notes"}/focus.md`,
      title: "Focus",
    });
  }

  async getDocumentBody() {
    this.getDocumentBodyCalls += 1;
    return "# Focus\nalpha";
  }

  async update(options?: unknown) {
    this.updateCalls += 1;
    this.updateOptions.push(options);
    const collections = (options as { collections?: string[] } | undefined)?.collections ?? [];
    this.visibleDocumentCollectionsBeforeUpdates.push(
      existingQmdDocumentCollections.filter((collection) => collections.includes(collection)),
    );
    if (updateError) {
      throw updateError;
    }
  }

  async embed(options?: unknown) {
    this.embedCalls += 1;
    this.embedOptions.push(options);
  }

  async close() {}

  private normalizeQmdResult(result: unknown): unknown {
    if (!result || typeof result !== "object") {
      return result;
    }
    const normalized = { ...(result as Record<string, unknown>) };
    for (const key of ["file", "filepath", "displayPath"]) {
      const value = normalized[key];
      if (typeof value !== "string") {
        continue;
      }
      normalized[key] = value.replace(/^qmd:\/\/([^/]+)/, (_, alias: string) => {
        const collection = Object.entries(this.config.collections)
          .find(([, config]) => path.basename(config.path) === alias)?.[0];
        return collection ? `qmd://${collection}` : `qmd://${alias}`;
      });
    }
    return normalized;
  }
}

function qmdResult(file: string, score = 0.8) {
  return {
    file,
    title: "Focus",
    snippet: "alpha",
    score,
    docid: "abc123",
  };
}

function configuredCollectionForPath(store: MockStore, rootPath: string): string {
  const collection = Object.entries(store.config.collections)
    .find(([, config]) => path.resolve(config.path) === path.resolve(rootPath))?.[0];
  expect(collection).toMatch(/^[A-Za-z0-9_-]+$/);
  return collection!;
}

function pendingQmdCollectionReindexPath(root: string): string {
  return path.join(root, ".exograph", "qmd", "pending-collection-reindex");
}

async function fileExists(filePath: string): Promise<boolean> {
  return access(filePath).then(
    () => true,
    () => false,
  );
}
