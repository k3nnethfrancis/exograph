import { createDefaultClaudeAgentCommand, createDefaultCodexAgentCommand } from "./default-agent-command";

const AGENT_COMMAND_PROMPT_DELIVERIES = ["stdin"] as const;
const AGENT_COMMAND_CWD_POLICIES = ["workspace_root", "note_dir", "fixed"] as const;
const AGENT_COMMAND_ADAPTERS = ["generic", "claude-code", "codex-cli"] as const;
const AGENT_COMMAND_UNSUPPORTED_V1_FIELDS = ["env", "template", "promptTemplate"] as const;
const AGENT_HANDLE_PATTERN = /^[a-z][a-z0-9_-]{1,31}$/;

export type AgentCommandPromptDelivery = (typeof AGENT_COMMAND_PROMPT_DELIVERIES)[number];
export type AgentCommandCwdPolicy = (typeof AGENT_COMMAND_CWD_POLICIES)[number];
export type AgentCommandAdapter = (typeof AGENT_COMMAND_ADAPTERS)[number];
export type InvocationContinuityPolicy = "continuous" | "fresh";

export const DEFAULT_AGENT_COMMAND_PROMPT_DELIVERY: AgentCommandPromptDelivery = "stdin";

export interface AgentCommandAppearance {
  color?: string;
  iconDataUrl?: string;
}

export const AGENT_ICON_MAX_BYTES = 64 * 1024;
export const AGENT_ICON_MAX_DIMENSION = 128;

/** Only bounded raster PNGs are persisted; never paths, remote URLs, or SVG. */
export function normalizeAgentCommandAppearance(input: unknown): AgentCommandAppearance | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const candidate = input as AgentCommandAppearance;
  const color = typeof candidate.color === "string" && /^#[0-9a-f]{6}$/.test(candidate.color) ? candidate.color : undefined;
  const iconDataUrl = validAgentIcon(candidate.iconDataUrl) ? candidate.iconDataUrl : undefined;
  return color || iconDataUrl ? { ...(color ? { color } : {}), ...(iconDataUrl ? { iconDataUrl } : {}) } : undefined;
}

