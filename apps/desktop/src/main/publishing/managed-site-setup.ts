import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile, readdir, appendFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { promisify } from "node:util";
import type { PublicationSnapshot, WorkspaceModel, WorkspaceSettings } from "@exograph/core";
import { publicationScope, type PublishingAuthStatus, type PublishingSetupRequest, type PublishingSetupResult } from "../../shared/api";
import { commandEnvironment } from "../command/command-environment";
import { findGitHubCli, resolveGitHubCli } from "./github-cli";
import { readGeneratedRoutes } from "./publishing-service";
import { publishingResource } from "./publishing-resources";
import { within } from "./preview-server";

const STOCK_REPOSITORY = "https://github.com/jackyzha0/quartz.git";
const STOCK_COMMIT = "f1fba3fc55cbf60a60a5d09c95a49c042cdab63a";
const excluded = ["content", "garden", "node_modules", "public", "dist", "release", ".quartz-cache", ".github/workflows"];
type Run = (file: string, args: string[], options?: { cwd?: string; signal?: AbortSignal; env?: NodeJS.ProcessEnv }) => Promise<string>;
interface Options {
  context: () => { settings: WorkspaceSettings; model: WorkspaceModel };
  sitesParent: string;
  capture: (model: WorkspaceModel, publicationDirectory: string, stagingParent: string, generatedRoutes: readonly string[], assertCurrent: () => void) => Promise<PublicationSnapshot>;
  verify: (snapshot: PublicationSnapshot) => Promise<void>;
  run?: Run;
  install?: (directory: string, signal: AbortSignal) => Promise<void>;
}
const defaultRun: Run = async (file, args, options = {}) => (await promisify(execFile)(file, args, {
  ...options, env: { ...commandEnvironment(), ELECTRON_RUN_AS_NODE: "1", GIT_TERMINAL_PROMPT: "0", ...options.env }, timeout: 600_000, maxBuffer: 8_388_608,
})).stdout.trim();

/** Owns setup transactions; never writes Workspace Settings or publishes a workflow. */
export class ManagedSiteSetup {
  private controller?: AbortController;
  private setupKey?: string;
  private auth?: ChildProcess;
  private authMessage?: string;
  private deviceCode?: string;
  private readonly run: Run;
  private gh = "gh";
  constructor(private readonly options: Options) { this.run = options.run ?? defaultRun; }

  async getSetupStatus(): Promise<PublishingAuthStatus> {
    if (!this.options.run) this.gh = await findGitHubCli(path.join(this.options.sitesParent, ".tools")) ?? "gh";
    const engineDirectory = this.options.context().settings.publishing?.engineDirectory;
    let managed = false;
    if (engineDirectory) {
      try {
        const marker = JSON.parse(await readFile(path.join(engineDirectory, "exograph-site.json"), "utf8"));
        managed = marker.schemaVersion === 1 && marker.contentDirectory === "garden";
      } catch { /* Legacy engine or not configured. */ }
    }
    try {
      const login = await this.run(this.gh, ["api", "user", "--jq", ".login"]);
      const headers = await this.run(this.gh, ["api", "--include", "user"]);
      const scopes = headers.match(/^x-oauth-scopes:\s*(.*)$/im)?.[1];
      if (scopes !== undefined && !scopes.split(",").map(value => value.trim()).includes("workflow")) {
        return { authenticated: false, login, managed, engineDirectory, message: "Reconnect GitHub to allow Exo to install the website publishing workflow." };
      }
      return { authenticated: true, login, managed, engineDirectory };
    } catch {
      return { authenticated: false, managed, engineDirectory, pending: Boolean(this.auth), deviceCode: this.deviceCode,
        verificationUrl: this.deviceCode ? "https://github.com/login/device" : undefined,
        message: this.authMessage ?? "Connect GitHub to set up your website." };
    }
  }

