import { execFile as execFileCallback } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { expect, test } from "@playwright/test";

import { launchExographWorkspaceFixture } from "../helpers";

const execFile = promisify(execFileCallback);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const cliEntry = path.join(repoRoot, "packages/cli/dist/index.cjs");

test("CLI controls a live direct-PTY terminal without UI automation", async () => {
  const fixture = await launchExographWorkspaceFixture({ initialNoteLabel: null, mutable: true });
  const env = {
    ...process.env,
    EXOGRAPH_WORKSPACE_ROOT: fixture.workspaceRoot,
    EXOGRAPH_NOTE_ROOTS: path.join(fixture.workspaceRoot, "notes/test-notes"),
    EXOGRAPH_DEFAULT_TERMINAL_CWD: fixture.workspaceRoot,
    EXOGRAPH_RUNTIME_ROOT: path.join(fixture.workspaceRoot, ".exograph"),
  };

  try {
    await expect.poll(async () => {
      try {
        await cliJson(["terminals", "list"], env);
        return true;
      } catch {
        return false;
      }
    }, { timeout: 15_000 }).toBe(true);

    const created = await cliJson(["terminals", "create"], env) as { terminal: { id: string } };
    const id = created.terminal.id;
    expect(id).toMatch(/^term-/);

    await cliJson(["terminals", "write", id, "--newline"], env);
    await cliJson(["terminals", "write", id, "cli-terminal-proof", "--newline"], env);
    await expect.poll(async () => {
      const read = await cliJson(["terminals", "read", id], env) as { output: string };
      return read.output;
    }).toContain("cli-terminal-proof");

    const listed = await cliJson(["terminals", "list"], env) as { terminals: Array<{ id: string }> };
    expect(listed.terminals.map((terminal) => terminal.id)).toContain(id);

    const firstRead = await cliJson(["terminals", "read", id], env) as { cursor: number };
    await cliJson(["terminals", "write", id, "second-proof", "--newline"], env);
    await expect.poll(async () => {
      const read = await cliJson(["terminals", "read", id, "--cursor", String(firstRead.cursor)], env) as { output: string };
      return read.output;
    }).toContain("second-proof");

    await cliJson(["terminals", "stop", id], env);
    const afterStop = await cliJson(["terminals", "list"], env) as { terminals: Array<{ id: string }> };
    expect(afterStop.terminals.map((terminal) => terminal.id)).not.toContain(id);
  } finally {
    await fixture.cleanup();
  }
});

async function cliJson(args: string[], env: NodeJS.ProcessEnv): Promise<unknown> {
  const { stdout } = await execFile(process.execPath, [cliEntry, ...args], { cwd: repoRoot, env });
  return JSON.parse(stdout);
}
