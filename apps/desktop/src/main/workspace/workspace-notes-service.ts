import { access, readdir, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  createWorkspaceFile,
  listFiles,
  ensureFolderIndex,
  listMarkdownFiles,
  normalizeWorkspaceContentPolicy,
  readWorkspaceDocument,
  type SearchResult,
  type FolderOverview,
  type GraphConceptDetailByIndexResult,
  type GraphConceptLookupReference,
  type GraphConceptLookupResult,
  type GraphConceptSummaryResult,
  type GraphTopology,
  type OntologyKeepResult,
  type OntologyRejectResult,
  type OntologyReviewGuard,
  type OntologyReviewState,
  type WorkspaceSearchResults,
  WorkspaceFiles,
  WorkspaceGraph,
  type WorkspaceGraphContext,
  type WorkspaceModel,
} from "@exograph/core";
import type { WorkspaceChangeEvent } from "./workspace-watchers";
import type { DerivedIndexClient } from "../indexing/derived-index-process";

export interface WorkspaceNotesServiceOptions {
  getWorkspaceModel: () => WorkspaceModel;
  getRuntimeRoot?: () => string;
  derivedIndex?: DerivedIndexClient;
  derivedIndexFactory?: () => DerivedIndexClient;
  onGraphChanged?: () => void;
}

export interface WorkspaceNotesActivation {
  model: WorkspaceModel;
  runtimeRoot: string;
  generation: number;
}

interface WorkspaceNotesScope extends WorkspaceNotesActivation {
  controller: AbortController;
}

export class WorkspaceNotesService {
  private graph: WorkspaceGraph | null = null;
  private graphModelKey: string | null = null;
  private readonly folderOverviewCache = new Map<string, FolderOverview>();
  private noteFileCache: string[] | null = null;
  private readonly imageFileCache = new Map<string, Promise<string[]>>();
  private scope: WorkspaceNotesScope;
  private derivedIndex: DerivedIndexClient | undefined;
  private readonly createDerivedIndex: (() => DerivedIndexClient) | undefined;

  constructor(private readonly options: WorkspaceNotesServiceOptions) {
    this.createDerivedIndex = options.derivedIndexFactory;
    this.derivedIndex = options.derivedIndex ?? this.createDerivedIndex?.();
    this.scope = this.createScope({
      model: options.getWorkspaceModel(),
      runtimeRoot: options.getRuntimeRoot?.() ?? "",
      generation: 0,
    });
  }

  activateWorkspace(activation: WorkspaceNotesActivation): void {
    this.scope.controller.abort();
    if (this.createDerivedIndex) {
      const previousDerivedIndex = this.derivedIndex;
      this.derivedIndex = this.createDerivedIndex();
      previousDerivedIndex?.dispose();
    }
    this.scope = this.createScope(activation);
    this.graph?.invalidate();
    this.graph = null;
    this.graphModelKey = null;
    this.folderOverviewCache.clear();
    this.noteFileCache = null;
    this.imageFileCache.clear();
  }

  /**
   * Publishes a model whose Workspace authority is unchanged.
   *
   * Search/index settings may change the model passed to derived operations,
   * but they do not invalidate the graph worker or its staged review state.
   */
  applyWorkspaceModel(model: WorkspaceModel): void {
    const previousExclusions = normalizeWorkspaceContentPolicy(this.scope.model.contentPolicy).excludedPaths;
    const nextExclusions = normalizeWorkspaceContentPolicy(model.contentPolicy).excludedPaths;
    this.scope = { ...this.scope, model };
    if (!sameStringSet(previousExclusions, nextExclusions)) {
      this.noteFileCache = null;
    }
  }

  invalidateDerivedState(): void {
    this.graph?.invalidate();
    const scope = this.scope;
    const derivedIndex = this.derivedIndex;
    if (derivedIndex && scope.runtimeRoot) {
      void derivedIndex
        .graphInvalidate(scope.model, scope.runtimeRoot, scope.controller.signal)
        .catch((error) => {
          if (!isAbortError(error)) console.warn("[exograph] derived graph invalidation failed", error);
        });
    }
    this.folderOverviewCache.clear();
    this.noteFileCache = null;
    this.imageFileCache.clear();
  }

