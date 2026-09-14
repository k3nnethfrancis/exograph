import { EventEmitter } from "node:events";
import { writeFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { AgentCommandTrustStore, agentCommandExecutableFingerprint, agentCommandSnapshot, createDefaultClaudeAgentCommand, formatDocumentAgentInvocation, formatDocumentAgentResponse, InvocationContinuityStore, InvocationStore, removeDocumentAgentInvocation, type WorkspaceSettings } from "@exograph/core";

import type { TerminalManager } from "../terminal/terminal-manager";
import { commandForClaudeResume, commandForHeadlessInvocation, extractClaudeSessionId, InvocationRunner, InvocationRunnerError } from "./invocation-runner";
import { DirectInvocationProcessFactory, type InvocationProcess, type InvocationProcessExit, type InvocationProcessFactory } from "./invocation-process";
import type { WorkspaceWatcherService } from "../workspace/workspace-watchers";

const temporaryRoots: string[] = [];
const TEST_PROTOCOL_INVOCATION_ID = "11111111-1111-4111-8111-111111111111";

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("InvocationRunner readiness parity", () => {
  it("rejects an absent @claude command instead of launching an implicit default", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "exograph-invocation-runner-"));
    temporaryRoots.push(root);
    const runner = createRunner({ ...settings(root, createDefaultClaudeAgentCommand()), agentCommands: [] });

    await expect(runner.prepare({ context: "cli", handle: "claude", message: "test" })).rejects.toMatchObject({
      code: "not-found",
    } satisfies Partial<InvocationRunnerError>);
  });

  it("keeps a disabled @claude command disabled", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "exograph-invocation-runner-"));
    temporaryRoots.push(root);
    const disabledClaude = { ...createDefaultClaudeAgentCommand(), enabled: false };
    const runner = createRunner(settings(root, disabledClaude));

    await expect(runner.prepare({ context: "cli", handle: "claude", message: "test" })).rejects.toMatchObject({
      code: "disabled",
    } satisfies Partial<InvocationRunnerError>);
  });

  it("keeps historical snapshots readable after removal and rejects the removed handle for new work", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "exograph-invocation-removed-command-"));
    temporaryRoots.push(root);
    const notePath = path.join(root, "history.md");
    await writeFile(notePath, "# History\n", "utf8");
    const command = {
      ...createDefaultClaudeAgentCommand(),
      id: "custom",
      label: "Local",
      handle: "local",
      command: "/bin/echo",
      adapter: "generic" as const,
      continuityPolicy: "fresh" as const,
    };
    let activeSettings = settings(root, command);
    const runner = new InvocationRunner({
      getWorkspaceSettings: () => activeSettings,
      trustStateRoot: root,
      terminalManager: new FakeTerminalManager() as unknown as TerminalManager,
      workspaceWatcherService: { subscribe: () => () => undefined } as unknown as WorkspaceWatcherService,
    });
    await new InvocationStore(root).writeRecord({
      id: "historical-local",
      workspaceRoot: root,
      noteRoots: [root],
      status: "failed",
      context: "note",
      taggedDocumentPath: notePath,
      originalMentionText: "@local",
      mentionProvenance: "human-authored",
      message: "Historical request",
      promptDelivery: "stdin",
      command: agentCommandSnapshot(command),
      cwd: root,
      createdAt: "2026-07-26T00:00:00.000Z",
      endedAt: "2026-07-26T00:00:01.000Z",
      failureReason: "Fixture failure.",
      continuity: { policy: "fresh", outcome: "fresh" },
    });

    activeSettings = { ...activeSettings, agentCommands: [] };

    await expect(runner.listHistoryForNote(notePath)).resolves.toEqual([
      expect.objectContaining({
        invocationId: "historical-local",
        command: { handle: "local", label: "Local" },
        outcome: "failed",
      }),
    ]);
    await expect(runner.prepare({ context: "cli", handle: "local", message: "new work" })).rejects.toMatchObject({
      code: "not-found",
      message: "No AgentCommand is configured for @local.",
    });
  });

  it("uses the same facts and cwd as prepare", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "exograph-invocation-runner-"));
    temporaryRoots.push(root);
    const command = { ...createDefaultClaudeAgentCommand(), id: "echo", handle: "echo", label: "Echo", command: "/bin/echo", adapter: "generic" as const, continuityPolicy: "fresh" as const };
    const runner = createRunner(settings(root, command));

    const facts = await runner.getCommandLaunchFacts(command.id);
    const prepared = await runner.prepare({ context: "cli", handle: command.handle, message: "test" });

    expect(facts.launchable).toBe(true);
    expect(prepared.cwd).toBe(facts.cwd);
    expect(prepared.command.id).toBe(facts.commandId);
  });

  it("blocks prepare when the readiness facts block launch", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "exograph-invocation-runner-"));
    temporaryRoots.push(root);
    const command = { ...createDefaultClaudeAgentCommand(), id: "missing", handle: "missing", command: "definitely-not-an-executable", adapter: "generic" as const, continuityPolicy: "fresh" as const };
    const runner = createRunner(settings(root, command));

    await expect(runner.getCommandLaunchFacts(command.id)).resolves.toMatchObject({
      launchable: false,
      block: "executable-missing",
    });
    await expect(runner.prepare({ context: "cli", handle: command.handle, message: "test" })).rejects.toMatchObject({
      code: "executable-missing",
    } satisfies Partial<InvocationRunnerError>);
  });

  it("rejects fingerprint drift before creating a terminal", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "exograph-invocation-runner-"));
    temporaryRoots.push(root);
    const command = { ...createDefaultClaudeAgentCommand(), id: "echo", handle: "echo", label: "Echo", command: "/bin/echo", adapter: "generic" as const, continuityPolicy: "fresh" as const };
    const terminalManager = new FakeTerminalManager();
    const runner = createRunner(settings(root, command), terminalManager);

    await expect(runner.testCommand(command.id, "stale-fingerprint")).rejects.toMatchObject({ code: "fingerprint-drift" });
    expect(terminalManager.created).toBe(0);
  });

  it("creates a normal visible CLI invocation record after confirmed one-shot authorization", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "exograph-invocation-runner-"));
    temporaryRoots.push(root);
    const command = { ...createDefaultClaudeAgentCommand(), id: "echo", handle: "echo", label: "Echo", command: "/bin/echo", adapter: "generic" as const, continuityPolicy: "fresh" as const };
    const terminalManager = new FakeTerminalManager();
    const runner = createRunner(settings(root, command), terminalManager);
    const facts = await runner.getCommandLaunchFacts(command.id);

    const result = await runner.testCommand(command.id, facts.fingerprint);

    expect(terminalManager.created).toBe(1);
    expect(result.terminal).toMatchObject({ id: "terminal-1", status: "running" });
    expect(result.invocation).toMatchObject({
      status: "running",
      context: "cli",
      message: "Test @echo in terminal",
      terminalSessionId: "terminal-1",
      command: { id: command.id },
    });
  });

  it("captures immutable A terminal context before a later active settings change", async () => {
    const rootA = await mkdtemp(path.join(os.tmpdir(), "exograph-invocation-a-"));
    const rootB = await mkdtemp(path.join(os.tmpdir(), "exograph-invocation-b-"));
    temporaryRoots.push(rootA, rootB);
    const command = { ...createDefaultClaudeAgentCommand(), id: "echo", handle: "echo", label: "Echo", command: "/bin/echo", adapter: "generic" as const, continuityPolicy: "fresh" as const };
    let activeSettings = settings(rootA, command);
    const watcher = { subscribe: () => () => undefined };
    const runner = new InvocationRunner({
      getWorkspaceSettings: () => activeSettings,
      trustStateRoot: rootA,
      terminalManager: new FakeTerminalManager() as unknown as TerminalManager,
      workspaceWatcherService: watcher as unknown as WorkspaceWatcherService,
      settlementQuietMs: 0,
      settlementMaxWaitMs: 0,
    });
    const prepared = await runner.prepare({ context: "cli", handle: command.handle, message: "test" });
    activeSettings = settings(rootB, command);
    expect(prepared.terminalWorkspace).toMatchObject({
      workspaceRoot: rootA,
      runtimeRoot: path.join(rootA, ".exograph"),
    });
    expect(runner.workspaceRootForInvocation(prepared.id)).toBe(rootA);
    await expect(runner.authorizeAndStart(prepared, {
      decision: { kind: "trusted" },
      expectedFingerprint: prepared.pending.command.executableFingerprint,
    })).rejects.toMatchObject({ code: "fingerprint-drift" });
  });

  it("derives note authorization facts and trust from the exact main-process context", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "exograph-invocation-authorization-"));
    temporaryRoots.push(root);
    const noteDirectory = path.join(root, "notes");
    const notePath = path.join(noteDirectory, "note.md");
    await mkdir(noteDirectory);
    await writeFile(notePath, "# Note\n", "utf8");
    const command = {
      ...createDefaultClaudeAgentCommand(),
      command: process.execPath,
      cwdPolicy: "note_dir" as const,
    };
    const runner = createRunner(settings(root, command));

    const authorization = await runner.getInvocationAuthorization(command.handle, notePath);
    expect(authorization).toMatchObject({
      command,
      cwd: noteDirectory,
      launchable: true,
      trusted: false,
    });
    expect(authorization.fingerprint).not.toBe(agentCommandExecutableFingerprint(command));
    await new AgentCommandTrustStore(root, root).trust(command, undefined, authorization.fingerprint);
    await expect(runner.getInvocationAuthorization(command.handle, notePath)).resolves.toMatchObject({ trusted: true });
  });

  it("runs once without persisting Command trust", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "exograph-invocation-run-once-"));
    temporaryRoots.push(root);
    const notePath = path.join(root, "note.md");
    const command = { ...createDefaultClaudeAgentCommand(), command: process.execPath, continuityPolicy: "fresh" as const };
    const documentBody = protocolNoteBody("# Note\n", command.handle, "Review this.");
    await writeFile(notePath, documentBody, "utf8");
    const processFactory = new FakeInvocationProcessFactory();
    const runner = createRunner(settings(root, command), new FakeTerminalManager(), processFactory);
    const prepared = await runner.prepare(invocationRequest(notePath, documentBody));

    await runner.authorizeAndStart(prepared, authorizationFor(prepared, "run-once"));

    expect(processFactory.processes).toHaveLength(1);
    await expect(new AgentCommandTrustStore(root, root).status(command)).resolves.toMatchObject({ trusted: false });
  });

  it("durably records process ownership before releasing the pre-exec gate", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "exograph-invocation-launch-gate-"));
    temporaryRoots.push(root);
    const notePath = path.join(root, "note.md");
    const command = { ...createDefaultClaudeAgentCommand(), command: process.execPath, continuityPolicy: "fresh" as const };
    const documentBody = protocolNoteBody("# Gate\n", command.handle, "Do not race persistence.");
    await writeFile(notePath, documentBody, "utf8");
    const processFactory = new FakeInvocationProcessFactory();
    const runner = createRunner(settings(root, command), new FakeTerminalManager(), processFactory);
    const prepared = await runner.prepare(invocationRequest(notePath, documentBody));
    processFactory.onRelease = async (invocationProcess) => {
      const durable = await new InvocationStore(root).readProcessOwnership(prepared.id);
      expect(durable).toEqual(invocationProcess.ownership);
    };

    await runner.authorizeAndStart(prepared, authorizationFor(prepared));

    expect(processFactory.process.releaseCalls).toBe(1);
    expect(processFactory.process.prompts).toHaveLength(1);
  });

  it("revalidates tagged bytes after whole-root capture and preserves a concurrent edit without executing", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "exograph-invocation-pre-exec-drift-"));
    temporaryRoots.push(root);
    const notePath = path.join(root, "note.md");
    const command = { ...createDefaultClaudeAgentCommand(), command: process.execPath, continuityPolicy: "fresh" as const };
    const documentBody = protocolNoteBody("# Gate\n", command.handle, "Do not overwrite this edit.");
    await writeFile(notePath, documentBody, "utf8");
    const processFactory = new FakeInvocationProcessFactory();
    const concurrentEdit = "# Human edit during capture\n";
    processFactory.onLaunch = () => writeFileSync(notePath, concurrentEdit, "utf8");
    const runner = createRunner(settings(root, command), new FakeTerminalManager(), processFactory);
    const prepared = await runner.prepare(invocationRequest(notePath, documentBody));

    await expect(runner.authorizeAndStart(prepared, authorizationFor(prepared))).rejects.toMatchObject({
      code: "document-drift",
    });

    expect(processFactory.process.releaseCalls).toBe(0);
    expect(processFactory.process.prompts).toHaveLength(0);
    expect(processFactory.process.stopCalls).toBe(1);
    await expect(readFile(notePath, "utf8")).resolves.toBe(concurrentEdit);
    await expect(new InvocationStore(root).readProcessOwnership(prepared.id)).resolves.toBeNull();
    const failed = await runner.get(prepared.id);
    expect(failed).toMatchObject({
      status: "failed",
      failureReason: expect.stringContaining("Command was not run"),
    });
    expect(failed?.changeset).toBeUndefined();

    await runner.recoverWorkspace(settings(root, command));
    await expect(readFile(notePath, "utf8")).resolves.toBe(concurrentEdit);
  });

  it("coalesces structured provider activity into bounded renderer events", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "exograph-invocation-activity-"));
    temporaryRoots.push(root);
    const notePath = path.join(root, "note.md");
    const command = { ...createDefaultClaudeAgentCommand(), command: process.execPath, continuityPolicy: "fresh" as const };
    const documentBody = protocolNoteBody("# Note\n", command.handle, "Review this.");
    await writeFile(notePath, documentBody, "utf8");
    const processFactory = new FakeInvocationProcessFactory();
    const runner = createRunner(settings(root, command), new FakeTerminalManager(), processFactory);
    const events: import("@exograph/core").InvocationActivityEvent[] = [];
    runner.on("activity", (event) => events.push(event));

    const result = await startPrepared(runner, invocationRequest(notePath, documentBody));
    processFactory.process.output("stdout", `${JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "Read", input: { file_path: "/private/wiki/essay.md" } }] },
    })}\n`);
    processFactory.process.output("stdout", `${JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "Edit", input: { file_path: "/private/wiki/essay.md" } }] },
    })}\n`);
    await new Promise((resolve) => setTimeout(resolve, 230));

    expect(events).toEqual([
      expect.objectContaining({ invocationId: result.invocation.id, kind: "working" }),
      expect.objectContaining({ invocationId: result.invocation.id, kind: "editing", label: "essay.md" }),
    ]);
    expect(JSON.stringify(events)).not.toContain("/private/wiki");
  });

  it("persists trust only for the exact always-allowed Command fingerprint", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "exograph-invocation-always-allow-"));
    temporaryRoots.push(root);
    const notePath = path.join(root, "note.md");
    const command = { ...createDefaultClaudeAgentCommand(), command: process.execPath, continuityPolicy: "fresh" as const };
    const documentBody = protocolNoteBody("# Note\n", command.handle, "Review this.");
    await writeFile(notePath, documentBody, "utf8");
    const runner = createRunner(settings(root, command));
    const prepared = await runner.prepare(invocationRequest(notePath, documentBody));

    await runner.authorizeAndStart(prepared, authorizationFor(prepared, "always-allow"));

    const store = new AgentCommandTrustStore(root, root);
    await expect(store.status(command, prepared.pending.command.executableFingerprint)).resolves.toMatchObject({
      trusted: true,
      executableFingerprint: prepared.pending.command.executableFingerprint,
    });
    expect(prepared.pending.command.executableFingerprint).not.toBe(agentCommandExecutableFingerprint(command));
    await expect(store.status({ ...command, command: "/bin/echo" })).resolves.toMatchObject({ trusted: false });
    await expect(runner.resetCommandTrust(command.handle)).resolves.toEqual({ revoked: true });
    await expect(store.status(command)).resolves.toMatchObject({ trusted: false });
  });

  it.each(["run-once", "always-allow"] as const)(
    "rejects %s after Command drift without launching or persisting trust",
    async (kind) => {
      const root = await mkdtemp(path.join(os.tmpdir(), "exograph-invocation-fingerprint-drift-"));
      temporaryRoots.push(root);
      const notePath = path.join(root, "note.md");
      const command = { ...createDefaultClaudeAgentCommand(), command: process.execPath, continuityPolicy: "fresh" as const };
      const documentBody = protocolNoteBody("# Note\n", command.handle, "Review this.");
      await writeFile(notePath, documentBody, "utf8");
      let currentSettings = settings(root, command);
      const processFactory = new FakeInvocationProcessFactory();
      const runner = new InvocationRunner({
        getWorkspaceSettings: () => currentSettings,
        trustStateRoot: root,
        terminalManager: new FakeTerminalManager() as unknown as TerminalManager,
        invocationProcessFactory: processFactory,
        workspaceWatcherService: { subscribe: () => () => undefined } as unknown as WorkspaceWatcherService,
      });
      const prepared = await runner.prepare(invocationRequest(notePath, documentBody));
      const changed = { ...command, command: "/bin/echo" };
      currentSettings = { ...currentSettings, agentCommands: [changed] };

      await expect(runner.authorizeAndStart(prepared, authorizationFor(prepared, kind))).rejects.toMatchObject({
        code: "fingerprint-drift",
      });
      expect(processFactory.processes).toHaveLength(0);
      const store = new AgentCommandTrustStore(root, root);
      await expect(store.status(command)).resolves.toMatchObject({ trusted: false });
      await expect(store.status(changed)).resolves.toMatchObject({ trusted: false });
    },
  );

  it("rejects an in-place executable replacement before launch", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "exograph-invocation-executable-drift-"));
    temporaryRoots.push(root);
    const notePath = path.join(root, "note.md");
    const executable = path.join(root, "agent");
    await writeFile(executable, "#!/bin/sh\nexit 0\n", "utf8");
    await chmod(executable, 0o755);
    const command = {
      ...createDefaultClaudeAgentCommand(),
      command: executable,
      adapter: "generic" as const,
      continuityPolicy: "fresh" as const,
    };
    const documentBody = protocolNoteBody("# Note\n", command.handle, "Review this.");
    await writeFile(notePath, documentBody, "utf8");
    const processFactory = new FakeInvocationProcessFactory();
    const runner = createRunner(settings(root, command), new FakeTerminalManager(), processFactory);
    const prepared = await runner.prepare(invocationRequest(notePath, documentBody));

    await writeFile(executable, "#!/bin/sh\nprintf replaced\n", "utf8");
    await expect(runner.authorizeAndStart(prepared, authorizationFor(prepared))).rejects.toMatchObject({
      code: "fingerprint-drift",
    });
    expect(processFactory.processes).toHaveLength(0);
  });

  it("runs inline invocations headlessly and delivers the current note body and frontmatter once", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "exograph-invocation-runner-"));
    temporaryRoots.push(root);
    const command = { ...createDefaultClaudeAgentCommand(), id: "echo", handle: "echo", label: "Echo", command: "/bin/echo", adapter: "generic" as const, continuityPolicy: "fresh" as const };
    const terminalManager = new FakeTerminalManager();
    const processFactory = new FakeInvocationProcessFactory();
    const runner = createRunner(settings(root, command), terminalManager, processFactory);
    const documentBody = protocolNoteBody("# Current note\n\nThis is the current editor content.", command.handle, "Summarize this note.");
    await writeFile(
      path.join(root, "note.md"),
      `---\ntags:\n  - project\n---\n${documentBody}`,
      "utf8",
    );
    const prepared = await runner.prepare({
      context: "note",
      handle: command.handle,
      documentPath: path.join(root, "note.md"),
      mentionText: "@echo",
      message: "Summarize this note.",
      protocolInvocationId: TEST_PROTOCOL_INVOCATION_ID,
      documentFrontmatter: { tags: ["project"] },
      documentBody,
    });

    const result = await runner.authorizeAndStart(prepared, authorizationFor(prepared));

    expect(result.terminal).toBeUndefined();
    expect(terminalManager.created).toBe(0);
    expect(processFactory.process.prompts).toHaveLength(1);
    expect(processFactory.process.prompts[0]).toContain("This is the current editor content.");
    expect(processFactory.process.prompts[0]).toContain('"project"');
    expect(processFactory.process.prompts[0]).toContain("Exograph document-agent protocol:");
    expect(processFactory.process.prompts[0]).toContain(`<exograph-agent-response invocation="${TEST_PROTOCOL_INVOCATION_ID}" agent="echo">`);
  });

  it("pins record settlement to the Workspace where the invocation was prepared", async () => {
    const workspaceA = await mkdtemp(path.join(os.tmpdir(), "exograph-invocation-workspace-a-"));
    const workspaceB = await mkdtemp(path.join(os.tmpdir(), "exograph-invocation-workspace-b-"));
    temporaryRoots.push(workspaceA, workspaceB);
    const notePath = path.join(workspaceA, "note.md");
    const documentBody = protocolNoteBody("# Workspace A\n", "echo", "Update this note.");
    await writeFile(notePath, documentBody, "utf8");
    const command = { ...createDefaultClaudeAgentCommand(), id: "echo", handle: "echo", label: "Echo", command: "/bin/echo", adapter: "generic" as const, continuityPolicy: "fresh" as const };
    let activeSettings = settings(workspaceA, command);
    const processFactory = new FakeInvocationProcessFactory();
    const runner = new InvocationRunner({
      getWorkspaceSettings: () => activeSettings,
      trustStateRoot: workspaceA,
      terminalManager: new FakeTerminalManager() as unknown as TerminalManager,
      invocationProcessFactory: processFactory,
      workspaceWatcherService: { subscribe: () => () => undefined } as unknown as WorkspaceWatcherService,
    });
    const prepared = await runner.prepare({
      context: "note",
      handle: command.handle,
      documentPath: notePath,
      mentionText: "@echo",
      message: "Update this note.",
      protocolInvocationId: TEST_PROTOCOL_INVOCATION_ID,
      documentBody,
    });
    const updated = new Promise<import("@exograph/core").InvocationRecord>((resolve) => {
      const onUpdated = (record: import("@exograph/core").InvocationRecord) => {
        if (record.status === "process-exited" && record.changeset) {
          runner.off("updated", onUpdated);
          resolve(record);
        }
      };
      runner.on("updated", onUpdated);
    });

    await runner.authorizeAndStart(prepared, authorizationFor(prepared));
    activeSettings = settings(workspaceB, command);
    await writeFile(notePath, withProtocolResponse(
      documentBody.replace("# Workspace A", "# Changed in Workspace A"),
      command.handle,
      "Changed in Workspace A.",
    ), "utf8");
    processFactory.process.exit(0, "done");

    const completed = await updated;
    expect(completed).toMatchObject({ status: "process-exited", workspaceRoot: workspaceA });
    await expect(readFile(path.join(workspaceA, ".exograph", "invocations", prepared.id, "record.json"), "utf8"))
      .resolves.toContain('"status": "process-exited"');
    await expect(readFile(path.join(workspaceB, ".exograph", "invocations", prepared.id, "record.json"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
    const changedNote = completed.changeset!.files.find((change) => change.operation === "modified")!;
    await expect(runner.getInvocationFileReview(prepared.id, changedNote.id)).resolves.toMatchObject({
      invocation: { workspaceRoot: workspaceA },
      beforeText: removeDocumentAgentInvocation(documentBody, TEST_PROTOCOL_INVOCATION_ID, command.handle),
      afterText: expect.stringContaining("# Changed in Workspace A"),
    });
    await runner.reviewInvocationFile(prepared.id, changedNote.id, "reject");
    await expect(readFile(notePath, "utf8")).resolves.toBe(
      removeDocumentAgentInvocation(documentBody, TEST_PROTOCOL_INVOCATION_ID, command.handle),
    );
  });

  it("continues a Claude conversation from the validated Workspace-local head", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "exograph-invocation-continuity-"));
    temporaryRoots.push(root);
    const notePath = path.join(root, "note.md");
    const command = { ...createDefaultClaudeAgentCommand(), command: process.execPath };
    const documentBody = protocolNoteBody("# Context\n", command.handle, "Remember this.");
    await writeFile(notePath, documentBody, "utf8");
    const processFactory = new FakeInvocationProcessFactory();
    const runner = createRunner(settings(root, command), new FakeTerminalManager(), processFactory);

    const firstUpdated = new Promise<import("@exograph/core").InvocationRecord>((resolve) => runner.once("updated", resolve));
    const firstPrepared = await runner.prepare(invocationRequest(notePath, documentBody));
    await runner.authorizeAndStart(firstPrepared, authorizationFor(firstPrepared));
    processFactory.process.exit(0, JSON.stringify({ session_id: "ce4b9e26-2574-4433-a054-1110cd403792" }));
    const first = await firstUpdated;
    expect(first.continuity).toEqual({ policy: "continuous", outcome: "fresh" });

    const secondUpdated = new Promise<import("@exograph/core").InvocationRecord>((resolve) => runner.once("updated", resolve));
    const secondPrepared = await runner.prepare(invocationRequest(notePath, documentBody));
    await runner.authorizeAndStart(secondPrepared, authorizationFor(secondPrepared));
    expect(processFactory.inputs.at(-1)?.command).toContain("--resume 'ce4b9e26-2574-4433-a054-1110cd403792'");
    processFactory.process.exit(0, JSON.stringify({ session_id: "ce4b9e26-2574-4433-a054-1110cd403792" }));
    await expect(secondUpdated).resolves.toMatchObject({
      continuity: { policy: "continuous", outcome: "resumed", resumedFromInvocationId: first.id },
    });
  });

  it("falls back fresh once only for the proven pre-turn stale Claude signature", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "exograph-invocation-stale-"));
    temporaryRoots.push(root);
    const notePath = path.join(root, "note.md");
    const command = { ...createDefaultClaudeAgentCommand(), command: process.execPath };
    const documentBody = protocolNoteBody("# Context\n", command.handle, "Continue this.");
    await writeFile(notePath, documentBody, "utf8");
    const staleId = "ce4b9e26-2574-4433-a054-1110cd403792";
    const freshId = "de4b9e26-2574-4433-a054-1110cd403793";
    const continuityStore = new InvocationContinuityStore(root);
    await continuityStore.writeHead({
      workspaceRoot: root,
      commandId: command.id,
      commandFingerprint: agentCommandExecutableFingerprint(command),
      adapter: "claude-code",
      cwd: root,
    }, { providerSessionId: staleId, sourceInvocationId: "prior-invocation" });
    const processFactory = new FakeInvocationProcessFactory();
    const runner = createRunner(settings(root, command), new FakeTerminalManager(), processFactory);
    const activity: import("@exograph/core").InvocationActivityEvent[] = [];
    runner.on("activity", (event) => activity.push(event));
    const updated = new Promise<import("@exograph/core").InvocationRecord>((resolve) => runner.once("updated", resolve));

    const prepared = await runner.prepare(invocationRequest(notePath, documentBody));
    await runner.authorizeAndStart(prepared, authorizationFor(prepared));
    processFactory.process.exit(1, "", `No conversation found with session ID: ${staleId}\n`);
    await expect.poll(() => processFactory.processes.length).toBe(2);
    expect(processFactory.inputs.at(-1)?.command).not.toContain("--resume");
    expect(activity.filter((event) => event.kind === "done" || event.kind === "failed")).toEqual([]);
    expect(activity.at(-1)).toMatchObject({ kind: "working" });
    processFactory.process.exit(0, JSON.stringify({ session_id: freshId }));

    await expect(updated).resolves.toMatchObject({
      providerSessionId: freshId,
      continuity: { policy: "continuous", outcome: "resume-failed-fresh", resumedFromInvocationId: "prior-invocation" },
    });
    expect(activity.filter((event) => event.kind === "done" || event.kind === "failed")).toEqual([
      expect.objectContaining({ kind: "done" }),
    ]);
  });

  it("does not launch a fresh fallback after Stop wins a stale-resume race", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "exograph-invocation-stale-stop-"));
    temporaryRoots.push(root);
    const notePath = path.join(root, "note.md");
    const command = { ...createDefaultClaudeAgentCommand(), command: process.execPath };
    const body = protocolNoteBody("# Context\n", command.handle, "Stop this.");
    await writeFile(notePath, body);
    const staleId = "ce4b9e26-2574-4433-a054-1110cd403792";
    await new InvocationContinuityStore(root).writeHead({
      workspaceRoot: root,
      commandId: command.id,
      commandFingerprint: agentCommandExecutableFingerprint(command),
      adapter: "claude-code",
      cwd: root,
    }, { providerSessionId: staleId, sourceInvocationId: "prior-invocation" });
    const processFactory = new FakeInvocationProcessFactory();
    const runner = createRunner(settings(root, command), new FakeTerminalManager(), processFactory);
    const activity: import("@exograph/core").InvocationActivityEvent[] = [];
    runner.on("activity", (event) => activity.push(event));
    const prepared = await runner.prepare(invocationRequest(notePath, body));
    await runner.authorizeAndStart(prepared, authorizationFor(prepared));

    await runner.endObservation(prepared.id);
    processFactory.process.exit(1, "", `No conversation found with session ID: ${staleId}\n`);
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(processFactory.processes).toHaveLength(1);
    await expect(runner.get(prepared.id)).resolves.toMatchObject({ status: "user-ended" });
    expect(activity.filter((event) => event.kind === "done" || event.kind === "stopped" || event.kind === "failed")).toEqual([
      expect.objectContaining({ kind: "stopped" }),
    ]);
  });

  it("retains the Note Root lock when fallback prompt delivery and Stop both fail", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "exograph-invocation-fallback-stop-failure-"));
    temporaryRoots.push(root);
    const notePath = path.join(root, "note.md");
    const command = { ...createDefaultClaudeAgentCommand(), command: process.execPath };
    const body = protocolNoteBody("# Context\n", command.handle, "Continue this.");
    await writeFile(notePath, body);
    const staleId = "ce4b9e26-2574-4433-a054-1110cd403792";
    await new InvocationContinuityStore(root).writeHead({
      workspaceRoot: root,
      commandId: command.id,
      commandFingerprint: agentCommandExecutableFingerprint(command),
      adapter: "claude-code",
      cwd: root,
    }, { providerSessionId: staleId, sourceInvocationId: "prior-invocation" });
    const processFactory = new FakeInvocationProcessFactory();
    const runner = createRunner(settings(root, command), new FakeTerminalManager(), processFactory);
    const prepared = await runner.prepare(invocationRequest(notePath, body));
    const overlapping = await runner.prepare(invocationRequest(notePath, body));
    await runner.authorizeAndStart(prepared, authorizationFor(prepared));
    processFactory.nextSendError = new Error("fallback send failed");
    processFactory.nextStopError = new Error("fallback stop failed");
    const settlementError = new Promise<{ invocationId: string }>((resolve) => runner.once("settlement-error", resolve));

    processFactory.process.exit(1, "", `No conversation found with session ID: ${staleId}\n`);
    await expect(settlementError).resolves.toMatchObject({ invocationId: prepared.id });

    expect(processFactory.processes).toHaveLength(2);
    expect(processFactory.process.stopCalls).toBe(1);
    const orphaned = await runner.get(prepared.id);
    expect(orphaned).toMatchObject({ status: "orphaned" });
    expect(orphaned?.changeset).toBeUndefined();
    await expect(runner.authorizeAndStart(overlapping, authorizationFor(overlapping))).rejects.toMatchObject({ code: "continuity-busy" });
  });

  it("does not retry or advance the head after an unknown resume failure", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "exograph-invocation-resume-failure-"));
    temporaryRoots.push(root);
    const notePath = path.join(root, "note.md");
    const command = { ...createDefaultClaudeAgentCommand(), command: process.execPath };
    const documentBody = protocolNoteBody("# Context\n", command.handle, "Continue this.");
    await writeFile(notePath, documentBody, "utf8");
    const staleId = "ce4b9e26-2574-4433-a054-1110cd403792";
    const lane = {
      workspaceRoot: root,
      commandId: command.id,
      commandFingerprint: agentCommandExecutableFingerprint(command),
      adapter: "claude-code" as const,
      cwd: root,
    };
    const continuityStore = new InvocationContinuityStore(root);
    await continuityStore.writeHead(lane, { providerSessionId: staleId, sourceInvocationId: "prior-invocation" });
    const processFactory = new FakeInvocationProcessFactory();
    const runner = createRunner(settings(root, command), new FakeTerminalManager(), processFactory);
    const updated = new Promise<import("@exograph/core").InvocationRecord>((resolve) => runner.once("updated", resolve));

    const prepared = await runner.prepare(invocationRequest(notePath, documentBody));
    await runner.authorizeAndStart(prepared, authorizationFor(prepared));
    processFactory.process.exit(1, "", "Authentication failed\n");

    await expect(updated).resolves.toMatchObject({
      status: "failed",
      continuity: { policy: "continuous", outcome: "resume-failed", resumedFromInvocationId: "prior-invocation" },
    });
    expect(processFactory.processes).toHaveLength(1);
    await expect(continuityStore.readHead(lane)).resolves.toMatchObject({
      providerSessionId: staleId,
      sourceInvocationId: "prior-invocation",
    });
  });

  it("rejects concurrent work in one continuity lane and releases the lane after exit", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "exograph-invocation-busy-"));
    temporaryRoots.push(root);
    const notePath = path.join(root, "note.md");
    const command = { ...createDefaultClaudeAgentCommand(), command: process.execPath };
    const documentBody = protocolNoteBody("# Context\n", command.handle, "Work.");
    await writeFile(notePath, documentBody, "utf8");
    const processFactory = new FakeInvocationProcessFactory();
    const runner = createRunner(settings(root, command), new FakeTerminalManager(), processFactory);
    const first = await runner.prepare(invocationRequest(notePath, documentBody));
    await runner.authorizeAndStart(first, authorizationFor(first));

    const second = await runner.prepare(invocationRequest(notePath, documentBody));
    await expect(runner.authorizeAndStart(second, authorizationFor(second))).rejects.toMatchObject({ code: "continuity-busy" });
    const updated = new Promise<import("@exograph/core").InvocationRecord>((resolve) => runner.once("updated", resolve));
    processFactory.process.exit(0, JSON.stringify({ session_id: "ce4b9e26-2574-4433-a054-1110cd403792" }));
    await updated;

    const third = await runner.prepare(invocationRequest(notePath, documentBody));
    await expect(runner.authorizeAndStart(third, authorizationFor(third))).resolves.toMatchObject({ ok: true });
  });

  it("reports and resets only the current Workspace Command context", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "exograph-invocation-reset-"));
    temporaryRoots.push(root);
    const command = { ...createDefaultClaudeAgentCommand(), command: process.execPath };
    const lane = {
      workspaceRoot: root,
      commandId: command.id,
      commandFingerprint: agentCommandExecutableFingerprint(command),
      adapter: "claude-code" as const,
      cwd: root,
    };
    await new InvocationContinuityStore(root).writeHead(lane, {
      providerSessionId: "ce4b9e26-2574-4433-a054-1110cd403792",
      sourceInvocationId: "prior-invocation",
    });
    const runner = createRunner(settings(root, command));

    await expect(runner.getCommandContinuityStatus(command.id)).resolves.toMatchObject({
      commandId: command.id,
      supported: true,
      policy: "continuous",
      hasHead: true,
      active: false,
    });
    await expect(runner.resetCommandContinuity(command.id)).resolves.toEqual({ cleared: 1 });
    await expect(runner.getCommandContinuityStatus(command.id)).resolves.toMatchObject({ hasHead: false });
  });

  it("refuses to baseline an editor snapshot that is not the saved document", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "exograph-invocation-runner-"));
    temporaryRoots.push(root);
    const notePath = path.join(root, "note.md");
    await writeFile(notePath, "# Saved\n", "utf8");
    const command = { ...createDefaultClaudeAgentCommand(), id: "echo", handle: "echo", label: "Echo", command: "/bin/echo", adapter: "generic" as const, continuityPolicy: "fresh" as const };
    const runner = createRunner(settings(root, command));

    await expect(runner.prepare({
      context: "note",
      handle: "echo",
      documentPath: notePath,
      mentionText: "@echo",
      message: "Update this.",
      documentBody: "# Stale editor body\n",
    })).rejects.toMatchObject({ code: "document-drift" });
  });

  it("executes a configured note command through stdin without creating a terminal", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "exograph-invocation-runner-"));
    temporaryRoots.push(root);
    const notePath = path.join(root, "note.md");
    const promptPath = path.join(root, "received-prompt.txt");
    const documentBody = protocolNoteBody("# Before\n", "fake-headless", "Replace the title.");
    await writeFile(notePath, documentBody, "utf8");
    const afterBody = withProtocolResponse(documentBody.replace("# Before", "# After"), "fake-headless", "Updated the title.");
    const scriptPath = path.join(root, "write-response.mjs");
    await writeFile(scriptPath, `
import { readFileSync, writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(promptPath)}, readFileSync(0, "utf8"));
writeFileSync(${JSON.stringify(notePath)}, ${JSON.stringify(afterBody)});
`, "utf8");
    const command = {
      ...createDefaultClaudeAgentCommand(), id: "fake-headless", handle: "fake-headless", label: "Fake headless",
      adapter: "generic" as const, continuityPolicy: "fresh" as const,
      command: `${shellQuote(process.execPath)} ${shellQuote(scriptPath)}`,
    };
    const terminalManager = new FakeTerminalManager();
    const runner = createRunner(settings(root, command), terminalManager, new DirectInvocationProcessFactory());
    const updated = new Promise<unknown>((resolve) => runner.once("updated", resolve));

    const result = await startPrepared(runner, {
      context: "note", handle: command.handle, documentPath: notePath, mentionText: "@fake-headless",
      message: "Replace the title.", protocolInvocationId: TEST_PROTOCOL_INVOCATION_ID, documentBody,
    });

    expect(result.terminal).toBeUndefined();
    expect(terminalManager.created).toBe(0);
    const completed = await updated as import("@exograph/core").InvocationRecord;
    expect(completed).toMatchObject({ status: "process-exited" });
    expect(completed.changeset?.files).toEqual(expect.arrayContaining([
      expect.objectContaining({ operation: "modified", after: expect.objectContaining({ path: expect.stringMatching(/note\.md$/) }) }),
      expect.objectContaining({ operation: "created", after: expect.objectContaining({ path: expect.stringMatching(/received-prompt\.txt$/) }) }),
    ]));
    await expect(readFile(promptPath, "utf8")).resolves.toContain("Replace the title.");
  });

  it("records a failed headless command instead of implying it completed without changes", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "exograph-invocation-runner-"));
    temporaryRoots.push(root);
    const notePath = path.join(root, "note.md");
    const documentBody = protocolNoteBody("# Before\n", "fails", "Test failure.");
    await writeFile(notePath, documentBody, "utf8");
    const command = {
      ...createDefaultClaudeAgentCommand(), id: "fails", handle: "fails", label: "Fails",
      adapter: "generic" as const, continuityPolicy: "fresh" as const,
      command: "/bin/sh -c 'exit 17'",
    };
    const terminalManager = new FakeTerminalManager();
    const runner = createRunner(settings(root, command), terminalManager, new DirectInvocationProcessFactory());
    const activity: import("@exograph/core").InvocationActivityEvent[] = [];
    runner.on("activity", (event) => activity.push(event));
    const updated = new Promise<import("@exograph/core").InvocationRecord>((resolve) => runner.once("updated", resolve));

    await startPrepared(runner, {
      context: "note", handle: command.handle, documentPath: notePath, mentionText: "@fails",
      message: "Test failure.", protocolInvocationId: TEST_PROTOCOL_INVOCATION_ID, documentBody,
    });

    const failed = await updated;
    expect(failed).toMatchObject({
      status: "failed",
      exitCode: 17,
      failureReason: "Command exited with code 17.",
    });
    expect(activity.filter((event) => event.kind === "done" || event.kind === "failed")).toEqual([
      expect.objectContaining({ kind: "failed" }),
    ]);
    await expect(runner.listHistoryForNote(notePath)).resolves.toEqual([
      expect.objectContaining({ invocationId: failed.id, outcome: "failed", changedFileCount: 0 }),
    ]);
  });

  it("keeps an exact failed-process changeset reviewable", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "exograph-invocation-failed-review-"));
    temporaryRoots.push(root);
    const notePath = path.join(root, "note.md");
    const createdPath = path.join(root, "partial.md");
    const documentBody = protocolNoteBody("# Before\n", "partial", "Try this.");
    await writeFile(notePath, documentBody);
    const command = {
      ...createDefaultClaudeAgentCommand(), id: "partial", handle: "partial", label: "Partial",
      adapter: "generic" as const, continuityPolicy: "fresh" as const,
      command: `/bin/sh -c 'printf "partial\\n" > "${createdPath}"; exit 17'`,
    };
    const runner = createRunner(settings(root, command), new FakeTerminalManager(), new DirectInvocationProcessFactory());
    const updated = new Promise<import("@exograph/core").InvocationRecord>((resolve) => runner.once("updated", resolve));

    await startPrepared(runner, {
      context: "note", handle: command.handle, documentPath: notePath, mentionText: "@partial",
      message: "Try this.", protocolInvocationId: TEST_PROTOCOL_INVOCATION_ID, documentBody,
    });

    const failed = await updated;
    expect(failed).toMatchObject({
      status: "failed",
      exitCode: 17,
      changeset: { status: "pending-review", files: [expect.objectContaining({ operation: "created" })] },
    });
    await expect(runner.listHistoryForNote(createdPath)).resolves.toEqual([
      expect.objectContaining({ invocationId: failed.id, outcome: "pending", changedFileCount: 1, changeIds: [failed.changeset!.files[0]!.id] }),
    ]);
    await runner.reviewInvocationAll(failed.id, "keep");
    await expect(readFile(createdPath, "utf8")).resolves.toBe("partial\n");
    await expect(runner.listHistoryForNote(createdPath)).resolves.toEqual([
      expect.objectContaining({ invocationId: failed.id, outcome: "kept", changedFileCount: 1 }),
    ]);
  });

  it("captures only a real Claude JSON session id and stores it with the reviewed change", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "exograph-invocation-runner-"));
    temporaryRoots.push(root);
    const notePath = path.join(root, "note.md");
    const documentBody = protocolNoteBody("# Before\n", "claude", "Update this.");
    await writeFile(notePath, documentBody, "utf8");
    const sessionId = "ce4b9e26-2574-4433-a054-1110cd403792";
    const afterBody = withProtocolResponse(documentBody.replace("# Before", "# After"), "claude", "Updated.");
    const scriptPath = path.join(root, "invoke.mjs");
    await writeFile(scriptPath, `
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(notePath)}, ${JSON.stringify(afterBody)});
process.stdout.write(${JSON.stringify(`${JSON.stringify({ session_id: sessionId })}\n`)});
`, "utf8");
    const command = {
      ...createDefaultClaudeAgentCommand(),
      command: `${shellQuote(process.execPath)} ${shellQuote(scriptPath)}`,
    };
    const terminalManager = new FakeTerminalManager();
    const runner = createRunner(settings(root, command), terminalManager, new DirectInvocationProcessFactory());
    const updated = new Promise<import("@exograph/core").InvocationRecord>((resolve) => {
      const onUpdated = (record: import("@exograph/core").InvocationRecord) => {
        if (record.status === "process-exited" && record.changeset) {
          runner.off("updated", onUpdated);
          resolve(record);
        }
      };
      runner.on("updated", onUpdated);
    });
    await startPrepared(runner, {
      context: "note", handle: "claude", documentPath: notePath, mentionText: "@claude", message: "Update this.", protocolInvocationId: TEST_PROTOCOL_INVOCATION_ID, documentBody,
    });
    const completed = await updated;
    expect(completed).toMatchObject({
      providerSessionId: sessionId,
      changeset: { status: "pending-review" },
    });
    const changedNote = completed.changeset!.files.find((change) => change.operation === "modified")!;
    const review = await runner.getInvocationFileReview(completed.id, changedNote.id);
    const cleanBase = removeDocumentAgentInvocation(documentBody, TEST_PROTOCOL_INVOCATION_ID, "claude");
    expect(review).toMatchObject({ canReject: true, beforeText: cleanBase, afterText: afterBody });
    const rejected = await runner.reviewInvocationFile(completed.id, changedNote.id, "reject");
    expect(rejected.changeset).toMatchObject({ status: "rejected" });
    await expect(readFile(notePath, "utf8")).resolves.toBe(cleanBase);
    await expect(runner.listHistoryForNote(notePath)).resolves.toEqual([
      expect.objectContaining({
        invocationId: completed.id,
        protocolInvocationId: TEST_PROTOCOL_INVOCATION_ID,
        outcome: "rejected",
      }),
    ]);
    await runner.resumeInTerminal(completed.id);
    expect(terminalManager.commands).toContainEqual(expect.objectContaining({ command: expect.stringContaining(`--resume '${sessionId}'`) }));
  });

  it("does not guess session provenance from malformed output", () => {
    const sessionId = "ce4b9e26-2574-4433-a054-1110cd403792";
    expect(extractClaudeSessionId('{"session_id":"not-a-session"}')).toBeNull();
    expect(extractClaudeSessionId(`ordinary output\n{"session_id":"${sessionId}"}`)).toBe(sessionId);
    expect(extractClaudeSessionId(JSON.stringify([
      { type: "system", session_id: sessionId },
      { type: "result", session_id: sessionId, permission_denials: [] },
    ]))).toBe(sessionId);
    expect(commandForHeadlessInvocation(createDefaultClaudeAgentCommand()))
      .toBe('claude -p --permission-mode acceptEdits --allowedTools "Read,Edit,Write,Glob,Grep" --output-format stream-json --verbose');
    expect(commandForHeadlessInvocation({ ...createDefaultClaudeAgentCommand(), command: "claude -p --permission-mode bypassPermissions" }))
      .toBe("claude -p --permission-mode bypassPermissions --output-format stream-json --verbose");
  });

  it("reports structured Claude permission denials as failures instead of successful no-change runs", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "exograph-invocation-runner-"));
    temporaryRoots.push(root);
    const notePath = path.join(root, "note.md");
    const documentBody = protocolNoteBody("# Before\n", "claude", "Update this.");
    await writeFile(notePath, documentBody, "utf8");
    const processFactory = new FakeInvocationProcessFactory();
    // This test exercises Claude's structured output semantics, not a locally
    // installed Claude binary. An explicit executable keeps it deterministic
    // on CI and on machines without Claude installed.
    const command = { ...createDefaultClaudeAgentCommand(), command: process.execPath };
    const runner = createRunner(settings(root, command), new FakeTerminalManager(), processFactory);
    const updated = new Promise<import("@exograph/core").InvocationRecord>((resolve) => runner.once("updated", resolve));

    await startPrepared(runner, {
      context: "note", handle: "claude", documentPath: notePath, mentionText: "@claude",
      message: "Update this.", protocolInvocationId: TEST_PROTOCOL_INVOCATION_ID, documentBody,
    });
    processFactory.process.exit(0, JSON.stringify([{ type: "result", subtype: "success", permission_denials: [{ tool_name: "Edit" }] }]));

    await expect(updated).resolves.toMatchObject({
      status: "failed",
      failureReason: "Claude could not edit the document because its write permission was denied.",
    });
  });

  it("fails a protocol invocation when the command prints a response but never writes it into the note", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "exograph-invocation-runner-"));
    temporaryRoots.push(root);
    const notePath = path.join(root, "note.md");
    const documentBody = protocolNoteBody("# Before\n", "claude", "What do you think?");
    await writeFile(notePath, documentBody, "utf8");
    const processFactory = new FakeInvocationProcessFactory();
    const runner = createRunner(settings(root, { ...createDefaultClaudeAgentCommand(), command: process.execPath }), new FakeTerminalManager(), processFactory);
    const updated = new Promise<import("@exograph/core").InvocationRecord>((resolve) => runner.once("updated", resolve));

    await startPrepared(runner, {
      context: "note", handle: "claude", documentPath: notePath, mentionText: "@claude",
      message: "What do you think?", protocolInvocationId: TEST_PROTOCOL_INVOCATION_ID, documentBody,
    });
    processFactory.process.exit(0, `<exograph-agent-response invocation="${TEST_PROTOCOL_INVOCATION_ID}" agent="claude">Chat only</exograph-agent-response>`);

    await expect(updated).resolves.toMatchObject({
      status: "failed",
      failureReason: "@claude finished without writing its linked response into the note.",
      changeset: { files: [] },
    });
  });

  it("does not accept a matching response from another file or a detached response in the invoked note", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "exograph-invocation-runner-"));
    temporaryRoots.push(root);
    const notePath = path.join(root, "note.md");
    const decoyPath = path.join(root, "decoy.md");
    const documentBody = protocolNoteBody("# Before\n", "claude", "What do you think?");
    await writeFile(notePath, documentBody, "utf8");
    await writeFile(decoyPath, formatDocumentAgentResponse({
      invocationId: TEST_PROTOCOL_INVOCATION_ID,
      agent: "claude",
      message: "A decoy response.",
    }), "utf8");
    const processFactory = new FakeInvocationProcessFactory();
    const runner = createRunner(settings(root, { ...createDefaultClaudeAgentCommand(), command: process.execPath }), new FakeTerminalManager(), processFactory);
    const updated = new Promise<import("@exograph/core").InvocationRecord>((resolve) => runner.once("updated", resolve));

    await startPrepared(runner, {
      context: "note", handle: "claude", documentPath: notePath, mentionText: "@claude",
      message: "What do you think?", protocolInvocationId: TEST_PROTOCOL_INVOCATION_ID, documentBody,
    });
    await writeFile(notePath, `${documentBody}\nOrdinary human text.\n${formatDocumentAgentResponse({
      invocationId: TEST_PROTOCOL_INVOCATION_ID,
      agent: "claude",
      message: "Detached response.",
    })}\n`, "utf8");
    processFactory.process.exit(0, "done");

    await expect(updated).resolves.toMatchObject({
      status: "failed",
      failureReason: "@claude finished without writing its linked response into the note.",
    });
  });

  it("serializes overlapping Note Roots until the prior changeset is reviewed, then releases them", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "exograph-invocation-root-lock-"));
    temporaryRoots.push(root);
    const notePath = path.join(root, "note.md");
    const command = { ...createDefaultClaudeAgentCommand(), command: process.execPath, continuityPolicy: "fresh" as const };
    const documentBody = protocolNoteBody("# Before\n", command.handle, "Update this.");
    await writeFile(notePath, documentBody);
    const processFactory = new FakeInvocationProcessFactory();
    const runner = createRunner(settings(root, command), new FakeTerminalManager(), processFactory);
    const first = await runner.prepare(invocationRequest(notePath, documentBody));
    const overlapping = await runner.prepare(invocationRequest(notePath, documentBody));

    await runner.authorizeAndStart(first, authorizationFor(first));
    await expect(runner.authorizeAndStart(overlapping, authorizationFor(overlapping))).rejects.toMatchObject({ code: "review-busy" });

    const cleanBase = removeDocumentAgentInvocation(documentBody, TEST_PROTOCOL_INVOCATION_ID, command.handle)!;
    await writeFile(notePath, withProtocolResponse(documentBody, command.handle, "Updated."));
    const updated = new Promise<import("@exograph/core").InvocationRecord>((resolve) => runner.once("updated", resolve));
    processFactory.process.exit(0, "done");
    const completed = await updated;

    await expect(runner.authorizeAndStart(overlapping, authorizationFor(overlapping))).rejects.toMatchObject({ code: "review-busy" });
    await runner.reviewInvocationAll(completed.id, "keep");

    const nextBody = `${await readFile(notePath, "utf8")}\n${formatDocumentAgentInvocation({
      id: TEST_PROTOCOL_INVOCATION_ID,
      agent: command.handle,
      message: `@${command.handle} Continue.`,
    })}\n`;
    await writeFile(notePath, nextBody);
    const afterReview = await runner.prepare(invocationRequest(notePath, nextBody));
    await expect(runner.authorizeAndStart(afterReview, authorizationFor(afterReview))).resolves.toMatchObject({ ok: true });
    await runner.stopAll();
  });

  it("keeps a conflicted review listed and blocks its Note Root until Keep-current resolves it", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "exograph-invocation-conflict-lock-"));
    temporaryRoots.push(root);
    const notePath = path.join(root, "note.md");
    const command = { ...createDefaultClaudeAgentCommand(), command: process.execPath, continuityPolicy: "fresh" as const };
    const body = protocolNoteBody("# Before\n", command.handle, "Update this.");
    await writeFile(notePath, body);
    const processFactory = new FakeInvocationProcessFactory();
    const runner = createRunner(settings(root, command), new FakeTerminalManager(), processFactory);
    const prepared = await runner.prepare(invocationRequest(notePath, body));
    const overlapping = await runner.prepare(invocationRequest(notePath, body));
    await runner.authorizeAndStart(prepared, authorizationFor(prepared));
    await writeFile(notePath, withProtocolResponse(body, command.handle, "Updated."));
    const updated = new Promise<import("@exograph/core").InvocationRecord>((resolve) => runner.once("updated", resolve));
    processFactory.process.exit(0, "done");
    const completed = await updated;
    const changedNote = completed.changeset!.files.find((change) => change.operation === "modified")!;
    await writeFile(notePath, "newer human work\n");

    const conflicted = await runner.reviewInvocationFile(completed.id, changedNote.id, "reject");
    expect(conflicted.changeset?.status).toBe("conflict");
    await expect(runner.listPendingReviews()).resolves.toEqual([
      expect.objectContaining({ invocationId: completed.id, pendingFileCount: 1 }),
    ]);
    await expect(runner.authorizeAndStart(overlapping, authorizationFor(overlapping))).rejects.toMatchObject({ code: "review-busy" });

    const resolved = await runner.reviewInvocationFile(completed.id, changedNote.id, "keep");
    expect(resolved.changeset?.status).toBe("kept");
    await expect(runner.listPendingReviews()).resolves.toEqual([]);
  });

  it("reports pending review and maps a fully resolved mixed decision to kept history", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "exograph-invocation-history-"));
    temporaryRoots.push(root);
    const notePath = path.join(root, "note.md");
    const createdPath = path.join(root, "created.md");
    const command = { ...createDefaultClaudeAgentCommand(), command: process.execPath, continuityPolicy: "fresh" as const };
    const body = protocolNoteBody("# History\n", command.handle, "Change files.");
    await writeFile(notePath, body);
    const processFactory = new FakeInvocationProcessFactory();
    const runner = createRunner(settings(root, command), new FakeTerminalManager(), processFactory);
    const prepared = await runner.prepare(invocationRequest(notePath, body));
    await runner.authorizeAndStart(prepared, authorizationFor(prepared));
    await writeFile(notePath, withProtocolResponse(body, command.handle, "History response."));
    await writeFile(createdPath, "created\n");
    const updated = new Promise<import("@exograph/core").InvocationRecord>((resolve) => runner.once("updated", resolve));
    processFactory.process.exit(0, "done");
    let completed = await updated;
    await expect(runner.listPendingReviews()).resolves.toEqual([
      expect.objectContaining({
        invocationId: completed.id,
        changedFileCount: 2,
        pendingFileCount: 2,
        pendingChangeIds: completed.changeset!.files.map((change) => change.id),
      }),
    ]);
    await expect(runner.listHistoryForNote(notePath)).resolves.toEqual([
      expect.objectContaining({
        invocationId: completed.id,
        outcome: "pending",
        changedFileCount: 2,
        changeIds: completed.changeset!.files.map((change) => change.id),
      }),
    ]);

    const created = completed.changeset!.files.find((change) => change.operation === "created")!;
    completed = await runner.reviewInvocationFile(completed.id, created.id, "reject");
    expect(completed.changeset?.status).toBe("partially-resolved");
    completed = await runner.reviewInvocationAll(completed.id, "keep");
    expect(completed.changeset?.status).toBe("resolved");
    await expect(runner.listPendingReviews()).resolves.toEqual([]);
    await expect(runner.listHistoryForNote(notePath)).resolves.toEqual([
      expect.objectContaining({ invocationId: completed.id, outcome: "kept", changedFileCount: 2 }),
    ]);
  });

  it("serializes concurrent identical file decisions as one idempotent review", async () => {
    const fixture = await multiFileReviewFixture();
    const created = fixture.completed.changeset!.files.find((change) => change.operation === "created")!;

    const [first, repeated] = await Promise.all([
      fixture.runner.reviewInvocationFile(fixture.completed.id, created.id, "keep"),
      fixture.runner.reviewInvocationFile(fixture.completed.id, created.id, "keep"),
    ]);

    expect(first.changeset?.files.find((change) => change.id === created.id)?.decision.status).toBe("kept");
    expect(repeated.changeset?.files.find((change) => change.id === created.id)?.decision.status).toBe("kept");
    await expect(readFile(fixture.createdPath, "utf8")).resolves.toBe("created\n");
    await expect(new InvocationStore(fixture.root).readReviewJournal(fixture.completed.id)).resolves.toBeNull();
  });

  it("preserves concurrent decisions for different files in one durable record", async () => {
    const fixture = await multiFileReviewFixture();
    const created = fixture.completed.changeset!.files.find((change) => change.operation === "created")!;
    const modified = fixture.completed.changeset!.files.find((change) => change.operation === "modified")!;

    await Promise.all([
      fixture.runner.reviewInvocationFile(fixture.completed.id, created.id, "keep"),
      fixture.runner.reviewInvocationFile(fixture.completed.id, modified.id, "reject"),
    ]);

    const persisted = await fixture.runner.get(fixture.completed.id);
    expect(persisted?.changeset?.status).toBe("resolved");
    expect(persisted?.changeset?.files.find((change) => change.id === created.id)?.decision.status).toBe("kept");
    expect(persisted?.changeset?.files.find((change) => change.id === modified.id)?.decision.status).toBe("rejected");
    await expect(readFile(fixture.createdPath, "utf8")).resolves.toBe("created\n");
    await expect(new InvocationStore(fixture.root).readReviewJournal(fixture.completed.id)).resolves.toBeNull();
  });

  it("rejects a concurrent contradictory file decision without overwriting the winner", async () => {
    const fixture = await multiFileReviewFixture();
    const created = fixture.completed.changeset!.files.find((change) => change.operation === "created")!;

    const [keep, reject] = await Promise.allSettled([
      fixture.runner.reviewInvocationFile(fixture.completed.id, created.id, "keep"),
      fixture.runner.reviewInvocationFile(fixture.completed.id, created.id, "reject"),
    ]);

    expect(keep).toMatchObject({ status: "fulfilled", value: { changeset: { status: "partially-resolved" } } });
    expect(reject).toMatchObject({
      status: "rejected",
      reason: expect.objectContaining({ code: "review-unavailable" }),
    });
    await expect(readFile(fixture.createdPath, "utf8")).resolves.toBe("created\n");
    const persisted = await fixture.runner.get(fixture.completed.id);
    expect(persisted?.changeset?.files.find((change) => change.id === created.id)?.decision.status).toBe("kept");
  });

  it("serializes concurrent contradictory bulk decisions without reversing the first result", async () => {
    const fixture = await multiFileReviewFixture();

    const [keepAll, rejectAll] = await Promise.all([
      fixture.runner.reviewInvocationAll(fixture.completed.id, "keep"),
      fixture.runner.reviewInvocationAll(fixture.completed.id, "reject"),
    ]);

    expect(keepAll.changeset?.status).toBe("kept");
    expect(rejectAll.changeset?.status).toBe("kept");
    expect(rejectAll.changeset?.files.every((change) => change.decision.status === "kept")).toBe(true);
    await expect(readFile(fixture.createdPath, "utf8")).resolves.toBe("created\n");
    await expect(readFile(fixture.notePath, "utf8")).resolves.toContain("Bulk-safe response.");
  });

  it("stops every headless process once and settles active runs before returning", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "exograph-invocation-stop-all-"));
    temporaryRoots.push(root);
    const notePath = path.join(root, "note.md");
    const command = { ...createDefaultClaudeAgentCommand(), command: process.execPath, continuityPolicy: "fresh" as const };
    const body = protocolNoteBody("# Stop\n", command.handle, "Stop this.");
    await writeFile(notePath, body);
    const processFactory = new FakeInvocationProcessFactory();
    const runner = createRunner(settings(root, command), new FakeTerminalManager(), processFactory);
    const prepared = await runner.prepare(invocationRequest(notePath, body));
    await runner.authorizeAndStart(prepared, authorizationFor(prepared));

    await runner.stopAll();

    expect(processFactory.process.stopCalls).toBe(1);
    await expect(runner.get(prepared.id)).resolves.toMatchObject({ status: "user-ended", changeset: { status: "no-change" } });
  });

  it("memoizes concurrent settlement and publishes one durable terminal record", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "exograph-invocation-settlement-memo-"));
    temporaryRoots.push(root);
    const notePath = path.join(root, "note.md");
    const command = { ...createDefaultClaudeAgentCommand(), command: process.execPath, continuityPolicy: "fresh" as const };
    const body = protocolNoteBody("# Memo\n", command.handle, "Stop this.");
    await writeFile(notePath, body);
    const processFactory = new FakeInvocationProcessFactory();
    const runner = createRunner(settings(root, command), new FakeTerminalManager(), processFactory);
    const prepared = await runner.prepare(invocationRequest(notePath, body));
    await runner.authorizeAndStart(prepared, authorizationFor(prepared));
    const updates: import("@exograph/core").InvocationRecord[] = [];
    runner.on("updated", (record) => updates.push(record));

    const [first, second] = await Promise.all([
      runner.endObservation(prepared.id),
      runner.endObservation(prepared.id),
    ]);

    expect(first).toEqual(second);
    expect(first).toMatchObject({ status: "user-ended", changeset: { status: "no-change" } });
    expect(processFactory.process.stopCalls).toBe(1);
    expect(updates).toHaveLength(1);
  });

  it("does not settle or unlock an invocation whose process Stop fails", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "exograph-invocation-stop-failure-"));
    temporaryRoots.push(root);
    const notePath = path.join(root, "note.md");
    const command = { ...createDefaultClaudeAgentCommand(), command: process.execPath, continuityPolicy: "fresh" as const };
    const body = protocolNoteBody("# Unsafe\n", command.handle, "Stop this.");
    await writeFile(notePath, body);
    const processFactory = new FakeInvocationProcessFactory();
    processFactory.nextStopError = new Error("cannot stop group");
    const runner = createRunner(settings(root, command), new FakeTerminalManager(), processFactory);
    const prepared = await runner.prepare(invocationRequest(notePath, body));
    const overlapping = await runner.prepare(invocationRequest(notePath, body));
    await runner.authorizeAndStart(prepared, authorizationFor(prepared));

    await expect(runner.stopAll()).rejects.toThrow("Failed to stop 1 invocation process");

    const stillRunning = await runner.get(prepared.id);
    expect(stillRunning).toMatchObject({ status: "running" });
    expect(stillRunning?.changeset).toBeUndefined();
    await expect(runner.authorizeAndStart(overlapping, authorizationFor(overlapping))).rejects.toMatchObject({ code: "review-busy" });
  });

  it("recovers an orphaned settlement failure with launch artifacts into an exact changeset", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "exograph-invocation-orphan-recovery-"));
    temporaryRoots.push(root);
    const notePath = path.join(root, "note.md");
    const extraPath = path.join(root, "created.md");
    const command = { ...createDefaultClaudeAgentCommand(), command: process.execPath, continuityPolicy: "fresh" as const };
    const body = protocolNoteBody("# Recover\n", command.handle, "Recover this.");
    await writeFile(notePath, body);
    const original = createRunner(settings(root, command));
    const prepared = await original.prepare(invocationRequest(notePath, body));
    await original.authorizeAndStart(prepared, authorizationFor(prepared));
    await writeFile(extraPath, "created while Exograph was gone\n");
    const store = new InvocationStore(root);
    const running = await store.readRecord(prepared.id);
    await store.writeRecord({
      ...running!,
      status: "orphaned",
      endedAt: new Date().toISOString(),
      failureReason: "Invocation settlement failed: simulated capture interruption",
    });

    const recovering = createRunner(settings(root, command));
    await recovering.markOrphanedRunningInvocations();

    await expect(recovering.get(prepared.id)).resolves.toMatchObject({
      status: "orphaned",
      changeset: { status: "pending-review", files: [expect.objectContaining({ operation: "created" })] },
    });
  });

  it("persists an unresolved orphan and keeps overlapping roots blocked when process ownership is missing", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "exograph-invocation-missing-ownership-"));
    temporaryRoots.push(root);
    const notePath = path.join(root, "note.md");
    const command = { ...createDefaultClaudeAgentCommand(), command: process.execPath, continuityPolicy: "fresh" as const };
    const body = protocolNoteBody("# Unsafe recovery\n", command.handle, "Recover this.");
    await writeFile(notePath, body);
    const original = createRunner(settings(root, command));
    const prepared = await original.prepare(invocationRequest(notePath, body));
    await original.authorizeAndStart(prepared, authorizationFor(prepared));
    await rm(path.join(root, ".exograph", "invocations", prepared.id, "process-ownership.json"));

    const recovering = createRunner(settings(root, command));
    await expect(recovering.markOrphanedRunningInvocations()).resolves.toBeUndefined();
    await expect(recovering.get(prepared.id)).resolves.toMatchObject({
      status: "orphaned",
      failureReason: expect.stringContaining("cannot prove the writer is dead"),
    });

    const overlapping = await recovering.prepare(invocationRequest(notePath, body));
    await expect(recovering.authorizeAndStart(overlapping, authorizationFor(overlapping))).rejects.toMatchObject({ code: "review-busy" });
  });

  it("isolates malformed recovery artifacts, persists the failure, and returns control to startup", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "exograph-invocation-malformed-recovery-"));
    temporaryRoots.push(root);
    const notePath = path.join(root, "note.md");
    const command = { ...createDefaultClaudeAgentCommand(), command: process.execPath, continuityPolicy: "fresh" as const };
    const body = protocolNoteBody("# Malformed recovery\n", command.handle, "Recover this.");
    await writeFile(notePath, body);
    const original = createRunner(settings(root, command));
    const prepared = await original.prepare(invocationRequest(notePath, body));
    await original.authorizeAndStart(prepared, authorizationFor(prepared));
    await writeFile(path.join(root, ".exograph", "invocations", prepared.id, "launch-manifest.json"), "{not-json\n");

    const recovering = createRunner(settings(root, command));
    await expect(recovering.recoverWorkspace(settings(root, command))).resolves.toBeUndefined();
    await expect(recovering.get(prepared.id)).resolves.toMatchObject({
      status: "orphaned",
      failureReason: expect.stringContaining("Invocation recovery remains unresolved"),
    });
  });

  it("enumerates a missing record, proves its owned process absent, and keeps the Note Root blocked", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "exograph-invocation-missing-record-recovery-"));
    temporaryRoots.push(root);
    const notePath = path.join(root, "note.md");
    const command = { ...createDefaultClaudeAgentCommand(), command: process.execPath, continuityPolicy: "fresh" as const };
    const body = protocolNoteBody("# Missing record\n", command.handle, "Do not unlock this root.");
    await writeFile(notePath, body);
    const store = new InvocationStore(root);
    await store.writeProcessOwnership("missing-record", absentProcessOwnership(2_000_000_000));
    const runner = createRunner(settings(root, command));

    await expect(runner.recoverWorkspace(settings(root, command))).resolves.toBeUndefined();

    const prepared = await runner.prepare(invocationRequest(notePath, body));
    await expect(runner.authorizeAndStart(prepared, authorizationFor(prepared))).rejects.toMatchObject({
      code: "review-busy",
      message: expect.stringContaining("record is missing or semantically invalid"),
    });
    await expect(store.readProcessOwnership("missing-record")).resolves.toEqual(absentProcessOwnership(2_000_000_000));
  });

  it("enumerates a semantically invalid record and keeps its Note Root blocked", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "exograph-invocation-invalid-record-recovery-"));
    temporaryRoots.push(root);
    const notePath = path.join(root, "note.md");
    const command = { ...createDefaultClaudeAgentCommand(), command: process.execPath, continuityPolicy: "fresh" as const };
    const body = protocolNoteBody("# Invalid record\n", command.handle, "Do not unlock this root.");
    await writeFile(notePath, body);
    const invocationDir = path.join(root, ".exograph", "invocations", "invalid-record");
    await mkdir(invocationDir, { recursive: true });
    await writeFile(path.join(invocationDir, "record.json"), JSON.stringify({ id: "invalid-record" }), "utf8");
    const runner = createRunner(settings(root, command));

    await expect(runner.recoverWorkspace(settings(root, command))).resolves.toBeUndefined();

    const prepared = await runner.prepare(invocationRequest(notePath, body));
    await expect(runner.authorizeAndStart(prepared, authorizationFor(prepared))).rejects.toMatchObject({
      code: "review-busy",
      message: expect.stringContaining("record is missing or semantically invalid"),
    });
  });

  it("does not recover or settle an active invocation twice across an A to B to A switch", async () => {
    const workspaceA = await mkdtemp(path.join(os.tmpdir(), "exograph-invocation-active-switch-a-"));
    const workspaceB = await mkdtemp(path.join(os.tmpdir(), "exograph-invocation-active-switch-b-"));
    temporaryRoots.push(workspaceA, workspaceB);
    const notePath = path.join(workspaceA, "note.md");
    const command = { ...createDefaultClaudeAgentCommand(), command: process.execPath, continuityPolicy: "fresh" as const };
    const body = protocolNoteBody("# Active switch\n", command.handle, "Stay active across the switch.");
    await writeFile(notePath, body);
    let activeSettings = settings(workspaceA, command);
    const processFactory = new FakeInvocationProcessFactory();
    const runner = new InvocationRunner({
      getWorkspaceSettings: () => activeSettings,
      trustStateRoot: workspaceA,
      terminalManager: new FakeTerminalManager() as unknown as TerminalManager,
      invocationProcessFactory: processFactory,
      workspaceWatcherService: { subscribe: () => () => undefined } as unknown as WorkspaceWatcherService,
      settlementQuietMs: 0,
      settlementMaxWaitMs: 0,
    });
    const prepared = await runner.prepare(invocationRequest(notePath, body));
    await runner.authorizeAndStart(prepared, authorizationFor(prepared));

    activeSettings = settings(workspaceB, command);
    await runner.recoverWorkspace(activeSettings);
    activeSettings = settings(workspaceA, command);
    await runner.recoverWorkspace(activeSettings);

    expect(processFactory.process.stopCalls).toBe(0);
    expect(processFactory.process.releaseCalls).toBe(1);
    const updates: import("@exograph/core").InvocationRecord[] = [];
    runner.on("updated", (record) => updates.push(record));
    const updated = new Promise<import("@exograph/core").InvocationRecord>((resolve) => runner.once("updated", resolve));
    await writeFile(notePath, withProtocolResponse(body, command.handle, "Finished after returning to Workspace A."));
    processFactory.process.exit(0, "done");
    const completed = await updated;

    expect(updates).toHaveLength(1);
    expect(completed).toMatchObject({ status: "process-exited", changeset: { status: "pending-review" } });
    await expect(runner.get(prepared.id)).resolves.toMatchObject({ status: "process-exited" });
  });

  it("resets the settlement quiet window when a late watcher event arrives", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "exograph-invocation-quiet-window-"));
    temporaryRoots.push(root);
    const notePath = path.join(root, "note.md");
    const command = { ...createDefaultClaudeAgentCommand(), command: process.execPath, continuityPolicy: "fresh" as const };
    const body = protocolNoteBody("# Quiet\n", command.handle, "Wait for this.");
    await writeFile(notePath, body);
    const processFactory = new FakeInvocationProcessFactory();
    const watcher = new FakeWorkspaceWatcher();
    const runner = new InvocationRunner({
      getWorkspaceSettings: () => settings(root, command),
      trustStateRoot: root,
      terminalManager: new FakeTerminalManager() as unknown as TerminalManager,
      invocationProcessFactory: processFactory,
      workspaceWatcherService: watcher as unknown as WorkspaceWatcherService,
      settlementQuietMs: 60,
      settlementMaxWaitMs: 500,
    });
    const prepared = await runner.prepare(invocationRequest(notePath, body));
    await runner.authorizeAndStart(prepared, authorizationFor(prepared));
    const startedAt = Date.now();
    const updated = new Promise<import("@exograph/core").InvocationRecord>((resolve) => runner.once("updated", resolve));
    processFactory.process.exit(0, "done");
    await new Promise((resolve) => setTimeout(resolve, 30));
    await writeFile(notePath, withProtocolResponse(body, command.handle, "Late response."));
    watcher.emit(root, notePath);

    const completed = await updated;
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(75);
    expect(completed).toMatchObject({ status: "process-exited", changeset: { status: "pending-review" } });
  });

  it("publishes an exact review checkpoint before the harness process exits", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "exograph-invocation-proposal-checkpoint-"));
    temporaryRoots.push(root);
    const notePath = path.join(root, "note.md");
    const command = { ...createDefaultClaudeAgentCommand(), command: process.execPath, continuityPolicy: "fresh" as const };
    const body = protocolNoteBody("# Proposal\n", command.handle, "Write the answer.");
    await writeFile(notePath, body);
    const processFactory = new FakeInvocationProcessFactory();
    const watcher = new FakeWorkspaceWatcher();
    const runner = new InvocationRunner({
      getWorkspaceSettings: () => settings(root, command),
      trustStateRoot: root,
      terminalManager: new FakeTerminalManager() as unknown as TerminalManager,
      invocationProcessFactory: processFactory,
      workspaceWatcherService: watcher as unknown as WorkspaceWatcherService,
      settlementQuietMs: 15,
      settlementMaxWaitMs: 500,
    });
    const prepared = await runner.prepare(invocationRequest(notePath, body));
    await runner.authorizeAndStart(prepared, authorizationFor(prepared));
    const checkpoint = new Promise<import("@exograph/core").InvocationRecord>((resolve) => {
      const onUpdated = (record: import("@exograph/core").InvocationRecord) => {
        if (record.id === prepared.id && record.status === "running" && record.changeset) {
          runner.off("updated", onUpdated);
          resolve(record);
        }
      };
      runner.on("updated", onUpdated);
    });
    await writeFile(notePath, withProtocolResponse(body, command.handle, "Answer on disk."));
    watcher.emit(root, notePath);

    await expect(checkpoint).resolves.toMatchObject({
      status: "running",
      changeset: { status: "pending-review", files: [expect.objectContaining({ operation: "modified" })] },
    });
    expect(processFactory.process.stopCalls).toBe(0);

    const completed = new Promise<import("@exograph/core").InvocationRecord>((resolve) => {
      const onUpdated = (record: import("@exograph/core").InvocationRecord) => {
        if (record.id === prepared.id && record.status === "process-exited") {
          runner.off("updated", onUpdated);
          resolve(record);
        }
      };
      runner.on("updated", onUpdated);
    });
    processFactory.process.exit(0, "done");
    await expect(completed).resolves.toMatchObject({ status: "process-exited", changeset: { status: "pending-review" } });
  });

  it("keeps settlement reviewable and reports artifact cleanup failure after the exact record is durable", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "exograph-invocation-compaction-error-"));
    temporaryRoots.push(root);
    const notePath = path.join(root, "note.md");
    const unrelatedPath = path.join(root, "unrelated.md");
    const command = { ...createDefaultClaudeAgentCommand(), command: process.execPath, continuityPolicy: "fresh" as const };
    const body = protocolNoteBody("# Context\n", command.handle, "Change this note.");
    await writeFile(notePath, body);
    await writeFile(unrelatedPath, "unchanged and not History\n");
    const processFactory = new FakeInvocationProcessFactory();
    const runner = createRunner(settings(root, command), new FakeTerminalManager(), processFactory);
    const prepared = await runner.prepare(invocationRequest(notePath, body));
    await runner.authorizeAndStart(prepared, authorizationFor(prepared));
    await writeFile(notePath, withProtocolResponse(body, command.handle, "Durable response."));
    const invocationDir = path.join(root, ".exograph", "invocations", prepared.id);
    await mkdir(path.join(invocationDir, "files", "objects", "stale-directory"));
    const compactionError = new Promise<{ invocationId: string; error: unknown }>((resolve) =>
      runner.once("artifact-compaction-error", resolve));
    const updated = new Promise<import("@exograph/core").InvocationRecord>((resolve) => runner.once("updated", resolve));

    processFactory.process.exit(0, "done");

    await expect(compactionError).resolves.toMatchObject({ invocationId: prepared.id });
    await expect(updated).resolves.toMatchObject({ status: "process-exited", changeset: { status: "pending-review" } });
    await expect(runner.get(prepared.id)).resolves.toMatchObject({ status: "process-exited" });
    const compactLaunch = JSON.parse(await readFile(path.join(invocationDir, "launch-manifest.json"), "utf8"));
    expect(compactLaunch.files).not.toHaveProperty(unrelatedPath);
  });

  it("resumes with the configured Claude executable, not an assumed global binary", () => {
    const command = { ...createDefaultClaudeAgentCommand(), command: '"/Applications/Claude/bin/claude" -p --output-format json' };
    expect(commandForClaudeResume(command, "ce4b9e26-2574-4433-a054-1110cd403792"))
      .toBe('"/Applications/Claude/bin/claude" --resume \'ce4b9e26-2574-4433-a054-1110cd403792\'');
  });
});

