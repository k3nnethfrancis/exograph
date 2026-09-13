import { mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { PublicationSnapshot, WorkspaceModel, WorkspaceSettings, WorkspaceSettingsSnapshot } from "@exograph/core";
import { publicationScope, type PublishingBuildRequest, type PublicationAction, type PublishingStatus } from "../../shared/api";
import { buildQuartzSite, type QuartzBuildInput } from "./quartz-build";
import { servePublication, within } from "./preview-server";

interface PublishingContext extends WorkspaceSettingsSnapshot { model: WorkspaceModel }
interface PublishingServiceOptions {
  context: () => PublishingContext;
  stagingParent: string;
  capture: (model: WorkspaceModel, publicationDirectory: string, stagingParent: string, generatedRoutes: readonly string[], assertCurrent: () => void) => Promise<PublicationSnapshot>;
  verify: (snapshot: PublicationSnapshot) => Promise<void>;
  publishStatus: (status: PublishingStatus) => void;
  build?: (input: QuartzBuildInput) => Promise<void>;
}

export class PublishingService {
  private status: PublishingStatus = { phase: "idle", diagnostics: [] };
  private contextKey = "";
  private generation = 0;
  private abort: AbortController | null = null;
  private pending: Promise<PublishingStatus> | null = null;
  private retainedRoot: string | null = null;
  private preview: { close: () => void } | null = null;

  constructor(private readonly options: PublishingServiceOptions) {}

  updateContext(): void {
    const next = contextKey(this.options.context());
    if (next === this.contextKey) return;
    this.contextKey = next;
    this.invalidate();
  }

  getStatus(): PublishingStatus { this.updateContext(); return this.status; }

  async build(input: PublishingBuildRequest): Promise<PublishingStatus> {
    this.updateContext();
    if (!input || (input.action !== "preview" && input.action !== "prepare")) throw new Error("Unknown publishing action.");
    const context = this.options.context();
    let expectedKey: string;
    try { expectedKey = JSON.stringify(publicationScope(input.scope)); }
    catch { throw new Error("Invalid publication settings scope."); }
    if (expectedKey !== contextKey(context)) throw new Error("Publication settings or Note Roots changed. Reopen Settings and review the current folders before building.");
    if (this.pending) throw new Error("A publication build is already running.");
    this.invalidate();
    const generation = this.generation;
    const controller = new AbortController();
    this.abort = controller;
    this.setStatus({ phase: "exporting", action: input.action, diagnostics: [] });
    const job = this.run(context, input.action, generation, controller.signal);
    this.pending = job;
    try { return await job; } finally {
      if (this.pending === job) this.pending = null;
      if (this.abort === controller) this.abort = null;
    }
  }

  async stop(): Promise<void> {
    this.invalidate();
    await this.pending;
  }

  outputPath(): string {
    const status = this.getStatus();
    if (status.phase !== "ready" || !status.outputPath) throw new Error("Build a site first.");
    return status.outputPath;
  }

  private invalidate(): void {
    this.generation++;
    this.abort?.abort();
    this.preview?.close();
    this.preview = null;
    const root = this.retainedRoot;
    this.retainedRoot = null;
    if (root) void rm(root, { recursive: true, force: true }).catch(() => {});
    this.setStatus({ phase: "idle", diagnostics: [] });
  }

  private async run(context: PublishingContext, action: PublicationAction, generation: number, signal: AbortSignal): Promise<PublishingStatus> {
    let snapshot: PublicationSnapshot | undefined;
    let retained = false;
    const assertCurrent = () => {
      this.updateContext();
      if (signal.aborted || generation !== this.generation) throw new Error("Build cancelled.");
    };
    try {
      const config = await validatePublishingSettings(context.settings, context.model, this.options.stagingParent);
      assertCurrent();
      const generatedRoutes = await readGeneratedRoutes(config.engineDirectory);
      assertCurrent();
      snapshot = await this.options.capture(context.model, config.publicationDirectory, config.stagingParent, generatedRoutes, assertCurrent);
      assertCurrent();
      await this.options.verify(snapshot);
      assertCurrent();
      const output = path.join(snapshot.stagingRoot, "site");
      this.setStatus({ phase: "building", action, diagnostics: snapshot.manifest.diagnostics });
      await (this.options.build ?? buildQuartzSite)({ engineDirectory: config.engineDirectory, inputDirectory: snapshot.directory,
        outputDirectory: output, siteUrl: config.siteUrl, action, signal });
      assertCurrent();
      await this.options.verify(snapshot);
      assertCurrent();
      // The private receipt never sits in the web root. A prepared artifact is not deployed.
      await writeFile(path.join(snapshot.stagingRoot, "publication.json"), JSON.stringify(snapshot.manifest, null, 2), { flag: "wx", mode: 0o600 });
      let previewUrl: string | undefined;
      if (action === "preview") {
        const preview = await servePublication(output, new URL(config.siteUrl).pathname);
        try { assertCurrent(); } catch (error) { preview.close(); throw error; }
        this.preview = preview;
        previewUrl = preview.url;
      }
      this.retainedRoot = snapshot.stagingRoot;
      retained = true;
      this.setStatus({ phase: "ready", action, outputPath: output, previewUrl, diagnostics: snapshot.manifest.diagnostics });
    } catch (error) {
      if (generation === this.generation) {
        const diagnostics = error && typeof error === "object" && "diagnostics" in error && Array.isArray(error.diagnostics)
          ? error.diagnostics : snapshot?.manifest.diagnostics ?? [];
        this.setStatus({ phase: "error", action, diagnostics, error: error instanceof Error ? error.message : String(error) });
      }
    } finally {
      if (snapshot && !retained) await rm(snapshot.stagingRoot, { recursive: true, force: true });
    }
    return this.status;
  }

  private setStatus(status: PublishingStatus): void { this.status = status; this.options.publishStatus(status); }
}

function contextKey(context: PublishingContext): string {
  return JSON.stringify(publicationScope({ workspaceRoot: context.model.workspaceRoot, noteRoots: context.model.noteRoots.map((root) => root.path), publishing: context.settings.publishing }));
}

export async function validatePublishingSettings(settings: WorkspaceSettings, model: WorkspaceModel, stagingParent: string) {
  const config = settings.publishing;
  if (!config || !config.publicationDirectory || !config.engineDirectory || !config.siteUrl) throw new Error("Choose a publication folder, Quartz project, and site URL.");
  if (!path.isAbsolute(config.publicationDirectory) || !path.isAbsolute(config.engineDirectory)) throw new Error("Publishing folders must be absolute paths.");
  const url = new URL(config.siteUrl);
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("Use a site URL without credentials, query, or fragment.");
  const roots = await Promise.all(model.noteRoots.map(async (root) => ({ lexical: path.resolve(root.path), canonical: await realpath(root.path) })));
  const publicationDirectory = await realpath(config.publicationDirectory);
  if (!roots.some((root) => within(root.lexical, path.resolve(config.publicationDirectory)) && within(root.canonical, publicationDirectory))) {
    throw new Error("The publication folder must be inside a Note Root.");
  }
  const engineDirectory = await realpath(config.engineDirectory);
  if (!(await stat(publicationDirectory)).isDirectory() || !(await stat(engineDirectory)).isDirectory()) throw new Error("Select folders for publication and Quartz.");
  // Check both aliases and canonical paths before creating private staging files.
  const assertOutside = (lexical: string, canonical: string) => {
    if (roots.some((root) => within(root.lexical, lexical) || within(root.canonical, canonical))) throw new Error("Quartz and publication builds must be outside every Note Root.");
  };
  assertOutside(path.resolve(config.engineDirectory), engineDirectory);
  assertOutside(path.resolve(stagingParent), await canonicalCreationPath(stagingParent));
  await mkdir(stagingParent, { recursive: true, mode: 0o700 });
  const canonicalStaging = await realpath(stagingParent);
  assertOutside(path.resolve(stagingParent), canonicalStaging);
  return { publicationDirectory: config.publicationDirectory, engineDirectory, stagingParent: canonicalStaging, siteUrl: url.toString() };
}

async function canonicalCreationPath(target: string): Promise<string> {
  try { return await realpath(target); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const parent = path.dirname(target);
    if (parent === target) throw error;
    return path.join(await canonicalCreationPath(parent), path.basename(target));
  }
}

async function readGeneratedRoutes(engine: string): Promise<readonly string[]> {
  const configPath = path.join(engine, "exograph-publishing.json");
  let source: string;
  try {
    if (!within(engine, await realpath(configPath))) throw new Error("Publishing configuration must belong to the Quartz project.");
    source = await readFile(configPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const config = JSON.parse(source) as { schemaVersion?: unknown; generatedRoutes?: unknown };
  if (config.schemaVersion !== 1 || !Array.isArray(config.generatedRoutes) || config.generatedRoutes.length > 10_000
    || !config.generatedRoutes.every((route) => typeof route === "string" && route.length < 2048 && !route.includes("..") && !route.includes("\\") && !route.includes(":"))) {
    throw new Error("Quartz project has an invalid generated route allowlist.");
  }
  return config.generatedRoutes;
}
