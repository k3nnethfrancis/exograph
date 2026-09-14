import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it, vi } from "vitest";
import { deployQuartzSite, readPublicationEngineCommit, readPublicationEngineRepository, type PublicationDeployInput } from "./quartz-deploy";
const resource = vi.hoisted(() => ({ adapter: "" }));
vi.mock("./publishing-resources", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./publishing-resources")>();
  return { publishingResource: (name: Parameters<typeof actual.publishingResource>[0]) => name === "quartz-deploy.mjs" ? Promise.resolve(resource.adapter) : actual.publishingResource(name) };
});
const cleanup: string[] = [];
afterEach(async () => { await Promise.all(cleanup.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function fixture(script: string) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "exo-deploy-"))); cleanup.push(root);
  const engineDirectory = path.join(root, "engine ; literal"); await mkdir(engineDirectory);
  resource.adapter = path.join(root, "app-deployment-adapter.mjs");
  await writeFile(resource.adapter, script);
  await writeFile(path.join(engineDirectory, "theme.txt"), "ordinary theme without deployment code");
  const git = (...args: string[]) => promisify(execFile)("git", ["-C", engineDirectory, ...args]);
  await git("init"); await git("remote", "add", "origin", "https://github.com/author/theme.git"); await git("add", ".");
  await git("-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "commit", "-m", "fixture");
  const engineCommit = await readPublicationEngineCommit(engineDirectory);
  const input: PublicationDeployInput = { engineDirectory, engineCommit, repository: "author/site", engineRepository: "author/theme", inputDirectory: path.join(root, "input ; literal"), snapshotHash: "a".repeat(64), siteUrl: "https://example.com/", signal: new AbortController().signal };
  await mkdir(input.inputDirectory);
  return { root, input, git };
}
const argv = `const args=Object.fromEntries(Array.from({length:(process.argv.length-2)/2},(_,i)=>[process.argv[2+i*2],process.argv[3+i*2]]));`;
it("passes exact pinned arguments to a real adapter child and accepts only its completed receipt", async () => {
  const f = await fixture(`${argv}
    if(args['--snapshot-hash']!=='${"a".repeat(64)}'||!args['--input'].endsWith('input ; literal')||args['--repository']!=='author/site'||args['--engine-repository']!=='author/theme'||!args['--workflow'].endsWith('github-pages.yml')||!args['--build-script'].endsWith('quartz-build.mjs'))process.exit(1);
    console.log(JSON.stringify({ok:true,status:'deployed',deploymentUrl:args['--site-url'],snapshotCommit:'${"b".repeat(40)}',engineCommit:args['--engine-commit'],runId:'123'}));`);
  await expect(deployQuartzSite(f.input)).resolves.toEqual({ status: "deployed", deploymentUrl: "https://example.com/", snapshotCommit: "b".repeat(40), engineCommit: f.input.engineCommit, runId: "123" });
});
it("returns setup-required for a missing workflow without requiring an engine deployment script", async () => {
  const absent = await fixture(`console.log(JSON.stringify({ok:false,status:'setup-required',message:'Install the workflow'}));process.exitCode=2;`);
  await expect(deployQuartzSite(absent.input)).resolves.toEqual({ status: "setup-required", message: "Install the workflow" });
});
it.each([
  `console.log(JSON.stringify({ok:true,status:'queued'}));`,
  `console.log(JSON.stringify({ok:true,status:'deployed',deploymentUrl:'javascript:alert(1)',snapshotCommit:'${"b".repeat(40)}',engineCommit:'wrong',runId:'123'}));`,
  `console.log(JSON.stringify({ok:false,status:'setup-required',message:'wrong exit'}));`,
])("rejects incomplete or malformed success %s", async (script) => {
  const f = await fixture(script);
  await expect(deployQuartzSite(f.input)).rejects.toThrow(/receipt/);
});
it("rejects a dirty or changed engine before invoking its deployment adapter", async () => {
  const f = await fixture(`throw new Error('must not execute');`);
  await writeFile(path.join(f.input.engineDirectory, "README.md"), "uncommitted");
  await expect(deployQuartzSite(f.input)).rejects.toThrow("Commit the Quartz project's changes");
  await rm(path.join(f.input.engineDirectory, "README.md"));
  await expect(deployQuartzSite({ ...f.input, engineCommit: "f".repeat(40) })).rejects.toThrow("changed since preparation");
});
it("stops a real child without claiming a dispatched remote workflow was cancelled", async () => {
  const f = await fixture(`${argv} import {writeFile} from 'node:fs/promises'; await writeFile(args['--input']+'/started','yes');setInterval(()=>{},1000);`);
  const controller = new AbortController();
  const job = deployQuartzSite({ ...f.input, signal: controller.signal });
  const rejection = expect(job).rejects.toThrow("a dispatched workflow may still finish");
  for (let i = 0; i < 100; i++) { try { await readFile(path.join(f.input.inputDirectory, "started")); break; } catch { await new Promise((resolve) => setTimeout(resolve, 10)); } }
  controller.abort(); await rejection;
});
it("preserves a failed workflow receipt and run identity without treating dispatch as success", async () => {
  const f = await fixture(`console.log(JSON.stringify({ok:false,status:'failed',message:'Pages build failed',runId:'456'}));process.exitCode=1;`);
  await expect(deployQuartzSite(f.input)).rejects.toThrow("Pages build failed Check GitHub Actions run 456 before retrying.");
});

