import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { GitHubSyncStatus } from "../../../shared/api";
import { GitHubSyncSection } from "./GitHubSyncSection";

let mounted: ReactTestRenderer | undefined;
let receive: (status: GitHubSyncStatus) => void;
const initial: GitHubSyncStatus = { root: "/notes", config: { enabled: false, cadence: "manual", remote: "origin", branch: "main" }, phase: "idle", excluded: [] };
const getStatus = vi.fn(), configure = vi.fn(), syncNow = vi.fn(), cancel = vi.fn();
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  getStatus.mockReset().mockResolvedValue(initial); configure.mockReset(); syncNow.mockReset(); cancel.mockReset();
  vi.stubGlobal("window", { exograph: {
    githubSync: { getStatus, configure, syncNow, cancel, onStatus: (callback: typeof receive) => { receive = callback; return () => {}; } },
    publishing: { getSetupStatus: async () => ({ authenticated: true, managed: false, login: "author" }) },
  } });
});
afterEach(async () => { if (mounted) await act(async () => mounted!.unmount()); mounted = undefined; vi.unstubAllGlobals(); });
async function mount(disabled = false) { await act(async () => { mounted = create(<GitHubSyncSection disabled={disabled} />); }); }
const find = (id: string) => mounted!.root.findByProps({ "data-testid": id });

it("saves a validated explicit configuration before enabling manual sync", async () => {
  await mount();
  expect(find("github-sync-now").props.disabled).toBe(true);
  await act(async () => find("github-sync-enabled").props.onChange({ target: { checked: true } }));
  await act(async () => find("github-sync-cadence").props.onChange({ target: { value: "hourly" } }));
  expect(configure).not.toHaveBeenCalled(); expect(find("github-sync-now").props.disabled).toBe(true);
  const configured = { ...initial, config: { ...initial.config, enabled: true, cadence: "hourly" as const }, repository: "author/private-notes" };
  configure.mockResolvedValue(configured);
  await act(async () => find("github-sync-save").props.onClick());
  expect(configure).toHaveBeenCalledExactlyOnceWith({ root: "/notes", config: configured.config });
  expect(find("github-sync-now").props.disabled).toBe(false);
  syncNow.mockResolvedValue({ ...configured, phase: "synced", lastSuccess: "2026-10-13T16:00:00Z", message: "All changes synced." });
  await act(async () => find("github-sync-now").props.onClick());
  expect(syncNow).toHaveBeenCalledExactlyOnceWith({ root: "/notes" });
  expect(JSON.stringify(mounted!.toJSON())).toContain("All changes synced.");
});

it("keeps in-progress form edits and ignores another workspace's status", async () => {
  await mount();
  await act(async () => find("github-sync-branch").props.onChange({ target: { value: "writing" } }));
  await act(async () => receive({ ...initial, phase: "fetching", message: "Fetching notes" }));
  expect(find("github-sync-branch").props.value).toBe("writing");
  expect(find("github-sync-now").props.disabled).toBe(true);
  await act(async () => receive({ ...initial, root: "/other", repository: "other/repo", message: "WRONG WORKSPACE" }));
  expect(JSON.stringify(mounted!.toJSON())).not.toContain("WRONG WORKSPACE");
});

it("uses the newest status event when the initial request resolves late", async () => {
  let resolve: (value: GitHubSyncStatus) => void = () => {};
  getStatus.mockReturnValue(new Promise<GitHubSyncStatus>(done => { resolve = done; }));
  await mount();
  await act(async () => receive({ ...initial, phase: "synced", message: "Latest sync" }));
  await act(async () => resolve(initial));
  expect(JSON.stringify(mounted!.toJSON())).toContain("Latest sync");
});

it("reports validation errors without enabling sync and explains conflict files", async () => {
  await mount();
  await act(async () => find("github-sync-enabled").props.onChange({ target: { checked: true } }));
  configure.mockRejectedValue(new Error("Choose a private GitHub repository."));
  await act(async () => find("github-sync-save").props.onClick());
  expect(JSON.stringify(mounted!.toJSON())).toContain("Choose a private GitHub repository.");
  expect(find("github-sync-now").props.disabled).toBe(true);
  await act(async () => receive({ ...initial, phase: "conflict", conflicts: ["essay.md"], message: "Both computers edited the same passage." }));
  expect(JSON.stringify(mounted!.toJSON())).toContain("essay.md");
});

it("disables operations until workspace changes have been applied", async () => {
  getStatus.mockResolvedValue({ ...initial, config: { ...initial.config, enabled: true } });
  await mount(true);
  expect(find("github-sync-now").props.disabled).toBe(true);
  await act(async () => find("github-sync-now").props.onClick());
  expect(syncNow).not.toHaveBeenCalled();
});

it("does not send duplicate manual sync requests while one is pending", async () => {
  getStatus.mockResolvedValue({ ...initial, config: { ...initial.config, enabled: true } });
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
