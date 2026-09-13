import { spawn } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { PublicationAction } from "../../shared/api";
import { within } from "./preview-server";

export interface QuartzBuildInput {
  engineDirectory: string;
  inputDirectory: string;
  outputDirectory: string;
  siteUrl: string;
  action: PublicationAction;
  signal: AbortSignal;
}

/** Executes the selected, trusted site adapter, without a command shell or install. */
export async function buildQuartzSite(input: QuartzBuildInput): Promise<void> {
  const adapter = await realpath(path.join(input.engineDirectory, "scripts/exograph-publish.mjs"));
  if (!within(input.engineDirectory, adapter)) throw new Error("The publishing adapter must belong to the selected Quartz project.");
  const stdout = await new Promise<string>((resolve, reject) => {
    if (input.signal.aborted) { reject(new Error("Build cancelled.")); return; }
    const child = spawn(process.execPath, [adapter, "--input", input.inputDirectory, "--output", input.outputDirectory,
      "--site-url", input.siteUrl, "--action", input.action], {
      cwd: input.engineDirectory,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    let output = "";
    let errors = "";
    let failure: Error | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const kill = (signal: NodeJS.Signals) => {
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch { /* Already exited. */ }
    };
    const cancel = (reason: string) => {
      if (failure) return;
      failure = new Error(reason);
      kill("SIGTERM");
      killTimer = setTimeout(() => kill("SIGKILL"), 2_000);
      killTimer.unref();
    };
    const abort = () => cancel("Build cancelled.");
    const timeout = setTimeout(() => cancel("Quartz build exceeded five minutes."), 300_000);
    timeout.unref();
    input.signal.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      if (failure) return;
      output += chunk.toString();
      if (output.length > 1_048_576) cancel("Quartz adapter returned too much output.");
    });
    child.stderr.on("data", (chunk: Buffer) => { errors = (errors + chunk.toString()).slice(-16_384); });
    const cleanup = () => { clearTimeout(timeout); if (killTimer) clearTimeout(killTimer); input.signal.removeEventListener("abort", abort); };
    child.once("error", (error) => { cleanup(); reject(error); });
    child.once("close", (code) => {
      cleanup();
      if (failure) { kill("SIGKILL"); reject(failure); }
      else if (code !== 0) reject(new Error(`Quartz build failed (${code ?? "terminated"}). ${errors.trim()}`));
      else resolve(output);
    });
  });
  let receipt: { ok?: unknown; outputPath?: unknown; action?: unknown };
  try { receipt = JSON.parse(stdout); } catch { throw new Error("Quartz adapter did not return a build receipt."); }
  if (receipt.ok !== true || receipt.outputPath !== input.outputDirectory || receipt.action !== input.action) {
    throw new Error("Quartz adapter returned an invalid build receipt.");
  }
  const output = await realpath(input.outputDirectory);
  if (output !== input.outputDirectory) throw new Error("Quartz output must not be a symlink.");
  const index = await realpath(path.join(output, "index.html"));
  if (!within(output, index) || !(await stat(index)).isFile()) throw new Error("Quartz build has no index.html.");
}
