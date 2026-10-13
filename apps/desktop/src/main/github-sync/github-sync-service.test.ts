import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { GitHubSyncStatus } from "../../shared/api";
import { GitHubSyncService } from "./github-sync-service";
import { type GitSyncRepository, SyncConflict } from "./git-sync-repository";
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
const config = { enabled: true, cadence: "hourly" as const, remote: "origin", branch: "main" };
async function fixture() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "exo-sync-service-"))); dirs.push(root);
  let now = Date.parse("2026-10-13T12:00:00Z"); let currentRoot = root;
  const statuses: GitHubSyncStatus[] = [];
  const result = { repository: "owner/private", commit: "abc123", hasLocalChanges: false };
  const repository = { inspect: vi.fn(async () => ({ repository: "owner/private", url: "private" })), sync: vi.fn(async (...args: Parameters<GitSyncRepository["sync"]>) => args[3] ? args[3](async () => result) : result) };
  const barrier = vi.fn(async () => {});
  const options = { stateRoot: path.join(root, "state"), toolsRoot: root, noteRoots: () => [currentRoot], repository, withDocumentsFlushed: async <T>(operation: () => Promise<T>): Promise<T> => { await barrier(); return operation(); }, publishStatus: (status: GitHubSyncStatus) => statuses.push(status), now: () => now };
  const service = new GitHubSyncService(options);
  return { root, service, repository, barrier, statuses, options, setRoot: (value: string) => { currentRoot = value; }, advance: (ms: number) => { now += ms; } };
}
describe("GitHub sync scheduling and save authority", () => {
  it("waits for notes and annotation persistence before invoking git", async () => {
    const f = await fixture(); const order: string[] = [];
    f.barrier.mockImplementation(async () => { order.push("freeze", "save-notes", "save-annotations"); });
    f.repository.sync.mockImplementation(async (...args) => args[3]!(async () => { order.push("git"); return { repository: "owner/private", commit: "abc123", hasLocalChanges: false }; }));
    await f.service.configure({ root: f.root, config }); await f.service.syncNow({ root: f.root });
    expect(order).toEqual(["freeze", "save-notes", "save-annotations", "git"]);
  });
  it("does not touch Git when the editor reports a save conflict", async () => {
    const f = await fixture(); f.barrier.mockRejectedValue(new Error("Resolve the unsaved document conflict"));
    await f.service.configure({ root: f.root, config });
    const result = await f.service.syncNow({ root: f.root });
    expect(result.phase).toBe("error"); expect(result.message).toContain("unsaved document conflict"); expect(f.repository.sync).toHaveBeenCalledTimes(1);
  });
  it("serializes timer/manual overlaps and keeps config unchanged during a run", async () => {
    const f = await fixture(); let release!: () => void;
    f.repository.sync.mockImplementation(async () => { await new Promise<void>((resolve) => { release = resolve; }); return { repository: "owner/private", commit: "abc123", hasLocalChanges: false }; });
    await f.service.configure({ root: f.root, config });
    const run = f.service.syncNow({ root: f.root });
    await expect(f.service.syncNow({ root: f.root })).rejects.toThrow("already running");
    await f.service.tick();
    await vi.waitFor(() => expect(f.repository.sync).toHaveBeenCalledTimes(1));
    await expect(f.service.configure({ root: f.root, config: { ...config, enabled: false } })).rejects.toThrow("current sync");
    release(); await run; expect(f.service.isBusy()).toBe(false);
  });
  it("runs due work once after wake/startup and persists last success across restart", async () => {
    const f = await fixture(); await f.service.configure({ root: f.root, config });
    await f.service.tick(); expect(f.repository.sync).toHaveBeenCalledTimes(1);
    await f.service.tick(); expect(f.repository.sync).toHaveBeenCalledTimes(1);
    f.advance(3_600_001); await f.service.tick(); expect(f.repository.sync).toHaveBeenCalledTimes(2);
    const restarted = new GitHubSyncService(f.options); expect((await restarted.getStatus()).lastSuccess).toBe((await f.service.getStatus()).lastSuccess);
    await restarted.tick(); expect(f.repository.sync).toHaveBeenCalledTimes(2);
    f.advance(24 * 3_600_000); await restarted.tick(); expect(f.repository.sync).toHaveBeenCalledTimes(3);
  });
  it("manual cadence and disabled config never perform scheduled work", async () => {
    const f = await fixture(); await f.service.configure({ root: f.root, config: { ...config, cadence: "manual" } });
    await f.service.tick(); expect(f.repository.sync).not.toHaveBeenCalled();
    await f.service.syncNow({ root: f.root });
    await f.service.configure({ root: f.root, config: { ...config, enabled: false } }); f.advance(86_400_000);
    await f.service.tick(); expect(f.repository.sync).toHaveBeenCalledTimes(1); expect((await f.service.getStatus()).nextRun).toBeUndefined();
  });
  it("daily cadence is durable and failures remain visible until the next attempt", async () => {
    const f = await fixture(); await f.service.configure({ root: f.root, config: { ...config, cadence: "daily" } });
    f.repository.sync.mockRejectedValue(new Error("Offline: could not connect")); await f.service.tick();
    const failed = await f.service.getStatus(); expect(failed.phase).toBe("error"); expect(failed.lastSuccess).toBeUndefined();
    const restarted = new GitHubSyncService(f.options); expect((await restarted.getStatus()).message).toContain("Offline");
    f.advance(3_600_000); await restarted.tick(); expect(f.repository.sync).toHaveBeenCalledTimes(1);
    f.advance(86_400_000); await restarted.tick(); expect(f.repository.sync).toHaveBeenCalledTimes(2);
  });
  it("never carries root A authority or config into root B", async () => {
    const f = await fixture(); const other = await fixture(); await f.service.configure({ root: f.root, config });
    f.setRoot(other.root); await expect(f.service.syncNow({ root: f.root })).rejects.toThrow("Workspace changed");
    expect((await f.service.getStatus()).config.enabled).toBe(false); await f.service.tick(); expect(f.repository.sync).not.toHaveBeenCalled();
  });
  it.each(["sync", "configure"])("rejects an interleaved root switch before %s can borrow another root's settings", async (action) => {
    const f = await fixture(); const other = await fixture();
    let root = f.root; let switchOnRead = false;
    const service = new GitHubSyncService({ ...f.options, noteRoots: () => {
      const captured = root;
      if (switchOnRead) { switchOnRead = false; root = other.root; }
      return [captured];
    } });
    await service.configure({ root: f.root, config });
    root = other.root; await service.configure({ root: other.root, config });
    const before = await service.getStatus(); f.repository.inspect.mockClear();
    root = f.root; switchOnRead = true;
    await expect(action === "sync" ? service.syncNow({ root: f.root }) : service.configure({ root: f.root, config }))
      .rejects.toThrow("Workspace changed");
    expect(f.repository.sync).not.toHaveBeenCalled();
    expect(f.repository.inspect).not.toHaveBeenCalled();
    expect(await service.getStatus()).toEqual(before);
    expect(service.isBusy()).toBe(false);
  });
  it("rejects root changes while a destination check is pending", async () => {
    const f = await fixture(); const other = await fixture();
    f.repository.inspect.mockImplementation(async () => { f.setRoot(other.root); return { repository: "owner/private", url: "private" }; });
    await expect(f.service.configure({ root: f.root, config })).rejects.toThrow("Workspace changed"); expect(f.service.isBusy()).toBe(false);
  });
  it("returns distinct conflict status and file references", async () => {
    const f = await fixture(); await f.service.configure({ root: f.root, config });
    f.repository.sync.mockRejectedValue(new SyncConflict("Resolve merge", ["note.md"]));
    expect(await f.service.syncNow({ root: f.root })).toMatchObject({ phase: "conflict", conflicts: ["note.md"] });
  });
  it("rejects unrecognized settings without modifying prior config", async () => {
    const f = await fixture(); await f.service.configure({ root: f.root, config });
    await expect(f.service.configure({ root: f.root, config: { ...config, cadence: "seconds" as "hourly" } })).rejects.toThrow("Invalid");
    expect((await f.service.getStatus()).config).toEqual(config);
  });
});
