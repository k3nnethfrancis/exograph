import { useEffect, useState } from "react";
import { Check, Database, Folder, Search, ShieldCheck, SquareTerminal } from "lucide-react";

import {
  defaultWorkspaceContentPolicy,
  repositoryWorkspaceContentPolicy,
} from "@exograph/core/workspace-content-policy";
import { normalizeDefaultAgentCommandId } from "@exograph/core/agent-command-configuration";

import type { CliInstallationStatus, ProviderMcpSetupResult } from "../../../shared/api";
import type { OnboardingState } from "../hooks/useWorkspaceBootstrap";
import { pathLabel } from "../workspaceTree";
import { AgentCommandConfigurator } from "./AgentCommandConfigurator";
import { AgentIcon } from "./AgentIcon";
import { AgentInvocationPromptEditor } from "./AgentInvocationPromptEditor";
import { DefaultAgentSelector } from "./DefaultAgentSelector";
import { PathList } from "./PathList";

export interface OnboardingFlowActions {
  activateSelectedWorkspace: () => Promise<void>;
  completeOnboarding: () => Promise<void>;
  confirmOnboardingChange: (update: (current: OnboardingState) => OnboardingState) => Promise<void>;
  continueFromWorkspaceConfigure: () => Promise<void>;
  persistCurrentOnboardingState: () => Promise<void>;
  resetMalformedOnboardingProgress: () => Promise<void>;
  selectDefaultTerminalForOnboarding: () => Promise<void>;
  selectNotesFolderForOnboarding: () => Promise<void>;
  startNewWorkspaceSetup: () => void;
}

interface OnboardingFlowProps {
  actions: OnboardingFlowActions;
  onDismiss: () => void;
  onEditState: (update: (current: OnboardingState) => OnboardingState) => void;
  state: OnboardingState;
}

interface McpSetupState {
  status: "idle" | "saving" | "done" | "error";
  results: ProviderMcpSetupResult[];
  errorMessage: string | null;
}

const EMPTY_MCP_SETUP: McpSetupState = {
  status: "idle",
  results: [],
  errorMessage: null,
};

