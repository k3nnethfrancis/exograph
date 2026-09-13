import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { deployQuartzSite, readPublicationEngineCommit, type PublicationDeployInput } from "./quartz-deploy";
const cleanup: string[] = [];
afterEach(async () => { await Promise.all(cleanup.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function fixture(script: string | null) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "exo-deploy-"))); cleanup.push(root);
  const engineDirectory = path.join(root, "engine ; literal"); await mkdir(path.join(engineDirectory, "scripts"), { recursive: true });
  if (script) await writeFile(path.join(engineDirectory, "scripts/exograph-deploy.mjs"), script);
  else await writeFile(path.join(engineDirectory, "README.md"), "fixture");
  const git = (...args: string[]) => promisify(execFile)("git", ["-C", engineDirectory, ...args]);
  await git("init"); await git("add", ".");
  await git("-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "commit", "-m", "fixture");
  const engineCommit = await readPublicationEngineCommit(engineDirectory);
  const input: PublicationDeployInput = { engineDirectory, engineCommit, inputDirectory: path.join(root, "input ; literal"), snapshotHash: "a".repeat(64), siteUrl: "https://example.com/", signal: new AbortController().signal };
  await mkdir(input.inputDirectory);
  return { root, input };
}
const argv = `const args=Object.fromEntries(Array.from({length:(process.argv.length-2)/2},(_,i)=>[process.argv[2+i*2],process.argv[3+i*2]]));`;
it("passes exact pinned arguments to a real adapter child and accepts only its completed receipt", async () => {
  const f = await fixture(`${argv}
    if(args['--snapshot-hash']!=='${"a".repeat(64)}'||!args['--input'].endsWith('input ; literal'))process.exit(1);
    console.log(JSON.stringify({ok:true,status:'deployed',deploymentUrl:args['--site-url'],snapshotCommit:'${"b".repeat(40)}',engineCommit:args['--engine-commit'],runId:'123'}));`);
  await expect(deployQuartzSite(f.input)).resolves.toEqual({ status: "deployed", deploymentUrl: "https://example.com/", snapshotCommit: "b".repeat(40), engineCommit: f.input.engineCommit, runId: "123" });
});
it("returns setup-required for a missing adapter or workflow without claiming deployment", async () => {
  const missing = await fixture(null);
  await expect(deployQuartzSite(missing.input)).resolves.toMatchObject({ status: "setup-required" });
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
