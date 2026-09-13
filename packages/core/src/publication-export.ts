import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readdir, realpath, rm, stat, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseDocument } from "yaml";
import type { WorkspaceModel } from "./types";
import { WorkspaceFiles } from "./workspace-files";
import { isPathWithinRoot } from "./path-containment";
import { projectPublicationHtml, projectPublicationMarkdown, type PublicationResolution } from "./publication-markdown";

export interface PublicationDiagnostic { path: string; code: string; message: string }
export interface PublicationFile { path: string; kind: "note" | "asset"; visibility?: "listed" | "unlisted"; sourceHash: string; outputHash: string; sourceCreatedAt: string; sourceModifiedAt: string }
export interface PublicationSnapshot {
  schemaVersion: "exograph.publication.v1";
  id: string;
  stagingRoot: string;
  directory: string;
  manifest: { workspaceRoot: string; publicationDirectory: string; createdAt: string; generatedRoutes: readonly string[]; files: PublicationFile[]; diagnostics: PublicationDiagnostic[] };
  /** Private verification state. Never place this object inside the public content directory. */
  sources: { noteRoots: string[]; inventory: string[]; hashes: Array<{ path: string; hash: string }> };
}
export interface PublicationExportRequest {
  model: WorkspaceModel;
  publicationDirectory: string;
  stagingParent: string;
  /** Exact generated URLs approved by the site adapter; never inferred from an arbitrary missing path. */
  generatedRoutes?: readonly string[];
}
export class PublicationExportError extends Error {
  constructor(message: string, readonly diagnostics: PublicationDiagnostic[]) { super(message); this.name = "PublicationExportError"; }
}
interface SourceFile { path: string; bytes: Buffer; body: string; metadata: Record<string, unknown>; document: ReturnType<typeof parseDocument> | null; headerEnd: number; published: boolean; unlisted: boolean }
const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const markdown = (file: string) => /\.md$/i.test(file);
const assetExtensions = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".ico", ".svg", ".pdf", ".mp3", ".wav", ".ogg", ".mp4", ".webm"]);
const trueValue = (value: unknown) => value === true || value === "true";
const slash = (value: string) => value.split(path.sep).join("/");