  async startAuth(): Promise<PublishingAuthStatus> {
    this.gh = await resolveGitHubCli(path.join(this.options.sitesParent, ".tools"));
    if (this.auth || (await this.getSetupStatus()).authenticated) return this.getSetupStatus();
    this.authMessage = undefined;
    this.deviceCode = undefined;
    const child = spawn(this.gh, ["auth", "login", "--hostname", "github.com", "--git-protocol", "https", "--web", "--scopes", "workflow"], {
      env: { ...commandEnvironment(), GH_BROWSER: "true", BROWSER: "true" }, stdio: ["ignore", "pipe", "pipe"],
    });
    this.auth = child;
    const receive = (data: Buffer) => {
      const text = data.toString();
      const code = text.match(/\b[A-Z0-9]{4}-[A-Z0-9]{4}\b/);
      if (code) this.deviceCode = code[0];
    };
    child.stdout?.on("data", receive);
    child.stderr?.on("data", receive);
    child.once("error", () => { this.authMessage = "GitHub sign-in could not start. Connect again to retry."; if (this.auth === child) this.auth = undefined; });
    child.once("exit", (code) => { if (code) this.authMessage = "GitHub sign-in did not complete. Connect again to retry."; if (this.auth === child) this.auth = undefined; });
    return this.getSetupStatus();
  }

  updateContext(): void {
    if (this.controller && this.setupKey !== JSON.stringify(publicationScope(this.options.context().settings))) this.controller.abort();
  }

  async cancelSetup(): Promise<void> { this.controller?.abort(); this.auth?.kill(); this.auth = undefined; }

  async themePath(): Promise<string> {
    const current = this.options.context().settings;
    const directory = current.publishing?.engineDirectory;
    if (!directory) throw new Error("Set up a website first.");
    const canonical = await realpath(directory);
    for (const root of current.noteRoots) if (within(await realpath(root), canonical)) throw new Error("The website checkout must be outside Note Roots.");
    return canonical;
  }

  async setup(input: PublishingSetupRequest): Promise<PublishingSetupResult> {
    if (this.controller) throw new Error("Website setup is already running.");
    const controller = new AbortController();
    this.controller = controller;
    this.setupKey = JSON.stringify(publicationScope(this.options.context().settings));
    try { return await this.setupTransaction(input, controller); }
    finally { if (this.controller === controller) this.controller = undefined; }
  }

