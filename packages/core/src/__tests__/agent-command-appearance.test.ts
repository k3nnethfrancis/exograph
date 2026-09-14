import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { normalizeWorkspaceSettings, saveWorkspaceSettings, loadWorkspaceSettings } from "../workspace-settings";
import { describe, expect, it } from "vitest";
import { agentCommandConfigurationError, normalizeAgentCommand, normalizeAgentCommandAppearance } from "../agent-command-configuration";
import { agentCommandExecutableFingerprint, agentCommandSnapshot, createDefaultCodexAgentCommand } from "../agent-invocation";

const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=";

describe("command appearance", () => {
  it("round-trips appearance through the workspace settings store", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-appearance-"));
    try {
      const appearance = { color: "#112233", iconDataUrl: png };
      const settings = normalizeWorkspaceSettings({ workspaceRoot: root, noteRoots: [root], defaultTerminalCwd: root, indexedRoots: [], agentCommands: [{ ...createDefaultCodexAgentCommand(), appearance }] })!;
      const env = { EXOGRAPH_USER_DATA_PATH: path.join(root, "profile") };
      await saveWorkspaceSettings(settings, env);
      expect((await loadWorkspaceSettings(env))?.agentCommands?.[0]?.appearance).toEqual(appearance);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("preserves a portable icon and color without changing execution trust", () => {
    const command = createDefaultCodexAgentCommand();
    const appearance = { color: "#0088cc", iconDataUrl: png };
    const styled = normalizeAgentCommand({ ...command, appearance })!;
    expect(styled.appearance).toEqual(appearance);
    expect(styled.version).toBe(command.version);
    expect(agentCommandConfigurationError([{ ...command, appearance: { iconDataUrl: png, color: "#0088cc" } }])).toBeNull();
    expect(agentCommandConfigurationError([styled])).toBeNull();
    expect(agentCommandExecutableFingerprint(styled)).toBe(agentCommandExecutableFingerprint(command));
    expect(agentCommandSnapshot(styled).appearance).toEqual(appearance);
    expect(normalizeAgentCommand(JSON.parse(JSON.stringify(styled)))).toEqual(styled);
  });

  it.each([
    { color: "red" }, { color: "#fff" }, { color: "url(https://example.org)" },
    { iconDataUrl: "file:///tmp/icon.png" }, { iconDataUrl: "https://example.org/icon.png" },
    { iconDataUrl: "data:image/svg+xml;base64,PHN2Zz4=" }, { iconDataUrl: "data:image/png;base64,bm90IGEgcG5n" },
    { iconDataUrl: "data:image/png;base64," + "A".repeat(90_000) },
  ])("drops invalid persisted appearance without losing the command: %j", (appearance) => {
    expect(normalizeAgentCommandAppearance(appearance)).toBeUndefined();
    const input = { ...createDefaultCodexAgentCommand(), appearance };
    expect(normalizeAgentCommand(input)?.id).toBe("codex");
    expect(agentCommandConfigurationError([input])).toContain("appearance");
  });

  it("rejects zero and oversized raster dimensions", () => {
    for (const width of [0, 129, 0xffffffff]) {
      const bytes = Buffer.from(png.split(",")[1]!, "base64");
      bytes.writeUInt32BE(width, 16);
      expect(normalizeAgentCommandAppearance({ iconDataUrl: `data:image/png;base64,${bytes.toString("base64")}` })).toBeUndefined();
    }
  });

  it("allows clearing appearance and preserves valid color if a persisted icon is broken", () => {
    expect(normalizeAgentCommandAppearance(undefined)).toBeUndefined();
    expect(normalizeAgentCommandAppearance({ color: "#123456", iconDataUrl: "broken" })).toEqual({ color: "#123456" });
  });
});
