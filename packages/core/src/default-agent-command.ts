import type { AgentCommand } from "./agent-command-configuration";

/** The built-in provider-neutral Command entry for a local Claude executable. */
export function createDefaultClaudeAgentCommand(): AgentCommand {
  return {
    id: "claude",
    label: "Claude",
    handle: "claude",
    command: 'claude -p --permission-mode acceptEdits --allowedTools "Read,Edit,Write,Glob,Grep"',
    adapter: "claude-code",
    continuityPolicy: "continuous",
    cwdPolicy: "workspace_root",
    promptDelivery: "stdin",
    version: 1,
    enabled: true,
  };
}

/** The built-in Command entry for a local Codex executable. */
export function createDefaultCodexAgentCommand(): AgentCommand {
  return {
    id: "codex",
    label: "Codex",
    handle: "codex",
    command: "codex exec --sandbox workspace-write --skip-git-repo-check -",
    adapter: "codex-cli",
    continuityPolicy: "fresh",
    cwdPolicy: "workspace_root",
    promptDelivery: "stdin",
    version: 2,
    enabled: true,
  };
}