it.each(["https://github.com/author/theme.git", "git@github.com:author/theme.git", "ssh://git@github.com/author/theme.git", "https://github.com/author/theme/"])("resolves the actual GitHub engine origin %s", async (origin) => {
  const f = await fixture("throw new Error('not invoked')");
  await f.git("remote", "set-url", "origin", origin);
  await expect(readPublicationEngineRepository(f.input.engineDirectory)).resolves.toBe("author/theme");
});
it.each(["https://gitlab.com/author/theme.git", "https://user:password@github.com/author/theme.git", "file:///tmp/theme.git"])("rejects an unsupported origin %s", async (origin) => {
  const f = await fixture("throw new Error('not invoked')");
  await f.git("remote", "set-url", "origin", origin);
  await expect(readPublicationEngineRepository(f.input.engineDirectory)).rejects.toThrow("GitHub repository");
});
it("rejects a changed origin before starting the app deployment adapter", async () => {
  const f = await fixture("throw new Error('must not execute')");
  await f.git("remote", "set-url", "origin", "https://github.com/other/theme.git");
  await expect(deployQuartzSite(f.input)).rejects.toThrow("origin changed");
});


it("selects the self-contained workflow for managed sites", async () => {
  const f = await fixture(`${argv}
    if(!args['--workflow'].endsWith('managed-github-pages.yml')) process.exit(1);
    console.log(JSON.stringify({ok:false,status:'setup-required',message:'Managed workflow selected'}));process.exitCode=2;`);
  await writeFile(path.join(f.input.engineDirectory, "exograph-site.json"), JSON.stringify({schemaVersion:1,repository:"author/site",contentDirectory:"garden"}));
  await f.git("add", ".");
  await f.git("-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "commit", "-m", "managed");
  f.input.engineCommit = await readPublicationEngineCommit(f.input.engineDirectory);
  await expect(deployQuartzSite(f.input)).resolves.toEqual({status:"setup-required",message:"Managed workflow selected"});
});

it("makes the provisioned GitHub CLI available to deployment and Git credential helpers", async () => {
  const f = await fixture(`${argv}
    import path from 'node:path';
    const expected=path.join(path.dirname(args['--input']),'tools','bin')+path.delimiter;
    if(!process.env.PATH.startsWith(expected)) process.exit(1);
    console.log(JSON.stringify({ok:false,status:'setup-required',message:'Managed CLI available'}));process.exitCode=2;`);
  f.input.githubCliPath = path.join(f.root,"tools","bin","gh");
  await expect(deployQuartzSite(f.input)).resolves.toEqual({status:"setup-required",message:"Managed CLI available"});
});
