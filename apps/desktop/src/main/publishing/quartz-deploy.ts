import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { PublicationSnapshot } from "@exograph/core";
import type { PublicationDeployResult } from "../../shared/api";
import { within } from "./preview-server";
export type { PublicationDeployResult } from "../../shared/api";

export interface PublicationDeployInput {
  engineDirectory: string;
  inputDirectory: string;
  snapshotHash: string;
  engineCommit: string;
  siteUrl: string;
  signal: AbortSignal;
}

/** Matches the engine adapter's exact sorted path/raw-byte digest; excludes the private receipt. */
export function publicationSnapshotDigest(snapshot: PublicationSnapshot): string {
  const files = snapshot.manifest.files.map((file) => ({ path: file.path, sha256: file.outputHash }))
    .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return createHash("sha256").update(JSON.stringify(files)).digest("hex");
}

/** Publication pins a clean project root, not a mutable branch name or executable shell string. */
export async function readPublicationEngineCommit(engineDirectory: string): Promise<string> {
  const root = await realpath(engineDirectory);
  const git = async (...args: string[]) => (await promisify(execFile)("git", ["-C", root, ...args], {
    timeout: 15_000, maxBuffer: 1_048_576, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  })).stdout.trim();
  try {
    if (await realpath(await git("rev-parse", "--show-toplevel")) !== root) throw new Error("Select the Quartz project's Git root.");
    const commit = await git("rev-parse", "HEAD");
    if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error("The Quartz project needs a committed Git revision.");
    if (await git("status", "--porcelain", "--untracked-files=normal")) throw new Error("Commit the Quartz project's changes, then prepare the site again before publishing.");
    return commit;
  } catch (error) {
    if (error instanceof Error && !('code' in error)) throw error;
    throw new Error("Publishing requires a clean, committed Quartz Git project.");
  }
}

/** Explicit user-invoked deployment only. A prepared build never calls this adapter. */
export async function deployQuartzSite(input: PublicationDeployInput): Promise<PublicationDeployResult> {
  if (!/^[a-f0-9]{64}$/.test(input.snapshotHash) || !/^[a-f0-9]{40}$/.test(input.engineCommit)) throw new Error("Invalid prepared publication identity.");
  if (await readPublicationEngineCommit(input.engineDirectory) !== input.engineCommit) throw new Error("Quartz changed since preparation. Prepare the site again.");
  let adapter: string;
  try { adapter = await realpath(path.join(input.engineDirectory, "scripts/exograph-deploy.mjs")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { status: "setup-required", message: "This Quartz project has no publishing adapter. Configure its deployment workflow first." };
    throw error;
  }
  if (!within(await realpath(input.engineDirectory), adapter)) throw new Error("The deployment adapter must belong to the selected Quartz project.");
  const result = await new Promise<{ stdout: string; code: number | null }>((resolve, reject) => {
    if (input.signal.aborted) { reject(new Error("Publishing cancelled before deployment.")); return; }
    const child = spawn(process.execPath, [adapter, "--input", input.inputDirectory, "--snapshot-hash", input.snapshotHash,
      "--engine-commit", input.engineCommit, "--site-url", input.siteUrl], {
      cwd: input.engineDirectory, env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32",
    });
    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let failure: Error | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const kill = (signal: NodeJS.Signals) => {
      try { if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal); else child.kill(signal); }
      catch { /* The process may already have exited. */ }
    };
    const cancel = (message: string) => {
      if (failure) return;
      failure = new Error(message);
      kill("SIGTERM");
      killTimer = setTimeout(() => kill("SIGKILL"), 2_000); killTimer.unref();
    };
    const abort = () => cancel("Stopped waiting for deployment; a dispatched workflow may still finish. Check its status before publishing again.");
    const timeout = setTimeout(() => cancel("Deployment exceeded twenty minutes. A dispatched workflow may still finish; check its status before publishing again."), 1_200_000); timeout.unref();
    input.signal.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > 1_048_576) { cancel("Deployment adapter returned too much output; check the workflow before retrying."); return; }
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-16_384); });
    const cleanup = () => { clearTimeout(timeout); if (killTimer) clearTimeout(killTimer); input.signal.removeEventListener("abort", abort); };
    child.once("error", (error) => { cleanup(); reject(error); });
    child.once("close", (code) => {
      cleanup();
      if (failure) { kill("SIGKILL"); reject(failure); }
      else if (code !== 0 && code !== 2) {
        let detail = stderr.trim();
        try {
          const receipt = JSON.parse(stdout) as Record<string, unknown>;
          if (receipt?.ok === false && receipt.status === "failed" && typeof receipt.message === "string") {
            detail = receipt.message.slice(0, 16_384);
            if (typeof receipt.runId === "string" && /^\d+$/.test(receipt.runId)) detail += ` Check GitHub Actions run ${receipt.runId} before retrying.`;
          }
        } catch { /* Fall back to bounded stderr when no failure receipt exists. */ }
        reject(new Error(`Deployment failed (${code ?? "terminated"}). ${detail}`));
      }
      else resolve({ stdout, code });
    });
  });
  let receipt: unknown;
  try { receipt = JSON.parse(result.stdout); } catch { throw new Error("Deployment adapter returned no valid receipt; check the workflow before retrying."); }
  if (!receipt || typeof receipt !== "object") throw new Error("Invalid deployment receipt.");
  const value = receipt as Record<string, unknown>;
  if (result.code === 2 && value.ok === false && value.status === "setup-required" && typeof value.message === "string" && value.message.length > 0) return { status: "setup-required", message: value.message };
  if (result.code !== 0 || value.ok !== true || value.status !== "deployed" || typeof value.deploymentUrl !== "string" || typeof value.snapshotCommit !== "string" || !/^[a-f0-9]{40}$/.test(value.snapshotCommit) || value.engineCommit !== input.engineCommit || typeof value.runId !== "string" || !/^\d+$/.test(value.runId)) throw new Error("Invalid deployment success receipt; no completed publication was confirmed.");
  const url = new URL(value.deploymentUrl);
  if (url.protocol !== "https:" || url.username || url.password) throw new Error("Deployment receipt has an invalid public URL.");
  return { status: "deployed", deploymentUrl: url.toString(), snapshotCommit: value.snapshotCommit, engineCommit: input.engineCommit, runId: value.runId };
}
