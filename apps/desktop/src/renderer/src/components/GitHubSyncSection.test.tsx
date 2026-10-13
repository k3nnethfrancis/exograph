import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { GitHubSyncRepositoryInfo, GitHubSyncSetup, GitHubSyncStatus } from "../../../shared/api";
import { GitHubSyncSection } from "./GitHubSyncSection";

let mounted: ReactTestRenderer | undefined;
let receive: (status: GitHubSyncStatus) => void;
const repo: GitHubSyncRepositoryInfo = { nameWithOwner: "author/private-notes", url: "https://github.com/author/private-notes", isPrivate: true, writable: true, defaultBranch: "main", empty: false };
const initial: GitHubSyncStatus = { root: "/notes", repository: repo.nameWithOwner, config: { enabled: true, cadence: "hourly", remote: "backup", branch: "writing", remoteBranch: "main" }, phase: "idle", excluded: [] };
const setup: GitHubSyncSetup = { root: "/notes", status: initial, account: { login: "author" }, suggestedName: "notes", local: { isRepository: true }, candidates: [{ remote: "backup", branch: "writing", repository: repo, preferred: true }] };
const getStatus = vi.fn(), configure = vi.fn(), syncNow = vi.fn(), cancel = vi.fn(), inspectSetup = vi.fn(), createAndSync = vi.fn(), connectExisting = vi.fn();
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  getStatus.mockReset().mockResolvedValue(initial); inspectSetup.mockReset().mockResolvedValue(setup); configure.mockReset(); syncNow.mockReset(); cancel.mockReset(); createAndSync.mockReset(); connectExisting.mockReset();
  vi.stubGlobal("window", { exograph: {
    githubSync: { getStatus, configure, syncNow, cancel, onSetupProgress: () => () => {}, inspectSetup, createAndSync, connectExisting, getAccountStatus: async () => ({ authenticated: true, managed: false, login: "author" }), onStatus: (callback: typeof receive) => { receive = callback; return () => {}; } },
  } });
});
afterEach(async () => { if (mounted) await act(async () => mounted!.unmount()); mounted = undefined; vi.unstubAllGlobals(); });
async function mount(disabled = false) { await act(async () => { mounted = create(<GitHubSyncSection disabled={disabled} />); }); }
const find = (id: string) => mounted!.root.findByProps({ "data-testid": id });
const content = () => JSON.stringify(mounted!.toJSON());

it("keeps Git mechanics in a closed disclosure and saves schedule without changing the existing upstream", async () => {
  await mount();
  expect(find("github-sync-details").props.open).toBeUndefined();
  expect(find("github-sync-cadence").props.value).toBe("hourly");
  expect(find("github-sync-now").props.disabled).toBe(false);
  configure.mockResolvedValue({ ...initial, config: { ...initial.config, cadence: "daily" } });
  await act(async () => find("github-sync-cadence").props.onChange({ target: { value: "daily" } }));
  expect(configure).toHaveBeenCalledExactlyOnceWith({ root: "/notes", config: { ...initial.config, cadence: "daily" } });
});

it("detects a connected local repository and enables without remote or branch entry", async () => {
  getStatus.mockResolvedValue({ ...initial, repository: undefined, config: { ...initial.config, enabled: false } });
  connectExisting.mockResolvedValue({ kind: "connected", repository: repo, status: initial });
  await mount();
  expect(mounted!.root.findAllByProps({ "data-testid": "github-sync-remote" })).toHaveLength(0);
  expect(content()).toContain("This notes folder is already connected.");
  await act(async () => find("github-sync-enable").props.onClick());
  expect(connectExisting).toHaveBeenCalledExactlyOnceWith({ root: "/notes", repository: repo.nameWithOwner, cadence: "hourly", remote: "backup" });
  expect(find("github-sync-now").props.disabled).toBe(false);
});