function createRunner(
  workspaceSettings: WorkspaceSettings,
  terminalManager: EventEmitter = new EventEmitter(),
  invocationProcessFactory: InvocationProcessFactory = new FakeInvocationProcessFactory(),
): InvocationRunner {
  const watcher = { subscribe: () => () => undefined };
  return new InvocationRunner({
    getWorkspaceSettings: () => workspaceSettings,
    trustStateRoot: workspaceSettings.workspaceRoot,
    terminalManager: terminalManager as TerminalManager,
    invocationProcessFactory,
    workspaceWatcherService: watcher as unknown as WorkspaceWatcherService,
    settlementQuietMs: 0,
    settlementMaxWaitMs: 0,
  });
}

function protocolNoteBody(prefix: string, handle: string, message: string): string {
  return `${prefix.replace(/\n?$/, "\n\n")}${formatDocumentAgentInvocation({
    id: TEST_PROTOCOL_INVOCATION_ID,
    agent: handle,
    message: `@${handle} ${message}`,
  })}\n`;
}

function withProtocolResponse(documentBody: string, handle: string, message: string): string {
  return `${documentBody}${formatDocumentAgentResponse({
    invocationId: TEST_PROTOCOL_INVOCATION_ID,
    agent: handle,
    message,
  })}\n`;
}

