import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { defaultWorkspaceContentPolicy } from "@exograph/core/workspace-content-policy";

import { OnboardingFlow } from "./OnboardingFlow";
import type { OnboardingState } from "../hooks/useWorkspaceBootstrap";

describe("OnboardingFlow", () => {
  it("renders the existing persisted setup model through a dedicated surface", () => {
    const state: OnboardingState = {
      mode: "first-run",
      step: "configure",
      workspaces: [],
      selectedWorkspaceId: null,
      notesFolder: "",
      defaultTerminalCwd: "",
      contentPolicy: defaultWorkspaceContentPolicy(),
      contentPolicyChoice: "recommended",
      contentInspection: null,
      indexMode: "lexical",
      searchEngine: "qmd",
      exploreIndexSearchOnEnter: false,
      indexUpdateStrategy: "on-save",
      agentCommands: [],
      defaultAgentCommandId: null,
      agentInvocationPrompt: "",
      selectedMcpProviders: ["claude", "codex"],
      status: "idle",
      errorMessage: null,
    };

    const html = renderToStaticMarkup(
      <OnboardingFlow
        actions={{
          activateSelectedWorkspace: vi.fn(),
          completeOnboarding: vi.fn(),
          confirmOnboardingChange: vi.fn(),
          continueFromWorkspaceConfigure: vi.fn(),
          persistCurrentOnboardingState: vi.fn(),
          resetMalformedOnboardingProgress: vi.fn(),
          selectDefaultTerminalForOnboarding: vi.fn(),
          selectNotesFolderForOnboarding: vi.fn(),
          startNewWorkspaceSetup: vi.fn(),
        }}
        onDismiss={vi.fn()}
        onEditState={vi.fn()}
        state={state}
      />,
    );

    expect(html).toContain('data-testid="onboarding"');
    expect(html).toContain("Choose your main wiki");
    expect(html).toContain('data-testid="onboarding-choose-notes"');
  });

  it("lets setup choose the agent used by Exograph features", () => {
    const state: OnboardingState = {
      mode: "first-run",
      step: "agents",
      workspaces: [],
      selectedWorkspaceId: null,
      notesFolder: "/workspace/notes",
      defaultTerminalCwd: "/workspace",
      contentPolicy: defaultWorkspaceContentPolicy(),
      contentPolicyChoice: "recommended",
      contentInspection: null,
      indexMode: "lexical",
      searchEngine: "qmd",
      exploreIndexSearchOnEnter: true,
      indexUpdateStrategy: "on-save",
      agentCommands: [
        { id: "claude", label: "Claude", handle: "claude", command: "claude -p", adapter: "claude-code", continuityPolicy: "continuous", cwdPolicy: "workspace_root", promptDelivery: "stdin", version: 1, enabled: true },
        { id: "codex", label: "Codex", handle: "codex", command: "codex exec -", adapter: "codex-cli", continuityPolicy: "fresh", cwdPolicy: "workspace_root", promptDelivery: "stdin", version: 1, enabled: true },
      ],
      defaultAgentCommandId: "codex",
      agentInvocationPrompt: "Use {{message}} for {{working_note}}.",
      selectedMcpProviders: ["claude", "codex"],
      status: "idle",
      errorMessage: null,
    };

    const html = renderToStaticMarkup(
      <OnboardingFlow
        actions={{
          activateSelectedWorkspace: vi.fn(), completeOnboarding: vi.fn(), confirmOnboardingChange: vi.fn(),
          continueFromWorkspaceConfigure: vi.fn(), persistCurrentOnboardingState: vi.fn(), resetMalformedOnboardingProgress: vi.fn(),
          selectDefaultTerminalForOnboarding: vi.fn(), selectNotesFolderForOnboarding: vi.fn(), startNewWorkspaceSetup: vi.fn(),
        }}
        onDismiss={vi.fn()}
        onEditState={vi.fn()}
        state={state}
      />,
    );

    expect(html).toContain("Default agent");
    expect(html).toContain('data-testid="onboarding-default-agent"');
    expect(html).toContain('<option value="codex" selected="">Codex</option>');
  });
});