it("reviews a prefilled private destination before creating and syncing", async () => {
  getStatus.mockResolvedValue({ ...initial, repository: undefined });
  inspectSetup.mockResolvedValue({ ...setup, local: { isRepository: false }, candidates: [] });
  createAndSync.mockResolvedValue({ kind: "connected", repository: repo, status: initial });
  await mount();
  await act(async () => find("github-sync-create").props.onClick());
  expect(find("github-sync-name").props.value).toBe("notes");
  expect(content()).toContain("author"); expect(content()).toContain("Private");
  expect(createAndSync).not.toHaveBeenCalled();
  await act(async () => find("github-sync-create-submit").props.onClick());
  expect(createAndSync).toHaveBeenCalledExactlyOnceWith({ root: "/notes", owner: "author", name: "notes", cadence: "hourly" });
});

it("keeps in-progress Git details and ignores another workspace's status", async () => {
  await mount();
  await act(async () => find("github-sync-branch").props.onChange({ target: { value: "draft" } }));
  await act(async () => receive({ ...initial, phase: "fetching", message: "Fetching notes" }));
  expect(find("github-sync-branch").props.value).toBe("draft");
  expect(find("github-sync-now").props.disabled).toBe(true);
  await act(async () => receive({ ...initial, root: "/other", repository: "other/repo", message: "WRONG WORKSPACE" }));
  expect(content()).not.toContain("WRONG WORKSPACE");
});

it("uses the newest status event when the initial request resolves late", async () => {
  let resolve: (value: GitHubSyncStatus) => void = () => {};
  getStatus.mockReturnValue(new Promise<GitHubSyncStatus>(done => { resolve = done; }));
  await mount();
  await act(async () => receive({ ...initial, phase: "synced", message: "Latest sync" }));
  await act(async () => resolve(initial));
  expect(content()).toContain("Latest sync");
});

it("reports validation errors without overwriting settings and explains conflict files", async () => {
  await mount();
  configure.mockRejectedValue(new Error("Choose a private GitHub repository."));
  await act(async () => find("github-sync-pause").props.onClick());
  expect(content()).toContain("Choose a private GitHub repository.");
  expect(find("github-sync-pause").children).toEqual(["Pause sync"]);
  await act(async () => receive({ ...initial, phase: "conflict", conflicts: ["essay.md"], message: "Both computers edited the same passage." }));
  expect(content()).toContain("essay.md");
});

it("disables operations until workspace changes have been applied", async () => {
  await mount(true);
  expect(find("github-sync-now").props.disabled).toBe(true);
  await act(async () => find("github-sync-now").props.onClick());
  expect(syncNow).not.toHaveBeenCalled();
});

it("does not send duplicate manual sync requests while one is pending", async () => {
  await mount();
  let resolve: (value: GitHubSyncStatus) => void = () => {};
  syncNow.mockReturnValue(new Promise<GitHubSyncStatus>(done => { resolve = done; }));
  await act(async () => { find("github-sync-now").props.onClick(); find("github-sync-now").props.onClick(); });
  expect(syncNow).toHaveBeenCalledTimes(1);
  await act(async () => resolve(initial));
});

it("offers safe network cancellation but not interruption of a local merge", async () => {
  await mount();
  await act(async () => receive({ ...initial, phase: "fetching" }));
  cancel.mockResolvedValue({ ...initial, message: "Sync stopped. Your saved work is preserved." });
  await act(async () => find("github-sync-cancel").props.onClick());
  expect(cancel).toHaveBeenCalledOnce();
  await act(async () => receive({ ...initial, phase: "merging" }));
  expect(mounted!.root.findAllByProps({ "data-testid": "github-sync-cancel" })).toHaveLength(0);
});

it("shows combination review when a detected remote cannot safely be connected", async () => {
  getStatus.mockResolvedValue({ ...initial, repository: undefined });
  connectExisting.mockResolvedValue({ kind: "review-required", repository: repo, message: "The local and remote histories are unrelated." });
  await mount();
  await act(async () => find("github-sync-enable").props.onClick());
  expect(find("github-sync-combination-review")).toBeDefined();
  expect(content()).toContain("The local and remote histories are unrelated.");
  expect(mounted!.root.findAllByProps({ "data-testid": "github-sync-now" })).toHaveLength(0);
});
