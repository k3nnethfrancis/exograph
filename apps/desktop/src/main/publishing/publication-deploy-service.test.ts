import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { exportPublication, normalizeWorkspaceSettings, verifyPublicationSnapshot, workspaceModelFromSettings } from "@exograph/core";
import { PublishingService } from "./publishing-service";
import type { PublicationDeployInput, PublicationDeployResult } from "./quartz-deploy";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const originalCommit = "a".repeat(40);
const deployed: PublicationDeployResult = { status: "deployed", deploymentUrl: "https://example.com/", snapshotCommit: "b".repeat(40), engineCommit: originalCommit, runId: "123" };

async function fixture(operation: (input: PublicationDeployInput) => Promise<PublicationDeployResult> = async () => deployed) {
  const deploy = vi.fn(operation);
  const temp = await realpath(await mkdtemp(path.join(os.tmpdir(), "exo-deployment-service-")));
  cleanups.push(() => rm(temp, { recursive: true, force: true }));
  const notes = path.join(temp, "notes");
  const engine = path.join(temp, "engine");
  await mkdir(notes);
  await mkdir(engine);
  const file = path.join(notes, "index.md");
  await writeFile(file, "# Public site\n");
  let settings = normalizeWorkspaceSettings({ workspaceRoot: temp, defaultTerminalCwd: temp, noteRoots: [notes], publishing: { publicationDirectory: notes, engineDirectory: engine, siteUrl: "https://example.com/", destinationRepository: "author/site" } })!;
  let commit = originalCommit;
  let repository = "author/theme";
  const service = new PublishingService({
    context: () => ({ settings, model: workspaceModelFromSettings(settings), revision: "any-settings-revision" }),
    stagingParent: path.join(temp, "staging"),
    capture: (model, publicationDirectory, stagingParent, generatedRoutes) => exportPublication({ model, publicationDirectory, stagingParent, generatedRoutes }),
    verify: verifyPublicationSnapshot,
    readEngineCommit: async () => commit,
    readEngineRepository: async () => repository,
    build: async ({ outputDirectory }) => { await mkdir(outputDirectory); await writeFile(path.join(outputDirectory, "index.html"), "built public site"); },
    deploy,
    publishStatus: vi.fn(),
  });
  cleanups.push(() => service.stop());
  return { service, deploy, file, settings, setRepository: (value: string) => { repository = value; }, setDestination: (value: string) => { settings = { ...settings, publishing: { ...settings.publishing!, destinationRepository: value } }; service.updateContext(); }, setCommit: (value: string) => { commit = value; }, changeScope: () => { settings = { ...settings, publishing: { ...settings.publishing!, siteUrl: "https://replacement.example/" } }; service.updateContext(); } };
}

it("requires explicit publication of the exact prepared id and records a confirmed deployment once", async () => {
  const f = await fixture();
  const prepared = await f.service.build({ scope: f.settings, action: "prepare" });
  expect(prepared.phase).toBe("ready");
  expect(prepared.preparedId).toBeTruthy();
  expect(f.deploy).not.toHaveBeenCalled();
  await expect(f.service.publish({ scope: f.settings, preparedId: "another-preparation" })).rejects.toThrow("Prepare and review");
  const result = await f.service.publish({ scope: f.settings, preparedId: prepared.preparedId! });
  expect(result).toMatchObject({ phase: "ready", deployment: deployed });
  expect(f.deploy).toHaveBeenCalledOnce();
  const input = f.deploy.mock.calls[0]![0];
  expect(input.engineCommit).toBe(originalCommit);
  expect(input.snapshotHash).toMatch(/^[a-f0-9]{64}$/);
  expect(input.inputDirectory).not.toBe(prepared.outputPath);
  expect(await readFile(path.join(input.inputDirectory, "index.md"), "utf8")).toContain("# Public site");
  await expect(f.service.publish({ scope: f.settings, preparedId: prepared.preparedId! })).rejects.toThrow("already deployed");
});

it.each(["source", "engine"])("refuses changed %s after review without calling deployment", async (change) => {
  const f = await fixture();
  const prepared = await f.service.build({ scope: f.settings, action: "prepare" });
  if (change === "source") await writeFile(f.file, "# Changed after review\n");
  else f.setCommit("c".repeat(40));
  const result = await f.service.publish({ scope: f.settings, preparedId: prepared.preparedId! });
  expect(result.phase).toBe("error");
  expect(result.error).toContain(change === "source" ? "source bytes changed" : "Quartz changed after preparation");
  expect(f.deploy).not.toHaveBeenCalled();
});

it("keeps setup-required truthful and only retries when explicitly invoked", async () => {
  const deploy = vi.fn(async (): Promise<PublicationDeployResult> => ({ status: "setup-required", message: "Install the reviewed workflow." }));
  const f = await fixture(deploy);
  const prepared = await f.service.build({ scope: f.settings, action: "prepare" });
  const result = await f.service.publish({ scope: f.settings, preparedId: prepared.preparedId! });
  expect(result).toMatchObject({ phase: "ready", deployment: { status: "setup-required" } });
  expect(deploy).toHaveBeenCalledOnce();
  f.service.getStatus();
  expect(deploy).toHaveBeenCalledOnce();
});

it("ignores a late remote completion after publication scope replacement", async () => {
  let finish!: (result: PublicationDeployResult) => void;
  const deploy = vi.fn(() => new Promise<PublicationDeployResult>((resolve) => { finish = resolve; }));
  const f = await fixture(deploy);
  const prepared = await f.service.build({ scope: f.settings, action: "prepare" });
  const pending = f.service.publish({ scope: f.settings, preparedId: prepared.preparedId! });
  await vi.waitFor(() => expect(deploy).toHaveBeenCalledOnce());
  f.changeScope();
  finish(deployed);
  const result = await pending;
  expect(result.phase).toBe("idle");
  expect(result.deployment).toBeUndefined();
  expect(f.service.getStatus().preparedId).toBeUndefined();
});

it("rejects an engine origin changed after preparation and invalidates a changed destination", async () => {
  const f = await fixture();
  const prepared = await f.service.build({ scope: f.settings, action: "prepare" });
  f.setRepository("another/theme");
  const result = await f.service.publish({ scope: f.settings, preparedId: prepared.preparedId! });
  expect(result.error).toContain("origin changed"); expect(f.deploy).not.toHaveBeenCalled();
  f.setDestination("another/site");
  expect(f.service.getStatus().preparedId).toBeUndefined();
  await expect(f.service.publish({ scope: f.settings, preparedId: prepared.preparedId! })).rejects.toThrow("Publication settings");
});
it("keeps local preparation available without a deployment destination", async () => {
  const f = await fixture(); f.setDestination("");
  const scope = { ...f.settings, publishing: { ...f.settings.publishing!, destinationRepository: "" } };
  const result = await f.service.build({ scope, action: "prepare" });
  expect(result).toMatchObject({ phase: "ready", deployment: { status: "setup-required" } });
  expect(result.preparedId).toBeUndefined(); expect(f.deploy).not.toHaveBeenCalled();
});
