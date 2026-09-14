#!/usr/bin/env node

import { spawn } from "node:child_process";
import { appendFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import path from "node:path";

const [scenario, noteRoot, taggedNote] = process.argv.slice(2);
if (!scenario || !noteRoot || !taggedNote) {
  throw new Error("Usage: invocation-fixture.mjs <scenario> <note-root> <tagged-note>");
}

const resumeIndex = process.argv.indexOf("--resume");
const prompt = resumeIndex >= 0 ? "" : await readStdin();
const invocation = resumeIndex >= 0 ? null : invocationIdentity(prompt);
// Keep control/PID evidence outside the authorized Note Root so it cannot
// accidentally become part of the invocation Changeset under test.
const fixtureDir = path.join(path.dirname(noteRoot), ".invocation-fixture");
await mkdir(fixtureDir, { recursive: true });

switch (scenario) {
  case "modify":
    await appendLinkedResponse("Modified the tagged note.");
    await appendFile(taggedNote, "\nFixture modified content.\n", "utf8");
    break;
  case "multi":
    await appendLinkedResponse("Updated several notes.");
    await appendFile(taggedNote, "\nFixture multi-file content.\n", "utf8");
    await appendFile(path.join(noteRoot, "second.md"), "\nFixture updated second note.\n", "utf8");
    await writeFile(path.join(noteRoot, "created.md"), "# Created by invocation fixture\n", "utf8");
    await rm(path.join(noteRoot, "deleted.md"));
    await rename(path.join(noteRoot, "rename-before.md"), path.join(noteRoot, "rename-after.md"));
    break;
  case "proposal-running":
    process.stdout.write(`${JSON.stringify({
      type: "system",
      subtype: "init",
      session_id: "ce4b9e26-2574-4433-a054-1110cd403792",
    })}\n`);
    await appendLinkedResponse("Prepared a proposal while the harness remains active.");
    await appendFile(taggedNote, "\nFixture proposal content.\n", "utf8");
    await writeFile(path.join(fixtureDir, "proposal-ready.txt"), "ready", "utf8");
    await waitForever();
    break;
  case "partial-failure":
    await appendLinkedResponse("The fixture failed after producing partial work.");
    await writeFile(path.join(noteRoot, "partial.md"), "# Partial invocation result\n", "utf8");
    process.exitCode = 17;
    break;
  case "no-response":
    break;
  case "stop-tree":
    await runStopTree();
    break;
  case "crash-recovery":
    await appendLinkedResponse("Wrote durable content before the host crash.");
    await appendFile(taggedNote, "\nFixture crash-recovery content.\n", "utf8");
    await writeFile(path.join(fixtureDir, "parent.pid"), String(process.pid), "utf8");
    await waitForever();
    break;
  case "resume":
    await runResume();
    break;
  case "resume-failure":
    await runResume(true);
    break;
  case "provider-activity":
    await emitProviderActivity();
    await appendLinkedResponse("Completed provider activity fixture.");
    break;
  default:
    throw new Error(`Unknown invocation fixture scenario: ${scenario}`);
}

async function appendLinkedResponse(message) {
  const response = [
    "",
    `<exograph-agent-response invocation="${invocation.id}" agent="${invocation.agent}">`,
    message,
    "</exograph-agent-response>",
    "",
  ].join("\n");
  await appendFile(taggedNote, response, "utf8");
}

async function runStopTree() {
  await writeFile(path.join(fixtureDir, "parent.pid"), String(process.pid), "utf8");
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1_000)"], {
    stdio: "ignore",
  });
  await writeFile(path.join(fixtureDir, "child.pid"), String(child.pid), "utf8");
  const recordSignal = (signal) => {
    try {
      writeFileSync(path.join(fixtureDir, "signal.txt"), signal, "utf8");
    } finally {
      process.exit(0);
    }
  };
  process.once("SIGTERM", () => recordSignal("SIGTERM"));
  process.once("SIGINT", () => recordSignal("SIGINT"));
  await waitForever();
}

async function runResume(fail = false) {
  if (resumeIndex >= 0) {
    await writeFile(path.join(fixtureDir, "resumed-session.txt"), process.argv[resumeIndex + 1] ?? "", "utf8");
    return;
  }
  if (fail) {
    process.stdout.write(`${JSON.stringify({
      type: "result",
      subtype: "success",
      session_id: "ce4b9e26-2574-4433-a054-1110cd403792",
      permission_denials: [{ tool_name: "Edit" }],
    })}\n`);
    return;
  }
  await appendLinkedResponse("Created a resumable provider session.");
  process.stdout.write(`${JSON.stringify({
    type: "result",
    subtype: "success",
    session_id: "ce4b9e26-2574-4433-a054-1110cd403792",
  })}\n`);
}

async function emitProviderActivity() {
  const adapter = process.env.EXOGRAPH_FIXTURE_ADAPTER ?? "generic";
  if (adapter === "claude-code") {
    writeJsonLines([
      { type: "system", subtype: "init" },
      { type: "assistant", message: { content: [{ type: "tool_use", name: "Read", input: { file_path: path.join(noteRoot, "second.md") } }] } },
      { type: "assistant", message: { content: [{ type: "text", text: "private assistant prose" }] } },
      { type: "assistant", message: { content: [{ type: "tool_use", name: "Edit", input: { file_path: taggedNote } }] } },
      { type: "result", subtype: "success", session_id: "ce4b9e26-2574-4433-a054-1110cd403792" },
    ]);
    return;
  }
  if (adapter === "codex-cli") {
    writeJsonLines([
      { type: "thread.started", thread_id: "fixture-thread" },
      { type: "item.completed", item: { type: "reasoning", text: "private reasoning" } },
      { type: "item.started", item: { type: "command_execution", command: "secret command" } },
      { type: "item.completed", item: { type: "file_change", changes: [{ path: taggedNote, kind: "update" }] } },
      { type: "turn.completed" },
    ]);
    return;
  }
  writeJsonLines([
    { type: "assistant", message: { content: [{ type: "tool_use", name: "Read", input: { file_path: taggedNote } }] } },
    { type: "item.started", item: { type: "command_execution", command: "must remain opaque" } },
  ]);
}

function writeJsonLines(events) {
  process.stdout.write(`${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
}

function invocationIdentity(source) {
  const opening = source.match(/<exograph-invocation\b([^>]*)>/i)?.[1] ?? "";
  const id = opening.match(/\bid="([^"]+)"/i)?.[1];
  const agent = opening.match(/\bagent="([^"]+)"/i)?.[1];
  if (!id || !agent) {
    throw new Error("Invocation fixture did not receive an Exograph invocation envelope.");
  }
  return { id, agent };
}

async function readStdin() {
  let value = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) value += chunk;
  return value;
}

async function waitForever() {
  await new Promise(() => {
    setInterval(() => undefined, 60_000);
  });
}
