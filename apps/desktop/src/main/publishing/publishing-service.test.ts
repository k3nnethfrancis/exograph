import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import { get } from "node:http";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { exportPublication, verifyPublicationSnapshot, normalizeWorkspaceSettings, workspaceModelFromSettings, type PublicationSnapshot } from "@exograph/core";
import { PublishingService, validatePublishingSettings } from "./publishing-service";
import { buildQuartzSite } from "./quartz-build";
import { servePublication } from "./preview-server";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture() {
  const temp = await realpath(await mkdtemp(path.join(os.tmpdir(), "exo-publishing-")));
  cleanups.push(() => rm(temp, { recursive: true, force: true }));
  const notes = path.join(temp, "notes");
  const publication = path.join(notes, "garden");
  const engine = path.join(temp, "engine");
  const staging = path.join(temp, "builds");
  await mkdir(publication, { recursive: true });
  await mkdir(path.join(engine, "scripts"), { recursive: true });
  const settings = normalizeWorkspaceSettings({ workspaceRoot: temp, defaultTerminalCwd: temp, noteRoots: [notes], publishing: {
    publicationDirectory: publication, engineDirectory: engine, siteUrl: "https://example.com/",
  } })!;
  return { temp, notes, publication, engine, staging, settings, model: workspaceModelFromSettings(settings) };
}

it("persists publishing as a normalized optional workspace setting", async () => {
  const f = await fixture();
  expect(normalizeWorkspaceSettings({ ...f.settings, publishing: { ...f.settings.publishing!, siteUrl: " https://site.example/ " } })?.publishing?.siteUrl).toBe("https://site.example/");
  expect(normalizeWorkspaceSettings({ ...f.settings, publishing: undefined })?.publishing).toBeUndefined();
});

it("rejects engine and staging symlink escapes into notes before writing staging", async () => {
  const f = await fixture();
  const alias = path.join(f.temp, "alias");
  await symlink(f.notes, alias);
  await expect(validatePublishingSettings({ ...f.settings, publishing: { ...f.settings.publishing!, engineDirectory: alias } }, f.model, f.staging)).rejects.toThrow("outside every Note Root");
  await expect(validatePublishingSettings(f.settings, f.model, path.join(alias, "never-created"))).rejects.toThrow("outside every Note Root");
  await expect(readFile(path.join(f.notes, "never-created"))).rejects.toMatchObject({ code: "ENOENT" });
  const privateAlias = path.join(f.publication, "outside");
  await symlink(f.engine, privateAlias);
  await expect(validatePublishingSettings({ ...f.settings, publishing: { ...f.settings.publishing!, publicationDirectory: privateAlias } }, f.model, f.staging)).rejects.toThrow("inside a Note Root");
});

it("serves only built files and rejects sibling receipts, symlinks, and foreign Host headers", async () => {
  const f = await fixture();
  await writeFile(path.join(f.engine, "index.html"), "public page");
  await writeFile(path.join(f.temp, "private.json"), "private receipt");
  await symlink(path.join(f.temp, "private.json"), path.join(f.engine, "leak.json"));
  const server = await servePublication(f.engine, "/garden/");
  cleanups.push(async () => server.close());
  expect(await (await fetch(server.url)).text()).toBe("public page");
  expect((await fetch(`${server.url}leak.json`)).status).toBe(404);
  expect((await fetch(`${server.url}%2e%2e%2fprivate.json`)).status).toBe(404);
  expect((await fetch(new URL("/index.html", server.url))).status).toBe(404);
  const spoofedStatus = await new Promise<number | undefined>((resolve, reject) => {
    get(server.url, { headers: { Host: "attacker.example" } }, (response) => { response.resume(); resolve(response.statusCode); }).on("error", reject);
  });
  expect(spoofedStatus).toBe(403);
});

it("runs a real fixed adapter with literal arguments and rejects false success", async () => {
  const f = await fixture();
  const adapter = path.join(f.engine, "scripts/exograph-publish.mjs");
  await writeFile(adapter, `import { mkdir, writeFile } from 'node:fs/promises';
    const args=Object.fromEntries(Array.from({length:(process.argv.length-2)/2},(_,i)=>[process.argv[2+i*2],process.argv[3+i*2]]));
    await mkdir(args['--output']); await writeFile(args['--output']+'/index.html',args['--site-url']);
    console.log(JSON.stringify({ok:true,outputPath:args['--output'],action:args['--action']}));`);
  const output = path.join(f.temp, "output ; literal");
  const input = { engineDirectory: f.engine, inputDirectory: f.publication, outputDirectory: output, siteUrl: "https://example.com/", action: "prepare" as const, signal: new AbortController().signal };
  await buildQuartzSite(input);
  expect(await readFile(path.join(output, "index.html"), "utf8")).toBe(input.siteUrl);
  await writeFile(adapter, `console.log(JSON.stringify({ok:true,outputPath:'/wrong',action:'prepare'}));`);
  await expect(buildQuartzSite({ ...input, outputDirectory: path.join(f.temp, "other") })).rejects.toThrow("Quartz build failed");
});

