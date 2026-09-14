import { AgentCommandAppearanceEditor } from "./AgentCommandAppearanceEditor";
import { AgentCommandIcon } from "./AgentCommandIcon";
import { useState } from "react";
import {
  agentCommandConfigurationError,
  normalizeAgentCommand,
  normalizeAgentHandle,
  type AgentCommand,
} from "@exograph/core/agent-command-configuration";
import {
  createDefaultClaudeAgentCommand,
  createDefaultCodexAgentCommand,
} from "@exograph/core/default-agent-command";

export type AgentCommandConfigurationChange = "edit" | "confirm";

interface AgentCommandConfiguratorProps {
  commands: AgentCommand[];
  onChange: (commands: AgentCommand[], change: AgentCommandConfigurationChange) => void;
  testId: string;
}

export interface CustomCommandDraft {
  appearance?: AgentCommand["appearance"];
  label: string;
  handle: string;
  command: string;
  adapter: AgentCommand["adapter"];
  continuityPolicy: AgentCommand["continuityPolicy"];
}

const EMPTY_CUSTOM_COMMAND: CustomCommandDraft = {
  label: "",
  handle: "",
  command: "",
  adapter: "generic",
  continuityPolicy: "fresh",
};

export function AgentCommandConfigurator({
  commands,
  onChange,
  testId,
}: AgentCommandConfiguratorProps) {
  const [pendingRemovalId, setPendingRemovalId] = useState<string | null>(null);
  const [addingCustom, setAddingCustom] = useState(false);
  const [customIconPending, setCustomIconPending] = useState(false);
  const [customDraft, setCustomDraft] = useState<CustomCommandDraft>(EMPTY_CUSTOM_COMMAND);
  const recommended = [
    commands.find((command) => command.id === "claude"),
    commands.find((command) => command.id === "codex"),
  ].filter((command): command is AgentCommand => Boolean(command));
  const custom = commands.filter((command) => command.id !== "claude" && command.id !== "codex");
  const configurationError = agentCommandConfigurationError(commands);
  const customError = addingCustom ? customCommandDraftError(customDraft, commands) : null;
  const missingClaude = !commands.some((command) => command.id === "claude");
  const missingCodex = !commands.some((command) => command.id === "codex");

  const publish = (next: AgentCommand[], change: AgentCommandConfigurationChange) => {
    onChange(next, change);
  };

  return (
    <div className="agent-command-configurator" data-testid={testId}>
      <section className="agent-command-group" aria-labelledby={`${testId}-recommended-title`}>
        <div className="agent-command-group__header">
          <div>
            <strong id={`${testId}-recommended-title`}>Recommended</strong>
            <span>Claude and Codex templates</span>
          </div>
          {missingClaude || missingCodex ? (
            <div className="agent-command-group__actions">
              {missingClaude ? (
                <button
                  className="toolbar-button"
                  data-testid={`${testId}-add-claude`}
                  onClick={() => publish(addRecommendedAgentCommand(commands, "claude"), "confirm")}
                  type="button"
                >
                  Add Claude
                </button>
              ) : null}
              {missingCodex ? (
                <button
                  className="toolbar-button"
                  data-testid={`${testId}-add-codex`}
                  onClick={() => publish(addRecommendedAgentCommand(commands, "codex"), "confirm")}
                  type="button"
                >
                  Add Codex
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
        {recommended.map((command) => (
          <AgentCommandEditor
            command={command}
            commands={commands}
            key={command.id}
            onChange={publish}
            onRequestRemoval={setPendingRemovalId}
            pendingRemoval={pendingRemovalId === command.id}
            recommended
            testId={testId}
          />
        ))}
      </section>

      <section className="agent-command-group agent-command-group--custom" aria-labelledby={`${testId}-custom-title`}>
        <div className="agent-command-group__header">
          <div>
            <strong id={`${testId}-custom-title`}>Custom</strong>
            <span>One provider-neutral local command</span>
          </div>
          {custom.length === 0 && !addingCustom ? (
            <button
              className="toolbar-button"
              data-testid={`${testId}-add-custom`}
              onClick={() => setAddingCustom(true)}
              type="button"
            >
              Add Custom
            </button>
          ) : null}
        </div>
        {custom.map((command) => (
          <AgentCommandEditor
            command={command}
            commands={commands}
            key={command.id}
            onChange={publish}
            onRequestRemoval={setPendingRemovalId}
            pendingRemoval={pendingRemovalId === command.id}
            recommended={false}
            testId={testId}
          />
        ))}
        {addingCustom ? (
          <div className="agent-command agent-command--draft" data-testid={`${testId}-custom-draft`}>
            <div className="dialog-form__grid agent-command__fields">
              <label className="dialog-field">
                <span className="dialog-field__label">Name</span>
                <input
                  aria-label="Custom command name"
                  className="dialog-card__input"
                  value={customDraft.label}
                  onChange={(event) => setCustomDraft((current) => ({ ...current, label: event.target.value }))}
                />
              </label>
              <label className="dialog-field">
                <span className="dialog-field__label">Handle</span>
                <input
                  aria-label="Custom command handle"
                  className="dialog-card__input"
                  placeholder="@local"
                  value={customDraft.handle}
                  onChange={(event) => setCustomDraft((current) => ({ ...current, handle: event.target.value }))}
                />
              </label>
              <label className="dialog-field agent-command__command">
                <span className="dialog-field__label">Executable and arguments</span>
                <input
                  aria-label="Custom command executable and arguments"
                  className="dialog-card__input"
                  spellCheck={false}
                  value={customDraft.command}
                  onChange={(event) => setCustomDraft((current) => ({ ...current, command: event.target.value }))}
                />
              </label>
              <label className="dialog-field">
                <span className="dialog-field__label">Adapter</span>
                <select
                  aria-label="Custom command adapter"
                  className="dialog-card__input"
                  value={customDraft.adapter}
                  onChange={(event) => setCustomDraft((current) => ({
                    ...current,
                    adapter: event.target.value as AgentCommand["adapter"],
                    continuityPolicy: event.target.value === "claude-code"
                      ? current.continuityPolicy
                      : "fresh",
                  }))}
                >
                  <option value="generic">Generic</option>
                  <option value="claude-code">Claude Code</option>
                  <option value="codex-cli">Codex CLI</option>
                </select>
              </label>
              {customDraft.adapter === "claude-code" ? (
                <label className="dialog-check dialog-check--inline">
                  <input
                    aria-label="Custom command keep context"
                    checked={customDraft.continuityPolicy === "continuous"}
                    onChange={(event) => setCustomDraft((current) => ({
                      ...current,
                      continuityPolicy: event.target.checked ? "continuous" : "fresh",
                    }))}
                    type="checkbox"
                  />
                  <span>Keep context</span>
                </label>
              ) : null}
            </div>
            <AgentCommandAppearanceEditor onPendingChange={setCustomIconPending} label="Custom command" handle={customDraft.handle} appearance={customDraft.appearance} onChange={(appearance) => setCustomDraft((current) => ({ ...current, appearance }))} />
            {customError ? <div className="dialog-field__error" data-testid={`${testId}-custom-error`}>{customError}</div> : null}
            <div className="agent-command__actions">
              <button
                className="toolbar-button"
                onClick={() => {
                  setAddingCustom(false);
                  setCustomIconPending(false);
                  setCustomDraft(EMPTY_CUSTOM_COMMAND);
                }}
                type="button"
              >
                Cancel
              </button>
              <button
                className="toolbar-button toolbar-button--primary"
                data-testid={`${testId}-confirm-custom`}
                disabled={Boolean(customError) || customIconPending}
                onClick={() => {
                  const next = customAgentCommand(customDraft);
                  if (!next) return;
                  publish([...commands, next], "confirm");
                  setAddingCustom(false);
                  setCustomIconPending(false);
                  setCustomDraft(EMPTY_CUSTOM_COMMAND);
                }}
                type="button"
              >
                Add Custom
              </button>
            </div>
          </div>
        ) : null}
      </section>
      {configurationError ? <div className="dialog-field__error" data-testid={`${testId}-error`}>{configurationError}</div> : null}
    </div>
  );
}

function AgentCommandEditor({
  command,
  commands,
  onChange,
  onRequestRemoval,
  pendingRemoval,
  recommended,
  testId,
}: {
  command: AgentCommand;
  commands: AgentCommand[];
  onChange: AgentCommandConfiguratorProps["onChange"];
  onRequestRemoval: (commandId: string | null) => void;
  pendingRemoval: boolean;
  recommended: boolean;
  testId: string;
}) {
  const update = (patch: Partial<AgentCommand>, change: AgentCommandConfigurationChange = "edit") => {
    onChange(commands.map((entry) => entry.id === command.id ? { ...entry, ...patch } : entry), change);
  };
  const updateAdapter = (adapter: AgentCommand["adapter"]) => {
    update({
      adapter,
      continuityPolicy: adapter === "claude-code" ? command.continuityPolicy : "fresh",
    }, "confirm");
  };
  const updateCwdPolicy = (cwdPolicy: AgentCommand["cwdPolicy"]) => {
    update({
      cwdPolicy,
      fixedCwd: cwdPolicy === "fixed" ? command.fixedCwd ?? "" : undefined,
    }, "confirm");
  };

  return (
    <section className="agent-command" data-testid={`${testId}-command-${command.id}`}>
      <div className="agent-command__header">
        <div>
          <strong><AgentCommandIcon command={command} /> {command.label || `@${command.handle}`}{recommended ? <em>Recommended</em> : null}</strong>
          <span>@{command.handle}</span>
        </div>
        <label className="dialog-check dialog-check--inline">
          <input
            checked={command.enabled}
            data-testid={`${testId}-enabled-${command.id}`}
            onChange={(event) => update({ enabled: event.target.checked }, "confirm")}
            type="checkbox"
          />
          <span>Enabled</span>
        </label>
      </div>
      <div className="dialog-form__grid agent-command__fields">
        <label className="dialog-field">
          <span className="dialog-field__label">Name</span>
          <input
            aria-label={`${command.label || command.handle} name`}
            className="dialog-card__input"
            data-testid={`${testId}-label-${command.id}`}
            value={command.label}
            onBlur={() => onChange(commands, "confirm")}
            onChange={(event) => update({ label: event.target.value })}
          />
        </label>
        {!recommended ? (
          <label className="dialog-field">
            <span className="dialog-field__label">Handle</span>
            <input
              aria-label={`${command.label || "Custom"} handle`}
              className="dialog-card__input"
              data-testid={`${testId}-handle-${command.id}`}
              value={command.handle}
              onBlur={() => onChange(commands, "confirm")}
              onChange={(event) => update({ handle: event.target.value })}
            />
          </label>
        ) : null}
        <label className="dialog-field agent-command__command">
          <span className="dialog-field__label">Executable and arguments</span>
          <input
            aria-label={`${command.label} command`}
            className="dialog-card__input"
            data-testid={`${testId}-command-input-${command.id}`}
            spellCheck={false}
            value={command.command}
            onBlur={() => onChange(commands, "confirm")}
            onChange={(event) => update({ command: event.target.value })}
          />
        </label>
        <label className="dialog-field">
          <span className="dialog-field__label">Adapter</span>
          <select
            aria-label={`${command.label || command.handle} adapter`}
            className="dialog-card__input"
            data-testid={`${testId}-adapter-${command.id}`}
            value={command.adapter}
            onChange={(event) => updateAdapter(event.target.value as AgentCommand["adapter"])}
          >
            <option value="generic">Generic</option>
            <option value="claude-code">Claude Code</option>
            <option value="codex-cli">Codex CLI</option>
          </select>
        </label>
        <label className="dialog-field">
          <span className="dialog-field__label">Run from</span>
          <select
            className="dialog-card__input"
            data-testid={`${testId}-cwd-${command.id}`}
            value={command.cwdPolicy}
            onChange={(event) => updateCwdPolicy(event.target.value as AgentCommand["cwdPolicy"])}
          >
            <option value="workspace_root">Workspace</option>
            <option value="note_dir">Note folder</option>
            <option value="fixed">Fixed folder</option>
          </select>
        </label>
        {command.cwdPolicy === "fixed" ? (
          <label className="dialog-field agent-command__command">
            <span className="dialog-field__label">Folder</span>
            <input
              className="dialog-card__input"
              data-testid={`${testId}-fixed-cwd-${command.id}`}
              value={command.fixedCwd ?? ""}
              onBlur={() => onChange(commands, "confirm")}
              onChange={(event) => update({ fixedCwd: event.target.value })}
            />
          </label>
        ) : null}
        <div className="dialog-field agent-command__continuity">
          <span className="dialog-field__label">Context</span>
          {command.adapter === "claude-code" ? (
            <div className="agent-command__continuity-controls">
              <label className="dialog-check dialog-check--inline">
                <input
                  checked={command.continuityPolicy === "continuous"}
                  data-testid={`${testId}-continuity-${command.id}`}
                  onChange={(event) => update({ continuityPolicy: event.target.checked ? "continuous" : "fresh" }, "confirm")}
                  type="checkbox"
                />
                <span>Keep context</span>
              </label>
            </div>
          ) : <span className="dialog-field__hint">Fresh each time</span>}
        </div>
      </div>
      {!recommended ? <AgentCommandAppearanceEditor label={command.label || "Custom command"} handle={command.handle} appearance={command.appearance} onChange={(appearance) => update({ appearance }, "confirm")} /> : null}
      {pendingRemoval ? (
        <div className="agent-command__remove-confirmation" data-testid={`${testId}-remove-confirmation-${command.id}`}>
          <span>Remove @{command.handle} configuration? Invocation History stays available.</span>
          <button className="toolbar-button" onClick={() => onRequestRemoval(null)} type="button">Cancel</button>
          <button
            className="toolbar-button toolbar-button--danger"
            data-testid={`${testId}-confirm-remove-${command.id}`}
            onClick={() => {
              onChange(commands.filter((entry) => entry.id !== command.id), "confirm");
              onRequestRemoval(null);
            }}
            type="button"
          >
            Remove @{command.handle}
          </button>
        </div>
      ) : (
        <div className="agent-command__actions">
          <button
            className="toolbar-button"
            data-testid={`${testId}-remove-${command.id}`}
            onClick={() => onRequestRemoval(command.id)}
            type="button"
          >
            Remove
          </button>
        </div>
      )}
    </section>
  );
}

export function addRecommendedAgentCommand(
  commands: readonly AgentCommand[],
  provider: "claude" | "codex",
): AgentCommand[] {
  if (commands.some((command) => command.id === provider)) return [...commands];
  const command = provider === "claude"
    ? createDefaultClaudeAgentCommand()
    : createDefaultCodexAgentCommand();
  const custom = commands.filter((entry) => entry.id !== "claude" && entry.id !== "codex");
  const recommended = [
    provider === "claude" ? command : commands.find((entry) => entry.id === "claude"),
    provider === "codex" ? command : commands.find((entry) => entry.id === "codex"),
  ].filter((entry): entry is AgentCommand => Boolean(entry));
  return [...recommended, ...custom];
}

export function customCommandDraftError(
  draft: CustomCommandDraft,
  commands: readonly AgentCommand[],
): string | null {
  if (!draft.label.trim()) return "Enter a name.";
  const handle = normalizeAgentHandle(draft.handle);
  if (!handle) return "Use a handle with 2–32 lowercase letters, numbers, hyphens, or underscores.";
  if (!draft.command.trim()) return "Enter an executable and any arguments.";
  if (commands.some((command) => command.handle === handle)) return `@${handle} is already configured.`;
  return customAgentCommand(draft) ? null : "This Custom command is malformed.";
}

function customAgentCommand(draft: CustomCommandDraft): AgentCommand | null {
  const handle = normalizeAgentHandle(draft.handle);
  if (!handle || !draft.label.trim() || !draft.command.trim()) return null;
  return normalizeAgentCommand({
    appearance: draft.appearance,
    id: "custom",
    label: draft.label,
    handle,
    command: draft.command,
    adapter: draft.adapter,
    continuityPolicy: draft.adapter === "claude-code" ? draft.continuityPolicy : "fresh",
    cwdPolicy: "workspace_root",
    promptDelivery: "stdin",
    version: 1,
    enabled: true,
  });
}
