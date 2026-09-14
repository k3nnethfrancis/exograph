import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { normalizeWorkspaceSettings, workspaceModelFromSettings } from "@exograph/core";
const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", async () => ({ ...await vi.importActual<typeof import("node:child_process")>("node:child_process"), spawn }));
vi.mock("./github-cli", () => ({ resolveGitHubCli: async () => "gh", findGitHubCli: async () => "gh" }));
import { ManagedSiteSetup } from "./managed-site-setup";
afterEach(() => vi.clearAllMocks());
it("keeps reconnect polling active and exposes a device code split across output chunks", async () => {
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
  spawn.mockReturnValue(child);
  const settings = normalizeWorkspaceSettings({ workspaceRoot: "/notes", defaultTerminalCwd: "/notes", noteRoots: ["/notes"] })!;
  const service = new ManagedSiteSetup({ context: () => ({ settings, model: workspaceModelFromSettings(settings) }), sitesParent: "/sites",
    capture: vi.fn(), verify: vi.fn(), run: async (_file, args) => args.includes("--include") ? "HTTP/2 200\nx-oauth-scopes: repo, read:org\n" : "user" });
  const starting = await service.startAuth();
  expect(starting).toMatchObject({ authenticated: false, pending: true });
  expect(spawn.mock.calls[0]?.[1]).toContain("workflow");
  child.stderr.write("First copy your one-time code: ABCD-"); child.stderr.write("EFGH\n");
  expect(await service.getSetupStatus()).toMatchObject({ authenticated: false, pending: true, deviceCode: "ABCD-EFGH", verificationUrl: "https://github.com/login/device" });
  await service.cancelSetup(); expect(child.kill).toHaveBeenCalledOnce();
});
