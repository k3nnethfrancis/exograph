import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, realpath, rename, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { commandEnvironment } from "../command/command-environment";
import { saveManagedTheme } from "./managed-theme";
import { installSiteDependencies } from "./site-dependencies";
import { STOCK_COMMIT, STOCK_REPOSITORY } from "./quartz-baseline";

const recoveryRef = "refs/exograph/design-recovery";
// Site identity, publication automation, and exported notes are not a design.
const preserved = ["garden", ".github", ".exograph", "exograph-site.json", "publishing.json", "CNAME", "README.md", "PUBLISHING.md"];
const generated = ["content", "node_modules", "public", "dist", "release", ".quartz-cache"];
const designPath = (file: string) => ![...preserved, ...generated].some(prefix => file === prefix || file.startsWith(`${prefix}/`));
const exec = promisify(execFile);
const git = async (root: string, ...args: string[]) => (await exec("git", ["-C", root, ...args], {
  env: { ...commandEnvironment(), GIT_TERMINAL_PROMPT: "0" }, timeout: 120_000, maxBuffer: 16_777_216,
})).stdout.trim();
const files = async (root: string, ref: string) => (await git(root, "ls-tree", "-r", "-z", ref)).split("\0").filter(Boolean).map(entry => {
  const file = entry.slice(entry.indexOf("\t") + 1);
  if (designPath(file) && !/^(100644|100755) blob /.test(entry)) throw new Error("Designs must contain regular files, not symbolic links or submodules.");
  return file;
}).filter(designPath);

async function assertSite(root: string): Promise<{ vanillaCommit?: string }> {
  if (await realpath(await git(root, "rev-parse", "--show-toplevel")) !== await realpath(root)) throw new Error("Choose a dedicated website checkout.");
  const marker = JSON.parse(await readFile(path.join(root, "exograph-site.json"), "utf8"));
  if (marker.schemaVersion !== 1 || marker.contentDirectory !== "garden") throw new Error("Set up managed publishing before changing the design.");
  return marker;
}

/** Fetch the site's exact original stock version; restoring never upgrades Quartz. */
async function baseline(root: string, signal: AbortSignal): Promise<string> {
  const marker = await assertSite(root);
  // Sites created before baseline metadata used this same pinned Quartz version.
  const commit = marker.vanillaCommit ?? STOCK_COMMIT;
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error("The site's vanilla Quartz revision is invalid.");
  try { await git(root, "cat-file", "-e", `${commit}^{commit}`); }
  catch {
    await exec("git", ["-C", root, "fetch", "--depth=1", STOCK_REPOSITORY, commit], {
      signal, timeout: 120_000, env: { ...commandEnvironment(), GIT_TERMINAL_PROMPT: "0" },
    });
  }
  return commit;
}

async function replaceDesign(root: string, source: string, target: string, checkCollisions = true): Promise<void> {
  const old = await files(root, source), next = await files(root, target);
  const oldSet = new Set(old);
  for (const file of next) {
    if (!checkCollisions || oldSet.has(file)) continue;
    try { await lstat(path.join(root, file)); throw new Error(`An untracked file would be replaced: ${file}. Preserve it before restoring.`); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  // Remove only tracked design files, never ignored local files or publication state.
  if (old.length) await git(root, "rm", "-r", ...(checkCollisions ? [] : ["-f"]), "--ignore-unmatch", "--", ...old);
  if (next.length) await git(root, "restore", `--source=${target}`, "--staged", "--worktree", "--", ...next);
}

export async function vanillaPreview(root: string, parent: string, signal: AbortSignal,
  install = installSiteDependencies): Promise<{ directory: string; dispose: () => Promise<void> }> {
  const commit = await baseline(root, signal);
  await mkdir(parent, { recursive: true });
  const temporary = await mkdtemp(path.join(parent, "vanilla-"));
  const directory = path.join(temporary, "site");
  try {
    await git(root, "clone", "--shared", "--no-hardlinks", root, directory);
    await git(directory, "fetch", "--depth=1", root, commit);
    await replaceDesign(directory, "HEAD", commit);
    signal.throwIfAborted();
    await install(directory, signal);
    return { directory, dispose: () => rm(temporary, { recursive: true, force: true }) };
  } catch (error) { await rm(temporary, { recursive: true, force: true }); throw error; }
}

/** Save edits and a recovery ref before applying a locally reviewed design. No push. */
export async function changeManagedDesign(root: string, action: "restore" | "undo", signal: AbortSignal,
  install = installSiteDependencies): Promise<void> {
  await assertSite(root);
  let target: string;
  if (action === "restore") target = await baseline(root, signal);
  else {
    try { target = await git(root, "rev-parse", "--verify", recoveryRef); }
    catch { throw new Error("There is no saved design to restore yet."); }
  }
  await saveManagedTheme(root, signal);
  const before = await git(root, "rev-parse", "HEAD");
  if (!(await git(root, "diff", "--name-only", "-z", before, target)).split("\0").filter(Boolean).some(designPath)) {
    if (action === "undo") await git(root, "update-ref", "-d", recoveryRef);
    else {
      try { await git(root, "rev-parse", "--verify", recoveryRef); }
      catch { await git(root, "update-ref", recoveryRef, before); }
    }
    return;
  }
  const temporary = await mkdtemp(path.join(path.dirname(root), ".design-"));
  const candidate = path.join(temporary, "site");
  let replacing = false, movedDependencies = false, installedDependencies = false, cleanup = true;
  try {
    await git(root, "clone", "--shared", "--no-hardlinks", root, candidate);
    await git(candidate, "fetch", "--depth=1", root, target);
    await replaceDesign(candidate, "HEAD", target);
    await install(candidate, signal);
    signal.throwIfAborted();
    if (await git(root, "rev-parse", "HEAD") !== before || await git(root, "status", "--porcelain")) throw new Error("The site changed during design preparation. Retry after saving your edits.");
    // Keep recovery available even if the process is interrupted during replacement.
    if (action === "restore") await git(root, "update-ref", recoveryRef, before);
    replacing = true;
    await replaceDesign(root, before, target);
    try {
      const info = await lstat(path.join(root, "node_modules"));
      if (info.isSymbolicLink()) throw new Error("Website dependencies must not be a symbolic link.");
      await rename(path.join(root, "node_modules"), path.join(temporary, "previous-dependencies"));
      movedDependencies = true;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    try {
      await rename(path.join(candidate, "node_modules"), path.join(root, "node_modules"));
      installedDependencies = true;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    // Changes already staged by replaceDesign; ignore dependency lifecycle mutations.
    await git(root, "-c", "user.name=Exo Publishing", "-c", "user.email=publishing@exograph.local", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "commit", "--allow-empty", "-m", action === "restore" ? "Restore vanilla Quartz design" : "Restore saved website customization");
    replacing = false;
    if (action === "undo") await git(root, "update-ref", "-d", recoveryRef);
  } catch (error) {
    if (replacing) {
      try {
        await replaceDesign(root, target, before, false);
        if (installedDependencies) await rm(path.join(root, "node_modules"), { recursive: true, force: true });
        if (movedDependencies) await rename(path.join(temporary, "previous-dependencies"), path.join(root, "node_modules"));
      } catch (recoveryError) {
        cleanup = false;
        throw new Error(`Design recovery needs attention. The saved commit is ${before}; dependency backups remain at ${temporary}.`, { cause: recoveryError });
      }
    }
    throw error;
  } finally { if (cleanup) await rm(temporary, { recursive: true, force: true }); }
}