function invocationRequest(notePath: string, documentBody: string) {
  return {
    context: "note" as const,
    handle: "claude",
    documentPath: notePath,
    mentionText: "@claude",
    message: "Continue this.",
    protocolInvocationId: TEST_PROTOCOL_INVOCATION_ID,
    documentBody,
  };
}

function authorizationFor(
  prepared: Awaited<ReturnType<InvocationRunner["prepare"]>>,
  kind: "trusted" | "run-once" | "always-allow" = "run-once",
) {
  return {
    decision: { kind },
    expectedFingerprint: prepared.pending.command.executableFingerprint,
  } as const;
}

async function startPrepared(
  runner: InvocationRunner,
  request: Parameters<InvocationRunner["prepare"]>[0],
) {
  const prepared = await runner.prepare(request);
  return runner.authorizeAndStart(prepared, authorizationFor(prepared));
}

async function multiFileReviewFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "exograph-invocation-concurrent-review-"));
  temporaryRoots.push(root);
  const notePath = path.join(root, "note.md");
  const createdPath = path.join(root, "created.md");
  const command = { ...createDefaultClaudeAgentCommand(), command: process.execPath, continuityPolicy: "fresh" as const };
  const body = protocolNoteBody("# Concurrent review\n", command.handle, "Change files.");
  await writeFile(notePath, body);
  const processFactory = new FakeInvocationProcessFactory();
  const runner = createRunner(settings(root, command), new FakeTerminalManager(), processFactory);
  const prepared = await runner.prepare(invocationRequest(notePath, body));
  await runner.authorizeAndStart(prepared, authorizationFor(prepared));
  await writeFile(notePath, withProtocolResponse(body, command.handle, "Bulk-safe response."));
  await writeFile(createdPath, "created\n");
  const updated = new Promise<import("@exograph/core").InvocationRecord>((resolve) => runner.once("updated", resolve));
  processFactory.process.exit(0, "done");
  const completed = await updated;
  return { root, notePath, createdPath, runner, completed };
}