  private async setupTransaction(input: PublishingSetupRequest, controller: AbortController): Promise<PublishingSetupResult> {
    const context = this.options.context();
    const key = JSON.stringify(publicationScope(context.settings));
    const assertCurrent = () => {
      if (controller.signal.aborted || key !== JSON.stringify(publicationScope(this.options.context().settings))) throw new Error("Website setup was cancelled or the Workspace changed. Retry from current Settings.");
    };
    if (!input || JSON.stringify(publicationScope(input.scope)) !== key) throw new Error("Workspace settings changed. Reopen Publishing and retry.");
    if (typeof input.repository !== "string" || !/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+$/.test(input.repository) || input.repository.endsWith("/." ) || input.repository.endsWith("/..")) throw new Error("Enter a GitHub repository as owner/name.");
    const publicationDirectory = await realpath(input.publicationDirectory);
    const roots = await Promise.all(context.settings.noteRoots.map((root) => realpath(root)));
    if (!roots.some((root) => within(root, publicationDirectory))) throw new Error("The publishing folder must be inside an authorized Note Root.");
    await mkdir(this.options.sitesParent, { recursive: true });
    const parent = await realpath(this.options.sitesParent);
    if (roots.some((root) => within(root, parent))) throw new Error("Managed websites must be stored outside Note Roots.");
    const repository = input.repository;
    const destination = path.join(parent, createHash("sha256").update(repository.toLowerCase()).digest("hex").slice(0, 24));
    const command: Run = (file, args, options) => {
      assertCurrent();
      const quote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
      const credentialArgs = file === "git" ? ["-c", "credential.helper=", "-c", `credential.helper=!${quote(this.gh)} auth git-credential`] : [];
      return this.run(file, [...credentialArgs, ...args], { ...options, signal: controller.signal });
    };
    const git = (cwd: string, ...args: string[]) => command("git", ["-C", cwd, ...args]);
    try {
      const existing = await lstat(destination);
      if (existing.isSymbolicLink()) throw new Error("The managed website path is a symbolic link.");
      if (await git(destination, "status", "--porcelain")) throw new Error("The managed website has local changes. Commit or preserve them before running setup again.");
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const temporary = await mkdtemp(path.join(parent, ".setup-"));
    let snapshot: PublicationSnapshot | undefined;

    try {
      if (!this.options.run) this.gh = await resolveGitHubCli(path.join(parent, ".tools"), controller.signal);
      await command(this.gh, ["auth", "status", "--hostname", "github.com"]);
      let info: { default_branch: string };
      try { info = JSON.parse(await command(this.gh, ["api", `repos/${repository}`])); }
      catch (error) {
        if (!input.createRepository) throw error;
        await command(this.gh, ["repo", "create", repository, input.visibility === "private" ? "--private" : "--public"]);
        info = JSON.parse(await command(this.gh, ["api", `repos/${repository}`]));
      }
      const branch = info.default_branch || "main";
      if (branch !== "main") throw new Error("This website uses a default branch other than main. Choose a repository with main as its default branch.");
      let pages: { cname?: string } | undefined;
      try { pages = JSON.parse(await command(this.gh, ["api", `repos/${repository}/pages`])); } catch { /* Pages may not yet exist. */ }
      const defaultUrl = repository.split("/")[1].toLowerCase() === `${repository.split("/")[0].toLowerCase()}.github.io`
        ? `https://${repository.split("/")[0]}.github.io/` : `https://${repository.split("/")[0]}.github.io/${repository.split("/")[1]}/`;
      const siteUrl = input.siteUrl?.trim() || (pages?.cname ? `https://${pages.cname}/` : defaultUrl);
      const url = new URL(siteUrl);
      if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error("Use an HTTPS website URL without credentials, query, or fragment.");
      const customDomain = url.hostname !== new URL(defaultUrl).hostname;
      if (customDomain && url.pathname !== "/") throw new Error("A custom domain must use its root URL, such as https://example.com/.");
      if (!customDomain && pages?.cname) throw new Error("This website already uses a custom domain. Keep that domain here or remove it in GitHub Pages before setup.");
      const checkout = path.join(temporary, "site");
      await command("git", ["clone", "--depth=1", `https://github.com/${repository}.git`, checkout]);
      const remotePublication = await git(checkout, "ls-remote", "origin", "refs/heads/publication");
      if (remotePublication) await git(checkout, "fetch", "--depth=1", "origin", "refs/heads/publication:refs/exograph/publication");
      await assertRegularTree(checkout);
      const tracked = (await git(checkout, "ls-files")).split("\n").filter(Boolean);
      if (tracked.length && !tracked.some(file => ["quartz.config.ts", "quartz.config.json", "quartz.config.yaml", "quartz.config.default.yaml", "quartz.plugins.json", "quartz.plugins.default.json", "exograph-site.json", "publishing.json"].includes(file))) throw new Error("This repository is not a recognized Quartz or Exo website. Choose an empty repository or an existing website.");
      // Empty repositories have no initial branch; use the destination's default.
      await git(checkout, "symbolic-ref", "HEAD", `refs/heads/${branch}`);
      let theme = input.themeDirectory ? await realpath(input.themeDirectory) : "";
      if (!theme) {
        theme = path.join(temporary, "quartz");
        await command("git", ["init", theme]);
        await git(theme, "remote", "add", "origin", STOCK_REPOSITORY);
        await git(theme, "fetch", "--depth=1", "origin", STOCK_COMMIT);
        await git(theme, "checkout", "--detach", "FETCH_HEAD");
      }
      if (roots.some((root) => within(root, theme))) throw new Error("Import a theme checkout outside your Note Roots.");
      if (await realpath(await git(theme, "rev-parse", "--show-toplevel")) !== theme) throw new Error("Choose the root of a dedicated Quartz theme checkout.");
      if (await git(theme, "status", "--porcelain")) throw new Error("The imported theme has uncommitted changes. Commit them before setup.");
      const commit = await git(theme, "rev-parse", "HEAD");
      const paths = [".", ...excluded.map((entry) => `:(exclude)${entry}`)];
      const entries = (await git(theme, "ls-tree", "-r", "-z", commit)).split("\0").filter(entry => {
        const filename = entry.slice(entry.indexOf("\t") + 1);
        return !excluded.some(prefix => filename === prefix || filename.startsWith(`${prefix}/`));
      });
      if (entries.some((entry) => entry && !/^(100644|100755) blob /.test(entry))) throw new Error("Theme imports cannot contain symbolic links or submodules.");
      const archive = path.join(temporary, "theme.tar");
      await git(theme, "archive", "--format=tar", `--output=${archive}`, commit, "--", ...paths);
      await command("tar", ["-xf", archive, "-C", checkout]);
      const workflows = path.join(checkout, ".github", "workflows");
      try {
        await lstat(workflows);
        const previousHead = await git(checkout, "rev-parse", "HEAD");
        await cp(workflows, path.join(checkout, ".exograph", "previous-workflows", previousHead), { recursive: true });
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      await rm(workflows, { recursive: true, force: true });
      await mkdir(path.join(checkout, ".github", "workflows"), { recursive: true });
      await mkdir(path.join(checkout, ".github", "scripts"), { recursive: true });
      await cp(await publishingResource("managed-github-pages.yml"), path.join(checkout, ".github", "workflows", "exograph-publish.yml"));
      await cp(await publishingResource("quartz-build.mjs"), path.join(checkout, ".github", "scripts", "exograph-quartz-build.mjs"));
      await writeFile(path.join(checkout, "exograph-site.json"), JSON.stringify({ schemaVersion: 1, repository, contentDirectory: "garden", sourceEngine: { commit } }, null, 2) + "\n");
      snapshot = await this.options.capture(context.model, publicationDirectory, temporary, await readGeneratedRoutes(theme), assertCurrent);
      await this.options.verify(snapshot);
      await rm(path.join(checkout, "garden"), { recursive: true, force: true });
      await cp(snapshot.directory, path.join(checkout, "garden"), { recursive: true });
      if (customDomain) await writeFile(path.join(checkout, "CNAME"), `${url.hostname}\n`);
      if (this.options.install) await this.options.install(checkout, controller.signal);
      else {
        const npmPackage = createRequire(import.meta.url).resolve("npm/package.json");
        const npmCli = path.join(path.dirname(npmPackage), "bin", "npm-cli.js").replace("app.asar/", "app.asar.unpacked/");
        const bin = path.join(temporary, "bin");
        await mkdir(bin);
        const quote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
        await writeFile(path.join(bin, "node"), `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec ${quote(process.execPath)} "$@"\n`, { mode: 0o700 });
        await command(process.execPath, [npmCli, "ci", "--no-audit", "--no-fund"], { cwd: checkout,
          env: { PATH: `${bin}${path.delimiter}${commandEnvironment().PATH}` } });
      }
      await this.options.verify(snapshot);
      await rm(path.join(checkout, "garden"), { recursive: true, force: true });
      await cp(snapshot.directory, path.join(checkout, "garden"), { recursive: true });
      assertCurrent();
      await mkdir(path.join(checkout, ".git", "info"), { recursive: true });
      await appendFile(path.join(checkout, ".git", "info", "attributes"), "\ngarden/** -text -filter -working-tree-encoding -ident\n");
      await git(checkout, "add", "--all");
      // Stage exported bytes without inherited clean filters or line conversion.
      for (const file of await regularFiles(path.join(checkout, "garden"))) {
        const relative = path.relative(checkout, file).split(path.sep).join("/");
        const hash = await git(checkout, "hash-object", "-w", "--no-filters", file);
        await git(checkout, "update-index", "--add", "--cacheinfo", `100644,${hash},${relative}`);
      }
      if (await git(checkout, "status", "--porcelain")) await git(checkout, "-c", "user.name=Exo Publishing", "-c", "user.email=publishing@exograph.local", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "commit", "-m", "Set up self-contained Exo website");
      // Switch existing Pages away from branch builds before writing content.
      await command(this.gh, ["api", `repos/${repository}/pages`, "--method", pages ? "PUT" : "POST", "-f", "build_type=workflow", ...(customDomain ? ["-f", `cname=${url.hostname}`] : [])]);
      await git(checkout, "push", "origin", `HEAD:refs/heads/${branch}`);
      await git(checkout, "update-ref", "refs/exograph/main", await git(checkout, "rev-parse", "HEAD"));
      assertCurrent();
      try { await rename(destination, `${destination}.backup-${Date.now()}`); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      await rename(checkout, destination);

      return { status: "ready", repository, engineDirectory: destination, siteUrl: url.href, branch, message: "Website ready. Previous workflows are preserved in .exograph/previous-workflows; only the manual Exo publishing workflow is active. Custom domains require their DNS records to point to GitHub Pages." };
    } finally {
      if (snapshot) await rm(snapshot.stagingRoot, { recursive: true, force: true });
      await rm(temporary, { recursive: true, force: true });
      if (this.controller === controller) this.controller = undefined;

    }
  }
}

async function assertRegularTree(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === ".git") continue;
    if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) throw new Error("The destination website contains symbolic links or special files. Resolve them before setup.");
    if (entry.isDirectory()) await assertRegularTree(path.join(directory, entry.name));
  }
}

async function regularFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await regularFiles(target));
    else if (entry.isFile()) files.push(target);
    else throw new Error("Publication output must contain regular files only.");
  }
  return files;
}
