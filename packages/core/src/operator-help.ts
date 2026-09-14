export interface ExographCliCommandHelp {
  usageToken: string;
  syntax: string;
  label: string;
}

/**
 * One non-executable catalog for the protected CLI surface. The CLI owns
 * behavior; other product surfaces may render this catalog without copying it.
 */
export const EXOGRAPH_CLI_COMMANDS: readonly ExographCliCommandHelp[] = [
  { usageToken: "[start]", syntax: "exo start", label: "Open app" },
  { usageToken: "show", syntax: "exo show", label: "Show window" },
  { usageToken: "workspaces", syntax: "exo workspaces", label: "List workspaces" },
  { usageToken: "status", syntax: "exo status", label: "Workspace status" },
  { usageToken: "search", syntax: "exo search <query>", label: "Search notes" },
  { usageToken: "graph traverse", syntax: "exo graph traverse --help", label: "Traverse graph" },
  { usageToken: "index [status|sync]", syntax: "exo index [status|sync]", label: "Index" },
  { usageToken: "open", syntax: "exo open <path>", label: "Open note" },
  { usageToken: "invoke", syntax: "exo invoke @handle <task>", label: "Invoke command" },
  { usageToken: "terminals", syntax: "exo terminals [list|create|read|write|stop]", label: "Control terminals" },
  { usageToken: "mcp serve", syntax: "exo mcp serve", label: "Serve MCP" },
] as const;

export const EXOGRAPH_CLI_USAGE = `Usage: exo ${EXOGRAPH_CLI_COMMANDS.map((command) => command.usageToken).join(" | ")}`;
