import { expect, test } from "@playwright/test";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { createDefaultClaudeAgentCommand, createDefaultCodexAgentCommand, formatDocumentAgentInvocation } from "@exograph/core";

import { launchExographWorkspaceFixture } from "../helpers";

test("launches the recommended Codex command in a non-Git workspace and routes ontology discovery to it", async () => {
  const protocolInvocationId = randomUUID();
  const invocationMessage = "Prove this command launches from a non-Git note workspace without editing files.";
  let codexPath = "";
  let markerPath = "";
  let notePath = "";
  const fixture = await launchExographWorkspaceFixture({
    mutable: true,
    initialNoteLabel: "agent-routing",
    prepareWorkspace: async (workspaceRoot) => {
      const bin = path.join(workspaceRoot, "test-bin");
      codexPath = path.join(bin, "codex");
      markerPath = path.join(workspaceRoot, "codex-launches.jsonl");
      notePath = path.join(workspaceRoot, "notes/test-notes/agent-routing.md");
      await mkdir(bin, { recursive: true });
      await writeFile(notePath, `# Agent Routing\n\nA normal non-Git note workspace.\n\n${formatDocumentAgentInvocation({
        id: protocolInvocationId,
        agent: "codex",
        message: invocationMessage,
      })}\n`, "utf8");
      await writeFile(codexPath, `#!/usr/bin/env node
import { appendFile, writeFile } from "node:fs/promises";
const args = process.argv.slice(2);
await appendFile(process.env.EXOGRAPH_TEST_PROVIDER_MARKER, JSON.stringify({ args, cwd: process.cwd() }) + "\\n");
await new Promise((resolve) => { process.stdin.resume(); process.stdin.on("end", resolve); });
const outputIndex = args.indexOf("--output-last-message");
if (outputIndex >= 0) {
  await writeFile(args[outputIndex + 1], JSON.stringify({
    outcome: "proposal",
    summary: "One observed note type.",
    candidateSource: "ontology_schema: 1\\nid: discovered\\nversion: 1\\ntypes:\\n  note:\\n    paths: ['**/*.md']\\n",
    features: { conceptTypes: ["note"], properties: [], relations: [], pathDefaults: ["note:**/*.md"], validationRules: [] },
    evidence: [{ path: "agent-routing.md", detail: "Representative note." }],
    conflicts: [],
    question: null
  }));
}
`);
      await chmod(codexPath, 0o700);
    },
    prepareSettings: async ({ settingsPath, workspaceRoot }) => {
      await writeFile(settingsPath, JSON.stringify({
        workspaceRoot,
        defaultTerminalCwd: workspaceRoot,
        noteRoots: [path.join(workspaceRoot, "notes/test-notes")],
        agentCommands: [createDefaultClaudeAgentCommand(), createDefaultCodexAgentCommand()],
        defaultAgentCommandId: "codex",
        indexedRoots: [],
        indexing: { enabled: false, mode: "off", backend: "qmd" },
        searchEngine: "filesystem",
        appearanceMode: "system",
        colorThemeId: "exograph-neutral",
        editorFontSize: 15,
        terminalFontSize: 13,
        explorerScale: 1,
        exploreIndexSearchOnEnter: false,
        indexUpdateStrategy: "on-save",
      }, null, 2), "utf8");
    },
  });

  try {
    // The fixture environment is assembled after prepareWorkspace, so bind the
    // fake provider into the running main process without touching user config.
    await fixture.electronApp.evaluate(({ app }, input) => {
      process.env.PATH = input.path;
      process.env.EXOGRAPH_TEST_PROVIDER_MARKER = input.markerPath;
      return app.getPath("userData");
    }, { path: `${path.dirname(codexPath)}:${process.env.PATH ?? ""}`, markerPath });

    const authorization = await fixture.page.evaluate((documentPath) =>
      window.exograph.workspace.getAgentInvocationAuthorization({ handle: "codex", documentPath }), notePath);
    expect(authorization).toMatchObject({ launchable: true, trusted: false, cwd: fixture.workspaceRoot });
    expect(authorization.command.command).toContain("--skip-git-repo-check");

    const documentBody = await readFile(notePath, "utf8");
    await fixture.page.evaluate(async ({ documentPath, documentBody, fingerprint, invocationMessage, protocolInvocationId }) => {
      await window.exograph.workspace.launchAgentInvocation({
        handle: "codex",
        protocolInvocationId,
        documentPath,
        mentionText: "@codex prove non-Git launch",
        message: invocationMessage,
        documentBody,
        authorization: { kind: "run-once" },
        expectedFingerprint: fingerprint,
      });
    }, { documentPath: notePath, documentBody, fingerprint: authorization.fingerprint, invocationMessage, protocolInvocationId });

    await expect.poll(async () => launchRecords(markerPath)).toHaveLength(1);
    expect((await launchRecords(markerPath))[0]?.args).toContain("--skip-git-repo-check");

    const userDataRoot = path.dirname(fixture.runtimeRoot);
    await writeFile(path.join(userDataRoot, "agent-command-trust.json"), `${JSON.stringify({
      trustedCommands: [{
        workspaceRoot: fixture.workspaceRoot,
        commandId: "codex",
        handle: "codex",
        executableFingerprint: authorization.fingerprint,
        trustedAt: "2026-08-08T00:00:00.000Z",
      }],
    }, null, 2)}\n`, "utf8");

    await fixture.page.getByTestId("editor-panel").hover();
    await fixture.page.getByTestId("open-note-graph").click();
    await expect(fixture.page.getByTestId("graph-pane")).toBeVisible();
    await fixture.page.getByRole("button", { name: "Discover ontology" }).click();

    await expect.poll(async () => launchRecords(markerPath)).toHaveLength(2);
    const discovery = (await launchRecords(markerPath))[1];
    expect(discovery?.args).toEqual(expect.arrayContaining(["exec", "--sandbox", "read-only", "--skip-git-repo-check"]));
    await expect(fixture.page.getByTestId("graph-ontology")).toContainText("discovered");
    await expect(fixture.page.getByRole("button", { name: "Keep ontology" })).toBeVisible();
  } finally {
    await fixture.cleanup();
  }
});

async function launchRecords(target: string): Promise<Array<{ args: string[]; cwd: string }>> {
  try {
    return (await readFile(target, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}