/** Materialize a fresh publication from original-context resolution, without modifying Notes. */
export async function exportPublication(request: PublicationExportRequest): Promise<PublicationSnapshot> {
  const roots = await Promise.all(request.model.noteRoots.map((root) => realpath(root.path)));
  if (!path.isAbsolute(request.publicationDirectory)) throw new Error("Publication folder must be absolute.");
  const selected = path.resolve(request.publicationDirectory);
  const publicationDirectory = await new WorkspaceFiles(request.model.noteRoots.map((root) => root.path)).existingIdentity(selected);
  const rootIndex = request.model.noteRoots.findIndex((root, index) => isPathWithinRoot(root.path, selected) && path.resolve(roots[index], path.relative(root.path, selected)) === publicationDirectory);
  if (rootIndex < 0 || !(await lstat(publicationDirectory)).isDirectory()) throw new Error("Publication folder must be a directory inside an authorized Note Root without a symlink redirect.");
  const stagingParent = await prospectiveRealPath(request.stagingParent);
  if (roots.some((root) => isPathWithinRoot(root, stagingParent))) throw new Error("Publication staging must be outside every Note Root.");
  const generatedRoutes = [...new Set(request.generatedRoutes ?? [])];
  for (const route of generatedRoutes) if (!route || route.startsWith("/") || route.includes("\\") || route.split("/").some((part) => part === ".." || part === ".") || /[?#%]/.test(route)) throw new Error("Generated publication routes must be exact safe root-relative URLs.");
  const inventory = await inventoryFiles(roots, true, publicationDirectory);
  const sourceHashes = new Map<string, string>();
  const notes = new Map<string, SourceFile>();
  const diagnostics: PublicationDiagnostic[] = [];
  let incompleteResolution = false;
  for (const file of inventory.filter(markdown)) {
    const bytes = await containedRead(file);
    sourceHashes.set(file, hash(bytes));
    let parsed: SourceFile;
    try { parsed = parseSource(file, bytes); }
    catch (error) {
      if (isPathWithinRoot(publicationDirectory, file)) throw error;
      incompleteResolution = true;
      parsed = { path: file, bytes, body: "", metadata: {}, document: null, headerEnd: 0, published: false, unlisted: false };
    }
    parsed.published = isPathWithinRoot(publicationDirectory, file) && (!trueValue(parsed.metadata.draft) || trueValue(parsed.metadata.preview));
    parsed.unlisted = trueValue(parsed.metadata.unlisted) || (trueValue(parsed.metadata.draft) && trueValue(parsed.metadata.preview));
    notes.set(file, parsed);
  }
  const allPaths = new Set(inventory);
  const assets = new Set<string>();
  const output = new Map<string, { source: string; bytes: Buffer; kind: "note" | "asset"; visibility?: "listed" | "unlisted" }>();
  const generated = new Set(generatedRoutes.map((route) => route.replace(/\/$/, "")));
  // Quartz folder/tag routes derive from listed publication members, never private/unlisted-only members.
  for (const note of notes.values()) {
    if (!note.published || note.unlisted) continue;
    let folder = slash(path.relative(publicationDirectory, path.dirname(note.path)));
    while (folder && folder !== ".") { generated.add(folder); folder = path.posix.dirname(folder); }
    const tags = typeof note.metadata.tags === "string" ? [note.metadata.tags] : Array.isArray(note.metadata.tags) ? note.metadata.tags : [];
    for (const tag of tags) {
      if (typeof tag !== "string" || !tag || tag.split("/").some((part) => !part || part === "." || part === "..") || /[?#%\\]/.test(tag)) continue;
      generated.add("tags");
      const parts = tag.split("/");
      for (let i = 1; i <= parts.length; i++) generated.add(`tags/${parts.slice(0, i).join("/")}`);
    }
  }
  const noteNames = (note: SourceFile) => [path.basename(note.path, path.extname(note.path)), ...(typeof note.metadata.title === "string" ? [note.metadata.title] : []), ...(Array.isArray(note.metadata.aliases) ? note.metadata.aliases.filter((value): value is string => typeof value === "string") : typeof note.metadata.aliases === "string" ? [note.metadata.aliases] : [])];
  function resolver(sourcePath: string) {
    return (authored: string, wiki = false): PublicationResolution => {
      if (/^(https?:|mailto:|tel:|\/\/)/i.test(authored)) return { url: authored };
      if (/^[a-z][a-z\d+.-]*:/i.test(authored)) return { reason: "unsupported-url-scheme" };
      if (authored.startsWith("#")) return { url: authored };
      const suffixIndex = authored.search(/[?#]/);
      const targetRaw = suffixIndex < 0 ? authored : authored.slice(0, suffixIndex);
      const suffix = suffixIndex < 0 ? "" : authored.slice(suffixIndex);
      let target: string;
      try { target = decodeURIComponent(targetRaw); } catch { return { reason: "invalid-local-url" }; }
      if (!target || target.includes("\0") || target.includes("\\")) return { reason: "invalid-local-url" };
      if (wiki && incompleteResolution && !target.includes("/")) return { reason: "unverifiable-local-target" };
      const explicit = !wiki || target.includes("/") || path.extname(target) !== "";
      const localPath = target.startsWith("/") ? path.resolve(publicationDirectory, `.${target}`) : path.resolve(path.dirname(sourcePath), target);
      let candidates: string[];
      if (explicit) candidates = [localPath, ...(path.extname(localPath) ? [] : [`${localPath}.md`, path.join(localPath, "index.md")])].filter((candidate) => allPaths.has(candidate));
      else candidates = [...notes.values()].filter((note) => noteNames(note).some((name) => name.toLowerCase() === target.toLowerCase())).map((note) => note.path);
      if (candidates.length > 1) return { reason: "ambiguous-local-target" };
      if (candidates.length === 0) {
        const route = slash(path.relative(publicationDirectory, localPath)).replace(/\/$/, "");
        if (isPathWithinRoot(publicationDirectory, localPath) && generated.has(route)) return { url: publicRelative(sourcePath, localPath) + suffix, kind: "generated" };
        return { reason: "missing-local-target" };
      }
      const destination = candidates[0];
      if (!isPathWithinRoot(publicationDirectory, destination)) return { reason: "excluded-local-target" };
      if (markdown(destination)) {
        if (!notes.get(destination)?.published) return { reason: "excluded-local-target" };
      } else {
        if (!assetExtensions.has(path.extname(destination).toLowerCase())) return { reason: "unsupported-local-resource" };
        assets.add(destination);
      }
      return { url: publicRelative(sourcePath, destination) + suffix, kind: markdown(destination) ? "note" : "asset" };
    };
  }
  try {
    for (const note of notes.values()) {
      if (!note.published) continue;
      const relative = slash(path.relative(publicationDirectory, note.path));
      const diagnose = (code: string) => diagnostics.push({ path: relative, code, message: "A local publication reference was removed; its target is excluded, missing, ambiguous or unsupported." });
      const resolve = resolver(note.path);
      let body: string;
      try {
        body = projectPublicationMarkdown(note.body, resolve, diagnose);
        if (note.unlisted) { note.metadata.unlisted = true; note.document?.set("unlisted", true); }
        for (const [key, value] of Object.entries(note.metadata)) {
          if (key === "aliases") { validateAliases(value); continue; }
          const projected = projectMetadata(key, value, resolve, diagnose);
          if (projected !== value) { note.metadata[key] = projected; note.document?.set(key, projected); }
        }
      } catch (error) { throw new PublicationExportError("Publication contains an unsupported resource construct.", [{ path: relative, code: "unsupported-resource", message: error instanceof Error ? error.message : String(error) }]); }
      const sourceStat = await stat(note.path);
      // Fresh staging cannot preserve birthtime. Explicit generated dates preserve filesystem fallback.
      if (!note.metadata.date && !note.metadata.created) { note.metadata.created = sourceStat.birthtime.toISOString(); note.document?.set("created", note.metadata.created); }
      if (!note.metadata.modified && !note.metadata.updated && !note.metadata.lastmod) { note.metadata.modified = sourceStat.mtime.toISOString(); note.document?.set("modified", note.metadata.modified); }
      let text: string;
      const originalHeader = note.bytes.toString("utf8").slice(0, note.headerEnd);
      const originalMetadata = note.headerEnd ? parseSource(note.path, note.bytes).metadata : {};
      if (JSON.stringify(originalMetadata) === JSON.stringify(note.metadata)) text = originalHeader + body;
      else text = `---\n${note.document ? String(note.document) : Object.entries(note.metadata).map(([key, value]) => `${key}: ${JSON.stringify(value)}\n`).join("")}---\n${body}`;
      output.set(relative, { source: note.path, bytes: Buffer.from(text), kind: "note", visibility: note.unlisted ? "unlisted" : "listed" });
    }
    // Only resources reached from included Notes are copied. SVG references get the same projection.
    for (const file of assets) {
      const bytes = await containedRead(file);
      sourceHashes.set(file, hash(bytes));
      const relative = slash(path.relative(publicationDirectory, file));
      let projected = bytes;
      if (/\.svg$/i.test(file)) {
        try { projected = Buffer.from(projectPublicationHtml(bytes.toString("utf8"), resolver(file), (code) => diagnostics.push({ path: relative, code, message: "An SVG resource reference was removed." }))); }
        catch (error) { throw new PublicationExportError("Publication SVG contains unsupported resources.", [{ path: relative, code: "unsupported-resource", message: error instanceof Error ? error.message : String(error) }]); }
      }
      output.set(relative, { source: file, bytes: projected, kind: "asset" });
    }
    await mkdir(stagingParent, { recursive: true });
    const stagingRoot = await mkdtemp(path.join(stagingParent, "publication-"));
    const directory = path.join(stagingRoot, "content");
    try {
      await mkdir(directory);
      const files: PublicationFile[] = [];
      for (const [relative, item] of [...output].sort(([a], [b]) => a.localeCompare(b))) {
        const destination = path.join(directory, relative);
        await mkdir(path.dirname(destination), { recursive: true });
        await writeFile(destination, item.bytes, { flag: "wx" });
        const sourceStat = await stat(item.source);
        await utimes(destination, sourceStat.atime, sourceStat.mtime);
        files.push({ sourceCreatedAt: sourceStat.birthtime.toISOString(), sourceModifiedAt: sourceStat.mtime.toISOString(), path: relative, kind: item.kind, ...(item.visibility ? { visibility: item.visibility } : {}), sourceHash: sourceHashes.get(item.source)!, outputHash: hash(item.bytes) });
      }
      const snapshot: PublicationSnapshot = { schemaVersion: "exograph.publication.v1", id: "", stagingRoot, directory, manifest: { workspaceRoot: request.model.workspaceRoot, publicationDirectory, createdAt: new Date().toISOString(), generatedRoutes: [...generated].sort(), files, diagnostics }, sources: { noteRoots: roots, inventory, hashes: [...sourceHashes].map(([sourcePath, sourceHash]) => ({ path: sourcePath, hash: sourceHash })) } };
      snapshot.id = hash(JSON.stringify({ manifest: snapshot.manifest, sources: snapshot.sources }));
      await verifyPublicationSnapshot(snapshot);
      return snapshot;
    } catch (error) { await rm(stagingRoot, { recursive: true, force: true }); throw error; }
  } catch (error) { throw error; }
}

/** Reject source membership/byte changes and tampering with the exact staged content. */
export async function verifyPublicationSnapshot(snapshot: PublicationSnapshot): Promise<void> {
  if (hash(JSON.stringify({ manifest: snapshot.manifest, sources: snapshot.sources })) !== snapshot.id) throw new Error("Publication manifest changed; export again.");
  if (JSON.stringify(await inventoryFiles(snapshot.sources.noteRoots, true, snapshot.manifest.publicationDirectory)) !== JSON.stringify(snapshot.sources.inventory)) throw new Error("Publication source membership changed; export again.");
  for (const source of snapshot.sources.hashes) if (hash(await containedRead(source.path)) !== source.hash) throw new Error("Publication source bytes changed; export again.");
  const staged = await inventoryFiles([snapshot.directory], false);
  const expected = snapshot.manifest.files.map((file) => path.join(snapshot.directory, file.path)).sort();
  if (JSON.stringify(staged) !== JSON.stringify(expected)) throw new Error("Publication stage membership changed; export again.");
  for (const file of snapshot.manifest.files) {
    if (hash(await containedRead(path.join(snapshot.directory, file.path))) !== file.outputHash) throw new Error("Publication staged bytes changed; export again.");
    const sourceStat = await stat(path.join(snapshot.manifest.publicationDirectory, file.path));
    if (sourceStat.mtime.toISOString() !== file.sourceModifiedAt || sourceStat.birthtime.toISOString() !== file.sourceCreatedAt) throw new Error("Publication source timestamps changed; export again.");
  }
}

async function inventoryFiles(roots: readonly string[], hide = true, publicationDirectory?: string): Promise<string[]> {
  const files = new Set<string>();
  async function visit(directory: string): Promise<void> {
    if (await realpath(directory) !== directory) throw new Error("Publication directory identity changed.");
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (hide && (entry.name.startsWith(".") || entry.name === "node_modules")) continue;
      const target = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) { if (!hide) throw new Error("Publication stage contains a symlink."); continue; }
      if (entry.isDirectory()) await visit(target);
      else if (entry.isFile() && (!publicationDirectory || markdown(target) || isPathWithinRoot(publicationDirectory, target))) files.add(target);
    }
  }
  for (const root of roots) await visit(root);
  return [...files].sort();
}
async function containedRead(file: string): Promise<Buffer> {
  if (await realpath(file) !== file) throw new Error("Publication source identity changed or is a symlink.");
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { const bytes = await handle.readFile(); if (await realpath(file) !== file) throw new Error("Publication source identity changed while reading."); return bytes; }
  finally { await handle.close(); }
}
async function prospectiveRealPath(file: string): Promise<string> {
  if (!path.isAbsolute(file)) throw new Error("Publication paths must be absolute.");
  let existing = path.resolve(file);
  const missing: string[] = [];
  while (true) {
    try { return path.join(await realpath(existing), ...missing); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; missing.unshift(path.basename(existing)); existing = path.dirname(existing); }
  }
}
function parseSource(file: string, bytes: Buffer): SourceFile {
  const text = bytes.toString("utf8");
  const header = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  const document = header ? parseDocument(header[1]) : null;
  if (document?.errors.length) throw new Error(`Invalid publication frontmatter in ${path.basename(file)}.`);
  const metadata: unknown = document?.toJS() ?? {};
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) throw new Error("Publication frontmatter must be a mapping.");
  return { path: file, bytes, body: text.slice(header?.[0].length ?? 0), metadata: metadata as Record<string, unknown>, document, headerEnd: header?.[0].length ?? 0, published: false, unlisted: false };
}
function publicRelative(source: string, destination: string): string {
  const relative = slash(path.relative(path.dirname(source), destination));
  return relative.split("/").map((part) => encodeURIComponent(part)).join("/") || "./";
}
function validateAliases(value: unknown): void {
  const aliases = typeof value === "string" ? [value] : Array.isArray(value) ? value : [];
  for (const alias of aliases) if (typeof alias !== "string" || alias.startsWith("/") || alias.includes("\\") || alias.split("/").includes("..")) throw new Error("Publication aliases must be safe relative slugs.");
}
function projectMetadata(key: string, value: unknown, resolve: (url: string) => PublicationResolution, diagnose: (code: string) => void): unknown {
  if (Array.isArray(value)) { const mapped = value.map((item) => projectMetadata(key, item, resolve, diagnose)); return mapped.every((item, index) => item === value[index]) ? value : mapped; }
  if (value && typeof value === "object") { const entries = Object.entries(value); const mapped = entries.map(([nestedKey, item]) => [nestedKey, projectMetadata(nestedKey, item, resolve, diagnose)] as const); return mapped.every((entry, index) => entry[1] === entries[index][1]) ? value : Object.fromEntries(mapped); }
  if (typeof value !== "string") return value;
  if (["image", "cover", "banner", "thumbnail", "icon", "url"].includes(key)) {
    const result = resolve(value);
    if ("url" in result) return result.url;
    diagnose(result.reason); return "";
  }
  if (/\[\[|\]\(|<\w/.test(value)) return projectPublicationMarkdown(value, resolve, diagnose);
  if (!/^(https?:|mailto:|tel:)/i.test(value) && /(?:^|\/)[^\s]+\.(?:md|png|jpe?g|gif|svg|pdf|css|js|html?)(?:[?#]|$)/i.test(value)) throw new Error(`Unsupported frontmatter resource field: ${key}`);
  return value;
}
