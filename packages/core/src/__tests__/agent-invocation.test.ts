import { describe, expect, it } from "vitest";

import {
  agentCommandConfigurationError,
  agentCommandExecutableFingerprint,
  createDefaultClaudeAgentCommand,
  createDefaultCodexAgentCommand,
  deriveAgentCommandLaunch,
  formatNoteInvocationPrompt,
  NOTE_INVOCATION_SNAPSHOT_MAX_CHARACTERS,
  normalizeAgentCommand,
  normalizeAgentCommands,
  normalizeAgentHandle,
  normalizeInvocationRecord,
} from "../agent-invocation";
import {
  containsDocumentAgentProtocolSyntax,
  findDocumentAgentEnvelopes,
  formatDocumentAgentInvocation,
  formatDocumentAgentResponse,
  removeDocumentAgentInvocation,
} from "../document-agent-protocol";

describe("agent invocation model", () => {
  it("ships a headless Codex command suitable for a workspace invocation", () => {
    const command = createDefaultCodexAgentCommand();
    expect(command).toMatchObject({
      id: "codex",
      handle: "codex",
      command: "codex exec --sandbox workspace-write --skip-git-repo-check -",
      adapter: "codex-cli",
      continuityPolicy: "fresh",
      cwdPolicy: "workspace_root",
      promptDelivery: "stdin",
      enabled: true,
    });
    expect(deriveAgentCommandLaunch(command, { kind: "note", workspaceRoot: "/workspace", documentPath: "/workspace/a.md" }))
      .toEqual({ launchable: true, cwd: "/workspace" });
  });

  it("migrates only the exact persisted v1 Codex template", () => {
    expect(normalizeAgentCommand({
      id: "codex", label: "Codex", handle: "codex",
      command: "codex exec --sandbox workspace-write -", adapter: "codex-cli",
      continuityPolicy: "fresh", cwdPolicy: "workspace_root", promptDelivery: "stdin",
      version: 1, enabled: true,
    })).toMatchObject({
      command: "codex exec --sandbox workspace-write --skip-git-repo-check -",
      version: 2,
    });
    expect(normalizeAgentCommand({
      id: "codex", label: "Codex", handle: "codex",
      command: "codex exec --sandbox read-only -", adapter: "codex-cli",
      continuityPolicy: "fresh", cwdPolicy: "workspace_root", promptDelivery: "stdin",
      version: 1, enabled: true,
    })).toMatchObject({ command: "codex exec --sandbox read-only -", version: 1 });
  });

  it("derives one command launch decision for CLI and note contexts", () => {
    const command = createDefaultClaudeAgentCommand();
    expect(deriveAgentCommandLaunch(command, { kind: "cli", workspaceRoot: "/workspace" })).toEqual({
      launchable: true,
      cwd: "/workspace",
    });
    expect(deriveAgentCommandLaunch(
      { ...command, cwdPolicy: "note_dir" },
      { kind: "note", workspaceRoot: "/workspace", documentPath: "/workspace/notes/task.md" },
    )).toEqual({ launchable: true, cwd: "/workspace/notes" });
    expect(deriveAgentCommandLaunch(
      { ...command, cwdPolicy: "note_dir" },
      { kind: "cli", workspaceRoot: "/workspace" },
    )).toMatchObject({ launchable: false, block: "invalid-cwd-policy" });
  });

  it("normalizes configured agent handles", () => {
    expect(normalizeAgentHandle(" @Claude ")).toBe("claude");
    expect(normalizeAgentHandle("@codex-1")).toBe("codex-1");
    expect(normalizeAgentHandle("@c")).toBeNull();
    expect(normalizeAgentHandle("@import url")).toBeNull();
  });

  it("normalizes command records with headless stdin delivery as the default", () => {
    expect(normalizeAgentCommand({
      id: " Claude Code ",
      label: " Claude Code ",
      handle: " @Claude ",
      command: " claude ",
      cwdPolicy: "workspace_root",
      version: 0,
    })).toEqual({
      id: "Claude-Code",
      label: "Claude Code",
      handle: "claude",
      command: "claude",
      adapter: "generic",
      continuityPolicy: "fresh",
      cwdPolicy: "workspace_root",
      promptDelivery: "stdin",
      version: 1,
      enabled: true,
    });
  });

  it("rejects retired built-in Claude defaults without rewriting editable commands", () => {
    expect(normalizeAgentCommand({
      id: "claude", label: "Claude", handle: "claude", command: "claude",
      cwdPolicy: "workspace_root", promptDelivery: "terminalInputAfterLaunch",
    })).toBeNull();
    expect(normalizeAgentCommand({
      id: "claude", label: "Claude", handle: "claude", command: "claude -p",
      cwdPolicy: "workspace_root", promptDelivery: "stdin", version: 1,
    })).toBeNull();
    expect(normalizeAgentCommand({
      id: "claude", label: "Claude", handle: "claude", command: "claude -p --permission-mode acceptEdits",
      adapter: "claude-code", continuityPolicy: "continuous", cwdPolicy: "workspace_root", promptDelivery: "stdin", version: 1,
    })).toBeNull();
    expect(normalizeAgentCommand({
      id: "custom", label: "My Claude", handle: "claude", command: "claude",
      cwdPolicy: "workspace_root", promptDelivery: "stdin",
    })).toMatchObject({ command: "claude", adapter: "generic", continuityPolicy: "fresh", promptDelivery: "stdin" });
    expect(normalizeAgentCommand({
      id: "claude", label: "Claude", handle: "claude", command: "claude -p --model sonnet",
      cwdPolicy: "workspace_root", promptDelivery: "stdin", version: 1,
    })).toMatchObject({ command: "claude -p --model sonnet", adapter: "generic", continuityPolicy: "fresh" });
  });

  it("never infers a provider adapter from an editable handle", () => {
    expect(normalizeAgentCommand({
      id: "custom", label: "Claude", handle: "claude", command: "/tmp/not-claude",
      cwdPolicy: "workspace_root", promptDelivery: "stdin", version: 1,
    })).toMatchObject({ adapter: "generic", continuityPolicy: "fresh" });
    expect(normalizeAgentCommand({
      id: "custom", label: "Custom", handle: "helper", command: "/tmp/helper", adapter: "claude-code",
      cwdPolicy: "workspace_root", promptDelivery: "stdin", version: 1,
    })).toMatchObject({ adapter: "claude-code", continuityPolicy: "fresh" });
  });

  it("rejects V1 command records with env or template execution fields", () => {
    expect(normalizeAgentCommand({
      id: "claude",
      label: "Claude",
      handle: "claude",
      command: "claude",
      env: { ANTHROPIC_API_KEY: "secret" },
    })).toBeNull();
    expect(normalizeAgentCommand({
      id: "claude",
      label: "Claude",
      handle: "claude",
      command: "claude",
      promptTemplate: "{{message}}",
    })).toBeNull();
  });

  it("accepts only canonical stdin prompt delivery", () => {
    expect(normalizeAgentCommand({
      id: "custom",
      label: "Custom",
      handle: "custom",
      command: "/bin/cat",
      promptDelivery: "stdin",
    })).toMatchObject({ promptDelivery: "stdin" });
    expect(normalizeAgentCommand({
      id: "claude",
      label: "Claude",
      handle: "claude",
      command: "claude",
      promptDelivery: "argv",
    })).toBeNull();
  });

  it("fingerprints only executable command fields", () => {
    const command = createDefaultClaudeAgentCommand();
    const fingerprint = agentCommandExecutableFingerprint(command);

    expect(fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(agentCommandExecutableFingerprint({ ...command, label: "Claude Code" })).toBe(fingerprint);
    expect(agentCommandExecutableFingerprint({ ...command, command: "claude --print" })).not.toBe(fingerprint);
  });

  it("requires fixed cwd command records to include fixedCwd", () => {
    expect(normalizeAgentCommand({
      id: "local",
      label: "Local",
      handle: "local",
      command: "node agent.js",
      cwdPolicy: "fixed",
    })).toBeNull();
  });

  it("rejects multiline configured commands", () => {
    expect(normalizeAgentCommand({
      id: "local",
      label: "Local",
      handle: "local",
      command: "echo one\necho two",
    })).toBeNull();
  });

  it("deduplicates command records by id and handle", () => {
    expect(normalizeAgentCommands([
      createDefaultClaudeAgentCommand(),
      { ...createDefaultClaudeAgentCommand(), id: "claude-copy", command: "claude --dangerously-skip-permissions" },
      { ...createDefaultClaudeAgentCommand(), handle: "codex", command: "codex" },
    ])).toEqual([createDefaultClaudeAgentCommand()]);
  });

  it("validates complete Command configuration without silently dropping collisions", () => {
    const claude = createDefaultClaudeAgentCommand();
    const codex = createDefaultCodexAgentCommand();
    const custom = {
      ...codex,
      id: "custom",
      label: "Local",
      handle: "local",
      command: "/bin/echo local",
      adapter: "generic" as const,
    };
    expect(agentCommandConfigurationError([claude])).toBeNull();
    expect(agentCommandConfigurationError([
      claude,
      { ...claude, id: "claude-copy", command: "claude --model opus" },
    ])).toBe("Command handle @claude is already configured.");
    expect(agentCommandConfigurationError([
      claude,
      { ...claude, handle: "other", command: "claude --model opus" },
    ])).toBe('Command id "claude" is already configured.');
    expect(agentCommandConfigurationError([{ ...claude, command: "" }])).toContain("Command 1 is malformed");
    expect(agentCommandConfigurationError([{ ...claude, id: "???" }])).toBe("Command 1 has a non-canonical id.");
    expect(agentCommandConfigurationError([{ ...claude, handle: "@CLAUDE" }])).toBe("Command 1 has a non-canonical handle.");
    expect(agentCommandConfigurationError([{ ...claude, adapter: "unknown" }])).toBe("Command 1 has a non-canonical adapter.");
    expect(agentCommandConfigurationError([{ ...claude, cwdPolicy: "unknown" }])).toBe("Command 1 has a non-canonical working-folder policy.");
    expect(agentCommandConfigurationError([{ ...claude, version: "one" }])).toBe("Command 1 has a non-canonical version.");
    expect(agentCommandConfigurationError([{ ...claude, enabled: "yes" }])).toBe("Command 1 has a non-canonical enabled state.");
    expect(agentCommandConfigurationError([
      claude,
      codex,
      custom,
      { ...custom, id: "other", label: "Other", handle: "other" },
    ])).toBe("Only one Custom command can be configured.");
    expect(agentCommandConfigurationError([
      { ...claude, handle: "local" },
      { ...custom, id: "other", handle: "other" },
    ])).toBe("Only one Custom command can be configured.");
  });

  it("formats a note invocation with Exograph workspace and referenced-note guidance", () => {
    const protocolInvocationId = "11111111-1111-4111-8111-111111111111";
    const prompt = formatNoteInvocationPrompt({
      workspaceRoot: "/workspace",
      noteRoots: ["/workspace/notes", "/workspace/research"],
      documentPath: "/workspace/notes/task.md",
      mentionText: "@claude",
      message: "Read [[research/self-improving-systems|the essay]] and tell me what you think.",
      protocolInvocationId,
      agentHandle: "claude",
      frontmatter: { tags: ["exograph"] },
      body: "# Task\n\nCurrent draft",
    });
    expect(prompt).toContain("Working note:\n/workspace/notes/task.md");
    expect(prompt).toContain("Message:\nRead [[research/self-improving-systems|the essay]] and tell me what you think.");
    expect(prompt).toContain('"tags": [');
    expect(prompt).toContain("# Task");
    expect(prompt).toContain("Exograph Workspace");
    expect(prompt).toContain("Workspace root:\n/workspace");
    expect(prompt).toContain("Configured Note Roots:\n- /workspace/notes\n- /workspace/research");
    expect(prompt).toContain("configured Note Roots");
    expect(prompt).toContain("[[durable/path/to/note|Readable title]]");
    expect(prompt).toContain("[[note-name]]");
    expect(prompt).toContain("native filesystem tools or Exograph CLI/Search");
    expect(prompt).toContain("prefer the durable path target with a readable alias");
    expect(prompt).toContain("Exograph document-agent protocol:");
    expect(prompt).toContain(`<exograph-agent-response invocation="${protocolInvocationId}" agent="claude">`);
    expect(prompt).toContain("Use a filesystem Edit or Write tool to modify the Working note path");
    expect(prompt).toContain("Printing XML in stdout or assistant text does not write it to the note");
    expect(prompt).toContain("Do not claim completion unless the filesystem tool reports success");
    expect(prompt).toContain("Do not print the response envelope in your final summary");
  });

  it("renders a saved prompt template while protecting required context and protocol", () => {
    const invocationId = "11111111-1111-4111-8111-111111111111";
    const prompt = formatNoteInvocationPrompt({
      promptTemplate: "Be concise.\n{{message}}\n{{protocol}}",
      documentPath: "/workspace/notes/task.md",
      mentionText: "@claude",
      message: "Review this.",
      protocolInvocationId: invocationId,
      agentHandle: "claude",
    });

    expect(prompt).toContain("Be concise.\nReview this.");
    expect(prompt).toContain(`exactly one <exograph-agent-response> linked to invocation ${invocationId}`);
    expect(prompt).toContain("Working note:\n/workspace/notes/task.md");
  });

  it("keeps opinion and analysis requests response-only unless edits are useful", () => {
    const prompt = formatNoteInvocationPrompt({
      documentPath: "/workspace/notes/essay.md",
      mentionText: "@claude",
      message: "What do you think of this essay?",
      protocolInvocationId: "11111111-1111-4111-8111-111111111111",
      agentHandle: "claude",
      body: "# Essay\n\nDraft",
    });

    expect(prompt).toContain("For an answer-shaped request");
    expect(prompt).toContain("the linked Exograph agent response is the deliverable");
    expect(prompt).toContain("Make direct Markdown edits only when requested or genuinely useful.");
    expect(prompt).not.toContain("Complete the user's request by editing the working document directly");
    expect(prompt).not.toContain("write the useful result into the working document in the appropriate place");
  });

  it("directs requested document changes to ordinary reviewable Markdown", () => {
    const prompt = formatNoteInvocationPrompt({
      documentPath: "/workspace/notes/essay.md",
      mentionText: "@claude",
      message: "Rewrite the introduction and add two sources.",
      protocolInvocationId: "11111111-1111-4111-8111-111111111111",
      agentHandle: "claude",
      body: "# Essay\n\nDraft",
    });

    expect(prompt).toContain("For an edit-shaped request, edit the relevant Markdown directly");
    expect(prompt).toContain("use the linked Exograph agent response as a concise receipt describing those edits");
    expect(prompt).toContain("Direct edits remain ordinary Markdown and Exograph presents them for review.");
  });

  it("marks the supplied note snapshot as bounded and directs full reads to disk", () => {
    const withBody = formatNoteInvocationPrompt({
      documentPath: "/workspace/notes/large.md",
      mentionText: "@claude",
      message: "Check the conclusion.",
      body: "# Large note\n\nPartial snapshot",
    });
    const withoutBody = formatNoteInvocationPrompt({
      documentPath: "/workspace/notes/large.md",
      mentionText: "@claude",
      message: "Check the conclusion.",
    });

    expect(withBody).toContain("--- body snapshot (may be truncated) ---");
    expect(withBody).toContain("--- end bounded snapshot; read the working note from disk when more context is needed ---");
    expect(withoutBody).toContain("The current body was not supplied; read the file from disk.");
  });

  it("bounds a large snapshot around its matching protocol invocation with omission markers", () => {
    const invocationId = "11111111-1111-4111-8111-111111111111";
    const envelope = formatDocumentAgentInvocation({
      id: invocationId,
      agent: "claude",
      message: "@claude inspect the nearby argument",
    });
    const body = [
      `FAR_PREFIX_${"a".repeat(40_000)}`,
      "NEAR_CONTEXT_BEFORE",
      envelope,
      "NEAR_CONTEXT_AFTER",
      `${"b".repeat(40_000)}_FAR_SUFFIX`,
    ].join("\n");
    const prompt = formatNoteInvocationPrompt({
      documentPath: "/workspace/notes/large.md",
      mentionText: "@claude",
      message: "Inspect the nearby argument.",
      protocolInvocationId: invocationId,
      agentHandle: "claude",
      body,
    });
    const snapshot = bodySnapshotFromPrompt(prompt);

    expect(snapshot.length).toBeLessThanOrEqual(NOTE_INVOCATION_SNAPSHOT_MAX_CHARACTERS);
    expect(snapshot).toContain("NEAR_CONTEXT_BEFORE");
    expect(snapshot).toContain(envelope);
    expect(snapshot).toContain("NEAR_CONTEXT_AFTER");
    expect(snapshot).not.toContain("FAR_PREFIX_");
    expect(snapshot).not.toContain("_FAR_SUFFIX");
    expect(snapshot).toMatch(/^\[\.\.\. \d+ characters omitted before snapshot; read the working note from disk for full content \.\.\.\]/);
    expect(snapshot).toMatch(/\[\.\.\. \d+ characters omitted after snapshot; read the working note from disk for full content \.\.\.\]$/);
  });

  it("bounds an untagged no-protocol snapshot around the last matching mention", () => {
    const body = `${"a".repeat(45_000)}\nLEGACY_NEAR @claude explain this\n${"b".repeat(45_000)}`;
    const prompt = formatNoteInvocationPrompt({
      documentPath: "/workspace/notes/untagged.md",
      mentionText: "@claude",
      message: "Explain this.",
      body,
    });
    const snapshot = bodySnapshotFromPrompt(prompt);

    expect(snapshot.length).toBeLessThanOrEqual(NOTE_INVOCATION_SNAPSHOT_MAX_CHARACTERS);
    expect(snapshot).toContain("LEGACY_NEAR @claude explain this");
    expect(snapshot).toContain("characters omitted before snapshot");
    expect(snapshot).toContain("characters omitted after snapshot");
  });

  it("requires one linked, durable page-native response rather than a transient result", () => {
    const invocationId = "11111111-1111-4111-8111-111111111111";
    const prompt = formatNoteInvocationPrompt({
      documentPath: "/workspace/notes/essay.md",
      mentionText: "@claude",
      message: "Summarize the argument.",
      protocolInvocationId: invocationId,
      agentHandle: "claude",
    });

    expect(prompt).toContain(`exactly one <exograph-agent-response> linked to invocation ${invocationId}`);
    expect(prompt).toContain("Exograph renders that envelope as the colored, page-native agent response");
    expect(prompt).toContain("Never leave the useful answer only in stdout, chat, or another transient surface.");
    expect(prompt.match(/<exograph-agent-response invocation=/g)).toHaveLength(1);
  });

  it("round-trips the inert document-agent envelopes and ignores malformed source", () => {
    const invocationId = "11111111-1111-4111-8111-111111111111";
    const document = [
      "# Note",
      formatDocumentAgentInvocation({ id: invocationId, agent: "claude", message: "@claude inspect this note" }),
      formatDocumentAgentResponse({ invocationId, agent: "claude", message: "## Finding\n\nThe durable result." }),
      '<exograph-agent-response invocation="not-an-id" agent="claude">\nIgnore me\n</exograph-agent-response>',
    ].join("\n\n");
    expect(findDocumentAgentEnvelopes(document)).toEqual([
      expect.objectContaining({ kind: "invocation", id: invocationId, agent: "claude", status: "sent" }),
      expect.objectContaining({ kind: "response", invocationId, agent: "claude" }),
    ]);
  });

  it("renders durable exo invocation envelopes created before the product rename", () => {
    const invocationId = "11111111-1111-4111-8111-111111111111";
    const document = [
      "# Note",
      `<exo-invocation id="${invocationId}" agent="claude" status="sent">\n@claude inspect this note\n</exo-invocation>`,
      `<exo-agent-response invocation="${invocationId}" agent="claude">\nThe durable result.\n</exo-agent-response>`,
    ].join("\n\n");

    expect(findDocumentAgentEnvelopes(document)).toEqual([
      expect.objectContaining({ kind: "invocation", id: invocationId, agent: "claude", status: "sent" }),
      expect.objectContaining({ kind: "response", invocationId, agent: "claude" }),
    ]);
    expect(containsDocumentAgentProtocolSyntax(document)).toBe(true);
    expect(containsDocumentAgentProtocolSyntax("ordinary prose about an invocation")).toBe(false);
  });

  it("renders an id-less source envelope but never treats it as an executable V1 invocation", () => {
    const document = '<exograph-invocation agent="claude" status="sent">\n@claude preserved source\n</exograph-invocation>';

    expect(findDocumentAgentEnvelopes(document)).toEqual([
      expect.objectContaining({ kind: "invocation", agent: "claude", status: "sent" }),
    ]);
    expect(findDocumentAgentEnvelopes(document)[0]).not.toHaveProperty("id");
    expect(removeDocumentAgentInvocation(
      document,
      "11111111-1111-4111-8111-111111111111",
      "claude",
    )).toBeNull();
  });

  it("derives the clean base by removing only the exact invocation envelope", () => {
    const invocationId = "11111111-1111-4111-8111-111111111111";
    const before = "# Note\n\nHuman work before\n\n";
    const after = "\n\nHuman work after\n";
    const envelope = formatDocumentAgentInvocation({
      id: invocationId,
      agent: "claude",
      message: "@claude inspect this note",
    });
    const launch = `${before}${envelope}${after}`;

    expect(removeDocumentAgentInvocation(launch, invocationId, "claude")).toBe(`${before}${after}`);
    expect(removeDocumentAgentInvocation(launch, invocationId, "codex")).toBeNull();
    expect(removeDocumentAgentInvocation(launch, "not-an-id", "claude")).toBeNull();
  });

  it("normalizes exact invocation records and ignores obsolete attribution fields", () => {
    const record = normalizeInvocationRecord({
      id: "inv-1",
      status: "pending",
      context: "note",
      taggedDocumentPath: "/tmp/note.md",
      originalMentionText: "@claude summarize this",
      mentionProvenance: "human-authored",
      message: "summarize this",
      promptDelivery: "stdin",
      command: createDefaultClaudeAgentCommand(),
      cwd: "/tmp",
      workspaceRoot: "/tmp",
      noteRoots: ["/tmp/notes"],
      createdAt: "2026-07-08T00:00:00.000Z",
      changedFileRefs: [{ path: "/tmp/note.md", kind: "modified", attribution: "ambiguous", diffRefId: "diff-1" }],
      diffRefs: [{ id: "diff-1", path: "/tmp/note.md", format: "unified", ref: ".exograph/invocations/inv-1/diff.patch" }],
      attribution: { status: "ambiguous", reason: "user and agent touched the file during the invocation window" },
      providerSessionId: "ce4b9e26-2574-4433-a054-1110cd403792",
      continuity: { policy: "continuous", outcome: "resumed", resumedFromInvocationId: "inv-0" },
      skill: {
        id: "find-and-connect-relevant-context",
        label: "Find and connect relevant context",
        path: "/tmp/notes/skills/find-and-connect-relevant-context.md",
        revision: "c".repeat(64),
        graphSnapshotId: "graph:12",
        ontology: {
          state: "active",
          id: "research",
          sourcePath: "ontologies/research.yaml",
          revision: "d".repeat(64),
        },
      },
      review: { status: "pending", beforeSha256: "a".repeat(64), afterSha256: "b".repeat(64) },
      changeset: {
        version: 1,
        status: "pending-review",
        settledAt: "2026-07-08T00:01:00.000Z",
        files: [{
          id: "modified:/tmp/note.md",
          operation: "modified",
          decision: { status: "pending" },
          before: { path: "/tmp/note.md", sha256: "a".repeat(64), byteLength: 1, snapshotRef: `files/objects/${"a".repeat(64)}`, mediaType: "text" },
          after: { path: "/tmp/note.md", sha256: "b".repeat(64), byteLength: 1, snapshotRef: `files/objects/${"b".repeat(64)}`, mediaType: "text" },
        }],
      },
    });

    expect(record).toMatchObject({
      id: "inv-1",
      status: "pending",
      context: "note",
      promptDelivery: "stdin",
      command: { id: "claude", handle: "claude", version: 1, executableFingerprint: expect.any(String) },
      providerSessionId: "ce4b9e26-2574-4433-a054-1110cd403792",
      continuity: { policy: "continuous", outcome: "resumed", resumedFromInvocationId: "inv-0" },
      skill: {
        id: "find-and-connect-relevant-context",
        graphSnapshotId: "graph:12",
        ontology: {
          state: "active",
          sourcePath: "ontologies/research.yaml",
        },
      },
      noteRoots: ["/tmp/notes"],
      changeset: { status: "pending-review", files: [{ operation: "modified" }] },
    });
    expect(record).not.toHaveProperty("changedFileRefs");
    expect(record).not.toHaveProperty("diffRefs");
    expect(record).not.toHaveProperty("attribution");
    expect(record).not.toHaveProperty("review");
  });

  it("drops malformed persisted review hashes and session provenance", () => {
    const record = normalizeInvocationRecord({
      id: "inv-unsafe", status: "process-exited", context: "cli", message: "task", promptDelivery: "stdin",
      command: createDefaultClaudeAgentCommand(), cwd: "/tmp", createdAt: "2026-07-08T00:00:00.000Z",
      providerSessionId: "made-up", review: { status: "pending", beforeSha256: "invalid", afterSha256: "also-invalid" },
    });
    expect(record?.providerSessionId).toBeUndefined();
    expect(record).not.toHaveProperty("review");
    expect(record?.continuity).toEqual({ policy: "fresh", outcome: "fresh" });
  });

  it("preserves truthful failed-resume provenance", () => {
    const record = normalizeInvocationRecord({
      id: "inv-resume-failed", status: "failed", context: "cli", message: "task", promptDelivery: "stdin",
      command: createDefaultClaudeAgentCommand(), cwd: "/tmp", createdAt: "2026-07-08T00:00:00.000Z",
      continuity: { policy: "continuous", outcome: "resume-failed", resumedFromInvocationId: "inv-0" },
    });
    expect(record?.continuity).toEqual({ policy: "continuous", outcome: "resume-failed", resumedFromInvocationId: "inv-0" });
  });

  it("rejects pre-launch invocation prompt delivery records", () => {
    expect(normalizeInvocationRecord({
      id: "inv-cli",
      status: "user-ended",
      context: "cli",
      message: "Inspect the repo",
      promptDelivery: "terminalInputAfterLaunch",
      command: createDefaultClaudeAgentCommand(),
      cwd: "/tmp",
      createdAt: "2026-07-08T00:00:00.000Z",
    })).toBeNull();
  });
});

function bodySnapshotFromPrompt(prompt: string): string {
  const startMarker = "--- body snapshot (may be truncated) ---\n";
  const endMarker = "\n--- end bounded snapshot; read the working note from disk when more context is needed ---";
  const start = prompt.indexOf(startMarker);
  const end = prompt.indexOf(endMarker, start + startMarker.length);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return prompt.slice(start + startMarker.length, end);
}