export function OnboardingFlow({ actions, onDismiss, onEditState, state }: OnboardingFlowProps) {
  const [mcpSetup, setMcpSetup] = useState<McpSetupState>(EMPTY_MCP_SETUP);
  const [cliInstallation, setCliInstallation] = useState<CliInstallationStatus | null>(null);
  const [cliInstallStatus, setCliInstallStatus] = useState<"idle" | "saving" | "error">("idle");
  const [cliInstallError, setCliInstallError] = useState<string | null>(null);

  useEffect(() => {
    if (state.step !== "mcp") return;
    setMcpSetup(EMPTY_MCP_SETUP);
    setCliInstallStatus("idle");
    setCliInstallError(null);
    let cancelled = false;
    void window.exograph.workspace.getCliInstallationStatus()
      .then((status) => {
        if (!cancelled) setCliInstallation(status);
      })
      .catch(() => {
        if (!cancelled) setCliInstallation({ state: "unavailable", shellPathAvailable: false });
      });
    return () => {
      cancelled = true;
    };
  }, [state.step]);

  const selectedWorkspace = state.workspaces.find(
    (workspace) => workspace.id === state.selectedWorkspaceId,
  ) ?? null;
  const cliReady = cliInstallation?.state === "current";

  async function installMcp() {
    setMcpSetup({ status: "saving", results: [], errorMessage: null });
    try {
      await actions.persistCurrentOnboardingState();
      const results = await window.exograph.workspace.configureProviderMcp({
        providers: state.selectedMcpProviders,
      });
      setMcpSetup({
        status: results.every((result) => result.ok) ? "done" : "error",
        results,
        errorMessage: results.some((result) => !result.ok) ? "MCP setup needs attention." : null,
      });
    } catch (error) {
      setMcpSetup({
        status: "error",
        results: [],
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async function installCli() {
    setCliInstallStatus("saving");
    setCliInstallError(null);
    try {
      setCliInstallation(await window.exograph.workspace.installCli());
      setCliInstallStatus("idle");
    } catch (error) {
      setCliInstallStatus("error");
      setCliInstallError(error instanceof Error ? error.message : String(error));
    }
  }

  return (
    <div className="onboarding-shell" data-testid="onboarding">
      <div className="onboarding-card" data-testid="onboarding-card">
        <div className="onboarding-card__eyebrow">
          {state.mode === "first-run" ? "Set up Exograph" : "Switch workspace"}
        </div>
        {state.step === "recovery" ? (
          <>
            <div className="onboarding-card__body" data-testid="onboarding-recovery">
              <h1 className="onboarding-card__title">Setup progress needs recovery</h1>
              <p className="onboarding-card__copy">
                {state.errorMessage ?? "Exograph could not read the saved setup progress."}
              </p>
              <p className="onboarding-section__hint">
                Restarting setup replaces only the saved setup draft. It does not delete your notes or provider-owned MCP configuration.
              </p>
            </div>
            <div className="onboarding-card__actions">
              <button
                className="toolbar-button toolbar-button--primary"
                data-testid="onboarding-restart-setup"
                onClick={() => void actions.resetMalformedOnboardingProgress()}
                type="button"
              >
                Restart setup
              </button>
            </div>
          </>
        ) : state.step === "select" ? (
          <>
            <div className="onboarding-card__body" data-testid="onboarding-card-body">
              <h1 className="onboarding-card__title">Choose a wiki</h1>
              <p className="onboarding-card__copy">
                Each workspace begins with one main Markdown wiki. It keeps its own search, appearance, and agent settings.
              </p>
              <div className="workspace-picker" data-testid="workspace-picker">
                {state.workspaces.length > 0 ? (
                  state.workspaces.map((workspace) => (
                    <button
                      className={`workspace-picker__item${workspace.id === state.selectedWorkspaceId ? " workspace-picker__item--selected" : ""}`}
                      data-testid="workspace-picker-item"
                      key={workspace.id}
                      onClick={() => void actions.confirmOnboardingChange((current) => ({
                        ...current,
                        selectedWorkspaceId: workspace.id,
                      }))}
                      type="button"
                    >
                      <span className="workspace-picker__name">{workspace.label}</span>
                      <span className="workspace-picker__path">{workspace.notesFolder}</span>
                    </button>
                  ))
                ) : (
                  <div className="path-list__empty" data-testid="workspace-picker-empty">No workspaces yet.</div>
                )}
              </div>
              {selectedWorkspace ? (
                <div className="onboarding-section onboarding-section--summary" data-testid="workspace-picker-detail">
                  <div className="dialog-field__label">{selectedWorkspace.label}</div>
                  <div className="onboarding-section__hint">{selectedWorkspace.notesFolder}</div>
                  <div className="workspace-picker__meta">
                    search {selectedWorkspace.settings.indexing.mode}
                    {" | "}
                    terminal {pathLabel(selectedWorkspace.settings.defaultTerminalCwd)}
                  </div>
                </div>
              ) : null}
            </div>
            <div className="onboarding-card__actions">
              {state.mode === "switch" ? (
                <button className="toolbar-button" onClick={onDismiss} type="button">
                  Cancel
                </button>
              ) : null}
              <button
                className="toolbar-button"
                data-testid="workspace-picker-new"
                onClick={actions.startNewWorkspaceSetup}
                type="button"
              >
                New main wiki
              </button>
              <button
                className="toolbar-button toolbar-button--primary"
                data-testid="workspace-picker-open"
                disabled={!state.selectedWorkspaceId || state.status === "saving"}
                onClick={() => void actions.activateSelectedWorkspace()}
                type="button"
              >
                {state.status === "saving" ? "Opening…" : "Open wiki"}
              </button>
            </div>
          </>
        ) : state.step === "configure" ? (
          <>
            <div className="onboarding-card__body" data-testid="onboarding-card-body">
              <h1 className="onboarding-card__title">
                {state.mode === "first-run" ? "Choose your main wiki" : "Choose a main wiki"}
              </h1>
              <p className="onboarding-card__copy">
                Pick the Markdown folder Exograph should treat as this workspace. You can make another Workspace for a separate wiki later.
              </p>
              <div className="onboarding-grid">
                <div className="onboarding-section onboarding-section--primary">
                  <div className="onboarding-section__header">
                    <div>
                      <div className="dialog-field__label">Main wiki</div>
                      <div className="onboarding-section__hint">Required. Exograph indexes Markdown inside this one folder.</div>
                    </div>
                    <button
                      className="toolbar-button"
                      data-testid="onboarding-choose-notes"
                      onClick={() => void actions.selectNotesFolderForOnboarding()}
                      type="button"
                    >
                      Select
                    </button>
                  </div>
                  <PathList
                    emptyLabel="No main wiki selected."
                    paths={state.notesFolder ? [state.notesFolder] : []}
                    testId="onboarding-notes-folder"
                    onRemove={() => void actions.confirmOnboardingChange((current) => ({
                      ...current,
                      notesFolder: "",
                    }))}
                  />
                </div>
                <details className="onboarding-section onboarding-section--advanced">
                  <summary>Advanced</summary>
                  <div className="onboarding-section__header">
                    <div>
                      <div className="dialog-field__label">Default terminal</div>
                      <div className="onboarding-section__hint">Where new shell, Claude, and Codex sessions start.</div>
                    </div>
                    <button
                      className="toolbar-button"
                      data-testid="onboarding-choose-terminal"
                      onClick={() => void actions.selectDefaultTerminalForOnboarding()}
                      type="button"
                    >
                      Select
                    </button>
                  </div>
                  <PathList
                    emptyLabel={state.notesFolder ? "Defaults to the parent of your notes folder." : "Defaults after you choose notes."}
                    paths={state.defaultTerminalCwd ? [state.defaultTerminalCwd] : []}
                    testId="onboarding-terminal-folder"
                    onRemove={() => void actions.confirmOnboardingChange((current) => ({
                      ...current,
                      defaultTerminalCwd: "",
                    }))}
                  />
                </details>
              </div>
            </div>
            <div className="onboarding-card__actions">
              {state.workspaces.length > 0 || state.mode === "switch" ? (
                <button
                  className="toolbar-button"
                  onClick={() => void actions.confirmOnboardingChange((current) => ({
                    ...current,
                    step: "select",
                  }))}
                  type="button"
                >
                  Back
                </button>
              ) : null}
              <button
                className="toolbar-button toolbar-button--primary"
                data-testid="onboarding-continue"
                disabled={!state.notesFolder.trim() || state.status === "saving"}
                onClick={() => void actions.continueFromWorkspaceConfigure()}
                type="button"
              >
                Continue
              </button>
            </div>
          </>
        ) : state.step === "scope" ? (
          <>
            <div className="onboarding-card__body" data-testid="onboarding-card-body">
              <h1 className="onboarding-card__title">Code repository detected</h1>
              <p className="onboarding-card__copy">
                {state.contentInspection?.signals.length
                  ? `Exograph found ${state.contentInspection.signals.join(" · ")}. `
                  : ""}
                Code files never become Notes. Choose whether Markdown inside tool folders belongs in your graph.
              </p>
              <div className="onboarding-scope-options" data-testid="onboarding-content-scope">
                <button
                  aria-pressed={state.contentPolicy.excludedPaths.length > 0}
                  className={`onboarding-scope-option${state.contentPolicy.excludedPaths.length > 0 ? " onboarding-scope-option--selected" : ""}`}
                  data-testid="onboarding-content-scope-notes"
                  onClick={() => void actions.confirmOnboardingChange((current) => ({
                    ...current,
                    contentPolicy: repositoryWorkspaceContentPolicy(),
                    contentPolicyChoice: "explicit",
                  }))}
                  type="button"
                >
                  <Folder aria-hidden="true" size={18} strokeWidth={1.8} />
                  <span><strong>Repository Markdown</strong><small>Recommended. Keeps authored docs and notes; skips build output and dependency folders.</small></span>
                  {state.contentPolicy.excludedPaths.length > 0 ? <Check aria-label="Selected" size={16} strokeWidth={2.2} /> : null}
                </button>
                <button
                  aria-pressed={state.contentPolicy.excludedPaths.length === 0}
                  className={`onboarding-scope-option${state.contentPolicy.excludedPaths.length === 0 ? " onboarding-scope-option--selected" : ""}`}
                  data-testid="onboarding-content-scope-all"
                  onClick={() => void actions.confirmOnboardingChange((current) => ({
                    ...current,
                    contentPolicy: defaultWorkspaceContentPolicy(),
                    contentPolicyChoice: "explicit",
                  }))}
                  type="button"
                >
                  <Database aria-hidden="true" size={18} strokeWidth={1.8} />
                  <span><strong>All Markdown</strong><small>Includes every Markdown file, including generated docs. Code files still stay out.</small></span>
                  {state.contentPolicy.excludedPaths.length === 0 ? <Check aria-label="Selected" size={16} strokeWidth={2.2} /> : null}
                </button>
              </div>
              <div className="onboarding-section__hint">Tool folders include build, dist, coverage, node_modules, release, and vendor.</div>
            </div>
            <div className="onboarding-card__actions">
              <button className="toolbar-button" onClick={() => void actions.confirmOnboardingChange((current) => ({ ...current, step: "configure" }))} type="button">Back</button>
              <button className="toolbar-button toolbar-button--primary" onClick={() => void actions.confirmOnboardingChange((current) => ({ ...current, step: "mcp" }))} type="button">Continue to tools</button>
            </div>
          </>
        ) : state.step === "agents" ? (
          <>
            <div className="onboarding-card__body" data-testid="onboarding-card-body">
              <h1 className="onboarding-card__title">Set up agents</h1>
              <p className="onboarding-card__copy">
                Exograph invokes agents through their installed local CLIs. These commands stay on this computer and can be edited later in Settings.
              </p>
              <DefaultAgentSelector
                commands={state.agentCommands}
                onChange={(defaultAgentCommandId) => void actions.confirmOnboardingChange((current) => ({
                  ...current,
                  defaultAgentCommandId,
                }))}
                testId="onboarding-default-agent"
                value={state.defaultAgentCommandId}
              />
              <AgentCommandConfigurator
                commands={state.agentCommands}
                onChange={(agentCommands, change) => {
                  if (change === "confirm") {
                    void actions.confirmOnboardingChange((current) => ({
                      ...current,
                      agentCommands,
                      defaultAgentCommandId: normalizeDefaultAgentCommandId(current.defaultAgentCommandId, agentCommands) ?? null,
                    }));
                    return;
                  }
                  onEditState((current) => ({
                    ...current,
                    agentCommands,
                    defaultAgentCommandId: normalizeDefaultAgentCommandId(current.defaultAgentCommandId, agentCommands) ?? null,
                  }));
                }}
                testId="onboarding-agents-config"
              />
              <div className="onboarding-section onboarding-section--summary">
                <div className="dialog-field__label">How invocations run</div>
                <div className="onboarding-section__hint">Messages are sent headlessly from the main wiki. Exograph shows any document changes for review; it never grants a provider broader file access itself.</div>
              </div>
              <details className="agent-invocation-prompt-disclosure">
                <summary>Advanced</summary>
                <AgentInvocationPromptEditor
                  onSave={(agentInvocationPrompt) => void actions.confirmOnboardingChange((current) => ({
                    ...current,
                    agentInvocationPrompt,
                  }))}
                  testId="onboarding-invocation-prompt"
                  value={state.agentInvocationPrompt}
                />
              </details>
            </div>
            <div className="onboarding-card__actions">
              <button className="toolbar-button" onClick={() => void actions.confirmOnboardingChange((current) => ({ ...current, step: "mcp" }))} type="button">Back</button>
              <button className="toolbar-button toolbar-button--primary" disabled={state.status === "saving"} onClick={() => void actions.completeOnboarding()} type="button">{state.status === "saving" ? "Opening…" : "Open Exograph"}</button>
            </div>
          </>
        ) : (
          <>
            <div className="onboarding-card__body" data-testid="onboarding-card-body">
              <h1 className="onboarding-card__title">Agent access</h1>
              <p className="onboarding-card__copy">Choose CLI, MCP, or both.</p>
              <div className="onboarding-section onboarding-section--primary">
                <section className="onboarding-access onboarding-access--mcp" aria-labelledby="onboarding-mcp-title">
                  <div className="onboarding-access__header">
                    <ShieldCheck aria-hidden="true" size={16} strokeWidth={1.8} />
                    <div><strong id="onboarding-mcp-title">MCP</strong><span>{cliReady ? "Read-only context · 2 tools" : "Requires Exo CLI"}</span></div>
                  </div>
                  <div className="onboarding-provider-menu" aria-label="Install Exograph MCP in">
                    <div className="onboarding-provider-menu__title">Install in</div>
                    {(["claude", "codex"] as const).map((provider) => (
                      <button
                        aria-pressed={state.selectedMcpProviders.includes(provider)}
                        className={`onboarding-provider-menu__item ${state.selectedMcpProviders.includes(provider) ? "onboarding-provider-menu__item--active" : ""}`}
                        key={provider}
                        onClick={() => {
                          setMcpSetup(EMPTY_MCP_SETUP);
                          void actions.confirmOnboardingChange((current) => ({
                            ...current,
                            selectedMcpProviders: current.selectedMcpProviders.includes(provider)
                              ? current.selectedMcpProviders.filter((entry) => entry !== provider)
                              : [...current.selectedMcpProviders, provider],
                          }));
                        }}
                        type="button"
                      >
                        <AgentIcon kind={provider} size={16} />
                        <span className="onboarding-provider-menu__copy">
                          <span>{provider === "claude" ? "Claude" : "Codex"}</span>
                          <small>{provider === "claude" ? "claude mcp add" : "codex mcp add"}</small>
                        </span>
                        {state.selectedMcpProviders.includes(provider) ? <Check aria-label="Selected" size={15} strokeWidth={2.2} /> : null}
                      </button>
                    ))}
                  </div>
                  <ul className="onboarding-mcp-tools" aria-label="Exograph MCP tools">
                    <li>
                      <Database aria-hidden="true" size={16} strokeWidth={1.8} />
                      <span className="onboarding-mcp-tools__copy"><code>workspace_status</code><span>Wiki and search health</span></span>
                      <span className="onboarding-mcp-tools__access">Read</span>
                    </li>
                    <li>
                      <Search aria-hidden="true" size={16} strokeWidth={1.8} />
                      <span className="onboarding-mcp-tools__copy"><code>search_notes</code><span>Paths, titles, and snippets</span></span>
                      <span className="onboarding-mcp-tools__access">Read</span>
                    </li>
                  </ul>
                  <div className="onboarding-card__actions onboarding-card__actions--inline">
                    <button
                      className="toolbar-button"
                      disabled={!cliReady || state.selectedMcpProviders.length === 0 || mcpSetup.status === "saving"}
                      onClick={() => void installMcp()}
                      type="button"
                    >
                      {mcpSetup.status === "saving" ? "Installing…" : "Install MCP"}
                    </button>
                  </div>
                  {mcpSetup.errorMessage ? <div className="dialog-card__status dialog-card__status--error">{mcpSetup.errorMessage}</div> : null}
                  {mcpSetup.results.map((result) => <div className={`dialog-card__status${result.ok ? "" : " dialog-card__status--error"}`} key={result.provider}>{result.detail}</div>)}
                </section>
                <section className="onboarding-access onboarding-access--cli" aria-labelledby="onboarding-cli-title">
                  <div className="onboarding-access__header">
                    <SquareTerminal aria-hidden="true" size={16} strokeWidth={1.8} />
                    <div><strong id="onboarding-cli-title">CLI</strong><span>Shell access · required by MCP</span></div>
                  </div>
                  <div className="onboarding-cli-context"><code>exo search</code><code>exo open</code><code>exo invoke</code></div>
                  <p className="onboarding-section__hint">Search returns paths. Agents use their own filesystem tools to inspect them.</p>
                  <div className={`onboarding-cli-installation onboarding-cli-installation--${cliInstallation?.state ?? "checking"}`} aria-live="polite">
                    {cliInstallation?.state === "current" ? <Check aria-hidden="true" size={15} strokeWidth={2.2} /> : <SquareTerminal aria-hidden="true" size={15} strokeWidth={1.8} />}
                    <span>
                      <strong>{cliReady ? "CLI installed" : cliInstallation?.state === "non-exograph" ? "Existing command kept" : "CLI not installed"}</strong>
                      {cliReady ? (
                        <small>{cliInstallation.shellPathAvailable ? "Available to Exograph, MCP, and your shell" : "Available to Exograph and MCP"}</small>
                      ) : <small>Installs the CLI bundled with this app.</small>}
                    </span>
                  </div>
                  {cliReady && !cliInstallation.shellPathAvailable && cliInstallation.shellPathCommand ? (
                    <div className="onboarding-cli-shell-path">
                      <span>Add to your shell</span>
                      <code>{cliInstallation.shellPathCommand}</code>
                    </div>
                  ) : null}
                  {!cliReady ? (
                    <button
                      className="toolbar-button"
                      disabled={cliInstallStatus === "saving"}
                      onClick={() => void installCli()}
                      type="button"
                    >
                      {cliInstallStatus === "saving" ? "Installing…" : "Install CLI"}
                    </button>
                  ) : null}
                  {cliInstallError ? <div className="dialog-card__status dialog-card__status--error">{cliInstallError}</div> : null}
                </section>
              </div>
            </div>
            <div className="onboarding-card__actions">
              <button className="toolbar-button" onClick={() => void actions.confirmOnboardingChange((current) => ({
                ...current,
                step: current.contentInspection?.kind === "repository" ? "scope" : "configure",
              }))} type="button">Back</button>
              <button className="toolbar-button toolbar-button--primary" onClick={() => void actions.confirmOnboardingChange((current) => ({ ...current, step: "agents" }))} type="button">Set up CLI agents</button>
            </div>
          </>
        )}
        {state.step !== "recovery" && state.errorMessage ? (
          <div className="dialog-card__status dialog-card__status--error">{state.errorMessage}</div>
        ) : null}
      </div>
    </div>
  );
}
