import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { excludedSyncPath, GitSyncRepository, githubRepository, runSyncCommand, SyncConflict } from "./git-sync-repository";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
const config = { enabled: true, cadence: "hourly" as const, remote: "origin", branch: "main" };
const git = (cwd: string, ...args: string[]) => runSyncCommand("git", args, cwd);
async function fixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "exo-sync-test-")); directories.push(dir);
  const remote = path.join(dir, "remote.git");
  const a = path.join(dir, "a"); const b = path.join(dir, "b");
  await git(dir, "init", "--bare", "--initial-branch=main", remote);
  await git(dir, "clone", remote, a);
  await git(a, "config", "user.email", "sync@example.invalid"); await git(a, "config", "user.name", "Sync test");
  await writeFile(path.join(a, "note.md"), "Initial note\n");
  await git(a, "add", "."); await git(a, "commit", "-m", "Initial"); await git(a, "push", "origin", "main");
  await git(dir, "clone", remote, b);
  await git(b, "config", "user.email", "sync@example.invalid"); await git(b, "config", "user.name", "Sync test");
  const repo = new GitSyncRepository({ toolsRoot: dir, verifyRemote: async (url) => { expect(url).toBe(remote); return "owner/private-notes"; } });
  return { dir, remote, a, b, repo, sync: (root: string) => repo.sync(root, config, () => {}) };
}
describe("GitHub notes synchronization against two real clones", () => {
  it("commits local notes and editorial sidecars, preserves history, and fast-forwards the other Mac", async () => {
    const f = await fixture();
    const initial = (await git(f.a, "rev-parse", "HEAD")).trim();
    await writeFile(path.join(f.a, "note.md"), "Saved human edit\n");
    await mkdir(path.join(f.a, ".exograph/editorial/v1"), { recursive: true });
    await writeFile(path.join(f.a, ".exograph/editorial/v1/note.json"), '{"comment":"Keep this"}');
    await f.sync(f.a); await f.sync(f.b);
    expect(await readFile(path.join(f.b, "note.md"), "utf8")).toBe("Saved human edit\n");
    expect(await readFile(path.join(f.b, ".exograph/editorial/v1/note.json"), "utf8")).toContain("Keep this");
    expect((await git(f.a, "rev-list", "HEAD")).split("\n")).toContain(initial);
    expect(await git(f.b, "status", "--porcelain")).toBe("");
  });
  it("merges independent edits on two Macs without rewriting either commit", async () => {
    const f = await fixture();
    await writeFile(path.join(f.a, "first.md"), "First Mac\n"); await f.sync(f.a);
    const first = (await git(f.a, "rev-parse", "HEAD")).trim();
    await writeFile(path.join(f.b, "second.md"), "Second Mac\n"); await f.sync(f.b);
    expect(await readFile(path.join(f.b, "first.md"), "utf8")).toBe("First Mac\n");
    expect((await git(f.b, "rev-list", "HEAD")).split("\n")).toContain(first);
    expect((await git(f.b, "rev-list", "--parents", "-n", "1", "HEAD")).trim().split(" ")).toHaveLength(3);
    await f.sync(f.a); expect(await readFile(path.join(f.a, "second.md"), "utf8")).toBe("Second Mac\n");
  });
  it("stops before a conflicting merge changes local prose; both commits remain recoverable", async () => {
    const f = await fixture();
    await writeFile(path.join(f.a, "note.md"), "Remote wording\n"); await f.sync(f.a);
    const remoteHead = (await git(f.a, "rev-parse", "HEAD")).trim();
    await writeFile(path.join(f.b, "note.md"), "Local wording\n");
    await expect(f.sync(f.b)).rejects.toBeInstanceOf(SyncConflict);
    expect(await readFile(path.join(f.b, "note.md"), "utf8")).toBe("Local wording\n");
    expect(await git(f.b, "status", "--porcelain")).toBe("");
    expect((await git(f.b, "rev-parse", "FETCH_HEAD")).trim()).toBe(remoteHead);
    expect((await git(f.remote, "rev-parse", "main")).trim()).toBe(remoteHead);
  });
  it("honors ignore rules and excludes runtime and credential files without deleting them", async () => {
    const f = await fixture();
    await mkdir(path.join(f.a, ".exograph/invocations"), { recursive: true });
    await mkdir(path.join(f.a, ".obsidian"));
    for (const file of [".env", ".obsidian/credentials.json", ".exograph/invocations/runtime.json", "ignored.md"]) await writeFile(path.join(f.a, file), "PRIVATE SENTINEL");
    await writeFile(path.join(f.a, ".gitignore"), "ignored.md\n");
    await f.sync(f.a);
    const tracked = await git(f.a, "ls-files");
    expect(tracked).not.toContain(".env"); expect(tracked).not.toContain(".obsidian"); expect(tracked).not.toContain("runtime.json"); expect(tracked).not.toContain("ignored.md");
    expect(await readFile(path.join(f.a, ".env"), "utf8")).toBe("PRIVATE SENTINEL");
  });
  it("refuses pre-staged changes without changing the index", async () => {
    const f = await fixture(); await writeFile(path.join(f.a, "note.md"), "Staged\n"); await git(f.a, "add", "note.md");
    const staged = await git(f.a, "diff", "--cached");
    await expect(f.sync(f.a)).rejects.toThrow("already staged"); expect(await git(f.a, "diff", "--cached")).toBe(staged);
  });
  it("refuses tracked credentials before any upload", async () => {
    const f = await fixture(); await writeFile(path.join(f.a, ".env"), "SECRET"); await git(f.a, "add", ".env"); await git(f.a, "commit", "-m", "Local secret");
    const before = await git(f.remote, "rev-parse", "main");
    await expect(f.sync(f.a)).rejects.toThrow("tracks files excluded"); expect(await git(f.remote, "rev-parse", "main")).toBe(before);
  });
  it("rejects incoming excluded files before altering the Note Root", async () => {
    const f = await fixture(); await writeFile(path.join(f.a, ".env"), "REMOTE SECRET"); await git(f.a, "add", ".env"); await git(f.a, "commit", "-m", "Remote secret"); await git(f.a, "push");
    await expect(f.sync(f.b)).rejects.toThrow("tracks files excluded");
    await expect(readFile(path.join(f.b, ".env"))).rejects.toThrow();
  });
  it("rejects nested roots, detached HEAD, escaping symlinks and nested repositories", async () => {
    const f = await fixture(); const sub = path.join(f.a, "sub"); await mkdir(sub);
    await expect(f.sync(sub)).rejects.toThrow("top-level");
    await symlink("/tmp", path.join(f.a, "outside")); await expect(f.sync(f.a)).rejects.toThrow("symlinks"); await rm(path.join(f.a, "outside"));
    await git(sub, "init"); await writeFile(path.join(sub, "nested.md"), "Nested"); await git(sub, "add", "."); await git(sub, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "Nested");
    await expect(f.sync(f.a)).rejects.toThrow("nested repositories"); await rm(sub, { recursive: true });
    await git(f.a, "checkout", "--detach"); await expect(f.sync(f.a)).rejects.toThrow();
  });
  it("rechecks remote privacy immediately before push", async () => {
    const f = await fixture(); let checks = 0;
    const repo = new GitSyncRepository({ toolsRoot: f.dir, verifyRemote: async () => { if (++checks > 1) throw new Error("Repository became public"); return "owner/private"; } });
    const before = await git(f.remote, "rev-parse", "main"); await writeFile(path.join(f.a, "note.md"), "Saved\n");
    await expect(repo.sync(f.a, config, () => {})).rejects.toThrow("became public"); expect(await git(f.remote, "rev-parse", "main")).toBe(before);
    expect(await readFile(path.join(f.a, "note.md"), "utf8")).toBe("Saved\n");
  });
  it("refuses a different push destination", async () => {
    const f = await fixture(); await git(f.a, "remote", "set-url", "--push", "origin", "https://github.com/other/public.git");
    await expect(f.sync(f.a)).rejects.toThrow("matching fetch and push");
  });
  it("preserves an in-progress Git operation", async () => {
    const f = await fixture(); await writeFile(path.join(f.a, ".git/CHERRY_PICK_HEAD"), "existing");
    await expect(f.sync(f.a)).rejects.toThrow("existing Git operation"); expect(await readFile(path.join(f.a, ".git/CHERRY_PICK_HEAD"), "utf8")).toBe("existing");
  });
  it("rejects credential-bearing URLs and public host lookalikes", () => {
    expect(githubRepository("git@github.com:owner/private.git")).toBe("owner/private");
    expect(githubRepository("https://github.com/owner/private.git")).toBe("owner/private");
    expect(() => githubRepository("https://token@github.com/owner/repo")).toThrow();
    expect(() => githubRepository("https://github.com.example.org/owner/repo")).toThrow();
    expect(excludedSyncPath(".exograph/editorial/v1/note.json")).toBe(false);
    expect(excludedSyncPath("nested/.exograph/invocations/data.json")).toBe(true);
  });
});
