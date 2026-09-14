import { describe, expect, it } from "vitest";

import { emptyOnboardingStateStore, beginOnboardingProgress, markOnboardingComplete } from "@exograph/core";
import { createDefaultClaudeAgentCommand, createDefaultCodexAgentCommand } from "@exograph/core/default-agent-command";
import { hasOperatorWorkspaceSetup, workspaceSetupDecision } from "./workspace-setup-gate";

describe("workspace setup gate", () => {
  it("does not let an inherited note-root environment bypass a real user's onboarding", () => {
    expect(hasOperatorWorkspaceSetup({ EXOGRAPH_NOTE_ROOTS: "/Users/example/notes" })).toBe(false);
  });

  it("permits explicit isolated test fixtures", () => {
    expect(hasOperatorWorkspaceSetup({ EXOGRAPH_TEST: "1", EXOGRAPH_NOTE_ROOTS: "/tmp/fixture/notes" })).toBe(true);
  });

  it("does not bypass setup for an empty test root", () => {
    expect(hasOperatorWorkspaceSetup({ EXOGRAPH_TEST: "1", EXOGRAPH_NOTE_ROOTS: "  " })).toBe(false);
  });

  it("keeps pristine and explicit in-progress installs in onboarding", () => {
    expect(workspaceSetupDecision({
      hasWorkspaceSettings: false,
      onboarding: { kind: "missing", state: emptyOnboardingStateStore() },
      operatorSetupComplete: false,
    })).toEqual({ complete: false, onboardingRecovery: null });

    const inProgress = beginOnboardingProgress(emptyOnboardingStateStore(), draft());
    for (const hasWorkspaceSettings of [false, true]) {
      expect(workspaceSetupDecision({
        hasWorkspaceSettings,
        onboarding: { kind: "valid", state: inProgress },
        operatorSetupComplete: false,
      })).toEqual({ complete: false, onboardingRecovery: null });
    }
  });

  it("opens completed and legacy settings installs without trapping them", () => {
    expect(workspaceSetupDecision({
      hasWorkspaceSettings: true,
      onboarding: { kind: "valid", state: markOnboardingComplete(emptyOnboardingStateStore()) },
      operatorSetupComplete: false,
    })).toEqual({ complete: true, onboardingRecovery: null });

    expect(workspaceSetupDecision({
      hasWorkspaceSettings: true,
      onboarding: { kind: "missing", state: emptyOnboardingStateStore() },
      operatorSetupComplete: false,
    })).toEqual({ complete: true, onboardingRecovery: null });
  });

  it("keeps malformed progress visible and non-destructive even when settings exist", () => {
    expect(workspaceSetupDecision({
      hasWorkspaceSettings: true,
      onboarding: {
        kind: "malformed",
        state: emptyOnboardingStateStore(),
        errorMessage: "Saved setup progress could not be read.",
      },
      operatorSetupComplete: false,
    })).toEqual({
      complete: false,
      onboardingRecovery: {
        kind: "malformed",
        message: "Saved setup progress could not be read.",
      },
    });
  });

  it("keeps explicit operator fixtures independent from persisted progress", () => {
    expect(workspaceSetupDecision({
      hasWorkspaceSettings: false,
      onboarding: {
        kind: "malformed",
        state: emptyOnboardingStateStore(),
        errorMessage: "broken",
      },
      operatorSetupComplete: true,
    })).toEqual({ complete: true, onboardingRecovery: null });
  });
});

function draft() {
  return {
    version: 1 as const,
    step: "agents" as const,
    selectedWorkspaceId: null,
    notesFolder: "/tmp/wiki",
    defaultTerminalCwd: "/tmp",
    contentPolicy: { excludedPaths: [], sourceVisibility: false },
    contentPolicyChoice: "recommended" as const,
    search: {
      indexMode: "lexical" as const,
      searchEngine: "qmd" as const,
      exploreIndexSearchOnEnter: true,
      indexUpdateStrategy: "on-save" as const,
    },
    agentCommands: [createDefaultClaudeAgentCommand(), createDefaultCodexAgentCommand()],
    defaultAgentCommandId: "codex",
    agentInvocationPrompt: "Use {{working_note}}.",
    selectedMcpProviders: ["claude", "codex"] as Array<"claude" | "codex">,
  };
}