  async handleWorkspaceChange(event: WorkspaceChangeEvent): Promise<void> {
    const scope = this.scope;
    const derivedIndex = this.derivedIndex;
    const graph = this.graph;
    if (!this.isCurrentScope(scope)) return;
    if (!event.filePath) {
      this.folderOverviewCache.clear();
      this.noteFileCache = null;
      this.imageFileCache.clear();
      if (derivedIndex && scope.runtimeRoot) {
        await derivedIndex.graphInvalidate(scope.model, scope.runtimeRoot, scope.controller.signal);
        if (!this.isCurrentScope(scope)) return;
      } else {
        graph?.invalidate();
      }
      return;
    }

    const changedPath = path.resolve(event.filePath);
    this.invalidateFolderOverviewsForPath(changedPath);
    this.noteFileCache = null;
    this.imageFileCache.clear();
    if (/\.md$/i.test(changedPath)) {
      if (derivedIndex && scope.runtimeRoot) {
        await derivedIndex.graphRefresh(scope.model, scope.runtimeRoot, changedPath, scope.controller.signal);
        if (!this.isCurrentScope(scope)) return;
      } else {
        await graph?.refreshFile(changedPath);
        if (!this.isCurrentScope(scope)) return;
      }
    }
  }

  private createScope(activation: WorkspaceNotesActivation): WorkspaceNotesScope {
    return { ...activation, controller: new AbortController() };
  }

  private isCurrentScope(scope: WorkspaceNotesScope): boolean {
    return scope.generation === this.scope.generation;
  }

  private async awaitCurrentScope<Result>(scope: WorkspaceNotesScope, request: Promise<Result>): Promise<Result> {
    const result = await request;
    this.assertCurrentScope(scope);
    return result;
  }

  private assertCurrentScope(scope: WorkspaceNotesScope): void {
    if (this.isCurrentScope(scope) && !scope.controller.signal.aborted) return;
    const error = new Error("Workspace request was superseded by a Workspace change.");
    error.name = "AbortError";
    throw error;
  }

  /** Validates an operator-requested file before a command-server response can
   * claim that Exograph opened it.  This shares the same root and symlink boundary
   * as every other workspace read. */
  async authorizeOpenFile(filePath: string): Promise<string> {
    const target = await this.authorizeOpenPath(filePath);
    if (target.kind !== "file") {
      throw new Error("Exograph can only open an existing file inside the active wiki.");
    }
    return target.path;
  }

  /** Authorizes an exact operator-requested file or folder for presentation.
   * The command surface never performs fuzzy resolution and retains the same
   * containment and symlink checks as ordinary workspace reads. */
  async authorizeOpenPath(targetPath: string): Promise<{ path: string; kind: "file" | "directory" }> {
    const scope = this.scope;
    const authorizedPath = await this.workspaceFiles(scope).existing(targetPath);
    const targetStat = await stat(authorizedPath);
    this.assertCurrentScope(scope);
    if (targetStat.isFile()) return { path: authorizedPath, kind: "file" };
    if (targetStat.isDirectory()) return { path: authorizedPath, kind: "directory" };
    throw new Error("Exograph can only open an existing file or folder inside the active wiki.");
  }

  async searchFilenames(query: string): Promise<WorkspaceSearchResults> {
    const scope = this.scope;
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) {
      return { notes: [], tags: [] };
    }

    const model = scope.model;
    const files = this.noteFileCache ?? await listMarkdownFiles(
      this.noteRootPaths(scope),
      normalizeWorkspaceContentPolicy(model.contentPolicy),
    );
    this.assertCurrentScope(scope);
    this.noteFileCache = files;
    const notes = files
      .map((filePath) => {
        const root = model.noteRoots.find((candidate) => isPathWithin(candidate.path, filePath));
        const relativePath = root ? path.relative(root.path, filePath) : path.basename(filePath);
        const title = path.basename(filePath, path.extname(filePath));
        const normalizedTitle = title.toLowerCase();
        const normalizedPath = relativePath.toLowerCase();
        if (!normalizedTitle.includes(normalizedQuery) && !normalizedPath.includes(normalizedQuery)) {
          return null;
        }
        return {
          filePath,
          title,
          snippet: relativePath,
          kind: "note" as const,
          rank: normalizedTitle === normalizedQuery ? 0 : normalizedTitle.startsWith(normalizedQuery) ? 1 : 2,
        };
      })
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
      .sort((left, right) => left.rank - right.rank || left.snippet.localeCompare(right.snippet))
      .slice(0, 30)
      .map(({ rank: _rank, ...result }) => result);

