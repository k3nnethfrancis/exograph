import { access, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { constants, existsSync } from "node:fs";
import path from "node:path";

import type {
  IndexedRoot,
  IndexingConfig,
  SearchResult,
  TreeNode,
  WorkspaceModel,
  WorkspaceSearchResults,
} from "./types";
import { readWorkspaceDocument } from "./notes";
import {
  defaultWorkspaceContentPolicy,
  isWorkspaceContentExcluded,
  normalizeWorkspaceContentPolicy,
  type WorkspaceContentPolicy,
} from "./workspace-content-policy";

export { WorkspaceFiles } from "./workspace-files";

const SEARCH_RESULT_LIMIT = 30;
const MAX_SEARCH_VISITED_ENTRIES = 20_000;
export const DEFAULT_INDEX_PATTERN = "**/*.md";
export const DEFAULT_INDEXING: IndexingConfig = {
  enabled: false,
  mode: "off",
  backend: "qmd",
};
const IGNORED_DIRECTORY_NAMES = new Set([
  ".git",
  ".next",
  ".nuxt",
  ".turbo",
  ".venv",
  "__pycache__",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "site-packages",
  "target",
  "venv",
]);

function pathExists(targetPath: string): Promise<boolean> {
  return access(targetPath, constants.F_OK).then(
    () => true,
    () => false,
  );
}

function noteRoot(id: string, label: string, targetPath: string) {
  return { id, label, path: targetPath };
}

export function resolveWorkspaceModel(env: NodeJS.ProcessEnv = process.env): WorkspaceModel {
  const workspaceRoot = env.EXOGRAPH_WORKSPACE_ROOT ?? process.cwd();
  const defaultTerminalCwd = env.EXOGRAPH_DEFAULT_TERMINAL_CWD ?? workspaceRoot;
  const noteRootCandidates = (env.EXOGRAPH_NOTE_ROOTS ?? path.join(workspaceRoot, "notes")).split(path.delimiter).filter(Boolean);
  const indexedRoots = parseIndexedRoots(env.EXOGRAPH_INDEXED_ROOTS);
  const indexing = parseIndexingConfig(env);

  return {
    workspaceRoot,
    defaultTerminalCwd,
    noteRoots: noteRootCandidates.map((targetPath, index) =>
      noteRoot(`note-root-${index + 1}`, path.basename(targetPath), targetPath),
    ),
    indexedRoots,
    indexing,
    searchEngine: indexing.enabled && indexing.mode !== "off" && indexedRoots.length > 0 ? "qmd" : "filesystem",
  };
}

export function createIndexedRoot(
  targetPath: string,
  options: Partial<Omit<IndexedRoot, "path" | "backend" | "ignore">> & { ignore?: string[] } = {},
): IndexedRoot {
  const resolvedPath = path.resolve(targetPath);
  const label = options.label?.trim() || path.basename(resolvedPath) || "root";
  return {
    id: options.id?.trim() || `index-${handelize(label)}`,
    label,
    path: resolvedPath,
    kind: options.kind ?? "mixed",
    pattern: options.pattern?.trim() || DEFAULT_INDEX_PATTERN,
    ignore: options.ignore ?? [],
    backend: "qmd",
  };
}

function parseIndexedRoots(rawValue?: string): IndexedRoot[] {
  if (!rawValue) {
    return [];
  }

  try {
    const parsed = JSON.parse(rawValue) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.map((entry, index) => normalizeIndexedRoot(entry, index)).filter(isIndexedRoot);
  } catch {
    return rawValue
      .split(path.delimiter)
      .filter(Boolean)
      .map((entry, index) => createIndexedRoot(entry, { id: `index-root-${index + 1}` }));
  }
}

function normalizeIndexedRoot(entry: unknown, index: number): IndexedRoot | null {
  if (!entry || typeof entry !== "object") {
    return null;
  }
  const candidate = entry as Partial<IndexedRoot>;
  if (typeof candidate.path !== "string" || !candidate.path.trim()) {
    return null;
  }
  return createIndexedRoot(candidate.path, {
    id: typeof candidate.id === "string" && candidate.id.trim() ? candidate.id : `index-root-${index + 1}`,
    label: typeof candidate.label === "string" ? candidate.label : undefined,
    kind: candidate.kind === "notes" || candidate.kind === "docs" || candidate.kind === "code" || candidate.kind === "mixed" ? candidate.kind : "mixed",
    pattern: typeof candidate.pattern === "string" ? candidate.pattern : DEFAULT_INDEX_PATTERN,
    ignore: Array.isArray(candidate.ignore) ? candidate.ignore.filter((item): item is string => typeof item === "string") : [],
  });
}

function isIndexedRoot(value: IndexedRoot | null): value is IndexedRoot {
  return value !== null;
}

function parseIndexingConfig(env: NodeJS.ProcessEnv): IndexingConfig {
  const mode = normalizeIndexMode(env.EXOGRAPH_INDEX_MODE);
  return {
    enabled: env.EXOGRAPH_INDEX_ENABLED === "1" || mode !== "off",
    mode,
    backend: "qmd",
  };
}

export function normalizeIndexMode(value: unknown): IndexingConfig["mode"] {
  return value === "lexical" || value === "semantic" || value === "hybrid" ? value : "off";
}

function handelize(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    || "root";
}


export interface ListRootTreeOptions {
  markdownOnly?: boolean;
  /** Explicitly admits only these file extensions while retaining directories. */
  allowedFileExtensions?: readonly string[];
  maxDepth?: number;
  includeEmptyDirectories?: boolean;
  excludedPaths?: string[];
}

export async function listRootTree(rootPath: string, options?: ListRootTreeOptions): Promise<TreeNode[]> {
  const maxDepth = options?.maxDepth ?? 4;
  return listTreeRecursive(rootPath, options ?? {}, maxDepth, 0, rootPath);
}

async function listTreeRecursive(rootPath: string, options: ListRootTreeOptions, maxDepth: number, depth: number, noteRootPath: string): Promise<TreeNode[]> {
  if (!(await pathExists(rootPath))) {
    return [];
  }

  const markdownOnly = options.markdownOnly ?? false;
  const allowedFileExtensions = options.allowedFileExtensions?.map((extension) => extension.toLowerCase());
  const entries = await readdir(rootPath, { withFileTypes: true });
  const visibleEntries = entries
    .filter((entry) => {
      if (!entry.name.startsWith(".")) {
        return true;
      }

      return entry.isFile() && entry.name !== ".DS_Store" && (!markdownOnly || Boolean(allowedFileExtensions));
    })
    // Nested links can silently retarget a Note Root at content outside the
    // user's configured filesystem authority. Note-root aliases are resolved
    // during setup; content enumeration never follows nested symlinks.
    .filter((entry) => !entry.isSymbolicLink())
    .filter((entry) => entry.name !== "node_modules" && entry.name !== ".git")
    .filter((entry) => entry.isDirectory() || !allowedFileExtensions || allowedFileExtensions.some((extension) => entry.name.toLowerCase().endsWith(extension)))
    .filter((entry) => !isWorkspaceContentExcluded(path.relative(noteRootPath, path.join(rootPath, entry.name)), contentPolicyFromOptions(options)))
    .sort((left, right) => {
      if (left.isDirectory() === right.isDirectory()) {
        return left.name.localeCompare(right.name);
      }

      return left.isDirectory() ? -1 : 1;
    });

  const nodes = await Promise.all(
    visibleEntries.map(async (entry) => {
      const entryPath = path.join(rootPath, entry.name);

      if (entry.isDirectory()) {
        const children =
          depth >= maxDepth ? [] : await listTreeRecursive(entryPath, options, maxDepth, depth + 1, noteRootPath);

        if (markdownOnly && children.length === 0 && !options.includeEmptyDirectories) {
          return null;
        }

        return {
          id: entryPath,
          name: entry.name,
          path: entryPath,
          kind: "directory" as const,
          children,
        };
      }

      if (markdownOnly && !allowedFileExtensions && !entry.name.endsWith(".md")) {
        return null;
      }

      return {
        id: entryPath,
        name: entry.name,
        path: entryPath,
        kind: "file" as const,
      };
    }),
  );

  return nodes.reduce<TreeNode[]>((accumulator, node) => {
    if (node) {
      accumulator.push(node);
    }
    return accumulator;
  }, []);
}

export async function searchNotes(model: WorkspaceModel, query: string): Promise<SearchResult[]> {
  const trimmedQuery = query.trim().toLowerCase();
  if (!trimmedQuery) {
    return [];
  }

  const results: SearchResult[] = [];
  await findMatchingFiles(
    model.noteRoots.map((root) => root.path),
    async (filePath) => {
      if (!isWorkspaceMarkdownContentFile(model, filePath)) {
        return false;
      }
      const relativePath = path.relative(model.workspaceRoot, filePath);
      const pathTitle = path.basename(filePath, path.extname(filePath));

      let document;
      try {
        document = await readWorkspaceDocument(filePath);
      } catch {
        return false;
      }

      const frontmatterTags = frontmatterTagsForSearch(document.frontmatter);
      const bodyTags = Array.from(document.body.matchAll(/(^|\s)#([a-zA-Z0-9/_-]+)/g)).map((match) => match[2] ?? "");
      const heading = firstMarkdownHeading(document.body);
      const fields = [
        { kind: "title", value: document.title },
        { kind: "title", value: heading },
        { kind: "path", value: relativePath },
        { kind: "path", value: pathTitle },
        ...frontmatterTags.map((tag) => ({ kind: "tag", value: tag })),
        ...bodyTags.map((tag) => ({ kind: "tag", value: tag })),
        { kind: "body", value: document.body },
      ];
      const match = fields.find((field) => field.value.toLowerCase().includes(trimmedQuery));
      if (!match) {
        return false;
      }

      results.push({
        filePath,
        title: document.title,
        snippet: snippetForNoteMatch(match.kind, match.value, query.trim(), relativePath),
        kind: "note" as const,
      });
      return true;
    },
    SEARCH_RESULT_LIMIT,
  );

  return results.slice(0, SEARCH_RESULT_LIMIT);
}

export async function searchTags(model: WorkspaceModel, query: string): Promise<SearchResult[]> {
  const trimmedQuery = query.trim().replace(/^#/, "").toLowerCase();
  if (!trimmedQuery) {
    return [];
  }

  const results: SearchResult[] = [];
  await findMatchingFiles(
    model.noteRoots.map((root) => root.path),
    async (filePath) => {
      if (!isWorkspaceMarkdownContentFile(model, filePath)) {
        return false;
      }

      try {
        const document = await readWorkspaceDocument(filePath);
        const rawTags =
          Array.isArray(document.frontmatter.tags)
            ? document.frontmatter.tags.filter((entry: unknown): entry is string => typeof entry === "string")
            : typeof document.frontmatter.tags === "string"
              ? document.frontmatter.tags.split(/[,\s]+/)
              : [];
        const matchingTag = rawTags
          .map((entry) => entry.replace(/^#/, ""))
          .find((entry) => entry.toLowerCase().includes(trimmedQuery))
          ?? Array.from(document.body.matchAll(/(^|\s)#([a-zA-Z0-9/_-]+)/g))
            .map((match) => match[2] ?? "")
            .find((entry) => entry.toLowerCase().includes(trimmedQuery));

        if (!matchingTag) {
          return false;
        }

        results.push({
          filePath,
          title: document.title,
          snippet: `#${matchingTag}`,
          kind: "tag" as const,
        });
        return true;
      } catch {
        return false;
      }
    },
    SEARCH_RESULT_LIMIT,
  );

  return results.slice(0, SEARCH_RESULT_LIMIT);
}

export async function searchWorkspace(model: WorkspaceModel, query: string): Promise<WorkspaceSearchResults> {
  const [notes, tags] = await Promise.all([
    searchNotes(model, query),
    searchTags(model, query),
  ]);

  return {
    notes,
    tags,
  };
}

export function resolveNotePath(model: WorkspaceModel, target: string, cwd = process.cwd()): string {
  const noteRootPaths = model.noteRoots.map((root) => path.resolve(root.path));
  if (path.isAbsolute(target)) {
    const resolvedTarget = path.resolve(target);
    if (!noteRootPaths.some((rootPath) => isWithin(rootPath, resolvedTarget))) {
      throw new Error("Refusing to read a note path outside configured note roots.");
    }
    return resolvedTarget;
  }

  const cwdRelative = path.resolve(cwd, target);
  if (noteRootPaths.some((rootPath) => isWithin(rootPath, cwdRelative)) && existsSync(cwdRelative)) {
    return cwdRelative;
  }

  const rootRelative = noteRootPaths
    .map((rootPath) => ({ rootPath, targetPath: path.resolve(rootPath, target) }))
    .filter((candidate) => isWithin(candidate.rootPath, candidate.targetPath))
    .map((candidate) => candidate.targetPath);
  const existingRootRelative = rootRelative.find((candidate) => existsSync(candidate));
  if (existingRootRelative) {
    return existingRootRelative;
  }

  if (noteRootPaths.some((rootPath) => isWithin(rootPath, cwdRelative))) {
    return cwdRelative;
  }

  throw new Error(`Note path not found inside configured note roots: ${target}`);
}

export async function listMarkdownFiles(rootPaths: string[], policy = defaultWorkspaceContentPolicy()): Promise<string[]> {
  const files = await Promise.all(rootPaths.map((rootPath) => collectMarkdownFiles(rootPath, policy)));
  return files.flat();
}

async function collectMarkdownFiles(rootPath: string, policy: WorkspaceContentPolicy): Promise<string[]> {
  const files = await collectFiles(rootPath, true, rootPath, policy);
  return files.filter((filePath) => filePath.endsWith(".md"));
}

async function collectFiles(rootPath: string, markdownOnly = false, contentRootPath = rootPath, policy = defaultWorkspaceContentPolicy()): Promise<string[]> {
  if (!(await pathExists(rootPath))) {
    return [];
  }

  const entries = await readdir(rootPath, { withFileTypes: true });
  const files = await Promise.all(
    entries
      .filter((entry) => !entry.name.startsWith("."))
      .filter((entry) => !entry.isSymbolicLink())
      .filter((entry) => entry.name !== "node_modules" && entry.name !== ".git")
      .filter((entry) => !isWorkspaceContentExcluded(path.relative(contentRootPath, path.join(rootPath, entry.name)), policy))
      .map(async (entry) => {
        const entryPath = path.join(rootPath, entry.name);
        if (entry.isDirectory()) {
          return collectFiles(entryPath, markdownOnly, contentRootPath, policy);
        }

        if (markdownOnly) {
          return entry.name.endsWith(".md") ? [entryPath] : [];
        }

        return [entryPath];
      }),
  );

  return files.flat();
}

export async function listFiles(rootPaths: string[]): Promise<string[]> {
  const files = await Promise.all(rootPaths.map((rootPath) => collectFiles(rootPath)));
  return files.flat();
}

function contentPolicyFromOptions(options: ListRootTreeOptions): WorkspaceContentPolicy {
  return { excludedPaths: options.excludedPaths ?? [], sourceVisibility: false };
}

function isWorkspaceMarkdownContentFile(model: WorkspaceModel, filePath: string): boolean {
  const root = model.noteRoots.find((candidate) => isWithin(candidate.path, filePath));
  if (!root || !filePath.toLowerCase().endsWith(".md")) return false;
  const relativePath = path.relative(path.resolve(root.path), path.resolve(filePath));
  if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath)) return false;
  return !isWorkspaceContentExcluded(relativePath, normalizeWorkspaceContentPolicy(model.contentPolicy));
}

async function findMatchingFiles(
  rootPaths: string[],
  matches: (filePath: string) => boolean | Promise<boolean>,
  limit: number,
): Promise<string[]> {
  const results: string[] = [];
  let visited = 0;

  async function visit(directoryPath: string): Promise<void> {
    if (results.length >= limit || visited >= MAX_SEARCH_VISITED_ENTRIES || !(await pathExists(directoryPath))) {
      return;
    }

    let entries;
    try {
      entries = await readdir(directoryPath, { withFileTypes: true });
    } catch {
      return;
    }

    entries.sort((left, right) => {
      if (left.isDirectory() === right.isDirectory()) {
        return left.name.localeCompare(right.name);
      }
      return left.isDirectory() ? -1 : 1;
    });

    for (const entry of entries) {
      if (results.length >= limit || visited >= MAX_SEARCH_VISITED_ENTRIES) {
        return;
      }
      if (entry.name.startsWith(".")) {
        continue;
      }
      // Do not let filesystem search read through a nested link that points
      // beyond the configured Note Root.
      if (entry.isSymbolicLink()) {
        continue;
      }
      if (entry.isDirectory() && IGNORED_DIRECTORY_NAMES.has(entry.name)) {
        continue;
      }

      visited += 1;
      const entryPath = path.join(directoryPath, entry.name);
      if (entry.isDirectory()) {
        await visit(entryPath);
      } else if (await matches(entryPath)) {
        results.push(entryPath);
      }
    }
  }

  for (const rootPath of rootPaths) {
    await visit(rootPath);
    if (results.length >= limit || visited >= MAX_SEARCH_VISITED_ENTRIES) {
      break;
    }
  }

  return results;
}

export async function createWorkspaceFile(targetPath: string, content?: string): Promise<string> {
  await mkdir(path.dirname(targetPath), { recursive: true });
  try {
    await writeFile(targetPath, content ?? initialWorkspaceFileContent(targetPath), { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      throw new Error(`Destination already exists: ${targetPath}`);
    }
    throw error;
  }
  return targetPath;
}

function initialWorkspaceFileContent(targetPath: string): string {
  if (!/\.md(?:own)?$/i.test(targetPath)) {
    return "";
  }

  const title = path.basename(targetPath).replace(/\.md(?:own)?$/i, "");
  return ["---", `date: ${new Date().toISOString().slice(0, 10)}`, "tags: []", "---", "", `# ${title}`, ""].join("\n");
}

export async function renameWorkspacePath(sourcePath: string, nextPath: string): Promise<string> {
  await mkdir(path.dirname(nextPath), { recursive: true });
  if (sourcePath !== nextPath && existsSync(nextPath)) {
    throw new Error(`Destination already exists: ${nextPath}`);
  }
  await rename(sourcePath, nextPath);
  return nextPath;
}

export async function deleteWorkspacePath(targetPath: string): Promise<void> {
  await rm(targetPath, { recursive: true, force: true });
}

export async function loadFilePreview(filePath: string): Promise<string> {
  const content = await readFile(filePath, "utf8");
  return content.slice(0, 400);
}

function isWithin(root: string, targetPath: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(targetPath));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function frontmatterTagsForSearch(frontmatter: Record<string, unknown>): string[] {
  if (Array.isArray(frontmatter.tags)) {
    return frontmatter.tags.filter((entry: unknown): entry is string => typeof entry === "string");
  }
  if (typeof frontmatter.tags === "string") {
    return frontmatter.tags.split(/[,\s]+/).filter(Boolean);
  }
  return [];
}

function firstMarkdownHeading(body: string): string {
  const heading = body.match(/^#{1,6}\s+(.+)$/m);
  return heading?.[1]?.trim() ?? "";
}

function snippetForNoteMatch(kind: string, value: string, query: string, relativePath: string): string {
  if (kind === "title") {
    return `title: ${value}`;
  }
  if (kind === "tag") {
    return `#${value.replace(/^#/, "")}`;
  }
  if (kind === "path") {
    return relativePath;
  }
  return excerptAroundMatch(value, query);
}

function excerptAroundMatch(text: string, query: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  const index = normalized.toLowerCase().indexOf(query.toLowerCase());
  if (index < 0) {
    return normalized.slice(0, 240);
  }
  const start = Math.max(0, index - 80);
  const end = Math.min(normalized.length, index + query.length + 120);
  const prefix = start > 0 ? "..." : "";
  const suffix = end < normalized.length ? "..." : "";
  return `${prefix}${normalized.slice(start, end)}${suffix}`;
}
