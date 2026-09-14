import { access, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createDefaultClaudeAgentCommand, createDefaultCodexAgentCommand } from "../default-agent-command";
import {
  beginOnboardingProgress,
  emptyOnboardingStateStore,
  markOnboardingComplete,
  onboardingStatePath,
  readOnboardingStateStore,
  validateOnboardingProgressDraft,
  validateOnboardingStateStore,
  writeOnboardingStateStore,
  type OnboardingProgressDraft,
  type OnboardingStateStore,
} from "../onboarding-state";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("onboarding state", () => {
  it("keeps the empty state free of unconfirmed Workspace authority", () => {
    expect(emptyOnboardingStateStore()).toEqual({
      version: 1,
      status: "not-started",
      phase: "workspace",
      workspaceBasicsSaved: false,
    });
  });

  it("validates the complete versioned draft without projecting unknown persisted keys", () => {
    expect(validateOnboardingProgressDraft({
      ...draft(),
      futureState: { enabled: true },
    })).toEqual(draft());
  });

  it("rejects partial, aliased, and invalid in-progress drafts", () => {
    expect(() => validateOnboardingProgressDraft({ ...draft(), version: 2 })).toThrow("version 1");
    expect(() => validateOnboardingProgressDraft({ ...draft(), step: "tools" })).toThrow("step");
    expect(() => validateOnboardingProgressDraft({ ...draft(), contentPolicyChoice: "automatic" })).toThrow("contentPolicyChoice");
    expect(() => validateOnboardingProgressDraft({ ...draft(), notesFolder: 42 })).toThrow("notesFolder");
    expect(() => validateOnboardingProgressDraft({
      ...draft(),
      contentPolicy: { excludedPaths: [".git/**", 42], sourceVisibility: false },
    })).toThrow("contentPolicy");
    expect(() => validateOnboardingProgressDraft({ ...draft(), agentCommands: [{ id: "broken" }] })).toThrow("agentCommands");
    expect(() => validateOnboardingProgressDraft({ ...draft(), selectedMcpProviders: ["claude", "other"] })).toThrow("selectedMcpProviders");
  });

  it("rejects non-canonical Commands and a second Custom Command in explicit drafts", () => {
    const claude = createDefaultClaudeAgentCommand();
    for (const nonCanonical of [
      { ...claude, id: "???" },
      { ...claude, handle: "@CLAUDE" },
      { ...claude, adapter: "unknown" },
      { ...claude, cwdPolicy: "unknown" },
      { ...claude, version: "one" },
      { ...claude, enabled: "yes" },
    ]) {
      expect(() => validateOnboardingProgressDraft({
        ...draft(),
        agentCommands: [nonCanonical],
      })).toThrow("non-canonical");
    }

    const custom = {
      ...createDefaultCodexAgentCommand(),
      id: "custom",
      label: "Local",
      handle: "local",
      command: "/bin/echo local",
      adapter: "generic" as const,
    };
    expect(() => validateOnboardingProgressDraft({
      ...draft(),
      agentCommands: [
        createDefaultClaudeAgentCommand(),
        createDefaultCodexAgentCommand(),
        custom,
        { ...custom, id: "other", label: "Other", handle: "other" },
      ],
    })).toThrow("Only one Custom command can be configured");
  });

  it("does not write invalid explicit draft progress", async () => {
    const root = await temporaryRoot();
    const custom = {
      ...createDefaultCodexAgentCommand(),
      id: "custom",
      label: "Local",
      handle: "local",
      command: "/bin/echo local",
      adapter: "generic" as const,
    };
    const invalidDrafts = [
      {
        draft: {
          ...draft(),
          agentCommands: [{ ...createDefaultClaudeAgentCommand(), handle: "@CLAUDE" }],
        },
        error: "non-canonical handle",
      },
      {
        draft: {
          ...draft(),
          agentCommands: [
            custom,
            { ...custom, id: "other", label: "Other", handle: "other" },
          ],
        },
        error: "Only one Custom command can be configured",
      },
    ];

    for (const invalid of invalidDrafts) {
      await expect(writeOnboardingStateStore(root, {
        version: 1,
        status: "in-progress",
        phase: "workspace",
        workspaceBasicsSaved: false,
        draft: invalid.draft,
      } as OnboardingStateStore)).rejects.toThrow(invalid.error);
      await expect(access(onboardingStatePath(root))).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readdir(root)).toEqual([]);
    }
  });

  it("keeps legacy startup reads tolerant of canonicalizable Command fields", async () => {
    const root = await temporaryRoot();
    const legacyDraft = {
      ...draft(),
      agentCommands: [{
        ...createDefaultClaudeAgentCommand(),
        id: "???",
        handle: "@CLAUDE",
        adapter: "unknown",
        cwdPolicy: "unknown",
        version: "one",
        enabled: "yes",
      }],
    };
    await writeFile(onboardingStatePath(root), JSON.stringify({
      version: 1,
      status: "in-progress",
      phase: "workspace",
      workspaceBasicsSaved: false,
      draft: legacyDraft,
    }), "utf8");

    await expect(readOnboardingStateStore(root)).resolves.toMatchObject({
      kind: "valid",
      state: {
        draft: {
          agentCommands: [{
            id: "---",
            handle: "claude",
            adapter: "generic",
            cwdPolicy: "workspace_root",
            version: 1,
            enabled: true,
          }],
        },
      },
    });
  });

  it("requires a draft for explicit in-progress state and removes it on completion", () => {
    expect(() => validateOnboardingStateStore({
      version: 1,
      status: "in-progress",
      phase: "workspace",
      workspaceBasicsSaved: false,
    })).toThrow("requires a valid draft");

    const inProgress = beginOnboardingProgress(
      emptyOnboardingStateStore(),
      draft(),
      "2026-07-26T10:00:00.000Z",
    );
    expect(inProgress).toEqual({
      version: 1,
      status: "in-progress",
      phase: "workspace",
      workspaceBasicsSaved: false,
      draft: draft(),
      updatedAt: "2026-07-26T10:00:00.000Z",
    });

    expect(markOnboardingComplete(inProgress, "2026-07-26T10:01:00.000Z")).toEqual({
      version: 1,
      status: "complete",
      phase: "done",
      workspaceBasicsSaved: true,
      updatedAt: "2026-07-26T10:01:00.000Z",
      completedAt: "2026-07-26T10:01:00.000Z",
    });
  });

  it("distinguishes a missing state file from malformed progress for visible recovery", async () => {
    const root = await temporaryRoot();

    await expect(readOnboardingStateStore(root)).resolves.toEqual({
      kind: "missing",
      state: emptyOnboardingStateStore(),
    });

    await writeFile(onboardingStatePath(root), "{ truncated", "utf8");
    await expect(readOnboardingStateStore(root)).resolves.toMatchObject({
      kind: "malformed",
      state: emptyOnboardingStateStore(),
      errorMessage: expect.stringContaining("could not be read"),
    });

    await writeFile(onboardingStatePath(root), JSON.stringify({
      version: 1,
      status: "in-progress",
      phase: "workspace",
      workspaceBasicsSaved: false,
    }), "utf8");
    await expect(readOnboardingStateStore(root)).resolves.toMatchObject({
      kind: "malformed",
      errorMessage: expect.stringContaining("could not be read"),
    });
  });

  it("atomically replaces progress and leaves no temporary state file", async () => {
    const root = await temporaryRoot();
    const first = beginOnboardingProgress(emptyOnboardingStateStore(), draft(), "2026-07-26T10:00:00.000Z");
    const second = beginOnboardingProgress(first, { ...draft(), step: "agents" }, "2026-07-26T10:01:00.000Z");

    await writeOnboardingStateStore(root, first);
    await writeOnboardingStateStore(root, second);

    expect(JSON.parse(await readFile(onboardingStatePath(root), "utf8"))).toEqual(second);
    expect((await readdir(root)).filter((entry) => entry.endsWith(".tmp"))).toEqual([]);
  });
});

function draft(): OnboardingProgressDraft {
  return {
    version: 1,
    step: "mcp",
    selectedWorkspaceId: null,
    notesFolder: "/Users/tester/wiki",
    defaultTerminalCwd: "/Users/tester",
    contentPolicy: {
      excludedPaths: [".git/**", "node_modules/**"],
      sourceVisibility: false,
    },
    contentPolicyChoice: "recommended",
    search: {
      indexMode: "lexical",
      searchEngine: "qmd",
      exploreIndexSearchOnEnter: true,
      indexUpdateStrategy: "on-save",
    },
    agentCommands: [createDefaultClaudeAgentCommand(), createDefaultCodexAgentCommand()],
    defaultAgentCommandId: "codex",
    agentInvocationPrompt: "Use {{working_note}} and {{message}}.",
    selectedMcpProviders: ["claude", "codex"],
  };
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "exograph-onboarding-state-"));
  temporaryRoots.push(root);
  return root;
}
