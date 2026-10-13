import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { GitHubSyncService } from "./github-sync-service";
import { GitHubSyncSetupService } from "./github-sync-setup";
import type { SyncRepositoryProvider } from "./github-sync-provider";
import type { GitSyncRepository } from "./git-sync-repository";
import type { GitHubSyncRepositoryInfo } from "../../shared/api";
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(d => rm(d, { force: true, recursive: true }))); });
const git = (root: string, ...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
async function fixture() {
  const parent = await realpath(await mkdtemp(path.join(os.tmpdir(), "exo-sync-setup-"))); directories.push(parent);
  const root = path.join(parent, "notes"), remote = path.join(parent, "remote.git"), downloads = path.join(parent, "downloads");
  await mkdir(root); await mkdir(downloads); git(parent, "init", "--bare", "--initial-branch=main", remote);
  let roots = [root]; let exists = false; let empty = true;
  const info: GitHubSyncRepositoryInfo = { id: 123, nameWithOwner: "writer/notes", url: "https://github.com/writer/notes.git", isPrivate: true, writable: true, empty: true, defaultBranch: "main" };
  const provider: SyncRepositoryProvider = {
    account: vi.fn(async () => ({ login: "writer", id: 42, name: "Writer" })),
    list: vi.fn(async () => ({ repositories: [{ ...info, empty }] })),
    inspect: vi.fn(async () => { if (!exists) throw new Error("HTTP 404"); return { ...info, empty }; }),
    create: vi.fn(async () => { exists = true; return { ...info }; }),
    gitArgs: async () => ["-c", `url.${remote}.insteadOf=${info.url}`],
  };
  const repository = { inspect: vi.fn(async () => ({ repository: info.nameWithOwner, url: info.url })), sync: vi.fn(async (...args: Parameters<GitSyncRepository["sync"]>) => args[3]!(async () => {
    git(args[0], "add", "-A");
    if (git(args[0], "diff", "--cached", "--name-only")) git(args[0], "-c", "commit.gpgsign=false", "commit", "-m", "Sync fixture");
    git(args[0], "push", remote, "HEAD:main"); empty = false;
    return { repository: info.nameWithOwner, commit: git(args[0], "rev-parse", "HEAD"), hasLocalChanges: false };
  })) };
  const service = new GitHubSyncService({ stateRoot: path.join(parent, "state"), toolsRoot: parent, noteRoots: () => roots, withDocumentsFlushed: op => op(), publishStatus: () => {}, repository });
  const setup = new GitHubSyncSetupService({ service, stateRoot: path.join(parent, "state"), toolsRoot: parent, noteRoots: () => roots, provider, chooseParent: async () => downloads, publishProgress: () => {} });
  return { parent, root, remote, downloads, service, setup, provider, repository, info, setExists: (value: boolean) => { exists = value; }, setEmpty: (value: boolean) => { empty = value; }, setRoots: (value: string[]) => { roots = value; } };
}
describe("guided private notes setup", () => {
  it("creates and uploads ordinary notes, initializes per-repo identity, and excludes runtime files", async () => {
    const f = await fixture(); await writeFile(path.join(f.root, "note.md"), "# My writing\n"); await writeFile(path.join(f.root, ".env"), "PRIVATE=local\n");
    await mkdir(path.join(f.root, ".exograph/editorial/v1"), { recursive: true }); await writeFile(path.join(f.root, ".exograph/editorial/v1/catalog.json"), "{}\n");
    const result = await f.setup.createAndSync({ root: f.root, owner: "writer", name: "notes", cadence: "hourly" });
    expect(result.status?.phase).toBe("synced"); expect(result.status?.config.cadence).toBe("hourly");
    expect(git(f.remote, "show", "main:note.md")).toBe("# My writing");
    expect(git(f.remote, "ls-tree", "-r", "--name-only", "main")).toContain(".exograph/editorial/v1/catalog.json");
    expect(git(f.remote, "ls-tree", "-r", "--name-only", "main")).not.toContain(".env");
    expect(await readFile(path.join(f.root, ".env"), "utf8")).toContain("PRIVATE=local");
    expect(git(f.root, "config", "user.name")).toBeTruthy();
  });
  it("preserves an existing upstream rather than guessing origin/main", async () => {
    const f = await fixture(); f.setExists(true); git(f.root, "init", "-b", "writing"); git(f.root, "remote", "add", "backup", f.info.url);
    git(f.root, "config", "branch.writing.remote", "backup"); git(f.root, "config", "branch.writing.merge", "refs/heads/notes");
    const setup = await f.setup.inspectSetup(); expect(setup.candidates[0]).toMatchObject({ remote: "backup", branch: "writing", remoteBranch: "notes", preferred: true });
    await writeFile(path.join(f.root, "note.md"), "# Text\n");
    const connected = await f.setup.connectExisting({ root: f.root, repository: f.info.nameWithOwner, cadence: "daily", remote: "backup" });
    expect(connected.status?.config).toMatchObject({ remote: "backup", branch: "writing", remoteBranch: "notes", cadence: "daily" });
    expect(git(f.root, "config", "branch.writing.merge")).toBe("refs/heads/notes");
  });
  it("stops before creation when user staging or credential-bearing tracked files need attention", async () => {
    const f = await fixture(); git(f.root, "init", "-b", "main"); await writeFile(path.join(f.root, "note.md"), "text"); git(f.root, "add", "note.md");
    await expect(f.setup.createAndSync({ root: f.root, owner: "writer", name: "notes", cadence: "hourly" })).rejects.toThrow("staged");
    expect(f.provider.create).not.toHaveBeenCalled(); expect(git(f.root, "diff", "--cached", "--name-only")).toBe("note.md");
    await writeFile(path.join(f.root, ".env"), "SECRET=kept"); git(f.root, "add", ".env");
    await expect(f.setup.createAndSync({ root: f.root, owner: "writer", name: "notes", cadence: "hourly" })).rejects.toThrow("private/runtime");
  });
  it("requires separate review for populated destinations and matching remotes with unrelated histories", async () => {
    const f = await fixture(); f.setExists(true); f.setEmpty(false);
    await writeFile(path.join(f.root, "local.md"), "local");
    expect((await f.setup.connectExisting({ root: f.root, repository: f.info.nameWithOwner, cadence: "hourly" })).kind).toBe("review-required");
    expect((await f.service.getStatus()).config.enabled).toBe(false);
    git(f.root, "init", "-b", "main"); git(f.root, "config", "user.name", "Local"); git(f.root, "config", "user.email", "local@example.invalid"); git(f.root, "add", "local.md"); git(f.root, "commit", "-m", "Local history"); git(f.root, "remote", "add", "origin", f.info.url);
    const other = path.join(f.parent, "other"); git(f.parent, "clone", f.remote, other); git(other, "config", "user.name", "Other"); git(other, "config", "user.email", "other@example.invalid"); await writeFile(path.join(other, "remote.md"), "remote"); git(other, "add", "."); git(other, "commit", "-m", "Unrelated history"); git(other, "push", "origin", "main");
    const before = git(f.root, "rev-parse", "HEAD");
    const result = await f.setup.connectExisting({ root: f.root, repository: f.info.nameWithOwner, cadence: "hourly" });
    expect(result.kind).toBe("review-required"); expect(result.message).toContain("do not share an ancestor"); expect(git(f.root, "rev-parse", "HEAD")).toBe(before); expect(git(f.root, "status", "--porcelain")).toBe("");
  });
  it("downloads a clone with no active Workspace and retains it for safe later activation", async () => {
    const f = await fixture(); await writeFile(path.join(f.root, "note.md"), "portable"); await f.setup.createAndSync({ root: f.root, owner: "writer", name: "notes", cadence: "hourly" });
    f.setRoots([]); expect((await f.setup.listRepositories({})).repositories).toHaveLength(1);
    const result = await f.setup.downloadRepository({ repository: f.info.url });
    expect(result?.directory).toBe(path.join(f.downloads, "notes")); expect(await readFile(path.join(result!.directory, "note.md"), "utf8")).toBe("portable");
    await expect(f.setup.downloadRepository({ repository: f.info.url })).rejects.toThrow("already exists"); expect(await readdir(f.downloads)).toEqual(["notes"]);
  });
  it("reuses a confirmed created repository after sync failure without creating a duplicate", async () => {
    const f = await fixture(); await writeFile(path.join(f.root, "note.md"), "text");
    f.repository.sync.mockRejectedValueOnce(new Error("Offline upload"));
    const first = await f.setup.createAndSync({ root: f.root, owner: "writer", name: "notes", cadence: "hourly" }); expect(first.status?.phase).toBe("error");
    const retry = await f.setup.createAndSync({ root: f.root, owner: "writer", name: "notes", cadence: "hourly" }); expect(retry.status?.phase).toBe("synced"); expect(f.provider.create).toHaveBeenCalledTimes(1);
  });
  it("rejects a changed connected account before creating or changing notes", async () => {
    const f = await fixture(); await writeFile(path.join(f.root, "note.md"), "Original writing");
    const shown = await f.setup.inspectSetup(); expect(shown.account?.login).toBe("writer");
    vi.mocked(f.provider.account).mockResolvedValue({ login: "different-account", id: 99 });
    await expect(f.setup.createAndSync({ root: f.root, owner: shown.account!.login, name: "notes", cadence: "hourly" })).rejects.toThrow("account changed");
    expect(f.provider.create).not.toHaveBeenCalled(); expect(f.repository.sync).not.toHaveBeenCalled();
    expect(await readdir(f.root)).toEqual(["note.md"]); expect(await readFile(path.join(f.root, "note.md"), "utf8")).toBe("Original writing");
  });
  it("rejects a mismatched repository returned during creation before local setup or upload", async () => {
    const f = await fixture(); await writeFile(path.join(f.root, "note.md"), "Original writing");
    vi.mocked(f.provider.create).mockResolvedValue({ ...f.info, nameWithOwner: "different-account/notes", url: "https://github.com/different-account/notes.git" });
    await expect(f.setup.createAndSync({ root: f.root, owner: "writer", name: "notes", cadence: "hourly" })).rejects.toThrow("does not match");
    expect(f.provider.create).toHaveBeenCalledWith("writer/notes"); expect(f.repository.sync).not.toHaveBeenCalled();
    expect(await readdir(f.root)).toEqual(["note.md"]); expect(await readFile(path.join(f.root, "note.md"), "utf8")).toBe("Original writing");
  });
  it("an unconfirmed creation intent cannot adopt a later populated repository", async () => {
    const f = await fixture(); vi.mocked(f.provider.create).mockRejectedValueOnce(new Error("Offline before creation"));
    await expect(f.setup.createAndSync({ root: f.root, owner: "writer", name: "notes", cadence: "hourly" })).rejects.toThrow("Offline");
    f.setExists(true); f.setEmpty(false);
    await expect(f.setup.createAndSync({ root: f.root, owner: "writer", name: "notes", cadence: "hourly" })).rejects.toThrow("did not create");
    expect(f.repository.sync).not.toHaveBeenCalled(); expect(await readdir(f.root)).toEqual([]);
  });
});

describe("independent setup boundaries", () => {
  it("treats a child named ..drafts as inside a non-Git notes root", async () => {
    const f = await fixture(); f.setExists(true); const parent = path.join(f.root, "..drafts"); await mkdir(parent);
    const setup = new GitHubSyncSetupService({ service: f.service, stateRoot: path.join(f.parent, "state"), toolsRoot: f.parent, noteRoots: () => [f.root], provider: f.provider, chooseParent: async () => parent, publishProgress: () => {} });
    await expect(setup.downloadRepository({ repository: f.info.nameWithOwner })).rejects.toThrow("outside your existing notes");
    expect(await readdir(parent)).toEqual([]);
  });
  it("rejects a symlinked picker parent within the current Note Root", async () => {
    const f = await fixture(); f.setExists(true);
    const alias = path.join(f.parent, "notes-alias"); await symlink(f.root, alias);
    const setup = new GitHubSyncSetupService({ service: f.service, stateRoot: path.join(f.parent, "state"), toolsRoot: f.parent, noteRoots: () => [f.root], provider: f.provider, chooseParent: async () => alias, publishProgress: () => {} });
    await expect(setup.downloadRepository({repository:f.info.nameWithOwner})).rejects.toThrow("outside your existing notes");
    expect(await readdir(f.root)).toEqual([]);
  });
  it("cancels owned download staging and makes idle wait until cleanup finishes", async () => {
    const f = await fixture(); await writeFile(path.join(f.root,"note.md"),"portable"); await f.setup.createAndSync({root:f.root,owner:"writer",name:"notes",cadence:"hourly"}); f.setRoots([]);
    let entered!: () => void; const atCredentials = new Promise<void>(resolve => { entered=resolve; });
    let release!: () => void; const gate = new Promise<void>(resolve => { release=resolve; });
    const original = f.provider.gitArgs;
    f.provider.gitArgs = async () => { entered(); await gate; return original(); };
    const result = f.setup.downloadRepository({repository:f.info.nameWithOwner});
    const rejection = expect(result).rejects.toThrow("stopped");
    await atCredentials; expect(f.service.isBusy()).toBe(true);
    let idle = false; const waiting = f.service.idle().catch(()=>{}).then(()=>{idle=true;});
    f.setup.cancel(); await Promise.resolve(); expect(idle).toBe(false); release();
    await rejection; await waiting; expect(f.service.isBusy()).toBe(false); expect(await readdir(f.downloads)).toEqual([]);
  });
  it("root change after remote creation cannot initialize the old or new notes folder", async () => {
    const f = await fixture(); const other=path.join(f.parent,"other-notes"); await mkdir(other);
    vi.mocked(f.provider.create).mockImplementationOnce(async()=>{f.setRoots([other]);return f.info;});
    await expect(f.setup.createAndSync({root:f.root,owner:"writer",name:"notes",cadence:"hourly"})).rejects.toThrow("Workspace changed");
    expect(await readdir(f.root)).toEqual([]); expect(await readdir(other)).toEqual([]); expect(f.repository.sync).not.toHaveBeenCalled();
  });
  it("rejects a downloaded credential file and removes only its owned staging", async () => {
    const f = await fixture(); await writeFile(path.join(f.root,"note.md"),"portable"); await f.setup.createAndSync({root:f.root,owner:"writer",name:"notes",cadence:"hourly"});
    await writeFile(path.join(f.root,"credentials.json"),"{\"token\":\"fixture-only\"}"); git(f.root,"add","-f","credentials.json"); git(f.root,"commit","-m","Fixture excluded file"); git(f.root,"push",f.remote,"HEAD:main"); f.setRoots([]);
    await writeFile(path.join(f.downloads,"keep.txt"),"keep");
    await expect(f.setup.downloadRepository({repository:f.info.nameWithOwner})).rejects.toThrow("excluded from notes sync");
    expect(await readdir(f.downloads)).toEqual(["keep.txt"]);
  });
});
