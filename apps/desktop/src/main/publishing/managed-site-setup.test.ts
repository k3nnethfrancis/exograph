import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { exportPublication, normalizeWorkspaceSettings, verifyPublicationSnapshot, workspaceModelFromSettings } from "@exograph/core";
import { ManagedSiteSetup } from "./managed-site-setup";
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const run = async (file: string, args: string[], options = {}) => (await promisify(execFile)(file, args, { ...options, maxBuffer: 8_388_608 })).stdout.trim();
async function fixture() {
  const temp = await realpath(await mkdtemp(path.join(os.tmpdir(), "exo-managed-setup-"))); roots.push(temp);
  const notes = path.join(temp, "notes"), garden = path.join(notes, "garden"), theme = path.join(temp, "theme"), seed = path.join(temp, "seed"), remote = path.join(temp, "remote.git");
  await mkdir(garden, { recursive: true }); await writeFile(path.join(garden, "index.md"), "# Public\n[Private](../private.md)\n"); await writeFile(path.join(notes, "private.md"), "SECRET\n");
  const git = (dir: string, ...args: string[]) => run("git", ["-C", dir, ...args]);
  for (const directory of [theme, seed]) { await mkdir(directory); await git(directory, "init", "-b", "main"); }
  await mkdir(path.join(theme, "content")); await writeFile(path.join(theme, "content", "private.md"), "ENGINE PRIVATE");
  await writeFile(path.join(theme, "quartz.config.ts"), "// custom theme\n"); await writeFile(path.join(theme, ".gitignore"), "node_modules/\n");
  await writeFile(path.join(seed, "publishing.json"), "{}\n"); await writeFile(path.join(seed, "README.md"), "Prior website history\n"); await mkdir(path.join(seed, ".github", "workflows"), { recursive: true }); await writeFile(path.join(seed, ".github", "workflows", "old.yml"), "on: push\n");
  for (const directory of [theme, seed]) { await git(directory, "add", "."); await git(directory, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "initial"); }
  await run("git", ["clone", "--bare", seed, remote]);
  const original = await git(seed, "rev-parse", "HEAD");
  const settings = normalizeWorkspaceSettings({ workspaceRoot: temp, defaultTerminalCwd: temp, noteRoots: [notes] })!;
  const calls: string[][] = [];
  let branch = "main";
  let install = async (_directory: string) => {};
  const service = new ManagedSiteSetup({ context: () => ({ settings, model: workspaceModelFromSettings(settings) }), sitesParent: path.join(temp, "sites"),
    capture: (model, publicationDirectory, stagingParent, generatedRoutes) => exportPublication({ model, publicationDirectory, stagingParent, generatedRoutes }), verify: verifyPublicationSnapshot,
    install: (directory) => install(directory),
    run: async (file, args, options) => {
      if (file === "gh") { calls.push(args); if (args[0] === "auth") return ""; if (args[1] === "repos/author/site") return JSON.stringify({ default_branch: branch }); if (args.includes("--method")) return "{}"; return JSON.stringify({ cname: "example.com" }); }
      const rewritten = args.map(arg => arg === "https://github.com/author/site.git" ? remote : arg);
      return run(file, rewritten, options);
    },
  });
  return { temp, theme, seed, remote, notes, garden, service, settings, calls, original, git, setBranch: (value: string) => { branch = value; }, setInstall: (fn: typeof install) => { install = fn; }, input: { scope: settings, repository: "author/site", publicationDirectory: garden, themeDirectory: theme, createRepository: false } };
}
it("creates a self-contained normal descendant with only sanitized content, manual workflow, and preserved domain", async () => {
  const f = await fixture(); const result = await f.service.setup(f.input);
  expect(result.engineDirectory).toBe(path.join(f.temp, "sites", "author", "site"));
  expect(result).toMatchObject({ status: "ready", siteUrl: "https://example.com/", branch: "main" });
  expect(await f.git(result.engineDirectory, "rev-parse", "HEAD^")).toBe(f.original);
  expect(await readFile(path.join(result.engineDirectory, "garden", "index.md"), "utf8")).toContain("Private");
  expect(await f.git(result.engineDirectory, "ls-files")).not.toMatch(/content\/private|private.md/);
  expect(await readFile(path.join(result.engineDirectory, "CNAME"), "utf8")).toBe("example.com\n");
  expect(f.calls.some(args => args.includes("build_type=workflow"))).toBe(true);
  expect(f.calls.some(args => args[0] === "workflow")).toBe(false);
  expect(await readFile(path.join(f.notes, "private.md"), "utf8")).toBe("SECRET\n");
  await writeFile(path.join(result.engineDirectory, "quartz.config.ts"), "user edits");
  await expect(f.service.setup(f.input)).rejects.toThrow("local changes");
  expect(await readFile(path.join(result.engineDirectory, "quartz.config.ts"), "utf8")).toBe("user edits");
});
it("rejects a destination symlink before theme extraction or remote mutation", async () => {
  const f = await fixture(); await f.git(f.seed, "rm", "-r", ".github"); await symlink(f.notes, path.join(f.seed, ".github")); await f.git(f.seed, "add", "."); await f.git(f.seed, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "symlink"); await f.git(f.seed, "push", f.remote, "main");
  await expect(f.service.setup(f.input)).rejects.toThrow("symbolic links");
  expect(f.calls.some(args => args.includes("--method"))).toBe(false);
});
it("rejects unsupported destination branches and out-of-scope folders before writes", async () => {
  const f = await fixture(); f.setBranch("master"); await expect(f.service.setup(f.input)).rejects.toThrow("default branch");
  await expect(f.service.setup({ ...f.input, publicationDirectory: f.theme })).rejects.toThrow("authorized Note Root");
  expect(f.calls.some(args => args.includes("--method"))).toBe(false);
});
it("does not push when canonical source changes during dependency installation", async () => {
  const f = await fixture(); f.setInstall(async () => { await writeFile(path.join(f.garden, "index.md"), "changed"); });
  await expect(f.service.setup(f.input)).rejects.toThrow("source bytes changed");
  expect(await f.git(f.remote, "rev-parse", "main")).toBe(f.original);
});

