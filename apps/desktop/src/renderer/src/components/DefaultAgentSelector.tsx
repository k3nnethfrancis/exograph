import { isFeatureAgentCommand, type AgentCommand } from "@exograph/core/agent-command-configuration";

interface DefaultAgentSelectorProps {
  commands: readonly AgentCommand[];
  value: string | null | undefined;
  onChange: (commandId: string | null) => void;
  testId: string;
}

/** Selects the command used by Exograph-initiated agent features. */
export function DefaultAgentSelector({ commands, value, onChange, testId }: DefaultAgentSelectorProps) {
  const featureCommands = commands.filter(isFeatureAgentCommand);
  return (
    <label className="dialog-field default-agent-selector">
      <span className="dialog-field__label">Default agent</span>
      <select
        className="dialog-card__input"
        data-testid={testId}
        disabled={featureCommands.length === 0}
        onChange={(event) => onChange(event.target.value || null)}
        value={featureCommands.some((command) => command.id === value) ? value ?? "" : ""}
      >
        <option value="">Choose agent</option>
        {featureCommands.map((command) => (
          <option disabled={!command.enabled} key={command.id} value={command.id}>
            {command.label}{command.enabled ? "" : " (disabled)"}
          </option>
        ))}
      </select>
      <span className="dialog-field__hint">Used by Discover structure and other agent-powered features.</span>
    </label>
  );
}
