import { execFile } from "node:child_process";
import { lstat, open, readFile, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { GitHubSyncConfig, GitHubSyncStatus } from "../../shared/api";
import { commandEnvironment } from "../command/command-environment";
import { resolveGitHubCli } from "../publishing/github-cli";

export const SYNC_EXCLUSIONS = ["Git ignored files", ".exograph runtime state (editorial/v1 is included)", ".obsidian", ".claude/settings.local.json", ".env files, private keys and credentials", "dependency/build/cache folders"];
export function excludedSyncPath(file: string): boolean {
  const parts = file.split("/");
  const name = parts.at(-1)!;
  if (parts.includes(".exograph")) {
    const offset = parts.indexOf(".exograph");
    return parts[offset + 1] !== "editorial" || parts[offset + 2] !== "v1";
  }
  return parts.some((part) => [".obsidian", "node_modules", ".cache", ".venv", "__pycache__", ".DS_Store"].includes(part))
    || /^(\.env(?:\..*)?|credentials(?:\.json)?|id_(rsa|ed25519|ecdsa)|.*\.(?:pem|p12|pfx|key))$/i.test(name)
    || file.endsWith(".claude/settings.local.json");
}
export class SyncConflict extends Error {
  constructor(message: string, readonly files: string[] = []) { super(message); }
}

export async function runSyncCommand(file: string, args: string[], cwd: string): Promise<string> {
  try {
    const { stdout } = await promisify(execFile)(file, args, {
      cwd, env: { ...commandEnvironment(), GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never", GH_PROMPT_DISABLED: "1" },
      timeout: 120_000, maxBuffer: 16 * 1024 * 1024,
    });
    return stdout;
  } catch (error) {
    const result = error as Error & { stderr?: string; stdout?: string };
    // Command errors can contain a credential-bearing URL. Never expose it in UI.
    const detail = (result.stderr || result.stdout || result.message).replace(/https?:\/\/[^\s/@]+:[^\s/@]+@/g, "https://[redacted]@").trim();
    throw new Error(detail.slice(0, 2500));
  }
}

export function githubRepository(url: string): string {
  const match = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(url);
  if (!match) throw new Error("Choose a GitHub remote using HTTPS or SSH, without credentials in its URL.");
  return match[1]!;
}

export interface GitSyncRepositoryOptions {
  toolsRoot: string;
  /** Injected only by repository tests using local bare remotes. */
  verifyRemote?: (url: string, root: string) => Promise<string>;
}
export class GitSyncRepository {
  constructor(private readonly options: GitSyncRepositoryOptions) {}
  private credentialArgs: string[] = [];
  private git(root: string, ...args: string[]) { return runSyncCommand("git", ["-c", "core.hooksPath=/dev/null", ...this.credentialArgs, ...args], root); }
  async inspect(root: string, config: GitHubSyncConfig): Promise<{ repository: string; url: string }> {
    const canonical = await realpath(root);
    const top = (await this.git(root, "rev-parse", "--show-toplevel")).trim();
    if (await realpath(top) !== canonical) throw new Error("The Note Root must be the repository's top-level folder. Select that folder as your workspace before syncing.");
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(config.remote)) throw new Error("Enter an existing Git remote name, such as origin.");
    if (!config.branch || config.branch.startsWith("-")) throw new Error("Choose a branch to sync.");
    await this.git(root, "check-ref-format", "--branch", config.branch);
    const branch = (await this.git(root, "symbolic-ref", "--quiet", "--short", "HEAD")).trim();
    if (branch !== config.branch) throw new Error(`This workspace is on ${branch}. Choose that branch, or switch branches in Git before syncing.`);
    const urls = (await this.git(root, "remote", "get-url", "--all", config.remote)).trim().split("\n");
    const pushes = (await this.git(root, "remote", "get-url", "--push", "--all", config.remote)).trim().split("\n");
    if (urls.length !== 1 || pushes.length !== 1 || urls[0] !== pushes[0]) throw new Error("Sync requires one matching fetch and push URL for the selected remote.");
    const url = urls[0]!;
    const repository = this.options.verifyRemote ? await this.options.verifyRemote(url, root) : await this.verifyPrivate(url, root);
    return { repository, url };
  }
  private async verifyPrivate(url: string, root: string): Promise<string> {
    const repository = githubRepository(url);
    const gh = await resolveGitHubCli(this.options.toolsRoot, undefined, { download: false });
    this.credentialArgs = ["-c", "credential.helper=", "-c", `credential.helper=!'${gh.replace(/'/g, "'\"'\"'")}' auth git-credential`];
    let info: { nameWithOwner?: string; isPrivate?: boolean };
    try { info = JSON.parse(await runSyncCommand(gh, ["repo", "view", repository, "--json", "nameWithOwner,isPrivate"], root)); }
    catch { throw new Error("Could not verify this private repository. Connect GitHub in Publishing settings or run gh auth login, then retry."); }
    if (info.isPrivate !== true || info.nameWithOwner?.toLowerCase() !== repository.toLowerCase()) throw new Error("Notes sync requires a verified private GitHub repository. Public repositories cannot be used.");
    return info.nameWithOwner;
  }
  async sync(root: string, config: GitHubSyncConfig, phase: (phase: GitHubSyncStatus["phase"]) => void): Promise<string> {
    phase("checking");
    const { repository, url } = await this.inspect(root, config);
    const gitDir = (await this.git(root, "rev-parse", "--absolute-git-dir")).trim();
    const lock = path.join(gitDir, "exograph-sync.lock");
    const release = await acquireLock(lock);
    try {
      for (const marker of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply", "index.lock"]) {
        try { await lstat(path.join(gitDir, marker)); } catch { continue; }
        throw new SyncConflict("Finish the existing Git operation before syncing. Exograph has left it untouched.");
      }
      if ((await this.git(root, "diff", "--cached", "--name-only", "-z")).length) throw new SyncConflict("There are already staged changes. Commit or unstage them in Git before syncing so your staging choices are preserved.");
      await this.assertSafeTree(root, "HEAD");
      // The list is NUL-delimited and passed as literal pathspecs, never shell text.
      const paths = (await this.git(root, "ls-files", "--cached", "--others", "--exclude-standard", "-z")).split("\0").filter(Boolean).filter((file) => !excludedSyncPath(file));
      for (const file of paths) {
        try {
          const stat = await lstat(path.join(root, file));
          if (stat.isSymbolicLink() || stat.isDirectory()) throw new Error(`Sync cannot include symlinks or nested repositories: ${file}. Keep ordinary files in the Note Root.`);
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      }
      phase("saving");
      for (let index = 0; index < paths.length; index += 150) {
        await this.git(root, "--literal-pathspecs", "add", "-A", "--", ...paths.slice(index, index + 150));
      }
      if ((await this.git(root, "diff", "--cached", "--name-only", "-z")).length) {
        await this.git(root, "-c", "commit.gpgsign=false", "commit", "-m", "Sync notes from Exograph");
      }
      phase("fetching");
      // Exact URL and branch avoid remote push refspecs, extra push URLs and tag pushes.
      const exists = (await this.git(root, "ls-remote", "--heads", url, `refs/heads/${config.branch}`)).trim();
      if (exists) {
        await this.git(root, "fetch", "--no-tags", url, `refs/heads/${config.branch}`);
        const remoteHead = (await this.git(root, "rev-parse", "FETCH_HEAD")).trim();
        await this.assertSafeTree(root, remoteHead);
        const counts = (await this.git(root, "rev-list", "--left-right", "--count", `HEAD...${remoteHead}`)).trim().split(/\s+/).map(Number);
        if (counts[1]! > 0) {
          phase("merging");
          if (counts[0]! > 0) {
            try { await this.git(root, "merge-tree", "--write-tree", "HEAD", remoteHead); }
            catch (error) {
              const message = (error as Error).message;
              throw new SyncConflict("Both computers changed the same content. Your local work is committed and remote work is fetched; resolve the merge in Git, then Sync now.", [...message.matchAll(/CONFLICT.*? in (.+)/g)].map((match) => match[1]!));
            }
          }
          // Git refuses a merge that would overwrite a concurrent external edit.
          await this.git(root, "-c", "commit.gpgsign=false", "merge", "--no-edit", "--no-gpg-sign", remoteHead);
        }
      }
      phase("pushing");
      // Revalidate visibility and the exact configured destination immediately before upload.
      const finalDestination = await this.inspect(root, config);
      if (finalDestination.url !== url) throw new Error("The Git remote changed during sync. Review the remote and retry.");
      await this.git(root, "-c", "push.followTags=false", "push", "--porcelain", url, `HEAD:refs/heads/${config.branch}`);
      return repository;
    } finally { await release(); }
  }
  private async assertSafeTree(root: string, revision: string): Promise<void> {
    let tree: string;
    try { tree = await this.git(root, "ls-tree", "-r", "-z", revision); }
    catch (error) {
      if (revision === "HEAD" && !(await this.git(root, "rev-parse", "--quiet", "--verify", "HEAD").catch(() => ""))) return;
      throw error;
    }
    const entries = tree.split("\0").filter(Boolean);
    const special = entries.filter((entry) => /^(?:160000|120000) /.test(entry));
    if (special.length) throw new Error("Sync cannot include symlinks or submodules. Keep ordinary files in the Note Root.");
    const files = entries.map((entry) => entry.slice(entry.indexOf("\t") + 1));
    const excluded = files.filter(excludedSyncPath);
    if (excluded.length) throw new Error(`This repository tracks files excluded from sync: ${excluded.slice(0, 6).join(", ")}. Remove them from Git tracking while preserving local copies before enabling sync. Existing history is never rewritten.`);
  }
}

async function acquireLock(file: string): Promise<() => Promise<void>> {
  try {
    const existing = JSON.parse(await readFile(file, "utf8")) as { pid?: number };
    if (!Number.isInteger(existing.pid) || existing.pid! <= 0) throw new Error("Unknown lock owner");
    try { process.kill(existing.pid!, 0); throw new Error("Another Exograph sync is running for this repository."); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      await rm(file);
    }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const handle = await open(file, "wx", 0o600);
  await handle.writeFile(JSON.stringify({ pid: process.pid }));
  await handle.close();
  return () => rm(file, { force: true });
}