it("serializes setup before any asynchronous validation", async () => {
  const f = await fixture();
  const first = f.service.setup(f.input);
  await expect(f.service.setup(f.input)).rejects.toThrow("already running");
  await first;
});
it("sets up an empty repository and can repeat setup without losing history or workflow backups", async () => {
  const f = await fixture(); await f.git(f.remote, "update-ref", "-d", "refs/heads/main");
  const first = await f.service.setup(f.input);
  const initial = await f.git(first.engineDirectory, "rev-parse", "HEAD");
  const second = await f.service.setup(f.input);
  expect(second.engineDirectory).toBe(first.engineDirectory);
  expect(await f.git(second.engineDirectory, "rev-parse", "HEAD^")).toBe(initial);
  expect(await f.git(second.engineDirectory, "rev-parse", "refs/exograph/main")).toBe(await f.git(second.engineDirectory, "rev-parse", "HEAD"));
  expect(await readFile(path.join(second.engineDirectory, ".exograph", "previous-workflows", initial, "exograph-publish.yml"), "utf8")).toContain("workflow_dispatch");
});

it("restores exact exported content after dependency lifecycle scripts touch the copied garden", async () => {
  const f = await fixture();
  f.setInstall(async directory => {
    await writeFile(path.join(directory, "garden", "index.md"), "changed by install");
    await writeFile(path.join(directory, "garden", "extra.md"), "not exported");
  });
  const result = await f.service.setup(f.input);
  expect(await readFile(path.join(result.engineDirectory, "garden", "index.md"), "utf8")).toContain("# Public");
  expect(await f.git(result.engineDirectory, "ls-files", "garden")).not.toContain("extra.md");
});

it("configures an explicitly selected custom domain and rejects unsupported path prefixes", async () => {
  const f = await fixture();
  await expect(f.service.setup({ ...f.input, siteUrl: "https://new.example/blog/" })).rejects.toThrow("root URL");
  const result = await f.service.setup({ ...f.input, siteUrl: "https://new.example/" });
  expect(await readFile(path.join(result.engineDirectory, "CNAME"), "utf8")).toBe("new.example\n");
  expect(f.calls.some(args => args.includes("cname=new.example"))).toBe(true);
});

it("keeps raw CRLF exports clean despite theme text attributes while detecting genuine garden edits", async () => {
  const f = await fixture();
  await writeFile(path.join(f.garden, "index.md"), "# Public\r\n");
  await writeFile(path.join(f.theme, ".gitattributes"), "garden/** text eol=lf\n");
  await f.git(f.theme, "add", "."); await f.git(f.theme, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "attributes");
  const result = await f.service.setup(f.input);
  expect(await f.git(result.engineDirectory, "status", "--porcelain")).toBe("");
  expect(await readFile(path.join(result.engineDirectory, "garden", "index.md"), "utf8")).toContain("\r\n");
  await writeFile(path.join(result.engineDirectory, "garden", "index.md"), "user edit");
  expect(await f.git(result.engineDirectory, "status", "--porcelain")).toContain("garden/index.md");
});

it("rejects an account-directory symlink before touching a remote repository", async () => {
  const f = await fixture();
  await mkdir(path.join(f.temp, "sites"));
  await symlink(f.notes, path.join(f.temp, "sites", "author"));
  await expect(f.service.setup(f.input)).rejects.toThrow("symbolic link");
  expect(f.calls).toHaveLength(0);
});

it("loads personal and organization accounts across pages with their creation permissions", async () => {
  const f = await fixture();
  const service = new ManagedSiteSetup({ context: () => ({ settings: f.settings, model: workspaceModelFromSettings(f.settings) }), sitesParent: path.join(f.temp, "sites"),
    capture: (model, publicationDirectory, stagingParent) => exportPublication({ model, publicationDirectory, stagingParent }), verify: verifyPublicationSnapshot,
    run: async (_file, args) => {
      if (args.includes("--include")) return "x-oauth-scopes: repo, workflow, read:org";
      if (args.includes("graphql")) {
        expect(args).toContain("--paginate"); expect(args).toContain("--slurp");
        return JSON.stringify([{ data: { viewer: { organizations: { nodes: [{ login: "team", viewerCanCreateRepositories: true }] } } } },
          { data: { viewer: { organizations: { nodes: [{ login: "restricted", viewerCanCreateRepositories: false }] } } } }]);
      }
      return "author";
    },
  });
  expect(await service.getSetupStatus()).toMatchObject({ authenticated: true, accounts: [
    { login: "author", kind: "user", canCreate: true }, { login: "team", kind: "organization", canCreate: true }, { login: "restricted", kind: "organization", canCreate: false },
  ] });
});
it("preserves an imported managed site's original vanilla revision across setup", async () => {
  const f = await fixture();
  const vanillaCommit = await f.git(f.theme, "rev-parse", "HEAD");
  await writeFile(path.join(f.theme, "exograph-site.json"), JSON.stringify({ schemaVersion: 1, vanillaCommit }));
  await f.git(f.theme, "add", "."); await f.git(f.theme, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "baseline metadata");
  const result = await f.service.setup(f.input);
  expect(JSON.parse(await readFile(path.join(result.engineDirectory, "exograph-site.json"), "utf8")).vanillaCommit).toBe(vanillaCommit);
});