class FakeTerminalManager extends EventEmitter {
  created = 0;
  messages: string[] = [];
  commands: unknown[] = [];
  workspaceContexts: unknown[] = [];

  async createAgentCommand(command: unknown, cwd: string, workspaceContext?: unknown) {
    this.created += 1;
    this.commands.push(command);
    this.workspaceContexts.push(workspaceContext);
    return {
      id: `terminal-${this.created}`,
      title: "Echo",
      cwd,
      kind: "shell" as const,
      command: "/bin/echo",
      status: "running" as const,
      attachGeneration: 1,
    };
  }

  async sendMessage(_id: string, message: string) {
    this.messages.push(message);
    return { ok: true, delivery: "sent" as const };
  }

  async kill() {}
}

class FakeInvocationProcessFactory implements InvocationProcessFactory {
  readonly processes: FakeInvocationProcess[] = [];
  readonly inputs: Array<{ command: string; cwd: string; env: NodeJS.ProcessEnv }> = [];
  nextSendError: Error | null = null;
  nextStopError: Error | null = null;
  onLaunch?: () => void;
  onRelease?: (process: FakeInvocationProcess) => Promise<void>;

  get process(): FakeInvocationProcess {
    const process = this.processes.at(-1);
    if (!process) throw new Error("No invocation process has launched.");
    return process;
  }

