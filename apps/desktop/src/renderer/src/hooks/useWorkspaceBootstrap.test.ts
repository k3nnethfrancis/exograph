import { describe, expect, it } from "vitest";

import { createDefaultClaudeAgentCommand, createDefaultCodexAgentCommand } from "@exograph/core/default-agent-command";
import {
  onboardingDraftFromState,
  onboardingRuntimeApplyDecision,
  onboardingStateFromDraft,
  type OnboardingState,
} from "./useWorkspaceBootstrap";

describe("onboarding runtime apply decisions", () => {
  it("only completes onboarding after a fully applied runtime", () => {
    expect(onboardingRuntimeApplyDecision({ status: "applied" })).toEqual({ action: "complete" });
  });

  it("keeps a committed-but-degraded workspace retryable without marking setup healthy", () => {
    expect(onboardingRuntimeApplyDecision({
      status: "degraded",
      errorMessage: "command discovery needs recovery",
    })).toEqual({
      action: "retry",
      errorMessage: "Your workspace is open, but one runtime service needs attention: command discovery needs recovery Retry to recover it before continuing.",
    });
  });

  it("restores the exact confirmed draft without provider success state", () => {
    const draft = onboardingDraftFromState(state());
    expect(onboardingStateFromDraft(draft, [])).toEqual({
      ...state(),
      contentInspection: null,
      status: "idle",
      errorMessage: null,
    });
    expect(draft).not.toHaveProperty("mcpResults");
    expect(draft).not.toHaveProperty("mcpInstalled");
  });

  it("projects edited Commands, prompt, policy, search, and MCP selections into progress", () => {
    const current = state();
    current.agentCommands[0] = { ...current.agentCommands[0], command: "claude -p --model sonnet" };
    current.agentInvocationPrompt = "Confirmed {{message}} for {{working_note}}.";
    current.contentPolicy = { excludedPaths: ["dist/**"], sourceVisibility: true };
    current.contentPolicyChoice = "explicit";
    current.selectedMcpProviders = ["codex"];

    expect(onboardingDraftFromState(current)).toMatchObject({
      step: "agents",
      notesFolder: "/Users/tester/wiki",
      defaultTerminalCwd: "/Users/tester",
      contentPolicy: { excludedPaths: ["dist/**"], sourceVisibility: true },
      contentPolicyChoice: "explicit",
      search: {
        indexMode: "hybrid",
        searchEngine: "qmd",
        exploreIndexSearchOnEnter: true,
        indexUpdateStrategy: "manual",
      },
      agentCommands: [{ command: "claude -p --model sonnet" }, { id: "codex" }],
      agentInvocationPrompt: "Confirmed {{message}} for {{working_note}}.",
      selectedMcpProviders: ["codex"],
    });
  });
});

function state(): OnboardingState {
  return {
    mode: "first-run",
    step: "agents",
    workspaces: [],
    selectedWorkspaceId: null,
    notesFolder: "/Users/tester/wiki",
    defaultTerminalCwd: "/Users/tester",
    contentPolicy: { excludedPaths: [".git/**"], sourceVisibility: false },
    contentPolicyChoice: "recommended",
    contentInspection: { kind: "repository", signals: [".git"], recommendedPolicy: { excludedPaths: [".git/**"], sourceVisibility: false } },
    indexMode: "hybrid",
    searchEngine: "qmd",
    exploreIndexSearchOnEnter: true,
    indexUpdateStrategy: "manual",
    agentCommands: [createDefaultClaudeAgentCommand(), createDefaultCodexAgentCommand()],
    defaultAgentCommandId: "codex",
    agentInvocationPrompt: "Use {{message}} for {{working_note}}.",
    selectedMcpProviders: ["claude", "codex"],
    status: "idle",
    errorMessage: null,
  };
}