it("terminates a running real adapter when cancelled", async () => {
  const f = await fixture();
  await writeFile(path.join(f.engine, "scripts/exograph-publish.mjs"), `setInterval(()=>{},1000);`);
  const controller = new AbortController();
  const job = buildQuartzSite({ engineDirectory: f.engine, inputDirectory: f.publication, outputDirectory: path.join(f.temp, "out"), siteUrl: "https://example.com/", action: "preview", signal: controller.signal });
  setTimeout(() => controller.abort(), 80);
  await expect(job).rejects.toThrow("cancelled");
});

it("discards a late export after workspace context replacement without launching Quartz", async () => {
  const f = await fixture();
  const snapshotRoot = path.join(f.temp, "snapshot");
  await mkdir(path.join(snapshotRoot, "content"), { recursive: true });
  let complete!: (snapshot: PublicationSnapshot) => void;
  const capture = vi.fn(() => new Promise<PublicationSnapshot>((resolve) => { complete = resolve; }));
  let context = { settings: f.settings, model: f.model, revision: "rev1" };
  const build = vi.fn();
  const service = new PublishingService({ context: () => context, stagingParent: f.staging, capture, verify: vi.fn(), build, publishStatus: vi.fn() });
  const job = service.build({ scope: f.settings, action: "preview" });
  await vi.waitFor(() => expect(capture).toHaveBeenCalled());
  context = { ...context, settings: { ...f.settings, publishing: { ...f.settings.publishing!, siteUrl: "https://replacement.example/" } } };
  service.updateContext();
  complete({ stagingRoot: snapshotRoot, directory: path.join(snapshotRoot, "content"), manifest: { diagnostics: [] } } as unknown as PublicationSnapshot);
  expect((await job).phase).toBe("idle");
  expect(build).not.toHaveBeenCalled();
  await expect(readFile(snapshotRoot)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(service.build({ scope: { ...f.settings, publishing: { ...f.settings.publishing!, publicationDirectory: "/stale" } }, action: "preview" })).rejects.toThrow("Publication settings or Note Roots changed");
});

it("keeps source-change failures out of preview and removes failed artifacts", async () => {
  const f = await fixture();
  const snapshotRoot = path.join(f.temp, "snapshot");
  await mkdir(path.join(snapshotRoot, "content"), { recursive: true });
  const capture = async () => ({ stagingRoot: snapshotRoot, directory: path.join(snapshotRoot, "content"), manifest: { diagnostics: [] } } as unknown as PublicationSnapshot);
  const verify = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("source bytes changed"));
  const service = new PublishingService({ context: () => ({ settings: f.settings, model: f.model, revision: "rev1" }), stagingParent: f.staging,
    capture, verify, publishStatus: vi.fn(), build: async ({ outputDirectory }) => { await mkdir(outputDirectory); await writeFile(path.join(outputDirectory, "index.html"), "built"); } });
  const result = await service.build({ scope: f.settings, action: "preview" });
  expect(result).toMatchObject({ phase: "error", error: "source bytes changed" });
  expect(result.previewUrl).toBeUndefined();
  expect(() => service.outputPath()).toThrow("Build a site first");
  await expect(readFile(snapshotRoot)).rejects.toMatchObject({ code: "ENOENT" });
});

