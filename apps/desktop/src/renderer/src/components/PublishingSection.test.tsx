import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PublishingStatus } from "../../../shared/api";
import type { WorkspaceSettingsDialogState } from "../workspaceSettingsDialogTypes";
import { PublishingSection } from "./PublishingSection";

let mounted: ReactTestRenderer | undefined;
let receive: (status: PublishingStatus) => void;
const publish = vi.fn();
const build = vi.fn();
const settings = { workspaceRoot: "/workspace", noteRoots: ["/workspace/notes"], publishing: { publicationDirectory: "/workspace/notes/public", engineDirectory: "/engine", siteUrl: "https://example.com/", destinationRepository: "author/site" }, saveStatus: "saved", applyStatus: "applied" } as WorkspaceSettingsDialogState;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", { exograph: { publishing: {
    getSetupStatus: async () => ({ authenticated: true, managed: false }),
    getStatus: async () => ({ phase: "idle", diagnostics: [] }),
    onStatus: (callback: typeof receive) => { receive = callback; return () => {}; }, publish, build,
  } } });
  publish.mockReset(); build.mockReset();
});
afterEach(async () => { if (mounted) await act(async () => mounted!.unmount()); mounted = undefined; vi.unstubAllGlobals(); });
async function mount() { await act(async () => { mounted = create(<PublishingSection settings={settings} setSettings={vi.fn()} />); }); }
const button = () => mounted!.root.findByProps({ "data-testid": "publishing-publish" });
it("refreshes managed controls after migrated settings finish saving", async () => {
  const getSetupStatus = vi.fn().mockResolvedValue({ authenticated: true, managed: false });
  window.exograph.publishing.getSetupStatus = getSetupStatus;
  await mount();
  const migrated = { ...settings, publishing: { ...settings.publishing!, engineDirectory: "/managed-site" } };
  await act(async () => mounted!.update(<PublishingSection settings={{ ...migrated, saveStatus: "saving" }} setSettings={vi.fn()} />));
  expect(getSetupStatus).toHaveBeenCalledTimes(1);
  getSetupStatus.mockResolvedValue({ authenticated: true, managed: true });
  await act(async () => mounted!.update(<PublishingSection settings={migrated} setSettings={vi.fn()} />));
  expect(getSetupStatus).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(mounted!.toJSON())).toContain("Customize appearance");
  expect(JSON.stringify(mounted!.toJSON())).not.toContain("Use managed publishing");
});
it("enables publication only for a saved prepared snapshot, never a preview or pending build", async () => {
  await mount();
  expect(button().props.disabled).toBe(true);
  expect(publish).not.toHaveBeenCalled();
  await act(async () => receive({ phase: "ready", action: "preview", diagnostics: [] }));
  expect(button().props.disabled).toBe(true);
  await act(async () => receive({ phase: "ready", action: "prepare", preparedId: "prepared", diagnostics: [] }));
  expect(button().props.disabled).toBe(false);
  await act(async () => mounted!.update(<PublishingSection settings={{ ...settings, saveStatus: "saving" }} setSettings={vi.fn()} />));
  expect(button().props.disabled).toBe(true);
  expect(publish).not.toHaveBeenCalled();
});
it("publishes only on explicit click with the exact prepared identity and reports actual success", async () => {
  await mount();
  await act(async () => receive({ phase: "ready", action: "prepare", preparedId: "prepared", diagnostics: [] }));
  publish.mockResolvedValue({ phase: "ready", action: "prepare", preparedId: "prepared", diagnostics: [], deployment: { status: "deployed", deploymentUrl: "https://example.com/", snapshotCommit: "a".repeat(40), engineCommit: "b".repeat(40), runId: "1" } });
  expect(publish).not.toHaveBeenCalled();
  await act(async () => button().props.onClick());
  expect(publish).toHaveBeenCalledExactlyOnceWith({ scope: { workspaceRoot: settings.workspaceRoot, noteRoots: settings.noteRoots, publishing: settings.publishing }, preparedId: "prepared" });
  expect(button().props.disabled).toBe(true);
  expect(mounted!.root.findByProps({ "data-testid": "publishing-open-site" })).toBeDefined();
});
it("shows setup-required truthfully without inventing a deployed URL", async () => {
  await mount();
  await act(async () => receive({ phase: "ready", action: "prepare", diagnostics: [], deployment: { status: "setup-required", message: "Configure the workflow" } }));
  expect(button().props.disabled).toBe(true);
  expect(mounted!.root.findAllByProps({ "data-testid": "publishing-open-site" })).toHaveLength(0);
  expect(JSON.stringify(mounted!.toJSON())).toContain("Configure the workflow");
});
