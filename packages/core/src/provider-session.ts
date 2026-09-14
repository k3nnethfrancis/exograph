/** Build the provider-native Claude handoff shown to the user and executed by
 * Exograph. Keeping this shared prevents the renderer label and terminal command
 * from drifting apart. */
export function commandForClaudeResume(command: { command: string }, sessionId: string): string {
  const executable = command.command
    .replace(/(?:^|\s)-p(?:\s|$)/g, " ")
    .replace(/(?:^|\s)--print(?:\s|$)/g, " ")
    .replace(/(?:^|\s)--output-format(?:\s+\S+|=\S+)?/g, " ")
    .trim()
    .replace(/\s+/g, " ");
  return `${executable} --resume ${shellArgument(sessionId)}`;
}

/** Build the interactive Codex handoff from a configured headless command. */
export function commandForCodexResume(command: { command: string }, sessionId: string): string {
  const executable = firstShellWord(command.command) || "codex";
  return `${executable} resume ${shellArgument(sessionId)}`;
}

function firstShellWord(command: string): string {
  const quoted = command.trim().match(/^("(?:[^"\\]|\\.)*"|'(?:[^']|'"'"')*'|\S+)/)?.[1] ?? "";
  return quoted;
}

function shellArgument(value: string): string {
  return `'${value.replace(/'/g, "'\"'\"'")}'`;
}
