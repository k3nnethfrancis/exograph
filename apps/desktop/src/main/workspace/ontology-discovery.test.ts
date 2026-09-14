import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createDefaultClaudeAgentCommand, createDefaultCodexAgentCommand } from "@exograph/core";
import {
  createOntologyDesignPrompt,
  normalizeOntologyDiscoveryResponse,
  OntologyDiscoveryCoordinator,
  runOntologyDiscovery,
} from "./ontology-discovery";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("ontology discovery", () => {
  it("owns trusted Command selection, frozen identity, staging, and notification as one transaction", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "exograph-ontology-coordinator-test-"));
    roots.push(root);
    const noteRoot = path.join(root, "notes");
    const notifyCandidateChanged = vi.fn();
    const guard = {
      candidateSourcePath: "ontology.yaml",
      candidateRevision: null,
      activationRevision: null,
      baseSnapshotId: "graph-snapshot",
    };
    let previewCount = 0;
    const coordinator = new OntologyDiscoveryCoordinator({
      getCommands: () => [createDefaultCodexAgentCommand()],
      getDefaultCommandId: () => "codex",
      getWorkspace: () => ({
        workspaceRoot: root,
        runtimeRoot: path.join(root, ".exograph"),
        noteRoots: [noteRoot],
      }),
      getCommandLaunchFacts: async () => ({
        launchable: true,
        executablePath: "/usr/bin/true",
      }),
      getCommandTrust: async () => ({ trusted: true }),
      getPrompt: () => createOntologyDesignPrompt("Inspect without writing."),
      invalidateDerivedState: vi.fn(),
      previewOntology: async () => ({
        library: [],
        active: { state: "generic" },
        candidate: previewCount++ < 2
          ? { state: "absent", sourcePath: null, revision: null, pending: false, rejected: false }
          : { state: "valid", sourcePath: "ontology.yaml", revision: "candidate", pending: true, rejected: false },
        guard,
        diagnostics: [],
        omittedDiagnostics: 0,
      }),
      getGraphTopology: async () => ({ sourceSnapshotId: "graph-snapshot" }),
      runDiscovery: async ({ command, skill }) => ({
        response: normalizeOntologyDiscoveryResponse(proposal()),
        command: {
          id: command.id,
          handle: command.handle,
          label: command.label,
          adapter: command.adapter,
        },
        skill,
      }),
      notifyCandidateChanged,
    });

    await expect(coordinator.discover()).resolves.toMatchObject({
      status: "staged",
      summary: "One observed note type.",
      graphSnapshotId: "graph-snapshot",
    });
    expect(notifyCandidateChanged).toHaveBeenCalledOnce();
  });

  it("serializes discovery inside the transaction owner and releases the lock after completion", async () => {
    const command = createDefaultCodexAgentCommand();
    const guard = {
      candidateSourcePath: "ontology.yaml",
      candidateRevision: null,
      activationRevision: null,
      baseSnapshotId: "graph-snapshot",
    };
    let releaseDiscovery!: () => void;
    const discoveryReleased = new Promise<void>((resolve) => {
      releaseDiscovery = resolve;
    });
    const coordinator = new OntologyDiscoveryCoordinator({
      getCommands: () => [command],
      getDefaultCommandId: () => command.id,
      getWorkspace: () => ({
        workspaceRoot: "/workspace",
        runtimeRoot: "/workspace/.exograph",
        noteRoots: ["/workspace/notes"],
      }),
      getCommandLaunchFacts: async () => ({
        launchable: true,
        executablePath: "/usr/bin/true",
      }),
      getCommandTrust: async () => ({ trusted: true }),
      getPrompt: () => createOntologyDesignPrompt("Inspect without writing."),
      invalidateDerivedState: vi.fn(),
      previewOntology: async () => ({
        library: [],
        active: { state: "generic" },
        candidate: { state: "absent", sourcePath: null, revision: null, pending: false, rejected: false },
        guard,
        diagnostics: [],
        omittedDiagnostics: 0,
      }),
      getGraphTopology: async () => ({ sourceSnapshotId: "graph-snapshot" }),
      runDiscovery: async ({ skill }) => {
        await discoveryReleased;
        return {
          response: normalizeOntologyDiscoveryResponse({
            ...proposal(),
            outcome: "abstain",
            candidateSource: null,
          }),
          command: {
            id: command.id,
            handle: command.handle,
            label: command.label,
            adapter: command.adapter,
          },
          skill,
        };
      },
      notifyCandidateChanged: vi.fn(),
    });

    const first = coordinator.discover();
    await expect(coordinator.discover()).rejects.toThrow("already running");
    releaseDiscovery();
    await expect(first).resolves.toMatchObject({ status: "abstained" });
    await expect(coordinator.discover()).resolves.toMatchObject({ status: "abstained" });
  });

  it("uses the selected default command instead of configuration order", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "exograph-ontology-default-command-"));
    roots.push(root);
    const claude = createDefaultClaudeAgentCommand();
    const codex = createDefaultCodexAgentCommand();
    const runDiscovery = vi.fn(async ({ command, skill }) => ({
      response: normalizeOntologyDiscoveryResponse(proposal()),
      command: { id: command.id, handle: command.handle, label: command.label, adapter: command.adapter },
      skill,
    }));
    const coordinator = new OntologyDiscoveryCoordinator({
      getCommands: () => [claude, codex],
      getDefaultCommandId: () => codex.id,
      getWorkspace: () => ({ workspaceRoot: root, runtimeRoot: path.join(root, ".exograph"), noteRoots: [path.join(root, "notes")] }),
      getCommandLaunchFacts: async (commandId) => ({ launchable: true, executablePath: `/bin/${commandId}` }),
      getCommandTrust: async () => ({ trusted: true }),
      getPrompt: () => createOntologyDesignPrompt("Inspect."),
      invalidateDerivedState: vi.fn(),
      previewOntology: async () => reviewState(),
      getGraphTopology: async () => ({ sourceSnapshotId: "graph-snapshot" }),
      runDiscovery,
      notifyCandidateChanged: vi.fn(),
    });

    await coordinator.discover();
    expect(runDiscovery).toHaveBeenCalledWith(expect.objectContaining({ command: codex, executablePath: "/bin/codex" }));
  });

  it("reports the exact setup problem for the selected default command", async () => {
    const codex = createDefaultCodexAgentCommand();
    const coordinator = new OntologyDiscoveryCoordinator({
      getCommands: () => [codex],
      getDefaultCommandId: () => codex.id,
      getWorkspace: () => ({ workspaceRoot: "/workspace", runtimeRoot: "/workspace/.exograph", noteRoots: ["/workspace/notes"] }),
      getCommandLaunchFacts: async () => ({ launchable: false, executablePath: null }),
      getCommandTrust: async () => ({ trusted: true }),
      getPrompt: () => createOntologyDesignPrompt(),
      invalidateDerivedState: vi.fn(),
      previewOntology: vi.fn(),
      getGraphTopology: vi.fn(),
      runDiscovery: vi.fn(),
      notifyCandidateChanged: vi.fn(),
    });

    await expect(coordinator.discover()).rejects.toThrow("Codex is not available. Check its executable in Settings → Agents.");
  });

  it("explains how to authorize an untrusted default command", async () => {
    const codex = createDefaultCodexAgentCommand();
    const coordinator = new OntologyDiscoveryCoordinator({
      getCommands: () => [codex],
      getDefaultCommandId: () => codex.id,
      getWorkspace: () => ({ workspaceRoot: "/workspace", runtimeRoot: "/workspace/.exograph", noteRoots: ["/workspace/notes"] }),
      getCommandLaunchFacts: async () => ({ launchable: true, executablePath: "/bin/codex" }),
      getCommandTrust: async () => ({ trusted: false }),
      getPrompt: () => createOntologyDesignPrompt(),
      invalidateDerivedState: vi.fn(),
      previewOntology: vi.fn(),
      getGraphTopology: vi.fn(),
      runDiscovery: vi.fn(),
      notifyCandidateChanged: vi.fn(),
    });

    await expect(coordinator.discover()).rejects.toThrow(
      "Authorize Codex once with @codex, then try Discover structure again.",
    );
  });

  it("runs a configured provider against a disposable Markdown snapshot", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "exograph-ontology-discovery-test-"));
    roots.push(root);
    const notePath = path.join(root, "note.md");
    const ignoredPath = path.join(root, "private.txt");
    await writeFile(notePath, "# Note\n");
    await writeFile(ignoredPath, "not copied\n");
    const executablePath = path.join(root, "fake-codex.mjs");
    await writeFile(executablePath, `#!/usr/bin/env node
import { readdir, readFile, writeFile } from "node:fs/promises";
const outputIndex = process.argv.indexOf("--output-last-message");
const names = await readdir(process.cwd());
if (!names.includes("note.md") || names.includes("private.txt")) process.exit(7);
await new Promise((resolve) => { process.stdin.resume(); process.stdin.on("end", resolve); });
await writeFile(process.argv[outputIndex + 1], JSON.stringify(${JSON.stringify(proposal())}));
`);
    await chmod(executablePath, 0o700);

    const result = await runOntologyDiscovery({
      noteRoots: [root],
      command: createDefaultCodexAgentCommand(),
      executablePath,
      skill: {
        id: "ontology-design",
        label: "Ontology design",
        path: "exograph://settings/graph/ontology-design-prompt",
        revision: "a".repeat(64),
        source: "Inspect without writing.",
      },
      timeoutMs: 2_000,
    });

    expect(result.response).toMatchObject({
      outcome: "proposal",
      summary: "One observed note type.",
      features: { conceptTypes: ["note"] },
    });
    await expect(readFile(notePath, "utf8")).resolves.toBe("# Note\n");
    await expect(readFile(ignoredPath, "utf8")).resolves.toBe("not copied\n");
  });

  it("prepares discovery without creating a Skill inside the Note Root", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "exograph-ontology-no-skill-write-"));
    roots.push(root);
    const noteRoot = path.join(root, "notes");
    await mkdir(noteRoot);
    const command = createDefaultCodexAgentCommand();
    const coordinator = new OntologyDiscoveryCoordinator({
      getCommands: () => [command],
      getDefaultCommandId: () => command.id,
      getWorkspace: () => ({ workspaceRoot: root, runtimeRoot: path.join(root, ".exograph"), noteRoots: [noteRoot] }),
      getCommandLaunchFacts: async () => ({ launchable: true, executablePath: "/bin/codex" }),
      getCommandTrust: async () => ({ trusted: true }),
      getPrompt: () => createOntologyDesignPrompt(),
      invalidateDerivedState: vi.fn(),
      previewOntology: async () => reviewState(),
      getGraphTopology: async () => ({ sourceSnapshotId: "graph-snapshot" }),
      runDiscovery: async ({ command: selected, skill }) => ({
        response: normalizeOntologyDiscoveryResponse({ ...proposal(), outcome: "abstain", candidateSource: null }),
        command: { id: selected.id, handle: selected.handle, label: selected.label, adapter: selected.adapter },
        skill,
      }),
      notifyCandidateChanged: vi.fn(),
    });

    await coordinator.discover();
    await expect(readFile(path.join(noteRoot, "skills", "design-workspace-ontology.md"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects invalid source and absolute evidence before host staging", () => {
    expect(() => normalizeOntologyDiscoveryResponse({
      ...proposal(),
      candidateSource: "not: [valid",
    })).toThrow("invalid Workspace Ontology");
    expect(() => normalizeOntologyDiscoveryResponse({
      ...proposal(),
      evidence: [{ path: "/private/note.md", detail: "Observed." }],
    })).toThrow("must stay relative");
  });
});

function proposal() {
  return {
    outcome: "proposal",
    summary: "One observed note type.",
    candidateSource: "ontology_schema: 1\nid: discovered\nversion: 1\ntypes:\n  note:\n    paths: ['**/*.md']\n",
    features: {
      conceptTypes: ["note"],
      properties: [],
      relations: [],
      pathDefaults: ["note:**/*.md"],
      validationRules: [],
    },
    evidence: [{ path: "note.md", detail: "Representative note." }],
    conflicts: [],
    question: null,
  };
}

function reviewState() {
  return {
    library: [],
    active: { state: "generic" as const },
    candidate: { state: "absent" as const, sourcePath: null, revision: null, pending: false, rejected: false },
    guard: {
      candidateSourcePath: "ontology.yaml",
      candidateRevision: null,
      activationRevision: null,
      baseSnapshotId: "graph-snapshot",
    },
    diagnostics: [],
    omittedDiagnostics: 0,
  };
}