  launch(input: { command: string; cwd: string; env: NodeJS.ProcessEnv }): InvocationProcess {
    this.inputs.push(input);
    this.onLaunch?.();
    // Recovery probes the operating system for this identity. Small fake PIDs
    // can collide with real processes on CI and turn a unit test into an
    // accidental ownership check against the runner itself.
    const process = new FakeInvocationProcess(
      2_000_000_000 + this.processes.length,
      this.nextSendError,
      this.nextStopError,
      this.onRelease,
    );
    this.nextSendError = null;
    this.nextStopError = null;
    this.processes.push(process);
    return process;
  }
}

class FakeWorkspaceWatcher {
  private listener: ((event: { rootPath: string; eventType: string; filePath: string | null }) => void) | null = null;

  subscribe(listener: (event: { rootPath: string; eventType: string; filePath: string | null }) => void): () => void {
    this.listener = listener;
    return () => { this.listener = null; };
  }

  emit(rootPath: string, filePath: string): void {
    this.listener?.({ rootPath, filePath, eventType: "change" });
  }
}

class FakeInvocationProcess implements InvocationProcess {
  readonly ownership;
  releaseCalls = 0;
  prompts: string[] = [];
  stopCalls = 0;
  private stopPromise: Promise<void> | null = null;
  private exitHandler: ((event: InvocationProcessExit) => void) | null = null;
  private outputHandler: ((event: import("./invocation-process").InvocationProcessOutput) => void) | null = null;

