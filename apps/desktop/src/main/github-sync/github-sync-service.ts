import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { GitHubSyncConfig, GitHubSyncStatus } from "../../shared/api";
import { GitSyncRepository, runSyncCommand, SYNC_EXCLUSIONS, SyncConflict } from "./git-sync-repository";

const interval = (cadence: GitHubSyncConfig["cadence"]) => cadence === "hourly" ? 3_600_000 : cadence === "daily" ? 86_400_000 : 0;
const active = new Set<GitHubSyncStatus["phase"]>(["checking", "saving", "fetching", "merging", "pushing"]);
interface SavedState { version: 1; config: GitHubSyncConfig; lastAttempt?: string; lastSuccess?: string; lastSyncedCommit?: string; hasLocalChanges?: boolean; message?: string; phase?: GitHubSyncStatus["phase"]; repository?: string; conflicts?: string[] }
export interface GitHubSyncServiceOptions {
  stateRoot: string;
  toolsRoot: string;
  noteRoots: () => string[];
  withDocumentsFlushed: <T>(operation: () => Promise<T>) => Promise<T>;
  publishStatus: (status: GitHubSyncStatus) => void;
  repository?: Pick<GitSyncRepository, "inspect" | "sync"> & Partial<Pick<GitSyncRepository, "cancel">>;
  now?: () => number;
  canSchedule?: () => boolean;
}
export class GitHubSyncService {
  private readonly repository: Pick<GitSyncRepository, "inspect" | "sync"> & Partial<Pick<GitSyncRepository, "cancel">>;
  private readonly now: () => number;
  private states = new Map<string, GitHubSyncStatus>();
  private pending: Promise<GitHubSyncStatus> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private disposed = false;
  private busy = false;
  constructor(private readonly options: GitHubSyncServiceOptions) {
    this.repository = options.repository ?? new GitSyncRepository({ toolsRoot: options.toolsRoot });
    this.now = options.now ?? Date.now;
  }
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), 60_000);
    this.timer.unref();
    void this.tick();
  }
  dispose(): void { this.disposed = true; if (this.timer) clearInterval(this.timer); this.timer = null; }
  isBusy(): boolean { return this.busy; }
  async idle(): Promise<void> { if (this.pending) await this.pending; }
  async getStatus(): Promise<GitHubSyncStatus> {
    const root = await this.currentRoot();
    const cached = this.states.get(root);
    if (cached) return structuredClone(cached);
    let saved: SavedState | undefined;
    try {
      saved = JSON.parse(await readFile(this.statePath(root), "utf8")) as SavedState;
      if (saved.version !== 1) throw new Error("Unsupported GitHub sync settings version. Your saved settings were preserved.");
      validateConfig(saved.config);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    let branch = "main";
    try { branch = (await runSyncCommand("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], root)).trim(); } catch { /* Setup reports a non-repository or detached HEAD. */ }
    const status: GitHubSyncStatus = {
      root, config: saved?.config ?? { enabled: false, cadence: "manual", remote: "origin", branch },
      phase: saved?.phase && !active.has(saved.phase) ? saved.phase : "idle",
      lastAttempt: saved?.lastAttempt, lastSuccess: saved?.lastSuccess, lastSyncedCommit: saved?.lastSyncedCommit, hasLocalChanges: saved?.hasLocalChanges, repository: saved?.repository,
      message: saved?.phase && active.has(saved.phase) ? "The previous sync was interrupted. Sync now to check and continue safely." : saved?.message,
      conflicts: saved?.conflicts,
      excluded: [...SYNC_EXCLUSIONS],
    };
    this.updateNext(status);
    this.states.set(root, status);
    return structuredClone(status);
  }
  async configure(input: { root: string; config: GitHubSyncConfig }): Promise<GitHubSyncStatus> {
    if (this.busy) throw new Error("Wait for the current sync to finish before changing its configuration.");
    this.busy = true;
    try {
      validateConfig(input.config);
      const root = await this.assertRoot(input.root);
      const current = await this.getStatus();
      if (current.root !== root) throw new Error("The Workspace changed. Reopen GitHub sync settings for the current Workspace.");
      const info = input.config.enabled ? await this.repository.inspect(root, input.config) : undefined;
      await this.assertRoot(root);
      const destinationChanged = current.repository !== info?.repository || current.config.branch !== input.config.branch;
      const status: GitHubSyncStatus = { ...current, ...(destinationChanged && input.config.enabled ? { lastAttempt: undefined, lastSuccess: undefined, lastSyncedCommit: undefined, hasLocalChanges: undefined } : {}), config: { ...input.config }, phase: "idle", repository: info?.repository, message: input.config.enabled ? "Ready to sync." : "Automatic sync is off.", conflicts: undefined };
      this.updateNext(status);
      await this.persist(status);
      this.states.set(root, status);
      this.options.publishStatus(structuredClone(status));
      return structuredClone(status);
    } finally { this.busy = false; }
  }
  async syncNow(input: { root: string }): Promise<GitHubSyncStatus> {
    if (this.busy) throw new Error("A sync is already running. Wait for it to finish.");
    this.busy = true;
    try {
      await this.assertRoot(input.root);
      const status = await this.getStatus();
      if (status.root !== input.root) throw new Error("The Workspace changed. Reopen GitHub sync settings for the current Workspace.");
      if (!status.config.enabled) throw new Error("Save and enable GitHub sync before syncing.");
      const run = this.perform(status);
      this.pending = run;
      return await run;
    } finally { this.pending = null; this.busy = false; }
  }

  async cancel(): Promise<GitHubSyncStatus> {
    const status = await this.getStatus();
    if (!["checking", "fetching", "pushing"].includes(status.phase)) throw new Error("Wait for the local save or merge to finish before stopping sync.");
    this.repository.cancel?.();
    await this.idle();
    return this.getStatus();
  }
  async tick(): Promise<void> {
    if (this.disposed || this.busy || this.options.canSchedule?.() === false) return;
    try {
      const status = await this.getStatus();
      if (!status.config.enabled || !interval(status.config.cadence)) return;
      if (status.nextRun && Date.parse(status.nextRun) > this.now()) return;
      await this.syncNow({ root: status.root });
    } catch { /* Status-producing runs persist their errors; missing Workspace is not a sync failure. */ }
  }
  private async perform(status: GitHubSyncStatus): Promise<GitHubSyncStatus> {
    status.lastAttempt = new Date(this.now()).toISOString();
    status.message = undefined;
    status.conflicts = undefined;
    status.phase = "checking";
    this.updateNext(status);
    await this.persist(status);
    this.publish(status);
    try {
      const result = await this.repository.sync(status.root, status.config, (phase) => { status.phase = phase; this.publish(status); },
        (operation) => this.options.withDocumentsFlushed(async () => { await this.assertRoot(status.root); return operation(); }), status.repository);
      status.repository = result.repository;
      status.phase = "synced";
      status.lastSuccess = new Date(this.now()).toISOString();
      status.lastSyncedCommit = result.commit;
      status.hasLocalChanges = result.hasLocalChanges;
      status.message = result.hasLocalChanges ? "Saved snapshot uploaded. Newer local edits will sync next time." : "Saved snapshot uploaded. Changes made afterward will sync next time.";
    } catch (error) {
      status.phase = error instanceof SyncConflict ? "conflict" : "error";
      status.message = error instanceof Error ? error.message : String(error);
      if (error instanceof SyncConflict) status.conflicts = error.files;
    }
    this.updateNext(status);
    await this.persist(status);
    this.publish(status);
    return structuredClone(status);
  }
  private publish(status: GitHubSyncStatus) { this.states.set(status.root, status); this.options.publishStatus(structuredClone(status)); }
  private updateNext(status: GitHubSyncStatus) {
    const every = interval(status.config.cadence);
    status.nextRun = status.config.enabled && every ? new Date(status.lastAttempt ? Date.parse(status.lastAttempt) + every : this.now()).toISOString() : undefined;
  }
  private async currentRoot(): Promise<string> {
    const roots = this.options.noteRoots();
    if (roots.length !== 1) throw new Error("Select a Workspace with one Note Root to use GitHub sync.");
    return realpath(roots[0]!);
  }
  private async assertRoot(root: string): Promise<string> {
    const current = await this.currentRoot();
    if (root !== current) throw new Error("The Workspace changed. Reopen GitHub sync settings for the current Workspace.");
    return current;
  }
  private statePath(root: string) { return path.join(this.options.stateRoot, `${createHash("sha256").update(root).digest("hex")}.json`); }
  private async persist(status: GitHubSyncStatus) {
    await mkdir(this.options.stateRoot, { recursive: true });
    const { config, lastAttempt, lastSuccess, lastSyncedCommit, hasLocalChanges, message, phase, repository, conflicts } = status;
    const temporary = `${this.statePath(status.root)}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify({ version: 1, config, lastAttempt, lastSuccess, lastSyncedCommit, hasLocalChanges, message, phase, repository, conflicts } satisfies SavedState, null, 2), { mode: 0o600 });
    await rename(temporary, this.statePath(status.root));
  }
}
function validateConfig(config: GitHubSyncConfig): void {
  if (!config || typeof config.enabled !== "boolean" || typeof config.remote !== "string" || typeof config.branch !== "string"
    || !["manual", "hourly", "daily"].includes(config.cadence)) throw new Error("Invalid GitHub sync configuration.");
}