it("stops a ready preview and removes its private snapshot on configuration change", async () => {
  const f = await fixture();
  const snapshotRoot = path.join(f.temp, "snapshot");
  await mkdir(path.join(snapshotRoot, "content"), { recursive: true });
  const capture = async () => ({ stagingRoot: snapshotRoot, directory: path.join(snapshotRoot, "content"), manifest: { diagnostics: [] } } as unknown as PublicationSnapshot);
  let settings = f.settings;
  const service = new PublishingService({ context: () => ({ settings, model: f.model, revision: "rev1" }), stagingParent: f.staging,
    capture, verify: vi.fn(), publishStatus: vi.fn(), build: async ({ outputDirectory }) => { await mkdir(outputDirectory); await writeFile(path.join(outputDirectory, "index.html"), "built"); } });
  cleanups.push(() => service.stop());
  const result = await service.build({ scope: f.settings, action: "preview" });
  expect(result.phase).toBe("ready");
  expect(await (await fetch(result.previewUrl!)).text()).toBe("built");
  settings = { ...settings, publishing: { ...settings.publishing!, siteUrl: "https://different.example/" } };
  service.updateContext();
  expect(service.getStatus().phase).toBe("idle");
  await expect(fetch(result.previewUrl!)).rejects.toThrow();
  await vi.waitFor(async () => { await expect(readFile(snapshotRoot)).rejects.toMatchObject({ code: "ENOENT" }); });
});


it("builds and serves a real Core export while keeping private links and source bytes out of the site", async () => {
  const f = await fixture();
  const authored = "# Garden\n\n[Public](public.md) [Private](../secret.md)\n";
  await writeFile(path.join(f.publication, "index.md"), authored);
  await writeFile(path.join(f.publication, "public.md"), "# Public\n");
  await writeFile(path.join(f.notes, "secret.md"), "# PRIVATE_SENTINEL\n");
  await writeFile(path.join(f.engine, "scripts/exograph-publish.mjs"), `import { mkdir, readFile, writeFile } from 'node:fs/promises';
    const args=Object.fromEntries(Array.from({length:(process.argv.length-2)/2},(_,i)=>[process.argv[2+i*2],process.argv[3+i*2]]));
    const body=await readFile(args['--input']+'/index.md','utf8');
    await mkdir(args['--output']); await writeFile(args['--output']+'/index.html',body);
    console.log(JSON.stringify({ok:true,outputPath:args['--output'],action:args['--action']}));`);
  const service = new PublishingService({ context: () => ({ settings: f.settings, model: f.model, revision: "rev1" }), stagingParent: f.staging,
    capture: (model, publicationDirectory, stagingParent, generatedRoutes) => exportPublication({ model, publicationDirectory, stagingParent, generatedRoutes }),
    verify: verifyPublicationSnapshot, publishStatus: vi.fn() });
  cleanups.push(() => service.stop());
  const result = await service.build({ scope: f.settings, action: "preview" });
  expect(result.error).toBeUndefined();
  expect(result.phase).toBe("ready");
  const body = await (await fetch(result.previewUrl!)).text();
  expect(body).toContain("[Public](<public.md>)");
  expect(body).toContain("Private");
  expect(body).not.toContain("secret.md");
  expect(body).not.toContain("PRIVATE_SENTINEL");
  expect((await fetch(new URL("/publication.json", result.previewUrl!))).status).toBe(404);
  expect(await readFile(path.join(f.publication, "index.md"), "utf8")).toBe(authored);
});


it("accepts unrelated settings revisions and model replacements while rechecking actual publication scope after flush", async () => {
  const f = await fixture();
  const snapshotRoot = path.join(f.temp, "snapshot");
  await mkdir(path.join(snapshotRoot, "content"), { recursive: true });
  let context = { settings: f.settings, model: f.model, revision: "initial-revision" };
  const service = new PublishingService({ context: () => context, stagingParent: f.staging,
    capture: async (_model, _publication, _staging, _routes, assertCurrent) => {
      // Layout persistence can publish a new model while the editor flush awaits IPC.
      context = { settings: { ...context.settings, appearanceMode: "light" }, model: { ...f.model }, revision: "after-flush-layout" };
      assertCurrent();
      return { stagingRoot: snapshotRoot, directory: path.join(snapshotRoot, "content"), manifest: { diagnostics: [] } } as unknown as PublicationSnapshot;
    }, verify: vi.fn(), publishStatus: vi.fn(), build: async ({ outputDirectory }) => { await mkdir(outputDirectory); await writeFile(path.join(outputDirectory, "index.html"), "built"); } });
  cleanups.push(() => service.stop());
  context = { settings: { ...f.settings, appearanceMode: "dark" }, model: { ...f.model }, revision: "background-layout-revision" };
  expect((await service.build({ scope: f.settings, action: "prepare" })).phase).toBe("ready");
  const changedRoots = { ...f.settings, noteRoots: [f.publication] };
  await expect(service.build({ scope: changedRoots, action: "prepare" })).rejects.toThrow("Publication settings or Note Roots changed");
});
