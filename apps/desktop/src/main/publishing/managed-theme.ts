import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { promisify } from "node:util";
import { commandEnvironment } from "../command/command-environment";
import { isManagedPublicationSite } from "./quartz-deploy";

/** Prepare is the user's explicit save point for edits in their managed site code. */
export async function saveManagedTheme(engineDirectory: string, signal: AbortSignal): Promise<void> {
  if (!await isManagedPublicationSite(engineDirectory)) return;
  const root = await realpath(engineDirectory);
  const git = async (...args: string[]) => (await promisify(execFile)("git", ["-C", root, ...args], {
    env: commandEnvironment(), timeout: 30_000, maxBuffer: 1_048_576, signal,
  })).stdout.trim();
  if (await realpath(await git("rev-parse", "--show-toplevel")) !== root) throw new Error("The managed website must be its own Git checkout.");
  // garden is generated from the Note Root. Editing that copy must never be
  // mistaken for editing canonical notes or included in a theme save.
  if (await git("status", "--porcelain", "--", "garden")) throw new Error("The exported garden copy was edited. Keep those changes in your source notes before preparing the site.");
  if (!await git("status", "--porcelain")) return;
  await git("add", "--all", "--", ".", ":(exclude)garden");
  await git("-c", "user.name=Exo Publishing", "-c", "user.email=publishing@exograph.local", "commit", "-m", "Save website theme for publication");
}
