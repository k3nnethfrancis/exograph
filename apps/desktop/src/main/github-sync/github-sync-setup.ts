import { createHash, randomUUID } from "node:crypto";
import { appendFile, lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { GitHubSyncConfig, GitHubSyncConnectionResult, GitHubSyncRepositoryInfo, GitHubSyncSetup, GitHubSyncSetupProgress } from "../../shared/api";
import { excludedSyncPath, githubRepository, runSyncCommand } from "./git-sync-repository";
import { GitHubSyncProvider, repositoryName, type SyncRepositoryProvider } from "./github-sync-provider";
import type { GitHubSyncService } from "./github-sync-service";

interface Options {
  service: GitHubSyncService;
  toolsRoot: string;
  stateRoot: string;
  noteRoots: () => string[];
  chooseParent: () => Promise<string | null>;
  publishProgress: (progress: GitHubSyncSetupProgress) => void;
  provider?: SyncRepositoryProvider;
}
const ignored = [".DS_Store", "node_modules/", ".cache/", ".venv/", "__pycache__/", ".env", ".env.*", "*.pem", "*.p12", "*.pfx", "*.key", "id_rsa", "id_ed25519", "id_ecdsa", "credentials", "credentials.json", ".claude/settings.local.json", ".obsidian/workspace*.json*", ".obsidian/plugins/*/data.json", ".obsidian/**/cache/", ".obsidian/**/caches/", ".obsidian/**/.cache/", ".exograph/*", "!.exograph/editorial/", ".exograph/editorial/*", "!.exograph/editorial/v1/"];
const inside = (parent: string, child: string) => { const relative = path.relative(parent, child); return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)); };
function requirePrivate(info: GitHubSyncRepositoryInfo) {
  if (!info.isPrivate) throw new Error("This repository is public. Choose a private repository; Exograph does not change repository visibility.");
  if (!info.writable) throw new Error("Your GitHub account cannot write to this repository. Choose one you can update.");
}
export class GitHubSyncSetupService {
  private readonly provider: SyncRepositoryProvider;
  private controller?: AbortController;
  constructor(private readonly options: Options) { this.provider = options.provider ?? new GitHubSyncProvider(options.toolsRoot); }
  private progress(phase: GitHubSyncSetupProgress["phase"], message: string, canCancel = false) { this.options.publishProgress({ phase, message, canCancel }); }
  cancel(): void { this.controller?.abort(); }
  private git(root: string, ...args: string[]) { return runSyncCommand("git", ["-c", "core.hooksPath=/dev/null", ...args], root, { signal: this.controller?.signal, timeout: args.includes("clone") || args.includes("fetch") ? 4 * 60 * 60_000 : 120_000 }); }
  async inspectRepository(input: { repository: string }) { return this.provider.inspect(repositoryName(input.repository)); }
  async listRepositories(input: { query?: string; page?: number }) {
    const page = input.page ?? 1;
    if (!Number.isInteger(page) || page < 1 || page > 1000) throw new Error("Invalid repository page.");
    return this.provider.list((input.query ?? "").slice(0, 200), page);
  }
  private async local(root: string): Promise<GitHubSyncSetup["local"]> {
    let top: string;
    try { top = (await this.git(root, "rev-parse", "--show-toplevel")).trim(); }
    catch { return { isRepository: false }; }
    if (await realpath(top) !== root) return { isRepository: true, problem: "The notes folder is inside another Git repository. Open the repository root or choose a separate folder." };
    const branch = await this.git(root, "symbolic-ref", "--quiet", "--short", "HEAD").then(v => v.trim()).catch(() => undefined);
    if (!branch) return { isRepository: true, problem: "This repository has a detached HEAD. Switch to a branch in Git before connecting sync." };
    const upstream = await this.git(root, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}").then(v => v.trim()).catch(() => undefined);
    return { isRepository: true, branch, upstream };
  }
  async inspectSetup(): Promise<GitHubSyncSetup> {
    const status = await this.options.service.getStatus();
    const root = status.root;
    const local = await this.local(root);
    const account = await this.provider.account().catch(() => undefined);
    const candidates: GitHubSyncSetup["candidates"] = [];
    if (local.isRepository && !local.problem && local.branch) {
      const preferred = await this.git(root, "config", "--get", `branch.${local.branch}.remote`).then(v => v.trim()).catch(() => "");
      const remoteBranch = await this.git(root, "config", "--get", `branch.${local.branch}.merge`).then(v => v.trim().replace(/^refs\/heads\//, "")).catch(() => local.branch);
      const remotes = (await this.git(root, "remote")).trim().split("\n").filter(Boolean);
      for (const remote of remotes) {
        try {
          const url = (await this.git(root, "remote", "get-url", remote)).trim();
          const repository = await this.provider.inspect(githubRepository(url));
          candidates.push({ remote, branch: local.branch, remoteBranch: remote === preferred ? remoteBranch : undefined, repository, preferred: remote === preferred || (status.repository === repository.nameWithOwner && status.config.remote === remote) });
        } catch { /* Non-GitHub remotes remain available under Git details. */ }
      }
    }
    return { root, status, local, account, candidates, suggestedName: path.basename(root).replace(/[^\w.-]+/g, "-").replace(/^[.-]+/, "") || "notes" };
  }
  private async ready(root: string) {
    const local = await this.local(root);
    if (local.problem) throw new Error(local.problem);
    if (local.isRepository) {
      const tracked = (await this.git(root, "ls-files", "-s", "-z")).split("\0").filter(Boolean);
      if (tracked.some(row => /^(120000|160000) /.test(row))) throw new Error("Review tracked symlinks or submodules before connecting notes sync.");
      const excluded = tracked.map(row => row.slice(row.indexOf("\t") + 1)).filter(excludedSyncPath);
      if (excluded.length) throw new Error(`Remove private/runtime files from Git tracking while preserving local copies before connecting: ${excluded.slice(0, 5).join(", ")}.`);
      const gitDir = (await this.git(root, "rev-parse", "--absolute-git-dir")).trim();
      for (const marker of ["index.lock", "MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply"]) {
        if (await lstat(path.join(gitDir, marker)).then(() => true).catch(() => false)) throw new Error("Finish the existing Git operation before connecting sync. Your repository is unchanged.");
      }
      if ((await this.git(root, "diff", "--cached", "--name-only")).trim()) throw new Error("Commit or unstage your existing staged changes before connecting sync.");
    }
    return local;
  }
  private async identity(root: string) {
    const name = await this.git(root, "config", "--get", "user.name").then(v => v.trim()).catch(() => "");
    const email = await this.git(root, "config", "--get", "user.email").then(v => v.trim()).catch(() => "");
    if (name && email) return;
    const account = await this.provider.account();
    if (!name) await this.git(root, "config", "--local", "user.name", account.name || account.login);
    if (!email) await this.git(root, "config", "--local", "user.email", `${account.id}+${account.login}@users.noreply.github.com`);
  }
  private async prepare(root: string, repository: GitHubSyncRepositoryInfo, remote?: string): Promise<Pick<GitHubSyncConfig, "remote" | "branch" | "remoteBranch">> {
    return this.options.service.prepareLocal(root, async () => {
      const local = await this.ready(root);
      if (!local.isRepository) await this.git(root, "init", "-b", repository.defaultBranch);
      const branch = local.branch ?? repository.defaultBranch;
      await this.identity(root);
      const remotes = (await this.git(root, "remote")).trim().split("\n").filter(Boolean);
      let selected = remote;
      if (selected && !remotes.includes(selected)) throw new Error("The selected Git remote is no longer present. Refresh setup.");
      if (!selected) {
        for (const candidate of remotes) {
          const url = (await this.git(root, "remote", "get-url", candidate)).trim();
          try { if (githubRepository(url).toLowerCase() === repository.nameWithOwner.toLowerCase()) { selected = candidate; break; } } catch { /* Other destination. */ }
        }
      }
      if (selected) {
        const urls = (await this.git(root, "remote", "get-url", "--all", selected)).trim().split("\n");
        const pushes = (await this.git(root, "remote", "get-url", "--push", "--all", selected)).trim().split("\n");
        if (urls.length !== 1 || pushes.length !== 1 || urls[0] !== pushes[0] || githubRepository(urls[0]!).toLowerCase() !== repository.nameWithOwner.toLowerCase()) throw new Error("This Git remote has different fetch/push destinations. Review Git details before connecting.");
      } else {
        selected = remotes.includes("origin") ? "exograph-sync" : "origin";
        if (remotes.includes(selected)) throw new Error("A different exograph-sync remote already exists. Choose the intended repository in Git details.");
        await this.git(root, "remote", "add", selected, repository.url);
      }
      const upstreamRemote = await this.git(root, "config", "--get", `branch.${branch}.remote`).then(v => v.trim()).catch(() => "");
      const upstreamBranch = await this.git(root, "config", "--get", `branch.${branch}.merge`).then(v => v.trim().replace(/^refs\/heads\//, "")).catch(() => branch);
      if (!upstreamRemote) {
        await this.git(root, "config", "--local", `branch.${branch}.remote`, selected);
        await this.git(root, "config", "--local", `branch.${branch}.merge`, `refs/heads/${branch}`);
      }
      const ignorePath = path.join(root, ".gitignore");
      const stat = await lstat(ignorePath).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; return undefined; });
      if (stat?.isSymbolicLink() || (stat && !stat.isFile())) throw new Error("The .gitignore path must be an ordinary file.");
      const existing = stat ? await readFile(ignorePath, "utf8") : "";
      if (!existing.includes("# Exograph private sync")) await appendFile(ignorePath, `${existing && !existing.endsWith("\n") ? "\n" : ""}\n# Exograph private sync\n${ignored.join("\n")}\n`);
      return { remote: selected, branch, ...(upstreamRemote === selected && upstreamBranch !== branch ? { remoteBranch: upstreamBranch } : {}) };
    });
  }
  async connectExisting(input: { root: string; repository: string; cadence: GitHubSyncConfig["cadence"]; remote?: string }): Promise<GitHubSyncConnectionResult> {
    const repository = await this.provider.inspect(repositoryName(input.repository)); requirePrivate(repository);
    const setup = await this.inspectSetup();
    if (setup.root !== input.root) throw new Error("Workspace changed. Reopen sync setup.");
    const candidate = setup.candidates.find(c => c.repository.nameWithOwner.toLowerCase() === repository.nameWithOwner.toLowerCase() && (!input.remote || c.remote === input.remote));
    // Matching names are not authority to merge unrelated content. A verified existing
    // remote is the direct path; new populated destinations get a separate download.
    if (!repository.empty && !candidate) return { kind: "review-required", repository, message: `Your notes remain in ${input.root}. ${repository.nameWithOwner} already contains a history on ${repository.defaultBranch}. Download it into a separate folder to review both sources; connecting them directly could combine unrelated notes.` };
    if (!repository.empty && candidate) {
      const related = await this.options.service.exclusiveSetup(async () => {
        if ((await this.options.service.getStatus()).root !== input.root) throw new Error("Workspace changed. Reopen sync setup.");
        await this.ready(input.root);
        const localHead = await this.git(input.root, "rev-parse", "--verify", "HEAD").then(v => v.trim()).catch(() => "");
        if (!localHead) return false;
        const args = await this.provider.gitArgs();
        const remoteBranch = candidate.remoteBranch ?? candidate.branch;
        const heads = await this.git(input.root, ...args, "ls-remote", repository.url, `refs/heads/${remoteBranch}`, `refs/heads/${repository.defaultBranch}`);
        const rows = heads.trim().split("\n").map(row => row.split(/\s+/));
        const remoteHead = (rows.find(row => row[1] === `refs/heads/${remoteBranch}`) ?? rows[0])?.[0];
        if (!remoteHead || !/^[a-f0-9]{40,64}$/.test(remoteHead)) return false;
        await this.git(input.root, ...args, "fetch", "--no-tags", "--no-write-fetch-head", repository.url, remoteHead);
        return Boolean(await this.git(input.root, "merge-base", localHead, remoteHead).catch(() => ""));
      });
      if (!related) return { kind: "review-required", repository, message: `The local history in ${input.root} and ${repository.nameWithOwner} do not share an ancestor. Download the repository into a separate folder to compare both sources. No notes, branches or sync settings were changed.` };
    }
    this.progress("preparing", "Preparing your notes for private sync…");
    const status = await this.options.service.setupAndSync(input.root, async () => {
      await this.ready(input.root);
      const fresh = await this.provider.inspect(repository.nameWithOwner); requirePrivate(fresh);
      return { enabled: true, cadence: input.cadence, ...await this.prepare(input.root, fresh, input.remote ?? candidate?.remote) };
    });
    this.progress(status.phase === "synced" ? "ready" : "error", status.message ?? "Sync is ready.");
    return { kind: "connected", repository, status };
  }
  async createAndSync(input: { root: string; owner: string; name: string; cadence: GitHubSyncConfig["cadence"] }): Promise<GitHubSyncConnectionResult> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(input.name)) throw new Error("Use a repository name with letters, numbers, dots, hyphens or underscores.");
    let repository!: GitHubSyncRepositoryInfo;
    const status = await this.options.service.setupAndSync(input.root, async () => {
      await this.ready(input.root);
      const account = await this.provider.account();
      if (typeof input.owner !== "string" || input.owner.toLowerCase() !== account.login.toLowerCase()) throw new Error("The connected GitHub account changed. Refresh setup and review the destination before creating a repository.");
      const name = `${account.login}/${input.name}`;
      await mkdir(this.options.stateRoot, { recursive: true });
      const receipt = path.join(this.options.stateRoot, `create-${createHash("sha256").update(input.root + "\0" + name.toLowerCase()).digest("hex")}.json`);
      let recorded = false; let repositoryId: number | undefined;
      try { const saved = JSON.parse(await readFile(receipt, "utf8")); recorded = saved.root === input.root && saved.repository === name; if (recorded) repositoryId = saved.repositoryId; } catch { /* New intent. */ }
      let existing: GitHubSyncRepositoryInfo | undefined;
      try { existing = await this.provider.inspect(name); } catch (error) { if (!/404|not found/i.test(String(error))) throw error; }
      if (existing && !recorded) throw new Error("That repository already exists. Choose Use existing repository to review it before connecting.");
      if (existing && !existing.empty && (repositoryId === undefined || repositoryId !== existing.id)) throw new Error("The repository now contains work that this setup did not create. Use existing repository to review it or download a separate copy; your notes are unchanged.");
      if (!recorded) await writeFile(receipt, JSON.stringify({ root: input.root, repository: name }), { flag: "wx", mode: 0o600 });
      this.progress("creating", `Creating private repository ${name}…`);
      await this.options.service.assertSetupRoot(input.root);
      repository = existing ?? await this.provider.create(name); requirePrivate(repository);
      if (repository.nameWithOwner.toLowerCase() !== name.toLowerCase()) throw new Error("The created repository does not match the destination you approved. Your notes were not uploaded. Refresh setup and review the connected account.");
      await writeFile(receipt, JSON.stringify({ root: input.root, repository: name, repositoryId: repository.id }), { mode: 0o600 });
      return { enabled: true, cadence: input.cadence, ...await this.prepare(input.root, repository) };
    });
    this.progress(status.phase === "synced" ? "ready" : "error", status.message ?? "Sync is ready.");
    return { kind: "connected", repository, status };
  }
  async downloadRepository(input: { repository: string }) {
    const repository = await this.provider.inspect(repositoryName(input.repository)); requirePrivate(repository);
    const parentChoice = await this.options.chooseParent(); if (!parentChoice) return null;
    return this.options.service.exclusiveSetup(async () => {
      this.controller = new AbortController();
      let temporary: string | undefined;
      try {
        const parent = await realpath(parentChoice);
        for (const root of this.options.noteRoots()) if (inside(await realpath(root), parent)) throw new Error("Choose a download location outside your existing notes folders.");
        if (await this.git(parent, "rev-parse", "--show-toplevel").then(() => true).catch(() => false)) throw new Error("Choose a download location outside an existing Git repository.");
        const name = repository.nameWithOwner.split("/")[1]!;
        const destination = path.join(parent, name);
        if (await lstat(destination).then(() => true).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; return false; })) throw new Error(`The folder ${name} already exists. Choose another parent folder; existing files are unchanged.`);
        temporary = path.join(parent, `.exograph-download-${randomUUID()}`);
        await mkdir(temporary);
        this.progress("downloading", `Downloading ${repository.nameWithOwner}… Keep Exograph open. Large transfers can take time.`, true);
        const fresh = await this.provider.inspect(repository.nameWithOwner); requirePrivate(fresh);
        await this.git(parent, ...await this.provider.gitArgs(), "clone", "--", fresh.url, temporary);
        await this.identity(temporary);
        this.controller.signal.throwIfAborted();
        // Inspect authored trees before opening a clone; never follow a synced link.
        const files = (await this.git(temporary, "ls-files", "-s", "-z")).split("\0").filter(Boolean);
        if (files.some(file => /^(120000|160000) /.test(file))) throw new Error("This repository contains symlinks or submodules. Review it outside Exograph before using notes sync.");
        const excluded = files.map(file => file.slice(file.indexOf("\t") + 1)).filter(excludedSyncPath);
        if (excluded.length) throw new Error(`This repository tracks files excluded from notes sync: ${excluded.slice(0, 5).join(", ")}. Review its private files before connecting.`);
        // rename does not replace a nonempty target; an empty racing directory is
        // also explicitly refused immediately before promotion.
        if (await lstat(destination).then(() => true).catch(() => false)) throw new Error("The destination folder appeared during download. Your existing folder is unchanged.");
        await rename(temporary, destination); temporary = undefined;
        this.progress("ready", "Notes downloaded. Open this folder to continue setup.");
        return { directory: destination, repository };
      } catch (error) {
        this.progress("error", this.controller?.signal.aborted ? "Download stopped. Existing notes are unchanged; try again when ready." : String(error));
        throw error;
      } finally { if (temporary) await rm(temporary, { recursive: true, force: true }); this.controller = undefined; }
    });
  }
}
