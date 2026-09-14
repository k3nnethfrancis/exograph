import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  DirectInvocationProcessFactory,
  terminateOwnedInvocationProcessGroup,
  type InvocationProcessExit,
  type InvocationProcessOutput,
} from "./invocation-process";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("direct invocation process", () => {
  it.runIf(process.platform !== "win32")("does not execute the command before its durable launch gate is released", async () => {
    const root = await temporaryRoot("exograph-invocation-process-gate-");
    const marker = path.join(root, "executed");
    const invocation = new DirectInvocationProcessFactory().launch({
      command: `${shellQuote(globalThis.process.execPath)} -e ${shellQuote(`require("node:fs").writeFileSync(${JSON.stringify(marker)}, "yes")`)}`,
      cwd: processCwd(),
      env: globalThis.process.env,
    });
    const exited = exitOf(invocation);

    await new Promise((resolve) => setTimeout(resolve, 30));
    await expect(readFile(marker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await invocation.release();

    await expect(exited).resolves.toMatchObject({ exitCode: 0 });
    await expect(readFile(marker, "utf8")).resolves.toBe("yes");
  });

  it.runIf(process.platform === "darwin" || process.platform === "linux")("verifies and terminates a durably owned process group during recovery", async () => {
    const invocation = new DirectInvocationProcessFactory({ stopGraceMs: 100 }).launch({
      command: `${shellQuote(globalThis.process.execPath)} -e ${shellQuote("setInterval(() => {}, 1000)")}`,
      cwd: processCwd(),
      env: globalThis.process.env,
    });
    const exited = exitOf(invocation);
    await invocation.release();

    await terminateOwnedInvocationProcessGroup(invocation.ownership, 100);

    await expect(exited).resolves.toMatchObject({ exitCode: null });
    expect(processExists(invocation.ownership.pid)).toBe(false);
  });

  it.runIf(process.platform === "darwin" || process.platform === "linux")("refuses to signal when the durable token does not match", async () => {
    const invocation = new DirectInvocationProcessFactory({ stopGraceMs: 100 }).launch({
      command: `${shellQuote(globalThis.process.execPath)} -e ${shellQuote("setInterval(() => {}, 1000)")}`,
      cwd: processCwd(),
      env: globalThis.process.env,
    });
    await invocation.release();

    await expect(terminateOwnedInvocationProcessGroup({
      ...invocation.ownership,
      ownerToken: "ffffffff-ffff-4fff-8fff-ffffffffffff",
    }, 100)).rejects.toThrow("refusing to signal");
    expect(processExists(invocation.ownership.pid)).toBe(true);
    await invocation.stop();
  });

  it("streams output facts while retaining bounded exit output", async () => {
    const process = launch("read line; printf 'first:%s\\n' \"$line\"; printf 'warn\\n' >&2; printf 'last\\n'");
    const output: InvocationProcessOutput[] = [];
    process.onOutput?.((event) => output.push(event));
    const exited = exitOf(process);

    await process.send("hello\n");
    const result = await exited;

    expect(result).toMatchObject({ exitCode: 0, stdout: "first:hello\nlast\n", stderr: "warn\n" });
    expect(output).toEqual(expect.arrayContaining([
      { channel: "stdout", chunk: expect.stringContaining("first:hello") },
      { channel: "stderr", chunk: "warn\n" },
    ]));
  });

  it("retains only the bounded tail of large process output", async () => {
    const process = launch(`${shellQuote(globalThis.process.execPath)} -e ${shellQuote("process.stdout.write('x'.repeat(300000) + 'tail-marker')")}`);
    const result = await exitOf(process);

    expect(result.stdout.length).toBe(256_000);
    expect(result.stdout.endsWith("tail-marker")).toBe(true);
  });

  it.runIf(process.platform !== "win32")("stops the shell and its descendant process group", async () => {
    const root = await temporaryRoot("exograph-invocation-process-tree-");
    const childReadyPath = path.join(root, "child-ready");
    const childStoppedPath = path.join(root, "child-stopped");
    const scriptPath = path.join(root, "agent.mjs");
    await writeFile(scriptPath, `
import { spawn } from "node:child_process";
const child = spawn(process.execPath, ["-e", ${JSON.stringify(`
  const { writeFileSync } = require("node:fs");
  process.on("SIGTERM", () => {
    writeFileSync(${JSON.stringify(childStoppedPath)}, "stopped");
    process.exit(0);
  });
  writeFileSync(${JSON.stringify(childReadyPath)}, String(process.pid));
  setInterval(() => {}, 1000);
`)}], { stdio: "inherit" });
child.on("exit", () => process.exit(0));
setInterval(() => {}, 1000);
`, "utf8");
    const process = launch(`${shellQuote(globalThis.process.execPath)} ${shellQuote(scriptPath)}`);
    const exited = exitOf(process);
    await waitForFile(childReadyPath);

    await process.stop();

    await expect(exited).resolves.toMatchObject({ exitCode: null });
    await expect(readFile(childStoppedPath, "utf8")).resolves.toBe("stopped");
  });

  it.runIf(process.platform !== "win32")("reaps stdio-detached descendants before publishing natural exit", async () => {
    const root = await temporaryRoot("exograph-invocation-process-natural-descendant-");
    const childReadyPath = path.join(root, "child-ready");
    const childStoppedPath = path.join(root, "child-stopped");
    const childScriptPath = path.join(root, "child.mjs");
    const parentScriptPath = path.join(root, "parent.mjs");
    await writeFile(childScriptPath, `
import { writeFileSync } from "node:fs";
process.on("SIGTERM", () => {
  writeFileSync(${JSON.stringify(childStoppedPath)}, "stopped");
  process.exit(0);
});
writeFileSync(${JSON.stringify(childReadyPath)}, String(process.pid));
setInterval(() => {}, 1000);
`, "utf8");
    await writeFile(parentScriptPath, `
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
const child = spawn(process.execPath, [${JSON.stringify(childScriptPath)}], { stdio: "ignore" });
child.unref();
const ready = setInterval(() => {
  if (!existsSync(${JSON.stringify(childReadyPath)})) return;
  clearInterval(ready);
}, 5);
`, "utf8");
    const invocation = launch(
      `${shellQuote(globalThis.process.execPath)} ${shellQuote(parentScriptPath)}`,
      new DirectInvocationProcessFactory({ stopGraceMs: 100 }),
    );

    const result = await exitOf(invocation);

    const childPid = Number(await readFile(childReadyPath, "utf8"));
    expect(result.exitCode).toBe(0);
    await expect(readFile(childStoppedPath, "utf8")).resolves.toBe("stopped");
    expect(processExists(childPid)).toBe(false);
  });

  it("settles stop against natural exit exactly once", async () => {
    const process = launch(`${shellQuote(globalThis.process.execPath)} -e ${shellQuote("process.stdout.write('done')")}`);
    const exits: InvocationProcessExit[] = [];
    process.onExit((event) => exits.push(event));
    let stop: Promise<void> | undefined;
    process.onOutput?.(() => {
      stop ??= process.stop();
    });

    await exitOf(process);
    expect(stop).toBeDefined();
    await stop;
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(exits).toHaveLength(1);
    expect(exits[0]?.stdout).toBe("done");
  });

  it("returns one idempotent Stop operation", async () => {
    const process = launch(`${shellQuote(globalThis.process.execPath)} -e ${shellQuote("setInterval(() => {}, 1000)")}`);
    const exits: InvocationProcessExit[] = [];
    process.onExit((event) => exits.push(event));

    const first = process.stop();
    const second = process.stop();

    expect(second).toBe(first);
    await Promise.all([first, second]);
    expect(exits).toHaveLength(1);
  });

  it.runIf(process.platform !== "win32")("escalates when the process group ignores graceful Stop", async () => {
    const root = await temporaryRoot("exograph-invocation-process-escalation-");
    const readyPath = path.join(root, "ready");
    const termPath = path.join(root, "term-seen");
    const scriptPath = path.join(root, "stubborn.mjs");
    await writeFile(scriptPath, `
import { writeFileSync } from "node:fs";
process.on("SIGTERM", () => writeFileSync(${JSON.stringify(termPath)}, "term"));
writeFileSync(${JSON.stringify(readyPath)}, "ready");
setInterval(() => {}, 1000);
`, "utf8");
    const process = launch(
      `${shellQuote(globalThis.process.execPath)} ${shellQuote(scriptPath)}`,
      new DirectInvocationProcessFactory({ stopGraceMs: 40 }),
    );
    const exited = exitOf(process);
    await waitForFile(readyPath);

    await process.stop();

    await expect(readFile(termPath, "utf8")).resolves.toBe("term");
    await expect(exited).resolves.toMatchObject({ exitCode: null });
  });

  it("never emits output callbacks after close", async () => {
    const process = launch("printf 'final-output'");
    const output: string[] = [];
    process.onOutput?.((event) => output.push(event.chunk));

    await exitOf(process);
    const atClose = [...output];
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(atClose.join("")).toBe("final-output");
    expect(output).toEqual(atClose);
  });
});

function launch(command: string, factory = new DirectInvocationProcessFactory()) {
  const invocation = factory.launch({ command, cwd: processCwd(), env: globalThis.process.env });
  void invocation.release();
  return invocation;
}

function exitOf(process: ReturnType<DirectInvocationProcessFactory["launch"]>): Promise<InvocationProcessExit> {
  return new Promise((resolve) => process.onExit(resolve));
}

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}

async function waitForFile(filePath: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      await readFile(filePath);
      return;
    } catch (error) {
      if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") throw error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error(`Timed out waiting for ${filePath}`);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function processExists(pid: number): boolean {
  try {
    globalThis.process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ESRCH") return false;
    throw error;
  }
}

function processCwd(): string {
  return globalThis.process.cwd();
}