  constructor(
    pid: number,
    private readonly sendError: Error | null = null,
    private readonly stopError: Error | null = null,
    private readonly releaseCheck?: (process: FakeInvocationProcess) => Promise<void>,
  ) {
    this.ownership = {
      version: 1 as const,
      kind: "posix-process-group" as const,
      pid,
      processGroupId: pid,
      ownerToken: `00000000-0000-4000-8000-${String(pid).padStart(12, "0")}`,
      launchedAt: new Date().toISOString(),
    };
  }

  async release(): Promise<void> {
    await this.releaseCheck?.(this);
    this.releaseCalls += 1;
  }

  async send(prompt: string): Promise<void> {
    if (this.sendError) throw this.sendError;
    this.prompts.push(prompt);
  }

  onExit(handler: (event: InvocationProcessExit) => void): void {
    this.exitHandler = handler;
  }

  onOutput(handler: (event: import("./invocation-process").InvocationProcessOutput) => void): void {
    this.outputHandler = handler;
  }

  output(channel: "stdout" | "stderr", chunk: string): void {
    this.outputHandler?.({ channel, chunk });
  }

  exit(exitCode: number | null, stdout: string, stderr = ""): void {
    this.exitHandler?.({ exitCode, stdout, stderr });
  }

  stop(): Promise<void> {
    if (!this.stopPromise) {
      this.stopCalls += 1;
      this.stopPromise = this.stopError ? Promise.reject(this.stopError) : Promise.resolve();
    }
    return this.stopPromise;
  }
}

function settings(workspaceRoot: string, command: ReturnType<typeof createDefaultClaudeAgentCommand>): WorkspaceSettings {
  return {
    workspaceRoot,
    defaultTerminalCwd: workspaceRoot,
    noteRoots: [workspaceRoot],
    indexedRoots: [],
    indexing: { enabled: false, mode: "off", backend: "qmd" },
    agentCommands: [command],
    appearanceMode: "system",
    colorThemeId: "exograph-neutral",
    editorFontSize: 15,
    terminalFontSize: 13,
    explorerScale: 1,
    graphInverseNavigation: true,
    graphShowOverflowLabels: true,
    exploreIndexSearchOnEnter: true,
    indexUpdateStrategy: "manual",
  };
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function absentProcessOwnership(pid: number) {
  return {
    version: 1 as const,
    kind: "posix-process-group" as const,
    pid,
    processGroupId: pid,
    ownerToken: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    launchedAt: "2026-07-20T00:00:00.000Z",
  };
}
