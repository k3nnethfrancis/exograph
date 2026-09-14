import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createGitHubCliResolver } from "./github-cli";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, {recursive:true,force:true}))); });
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "exo-gh-test-")); roots.push(root);
  const bytes = Buffer.from("verified fixture archive");
  const download = vi.fn(async () => new Response(bytes));
  const execute = vi.fn(async (file: string, args: string[]) => {
    if (file === "gh") throw new Error("not installed");
    if (file === "/usr/bin/ditto") {
      const extracted = path.join(args[3]!, "gh_2.100.0_macOS_arm64");
      await mkdir(path.join(extracted,"bin"),{recursive:true});
      await writeFile(path.join(extracted,"bin/gh"), "fixture binary");
      await writeFile(path.join(extracted,"LICENSE"), "MIT license fixture");
    }
  });
  return { root, bytes, download, execute, expectedHash: createHash("sha256").update(bytes).digest("hex") };
}
it("prefers an existing GitHub CLI without a download", async () => {
  const f = await fixture();
  const resolve = createGitHubCliResolver({execute:async()=>{}, fetch:f.download});
  await expect(resolve(f.root)).resolves.toBe("gh");
  expect(f.download).not.toHaveBeenCalled();
});
it("verifies, installs once across concurrent callers, retains license and reuses validated cache", async () => {
  const f = await fixture();
  const resolve = createGitHubCliResolver({platform:"darwin",arch:"arm64",fetch:f.download,execute:f.execute,expectedHash:f.expectedHash});
  const [a,b] = await Promise.all([resolve(f.root),resolve(f.root)]);
  expect(a).toBe(b); expect(path.isAbsolute(a)).toBe(true);
  expect(await readFile(path.join(path.dirname(a),"../LICENSE"),"utf8")).toBe("MIT license fixture");
  await expect(resolve(f.root)).resolves.toBe(a);
  expect(f.download).toHaveBeenCalledTimes(1);
});
it("rejects bad checksums before unpacking or executing downloaded bytes", async () => {
  const f = await fixture();
  const resolve = createGitHubCliResolver({platform:"darwin",arch:"arm64",fetch:f.download,execute:f.execute,expectedHash:"0".repeat(64)});
  await expect(resolve(f.root)).rejects.toThrow("checksum verification");
  expect(f.execute.mock.calls.every(([file])=>file==="gh")).toBe(true);
});
it("reports unsupported platforms without external downloads and respects cancellation", async () => {
  const f = await fixture();
  const resolve = createGitHubCliResolver({platform:"linux",arch:"arm64",fetch:f.download,execute:f.execute});
  await expect(resolve(f.root)).rejects.toThrow("Install GitHub CLI");
  const controller = new AbortController(); controller.abort();
  await expect(resolve(f.root,controller.signal)).rejects.toThrow();
  expect(f.download).not.toHaveBeenCalled();
});


it("read-only discovery never downloads but recognizes a validated cache after restart", async () => {
  const f = await fixture();
  const dependencies = {platform:"darwin" as const,arch:"arm64",fetch:f.download,execute:f.execute,expectedHash:f.expectedHash};
  const resolve = createGitHubCliResolver(dependencies);
  await expect(resolve(f.root,undefined,{download:false})).rejects.toThrow("not installed");
  expect(f.download).not.toHaveBeenCalled();
  const binary = await resolve(f.root);
  const restarted = createGitHubCliResolver(dependencies);
  await expect(restarted(f.root,undefined,{download:false})).resolves.toBe(binary);
  expect(f.download).toHaveBeenCalledTimes(1);
});