    return { notes, tags: [] };
  }

  async searchTag(tag: string): Promise<SearchResult[]> {
    const scope = this.scope;
    const normalized = tag.replace(/^#/, "");
    const files = await listMarkdownFiles(
      this.noteRootPaths(scope),
      normalizeWorkspaceContentPolicy(scope.model.contentPolicy),
    );
    const results: Array<SearchResult | null> = await Promise.all(
      files.map(async (filePath) => {
        const document = await readWorkspaceDocument(filePath);
        const rawTags = Array.isArray(document.frontmatter.tags)
          ? document.frontmatter.tags.filter((entry): entry is string => typeof entry === "string")
          : typeof document.frontmatter.tags === "string"
            ? document.frontmatter.tags.split(/[,\s]+/)
            : [];
        const bodyIncludes = document.body.toLowerCase().includes(`#${normalized.toLowerCase()}`);
        const frontmatterIncludes = rawTags.some((entry) => entry.replace(/^#/, "").toLowerCase() === normalized.toLowerCase());
        if (!bodyIncludes && !frontmatterIncludes) {
          return null;
        }

        return {
          filePath,
          title: document.title,
          snippet: `#${normalized}`,
          kind: "tag" as const,
        };
      }),
    );

    this.assertCurrentScope(scope);
    return results.filter((entry): entry is SearchResult => entry !== null);
  }

  async resolveTarget(sourceFilePath: string, target: string): Promise<string | null> {
    const scope = this.scope;
    const files = this.workspaceFiles(scope);
    await files.existing(sourceFilePath);
    this.assertCurrentScope(scope);
    if (/^https?:\/\//.test(target)) {
      return null;
    }

    const isPdfTarget = target.toLowerCase().endsWith(".pdf");
    const relativeCandidate = isPdfTarget
      ? path.resolve(path.dirname(sourceFilePath), target)
      : target.endsWith(".md")
      ? path.resolve(path.dirname(sourceFilePath), target)
      : path.resolve(path.dirname(sourceFilePath), `${target}.md`);
    await files.writable(relativeCandidate);
    this.assertCurrentScope(scope);

    if (await fileExists(relativeCandidate)) {
      this.assertCurrentScope(scope);
      return isPdfTarget ? await files.existing(relativeCandidate) : relativeCandidate;
    }

    if (isPdfTarget) return null;

    const normalizedTarget = path.basename(target, ".md").toLowerCase();
    const noteFiles = await listMarkdownFiles(
      this.noteRootPaths(scope),
      normalizeWorkspaceContentPolicy(scope.model.contentPolicy),
    );
    this.assertCurrentScope(scope);
    return noteFiles.find((filePath) => path.basename(filePath, ".md").toLowerCase() === normalizedTarget) ?? null;
  }

  /**
   * Produces a renderer-safe URL for an attachment referenced by a Markdown
   * note. The renderer never turns a Markdown target into a file URL itself:
   * this method verifies both source and target through WorkspaceFiles first.
   */
  async resolveMarkdownImage(sourceFilePath: string, target: string, lookupByFilename = false): Promise<{ url: string }> {
    const scope = this.scope;
    const files = this.workspaceFiles(scope);
    const sourcePath = await files.existing(sourceFilePath);
    this.assertCurrentScope(scope);
    const normalizedTarget = normalizeMarkdownImageTarget(target);
    const imagePath = await this.resolveMarkdownImagePath(files, sourcePath, normalizedTarget, lookupByFilename, scope);
    // Point the renderer at the canonical path that WorkspaceFiles authorized,
    // rather than leaving a later file: load to follow a mutable symlink.
    const canonicalImagePath = await realpath(imagePath);
    const fileStat = await stat(canonicalImagePath);
    if (!fileStat.isFile()) {
      throw new Error("Markdown image target must be an existing file.");
    }
    this.assertCurrentScope(scope);
    return { url: pathToFileURL(canonicalImagePath).toString() };
  }

  async ensureTarget(sourceFilePath: string, target: string): Promise<string> {
    const scope = this.scope;
    const resolved = await this.resolveTarget(sourceFilePath, target);
    if (resolved) {
      return resolved;
    }
    if (target.toLowerCase().endsWith(".pdf")) {
      throw new Error("PDF link targets must be an existing file inside the active wiki.");
    }

    const noteRoot = scope.model.noteRoots.find((root) => isPathWithin(root.path, sourceFilePath));
    const normalizedTarget = target.replace(/\.md$/i, "");
    const targetWithExtension = `${normalizedTarget}.md`;
    const isDailyNoteTarget = /^\d{4}-\d{2}-\d{2}$/.test(normalizedTarget);
    const nextPath = path.isAbsolute(targetWithExtension)
      ? path.resolve(targetWithExtension)
      : isDailyNoteTarget && noteRoot
        ? path.join(noteRoot.path, targetWithExtension)
      : normalizedTarget.includes("/")
        ? path.join(noteRoot?.path ?? path.dirname(sourceFilePath), targetWithExtension)
        : path.join(path.dirname(sourceFilePath), targetWithExtension);

    const authorizedPath = await this.workspaceFiles(scope).writable(nextPath);
    this.assertCurrentScope(scope);
    await createWorkspaceFile(authorizedPath);
    this.assertCurrentScope(scope);
    return authorizedPath;
  }

  async suggestTargets(sourceFilePath: string, query: string) {
    const scope = this.scope;
    await this.workspaceFiles(scope).existing(sourceFilePath);
    this.assertCurrentScope(scope);
    const trimmedQuery = query.trim().toLowerCase();
    if (!trimmedQuery) {
      return [];
    }

    const model = scope.model;
    const noteFiles = await listMarkdownFiles(
      this.noteRootPaths(scope),
      normalizeWorkspaceContentPolicy(model.contentPolicy),
    );
    this.assertCurrentScope(scope);
    const suggestions = noteFiles
      .map((filePath) => {
        const rootPath = model.noteRoots.find((root) => isPathWithin(root.path, filePath))?.path;
        const relativePath = rootPath ? path.relative(rootPath, filePath) : path.basename(filePath);
        const relativeWithoutExtension = relativePath.replace(/\.md$/i, "");
        const target = path.relative(path.dirname(sourceFilePath), filePath)
          .replace(/\.md$/i, "")
          .split(path.sep)
          .join("/");
        const title = path.basename(filePath, ".md");
        const haystack = `${title}\n${relativeWithoutExtension}`.toLowerCase();
        if (!haystack.includes(trimmedQuery)) {
          return null;
        }

        return {
          filePath,
          title,
          target,
          snippet: relativeWithoutExtension,
        };
      })
      .filter((entry): entry is { filePath: string; title: string; target: string; snippet: string } => entry !== null)
      .slice(0, 20);

    suggestions.sort((left, right) => {
      const leftExact = left.title.toLowerCase() === trimmedQuery || left.target.toLowerCase() === trimmedQuery;
      const rightExact = right.title.toLowerCase() === trimmedQuery || right.target.toLowerCase() === trimmedQuery;
      if (leftExact !== rightExact) {
        return leftExact ? -1 : 1;
      }
      return left.target.localeCompare(right.target);
    });

    return suggestions;
  }

  async getGraphContext(filePath: string): Promise<WorkspaceGraphContext | null> {
    const scope = this.scope;
    const authorizedPath = await this.workspaceFiles(scope).existing(filePath);
    this.assertCurrentScope(scope);
    const derivedIndex = this.derivedIndex;
    if (derivedIndex && scope.runtimeRoot) {
      return this.awaitCurrentScope(scope, derivedIndex.graphContext(
        scope.model,
        scope.runtimeRoot,
        authorizedPath,
        scope.controller.signal,
      ));
    }
    return this.awaitCurrentScope(scope, this.workspaceGraph(scope).contextForNote(authorizedPath));
  }

  async getGraphTopology(): Promise<GraphTopology> {
    const scope = this.scope;
    const derivedIndex = this.derivedIndex;
    if (derivedIndex && scope.runtimeRoot) {
      return this.awaitCurrentScope(scope, derivedIndex.graphTopology(
        scope.model,
        scope.runtimeRoot,
        scope.controller.signal,
      ));
    }
    return this.awaitCurrentScope(scope, this.workspaceGraph(scope).graphTopology());
  }

  async previewOntology(sourcePath?: string | null): Promise<OntologyReviewState> {
    const scope = this.scope;
    const derivedIndex = this.derivedIndex;
    if (derivedIndex && scope.runtimeRoot) {
      return this.awaitCurrentScope(scope, derivedIndex.ontologyPreview(
        scope.model,
        scope.runtimeRoot,
        sourcePath,
        scope.controller.signal,
      ));
    }
    return this.awaitCurrentScope(scope, this.workspaceGraph(scope).previewOntology(sourcePath));
  }

  async keepOntology(guard: OntologyReviewGuard): Promise<OntologyKeepResult> {
    const scope = this.scope;
    const derivedIndex = this.derivedIndex;
    const result = derivedIndex && scope.runtimeRoot
      ? await this.awaitCurrentScope(scope, derivedIndex.ontologyKeep(
        scope.model,
        scope.runtimeRoot,
        guard,
        scope.controller.signal,
      ))
      : await this.awaitCurrentScope(scope, this.workspaceGraph(scope).keepOntology(guard));
    this.assertCurrentScope(scope);
    if (result.status === "applied") this.options.onGraphChanged?.();
    return result;
  }

  async rejectOntology(guard: OntologyReviewGuard): Promise<OntologyRejectResult> {
    const scope = this.scope;
    const derivedIndex = this.derivedIndex;
    if (derivedIndex && scope.runtimeRoot) {
      return this.awaitCurrentScope(scope, derivedIndex.ontologyReject(
        scope.model,
        scope.runtimeRoot,
        guard,
        scope.controller.signal,
      ));
    }
    return this.awaitCurrentScope(scope, this.workspaceGraph(scope).rejectOntology(guard));
  }

  async getGraphConceptSummaries(indexes: number[], sourceSnapshotId: string): Promise<GraphConceptSummaryResult> {
    const scope = this.scope;
    const derivedIndex = this.derivedIndex;
    if (derivedIndex && scope.runtimeRoot) {
      return this.awaitCurrentScope(scope, derivedIndex.graphConceptSummaries(
        scope.model,
        scope.runtimeRoot,
        indexes,
        sourceSnapshotId,
        scope.controller.signal,
      ));
    }
    return this.awaitCurrentScope(scope, this.workspaceGraph(scope).graphConceptSummaries(indexes, sourceSnapshotId));
  }

  async graphConceptLookup(
    reference: GraphConceptLookupReference,
    sourceSnapshotId: string,
  ): Promise<GraphConceptLookupResult> {
    const scope = this.scope;
    const normalizedReference = await this.authorizeGraphConceptLookupReference(reference, scope);
    this.assertCurrentScope(scope);
    const derivedIndex = this.derivedIndex;
    if (derivedIndex && scope.runtimeRoot) {
      return this.awaitCurrentScope(scope, derivedIndex.graphConceptLookup(
        scope.model,
        scope.runtimeRoot,
        normalizedReference,
        sourceSnapshotId,
        scope.controller.signal,
      ));
    }
    return this.awaitCurrentScope(scope, this.workspaceGraph(scope).graphConceptLookup(normalizedReference, sourceSnapshotId));
  }

  async getGraphConceptDetailByIndex(index: number, sourceSnapshotId: string): Promise<GraphConceptDetailByIndexResult> {
    const scope = this.scope;
    const derivedIndex = this.derivedIndex;
    if (derivedIndex && scope.runtimeRoot) {
      return this.awaitCurrentScope(scope, derivedIndex.graphConceptDetailByIndex(
        scope.model,
        scope.runtimeRoot,
        index,
        sourceSnapshotId,
        scope.controller.signal,
      ));
    }
    return this.awaitCurrentScope(scope, this.workspaceGraph(scope).graphConceptDetailByIndex(index, sourceSnapshotId));
  }

  private async authorizeGraphConceptLookupReference(reference: GraphConceptLookupReference, scope: WorkspaceNotesScope): Promise<GraphConceptLookupReference> {
    if (!reference || typeof reference !== "object") {
      throw new Error("Graph concept lookup requires exactly one of conceptId or filePath.");
    }
    const hasConceptId = reference.conceptId !== undefined;
    const hasFilePath = reference.filePath !== undefined;
    if (hasConceptId === hasFilePath) {
      throw new Error("Graph concept lookup requires exactly one of conceptId or filePath.");
    }
    if (hasConceptId) {
      const conceptId = reference.conceptId?.trim();
      if (!conceptId) throw new Error("Graph concept lookup conceptId must not be empty.");
      return { conceptId };
    }
    const requestedPath = reference.filePath;
    if (!requestedPath?.trim()) throw new Error("Graph concept lookup filePath must not be empty.");
    const resolvedPath = await this.workspaceFiles(scope).existing(requestedPath);
    const model = scope.model;
    const root = model.noteRoots.find((candidate) => isPathWithin(path.resolve(candidate.path), resolvedPath));
    if (!root) throw new Error("Refusing to access a path outside configured note roots.");
    const [canonicalPath, canonicalRoot] = await Promise.all([realpath(resolvedPath), realpath(root.path)]);
    this.assertCurrentScope(scope);
    return { filePath: path.resolve(root.path, path.relative(canonicalRoot, canonicalPath)) };
  }

  async getFolderOverview(directoryPath: string): Promise<FolderOverview> {
    const scope = this.scope;
    const files = this.workspaceFiles(scope);
    const authorizedDirectory = await files.existing(directoryPath);
    this.assertCurrentScope(scope);
    const cached = this.folderOverviewCache.get(authorizedDirectory);
    if (cached) {
      return cached;
    }
    const indexPath = path.join(authorizedDirectory, "index.md");
    const indexExists = await fileExists(indexPath);
    const indexDocument = indexExists ? await readWorkspaceDocument(indexPath) : null;
    const entries = await readdir(authorizedDirectory, { withFileTypes: true });
    const children = entries
      .filter((entry) => entry.isDirectory() || (entry.isFile() && entry.name.endsWith(".md") && entry.name !== "index.md"))
      .sort((left, right) => {
        if (left.isDirectory() !== right.isDirectory()) return left.isDirectory() ? -1 : 1;
        return left.name.localeCompare(right.name);
      })
      .map((entry) => ({ path: path.join(authorizedDirectory, entry.name), name: entry.name, kind: entry.isDirectory() ? "directory" as const : "file" as const }));

    const overview: FolderOverview = {
      directoryPath: authorizedDirectory,
      indexPath,
      title: indexDocument?.title || path.basename(authorizedDirectory),
      frontmatter: indexDocument?.frontmatter ?? {},
      indexExists,
      children,
      graphContext: null,
    };
    this.assertCurrentScope(scope);
    this.folderOverviewCache.set(authorizedDirectory, overview);
    return overview;
  }

  async ensureFolderIndex(directoryPath: string) {
    const scope = this.scope;
    const authorizedDirectory = await this.workspaceFiles(scope).existing(directoryPath);
    this.assertCurrentScope(scope);
    const result = await ensureFolderIndex(authorizedDirectory);
    this.assertCurrentScope(scope);
    this.invalidateFolderOverviewsForPath(result.indexPath);
    return result;
  }

  private workspaceGraph(scope: WorkspaceNotesScope): WorkspaceGraph {
    const model = scope.model;
    const modelKey = [path.resolve(model.workspaceRoot), path.resolve(scope.runtimeRoot), JSON.stringify(model.contentPolicy ?? null), ...model.noteRoots
      .map((root) => `${root.id}:${path.resolve(root.path)}`)
      .sort()]
      .join("\n");
    if (!this.graph || this.graphModelKey !== modelKey) {
      this.graph = new WorkspaceGraph(model, { runtimeRoot: scope.runtimeRoot || undefined });
      this.graphModelKey = modelKey;
      this.folderOverviewCache.clear();
      this.noteFileCache = null;
    }
    return this.graph;
  }

  private invalidateFolderOverviewsForPath(changedPath: string): void {
    const parentPath = path.dirname(changedPath);
    for (const cachedPath of this.folderOverviewCache.keys()) {
      if (
        cachedPath === changedPath
        || cachedPath === parentPath
        || isPathWithin(changedPath, cachedPath)
      ) {
        this.folderOverviewCache.delete(cachedPath);
      }
    }
  }

  private noteRootPaths(scope: WorkspaceNotesScope): string[] {
    return scope.model.noteRoots.map((root) => root.path);
  }

  private workspaceFiles(scope: WorkspaceNotesScope): WorkspaceFiles {
    return new WorkspaceFiles(this.noteRootPaths(scope));
  }

  private async resolveMarkdownImagePath(
    files: WorkspaceFiles,
    sourcePath: string,
    target: string,
    lookupByFilename: boolean,
    scope: WorkspaceNotesScope,
  ): Promise<string> {
    if (!target.startsWith("/")) {
      try {
        return await files.existing(path.resolve(path.dirname(sourcePath), target));
      } catch (error) {
        if (!lookupByFilename || target !== path.basename(target) || !isMissingPathError(error)) {
          throw error;
        }
        return this.resolveMarkdownImageByFilename(files, sourcePath, target, scope);
      }
    }

    const sourceRoot = this.sourceNoteRoot(sourcePath, scope);

    const relativeTarget = target.replace(/^\/+/, "");
    const noteRootCandidate = path.resolve(sourceRoot, relativeTarget);
    if (!isPathWithin(sourceRoot, noteRootCandidate)) {
      throw new Error("Refusing to access a path outside configured note roots.");
    }

    // Site-authored Markdown often uses `/images/...` relative to a content
    // tree nested inside the Note Root. Prefer the nearest source ancestor that
    // contains the target, while retaining the Note Root as the final fallback.
    let ancestorPath = path.dirname(sourcePath);
    let missingError: unknown;
    while (isPathWithin(sourceRoot, ancestorPath)) {
      try {
        const candidatePath = await files.existing(path.resolve(ancestorPath, relativeTarget));
        if ((await stat(await realpath(candidatePath))).isFile()) {
          return candidatePath;
        }
      } catch (error) {
        if (!isMissingPathError(error)) {
          throw error;
        }
        missingError = error;
      }
      if (ancestorPath === sourceRoot) {
        break;
      }
      ancestorPath = path.dirname(ancestorPath);
    }
    throw missingError ?? new Error("Markdown image target does not exist.");
  }

  private sourceNoteRoot(sourcePath: string, scope: WorkspaceNotesScope): string {
    const sourceRoot = scope.model.noteRoots
      .map((root) => path.resolve(root.path))
      .filter((rootPath) => isPathWithin(rootPath, sourcePath))
      .sort((left, right) => right.length - left.length)[0];
    if (!sourceRoot) {
      throw new Error("Source note is outside configured note roots.");
    }
    return sourceRoot;
  }

  private async resolveMarkdownImageByFilename(
    files: WorkspaceFiles,
    sourcePath: string,
    target: string,
    scope: WorkspaceNotesScope,
  ): Promise<string> {
    const sourceDirectory = path.dirname(sourcePath);
    const candidates = (await this.imageFilesInRoot(this.sourceNoteRoot(sourcePath, scope), scope))
      .filter((candidatePath) => path.basename(candidatePath) === target)
      .sort((left, right) => imageSearchDistance(sourceDirectory, left) - imageSearchDistance(sourceDirectory, right));

    for (const candidate of candidates) {
      try {
        const authorizedPath = await files.existing(candidate);
        if ((await stat(await realpath(authorizedPath))).isFile()) {
          return authorizedPath;
        }
      } catch {
        // Ignore stale or symlinked-outside candidates and continue looking
        // within the configured Note Root.
      }
    }
    throw new Error(`Markdown image target does not exist: ${target}`);
  }

  private imageFilesInRoot(rootPath: string, scope = this.scope): Promise<string[]> {
    const cached = this.imageFileCache.get(rootPath);
    if (cached) {
      return cached;
    }
    const files = listFiles([rootPath]);
    void files.then(() => {
      if (this.isCurrentScope(scope) && !scope.controller.signal.aborted) this.imageFileCache.set(rootPath, files);
    }).catch(() => {});
    return files;
  }

  dispose(): void {
    this.scope.controller.abort();
    this.derivedIndex?.dispose();
  }
}

function normalizeMarkdownImageTarget(target: string): string {
  const normalized = target.trim();
  if (!normalized) {
    throw new Error("Markdown image target cannot be empty.");
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(normalized) || normalized.startsWith("//")) {
    throw new Error("Remote Markdown images are not enabled in this workspace.");
  }
  try {
    return decodeURIComponent(normalized);
  } catch {
    throw new Error("Markdown image target has invalid URL encoding.");
  }
}

function isMissingPathError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR");
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const rightValues = new Set(right);
  return left.every((value) => rightValues.has(value));
}

async function fileExists(targetPath: string): Promise<boolean> {
  return access(targetPath, constants.F_OK).then(
    () => true,
    () => false,
  );
}

function isPathWithin(parentPath: string, candidatePath: string): boolean {
  const relativePath = path.relative(parentPath, candidatePath);
  return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

function imageSearchDistance(sourceDirectory: string, candidatePath: string): number {
  const segments = path.relative(sourceDirectory, candidatePath).split(path.sep);
  return segments.filter((segment) => segment === "..").length * 1_000 + segments.length;
}
