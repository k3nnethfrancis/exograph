import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { commandEnvironment } from "../command/command-environment";

const VERSION = "2.100.0";
const hashes: Record<string, string> = {
  arm64: "45f9a62da2f6e641a7fad57e2ce39656dfd7ef331372d80a2a2aed65abb01642",
  x64: "fcd7799e85eb575f3c7d2b1679bfbfedaefa1269d4bc7d096b51e10939b4812b",
};
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const execute = async (file: string, args: string[], signal?: AbortSignal) => {
  await promisify(execFile)(file, args, { env: commandEnvironment(), signal, timeout: 30_000, maxBuffer: 1_048_576 });
};
interface Dependencies {
  platform: NodeJS.Platform;
  arch: string;
  fetch: typeof fetch;
  execute: typeof execute;
  expectedHash?: string;
}

/** Factory keeps provisioning deterministic in tests without network downloads. */
export function createGitHubCliResolver(overrides: Partial<Dependencies> = {}) {
  const deps = { platform: process.platform, arch: process.arch, fetch, execute, ...overrides };
  const pending = new Map<string, Promise<string>>();
  return async function resolve(cacheRoot: string, signal?: AbortSignal, options: { download?: boolean } = {}): Promise<string> {
    signal?.throwIfAborted();
    try { await deps.execute("gh", ["--version"], signal); return "gh"; }
    catch { signal?.throwIfAborted(); }
    if (deps.platform !== "darwin" || !hashes[deps.arch]) throw new Error("Install GitHub CLI for this platform, then retry connecting GitHub.");
    const target = path.resolve(cacheRoot, `gh-${VERSION}-${deps.arch}`);
    const binary = path.join(target, "bin", "gh");
    const expected = deps.expectedHash ?? hashes[deps.arch]!;
    const cached = async () => {
      try {
        const receipt = JSON.parse(await readFile(path.join(target, "receipt.json"), "utf8")) as { archiveHash?: string; binaryHash?: string };
        if (receipt.archiveHash !== expected || hash(await readFile(binary)) !== receipt.binaryHash) return false;
        await deps.execute(binary, ["--version"], signal);
        return true;
      } catch { signal?.throwIfAborted(); return false; }
    };
    if (await cached()) return binary;
    if (options.download === false) throw new Error("GitHub CLI is not installed in the managed tools cache.");
    const existing = pending.get(target);
    if (existing) return existing;
    const job = (async () => {
      await mkdir(cacheRoot, { recursive: true });
      const temporary = await mkdtemp(path.join(cacheRoot, ".gh-download-"));
      try {
        const architecture = deps.arch === "x64" ? "amd64" : "arm64";
        const asset = `gh_${VERSION}_macOS_${architecture}`;
        const timeout = AbortSignal.timeout(90_000);
        const response = await deps.fetch(`https://github.com/cli/cli/releases/download/v${VERSION}/${asset}.zip`, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
        if (!response.ok || !response.body) throw new Error("Could not download GitHub CLI. Try connecting again.");
        const chunks: Uint8Array[] = [];
        let size = 0;
        const reader = response.body.getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.length;
            if (size > 100 * 1024 * 1024) throw new Error("GitHub CLI download exceeded the size limit.");
            chunks.push(value);
          }
        } finally { await reader.cancel(); }
        const archive = Buffer.concat(chunks);
        if (hash(archive) !== expected) throw new Error("GitHub CLI download failed checksum verification. Nothing was installed.");
        const zip = path.join(temporary, "gh.zip");
        const unpacked = path.join(temporary, "unpacked");
        await writeFile(zip, archive);
        await deps.execute("/usr/bin/ditto", ["-x", "-k", zip, unpacked], signal);
        const source = path.join(unpacked, asset);
        const prepared = path.join(temporary, "prepared");
        await mkdir(path.join(prepared, "bin"), { recursive: true });
        await copyFile(path.join(source, "bin", "gh"), path.join(prepared, "bin", "gh"));
        await copyFile(path.join(source, "LICENSE"), path.join(prepared, "LICENSE"));
        await chmod(path.join(prepared, "bin", "gh"), 0o755);
        await deps.execute(path.join(prepared, "bin", "gh"), ["--version"], signal);
        await writeFile(path.join(prepared, "receipt.json"), JSON.stringify({ version: VERSION, archiveHash: expected, binaryHash: hash(await readFile(path.join(prepared, "bin", "gh"))) }));
        signal?.throwIfAborted();
        // Only replace this resolver's versioned tool cache after full validation.
        await rm(target, { recursive: true, force: true });
        await rename(prepared, target);
        return binary;
      } finally { await rm(temporary, { recursive: true, force: true }); }
    })();
    pending.set(target, job);
    try { return await job; } finally { pending.delete(target); }
  };
}

export const resolveGitHubCli = createGitHubCliResolver();


/** Status checks may discover a validated cache without downloading anything. */
export async function findGitHubCli(cacheRoot: string, signal?: AbortSignal): Promise<string | undefined> {
  try { return await resolveGitHubCli(cacheRoot, signal, { download: false }); }
  catch { signal?.throwIfAborted(); return undefined; }
}