function validAgentIcon(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 22 + Math.ceil(AGENT_ICON_MAX_BYTES / 3) * 4
    || !/^data:image\/png;base64,(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return false;
  const bytes = Uint8Array.from(atob(value.slice(22)), (character) => character.charCodeAt(0));
  if (bytes.length < 45 || bytes.length > AGENT_ICON_MAX_BYTES) return false;
  const signature = [137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82];
  if (!signature.every((byte, index) => bytes[index] === byte)) return false;
  const view = new DataView(bytes.buffer);
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  return width > 0 && height > 0 && width <= AGENT_ICON_MAX_DIMENSION && height <= AGENT_ICON_MAX_DIMENSION
    && bytes.slice(-12).every((byte, index) => byte === [0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130][index]);
}

export interface AgentCommand {
  appearance?: AgentCommandAppearance;
  id: string;
  label: string;
  handle: string;
  command: string;
  adapter: AgentCommandAdapter;
  continuityPolicy: InvocationContinuityPolicy;
  cwdPolicy: AgentCommandCwdPolicy;
  fixedCwd?: string;
  promptDelivery: AgentCommandPromptDelivery;
  version: number;
  enabled: boolean;
}

export function normalizeAgentHandle(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().replace(/^@/, "").toLowerCase();
  return AGENT_HANDLE_PATTERN.test(trimmed) ? trimmed : null;
}

export function normalizeAgentCommand(input: unknown, fallbackId?: string): AgentCommand | null {
  if (!input || typeof input !== "object") return null;

  const candidate = input as Partial<AgentCommand>;
  if (hasUnsupportedAgentCommandV1Fields(candidate) || isUnsupportedPrelaunchAgentCommand(candidate)) return null;
  const handle = normalizeAgentHandle(candidate.handle);
  const command = normalizeAgentCommandString(candidate.command);
  if (!handle || !command) return null;

  const id = normalizeAgentCommandId(candidate.id, fallbackId ?? handle);
  const label = normalizeRequiredString(candidate.label) ?? `@${handle}`;
  const cwdPolicy = normalizeAgentCommandCwdPolicy(candidate.cwdPolicy);
  const fixedCwd = cwdPolicy === "fixed" ? normalizeRequiredString(candidate.fixedCwd) : undefined;
  if (cwdPolicy === "fixed" && !fixedCwd) return null;
  const promptDelivery = normalizeConfiguredAgentCommandPromptDelivery(candidate.promptDelivery);
  if (!promptDelivery) return null;

  const adapter = normalizeAgentCommandAdapter(candidate.adapter, { ...candidate, command });
  const appearance = normalizeAgentCommandAppearance(candidate.appearance);
  const normalized: AgentCommand = {
    ...(appearance ? { appearance } : {}),
    id,
    label,
    handle,
    command,
    adapter,
    continuityPolicy: normalizeCommandContinuityPolicy(candidate.continuityPolicy, adapter, candidate, command),
    cwdPolicy,
    ...(fixedCwd ? { fixedCwd } : {}),
    promptDelivery,
    version: normalizeAgentCommandVersion(candidate.version),
    enabled: typeof candidate.enabled === "boolean" ? candidate.enabled : true,
  };
  return migrateBuiltInCodexCommand(normalized);
}

export const LEGACY_BUILT_IN_CODEX_COMMAND = "codex exec --sandbox workspace-write -";

/** Repair only Exograph's exact v1 Codex template. A user-edited command,
 * including another command under the @codex handle, remains user-owned. */
export function isLegacyBuiltInCodexCommand(command: AgentCommand): boolean {
  return command.id === "codex"
    && command.label === "Codex"
    && command.handle === "codex"
    && command.adapter === "codex-cli"
    && command.cwdPolicy === "workspace_root"
    && command.promptDelivery === "stdin"
    && command.command === LEGACY_BUILT_IN_CODEX_COMMAND;
}

function migrateBuiltInCodexCommand(command: AgentCommand): AgentCommand {
  return isLegacyBuiltInCodexCommand(command)
    ? { ...command, command: createDefaultCodexAgentCommand().command, version: createDefaultCodexAgentCommand().version }
    : command;
}

export function normalizeAgentCommands(input: unknown): AgentCommand[] {
  if (!Array.isArray(input)) return [];

  const seenIds = new Set<string>();
  const seenHandles = new Set<string>();
  return input.reduce<AgentCommand[]>((commands, entry, index) => {
    const command = normalizeAgentCommand(entry, `agent-command-${index + 1}`);
    if (!command || seenIds.has(command.id) || seenHandles.has(command.handle)) return commands;
    seenIds.add(command.id);
    seenHandles.add(command.handle);
    commands.push(command);
    return commands;
  }, []);
}

/** Resolve the explicit command used by Exograph-initiated agent features. */
export function normalizeDefaultAgentCommandId(
  input: unknown,
  commands: readonly AgentCommand[],
): string | undefined {
  const requested = typeof input === "string" ? input.trim() : "";
  if (requested && commands.some((command) => command.id === requested)) return requested;
  return commands.find((command) => command.enabled && isFeatureAgentCommand(command))?.id;
}

export function isFeatureAgentCommand(command: AgentCommand): boolean {
  return command.adapter === "claude-code" || command.adapter === "codex-cli";
}

/** Validate a complete list without repairing or silently dropping entries. */
export function agentCommandConfigurationError(input: unknown): string | null {
  if (!Array.isArray(input)) return "Commands must be a list.";

  const seenIds = new Set<string>();
  const seenHandles = new Set<string>();
  let customCommandCount = 0;
  for (const [index, entry] of input.entries()) {
    const commandError = canonicalAgentCommandError(entry, index);
    if (commandError) return commandError;
    const command = entry as AgentCommand;
    if (seenIds.has(command.id)) return `Command id "${command.id}" is already configured.`;
    if (seenHandles.has(command.handle)) return `Command handle @${command.handle} is already configured.`;
    seenIds.add(command.id);
    seenHandles.add(command.handle);
    if (!isRecommendedAgentCommand(command)) {
      customCommandCount += 1;
      if (customCommandCount > 1) return "Only one Custom command can be configured.";
    }
  }
  return null;
}

function canonicalAgentCommandError(input: unknown, index: number): string | null {
  const malformed = (field?: string) => field
    ? `Command ${index + 1} has a non-canonical ${field}.`
    : `Command ${index + 1} is malformed. Check its handle, executable and arguments, and working folder.`;
  if (!input || typeof input !== "object" || Array.isArray(input)) return malformed();

  const candidate = input as Record<string, unknown>;
  const command = normalizeAgentCommand(candidate, `agent-command-${index + 1}`);
  if (!command) return malformed();
  if (candidate.appearance !== undefined) {
    const appearance = candidate.appearance as AgentCommandAppearance;
    if (!command.appearance || !appearance || typeof appearance !== "object"
      || Object.keys(appearance).some((key) => key !== "color" && key !== "iconDataUrl")
      || appearance.color !== command.appearance.color || appearance.iconDataUrl !== command.appearance.iconDataUrl) return malformed("appearance");
  }
  if (candidate.id !== command.id) return malformed("id");
  if (candidate.label !== command.label) return malformed("label");
  if (candidate.handle !== command.handle) return malformed("handle");
  if (candidate.command !== command.command) return malformed("executable and arguments");
  if (candidate.adapter !== command.adapter) return malformed("adapter");
  if (candidate.continuityPolicy !== command.continuityPolicy) return malformed("continuity policy");
  if (candidate.cwdPolicy !== command.cwdPolicy) return malformed("working-folder policy");
  if (candidate.promptDelivery !== command.promptDelivery) return malformed("prompt delivery");
  if (candidate.version !== command.version) return malformed("version");
  if (candidate.enabled !== command.enabled) return malformed("enabled state");
  if (command.cwdPolicy === "fixed") {
    if (candidate.fixedCwd !== command.fixedCwd) return malformed("fixed working folder");
  } else if (candidate.fixedCwd !== undefined) {
    return malformed("fixed working folder");
  }
  return null;
}

function isRecommendedAgentCommand(command: AgentCommand): boolean {
  return (command.id === "claude" && command.handle === "claude")
    || (command.id === "codex" && command.handle === "codex");
}

function hasUnsupportedAgentCommandV1Fields(candidate: Record<string, unknown>): boolean {
  return AGENT_COMMAND_UNSUPPORTED_V1_FIELDS.some((field) => field in candidate);
}

function normalizeAgentCommandId(value: unknown, fallback: string): string {
  const trimmed = normalizeRequiredString(value) ?? fallback;
  const normalized = trimmed.replace(/[^A-Za-z0-9_.-]/g, "-").replace(/^\.+$/, "-");
  return normalized || fallback;
}

function isUnsupportedPrelaunchAgentCommand(candidate: Partial<AgentCommand>): boolean {
  const isBuiltInIdentity = candidate.id === "claude" && candidate.handle === "claude" && candidate.label === "Claude";
  const promptDelivery = (candidate as { promptDelivery?: unknown }).promptDelivery;
  return promptDelivery === "terminalInputAfterLaunch"
    || promptDelivery === "auto"
    || promptDelivery === "argv"
    || (isBuiltInIdentity && (
      candidate.command === "claude"
      || candidate.command === "claude -p"
      || candidate.command === "claude -p --permission-mode acceptEdits"
    ));
}

function normalizeAgentCommandAdapter(
  value: unknown,
  candidate: Partial<AgentCommand> & { command: string },
): AgentCommandAdapter {
  if (value === "claude-code" || value === "codex-cli" || value === "generic") return value;
  const builtInIdentity = candidate.id === candidate.handle && candidate.label === capitalizeBuiltInLabel(candidate.handle);
  if (builtInIdentity && candidate.handle === "claude" && candidate.command === createDefaultClaudeAgentCommand().command) {
    return "claude-code";
  }
  if (builtInIdentity && candidate.handle === "codex" && candidate.command === createDefaultCodexAgentCommand().command) {
    return "codex-cli";
  }
  return "generic";
}

function normalizeCommandContinuityPolicy(
  value: unknown,
  adapter: AgentCommandAdapter,
  candidate: Partial<AgentCommand>,
  command: string,
): InvocationContinuityPolicy {
  if (adapter !== "claude-code") return "fresh";
  if (value === "continuous" || value === "fresh") return value;
  const exactBuiltIn = candidate.id === candidate.handle
    && candidate.label === capitalizeBuiltInLabel(candidate.handle)
    && command === createDefaultClaudeAgentCommand().command;
  return exactBuiltIn ? "continuous" : "fresh";
}

function capitalizeBuiltInLabel(handle: unknown): string | null {
  return handle === "claude" ? "Claude" : handle === "codex" ? "Codex" : null;
}

function normalizeAgentCommandCwdPolicy(value: unknown): AgentCommandCwdPolicy {
  return value === "note_dir" || value === "fixed" ? value : "workspace_root";
}

function normalizeConfiguredAgentCommandPromptDelivery(value: unknown): AgentCommandPromptDelivery | null {
  return value === "stdin" || value === undefined ? DEFAULT_AGENT_COMMAND_PROMPT_DELIVERY : null;
}

function normalizeAgentCommandVersion(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? Math.max(1, Math.floor(parsed)) : 1;
}

function normalizeAgentCommandString(value: unknown): string | null {
  const normalized = normalizeRequiredString(value);
  return normalized && !/[\r\n]/.test(normalized) ? normalized : null;
}

function normalizeRequiredString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
