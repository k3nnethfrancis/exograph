import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createDefaultClaudeAgentCommand } from "@exograph/core";
import type { TerminalProcess, TerminalProcessFactory, TerminalProcessOptions } from "./terminal-runtime";
import { TerminalManager } from "./terminal-manager";

describe("TerminalManager direct PTY", () => {
  it("keeps byte-faithful input and a bounded in-memory tail", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "exograph-terminal-manager-"));
    const factory = new FakeTerminalProcessFactory();
    const manager = new TerminalManager(root, 1_024, {}, factory);
    const terminal = await manager.create({ terminalKind: "shell", cwd: root });

    await expect(manager.write(terminal.id, "hello world\u001b[?1000h")).resolves.toEqual({
      ok: true,
      delivery: "sent",
      writeId: 1,
    });
    await expect(manager.write("missing", "ignored")).resolves.toEqual({
      ok: false,
      delivery: "not-found",
    });
    factory.process.emitData(`${"a".repeat(16)}${"b".repeat(1_024)}`);

    expect(factory.process.writes).toEqual(["hello world\u001b[?1000h"]);
    expect(manager.readTail(terminal.id)).toBe("b".repeat(1_024));
    expect(terminal).toMatchObject({ kind: "shell", cwd: root, status: "running" });
  });

  it("reports direct message delivery through the shared write result", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "exograph-terminal-manager-"));
    const factory = new FakeTerminalProcessFactory();
    const manager = new TerminalManager(root, 1_024, {}, factory);
    const terminal = await manager.create({ terminalKind: "shell", cwd: root });

    await expect(manager.sendMessage(terminal.id, "hello", false)).resolves.toEqual({
      ok: true,
      delivery: "sent",
      writeId: 1,
    });
    await expect(manager.sendMessage("missing", "ignored", false)).resolves.toEqual({
      ok: false,
      delivery: "not-found",
    });
    expect(factory.process.writes).toEqual(["hello"]);
  });

  it("supports incremental, bounded live-tail reads without persisting a transcript", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "exograph-terminal-manager-"));
    const factory = new FakeTerminalProcessFactory();
    const manager = new TerminalManager(root, 1_024, {}, factory);
    const terminal = await manager.create({ terminalKind: "shell", cwd: root });

    factory.process.emitData("first");
    expect(manager.readTailSince(terminal.id)).toEqual({ output: "first", cursor: 5, truncated: false });
    factory.process.emitData(`${"x".repeat(1_024)}-next`);
    expect(manager.readTailSince(terminal.id, 5)).toEqual({ output: `${"x".repeat(1_019)}-next`, cursor: 1_034, truncated: true });
    expect(manager.readTailSince(terminal.id, 10)).toEqual({ output: `${"x".repeat(1_019)}-next`, cursor: 1_034, truncated: false });
    expect(manager.readTailSince("missing", 0)).toBeNull();
  });

  it("uses the immutable invocation Workspace for agent terminal environment", async () => {
    const factory = new FakeTerminalProcessFactory();
    const manager = new TerminalManager("/workspace-b", 1_024, {}, factory);
    await manager.createAgentCommand(
      createDefaultClaudeAgentCommand(),
      "/workspace-a/notes",
      {
        workspaceRoot: "/workspace-a",
        noteRoots: ["/workspace-a/notes"],
        defaultTerminalCwd: "/workspace-a",
        runtimeRoot: "/workspace-a/.exograph",
      },
    );

    expect(factory.options?.env).toMatchObject({
      EXOGRAPH_WORKSPACE_ROOT: "/workspace-a",
      EXOGRAPH_NOTE_ROOTS: "/workspace-a/notes",
      EXOGRAPH_DEFAULT_TERMINAL_CWD: "/workspace-a",
      EXOGRAPH_RUNTIME_ROOT: "/workspace-a/.exograph",
    });
  });
});

class FakeTerminalProcessFactory implements TerminalProcessFactory {
  readonly process = new FakeTerminalProcess();
  options: TerminalProcessOptions | null = null;
  create(options: TerminalProcessOptions): TerminalProcess { this.options = options; return this.process; }
}

class FakeTerminalProcess implements TerminalProcess {
  readonly writes: string[] = [];
  private readonly dataHandlers = new Set<(data: string) => void>();
  private readonly exitHandlers = new Set<(event: { exitCode?: number }) => void>();
  onData(handler: (data: string) => void): void { this.dataHandlers.add(handler); }
  onExit(handler: (event: { exitCode?: number }) => void): void { this.exitHandlers.add(handler); }
  write(data: string): void { this.writes.push(data); }
  resize(): void {}
  kill(): void { for (const handler of this.exitHandlers) handler({ exitCode: 0 }); }
  emitData(data: string): void { for (const handler of this.dataHandlers) handler(data); }
}
