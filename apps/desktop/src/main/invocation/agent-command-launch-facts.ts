import { constants, createReadStream } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";

import {
  agentCommandExecutableFingerprint,
  deriveAgentCommandLaunch,
  type AgentCommand,
  type AgentCommandLaunchContext,
} from "@exograph/core";

import type { AgentCommandLaunchFacts } from "../../shared/api";
import { commandEnvironment } from "../command/command-environment";

export async function inspectAgentCommandLaunchFacts(
  command: AgentCommand,
  context: AgentCommandLaunchContext,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<AgentCommandLaunchFacts> {
  const derived = deriveAgentCommandLaunch(command, context);
  const fingerprint = agentCommandExecutableFingerprint(command);
  if (!derived.launchable) {
    return {
      commandId: command.id,
      handle: command.handle,
      label: command.label,
      fingerprint,
      cwd: derived.cwd,
      cwdReady: false,
      executable: executableToken(command.command),
      executablePath: null,
      executableReady: false,
      launchable: false,
      block: derived.block,
      detail: derived.detail,
    };
  }

  const [cwdReady, executablePath, gitReady] = await Promise.all([
    directoryExists(derived.cwd),
    resolveExecutable(executableToken(command.command), derived.cwd, commandEnvironment(environment).PATH),
    codexWorkingFolderReady(command, derived.cwd),
  ]);
  const executable = executableToken(command.command);
  const executableReady = executablePath !== null;
  const boundFingerprint = executablePath
    ? await executableLaunchFingerprint(command, executablePath)
    : fingerprint;
  const detail = !cwdReady
    ? `Working folder does not exist: ${derived.cwd}`
    : !executableReady
      ? `Executable was not found: ${executable || command.command}`
      : !gitReady
        ? "Codex requires a Git repository for this working folder. Add --skip-git-repo-check or restore the recommended Codex command."
      : "Ready to test in a visible terminal.";

  return {
    commandId: command.id,
    handle: command.handle,
    label: command.label,
    fingerprint: boundFingerprint,
    cwd: derived.cwd,
    cwdReady,
    executable,
    executablePath,
    executableReady,
    launchable: cwdReady && executableReady && gitReady,
    ...(!cwdReady
      ? { block: "cwd-missing" as const }
      : !executableReady
        ? { block: "executable-missing" as const }
        : !gitReady
          ? { block: "workspace-not-git" as const }
          : {}),
    detail,
  };
}

async function codexWorkingFolderReady(command: AgentCommand, cwd: string): Promise<boolean> {
  if (command.adapter !== "codex-cli" || /(?:^|\s)--skip-git-repo-check(?:\s|=|$)/.test(command.command)) {
    return true;
  }
  let candidate = path.resolve(cwd);
  while (true) {
    if (await directoryExists(path.join(candidate, ".git"))) return true;
    const parent = path.dirname(candidate);
    if (parent === candidate) return false;
    candidate = parent;
  }
}

export function executableToken(command: string): string {
  const span = executableTokenSpan(command);
  return span ? span.token : "";
}

/** Replaces only the configured executable token with the canonical file that
 * readiness just fingerprinted. The rest of the configured argument string is
 * preserved verbatim, so user-visible command editing stays simple. */
export function bindResolvedExecutable(command: string, executablePath: string): string {
  const span = executableTokenSpan(command);
  if (!span) throw new Error("A configured Command must start with an executable.");
  return `${command.slice(0, span.from)}${shellQuote(executablePath)}${command.slice(span.to)}`;
}

function executableTokenSpan(command: string): { token: string; from: number; to: number } | null {
  const input = command.trimStart();
  if (!input) return null;
  const from = command.length - input.length;
  const quote = input[0] === "\"" || input[0] === "'" ? input[0] : null;
  let token = "";
  for (let index = quote ? 1 : 0; index < input.length; index += 1) {
    const character = input[index];
    if (quote && character === quote) return { token, from, to: from + index + 1 };
    if (!quote && /\s/.test(character)) return { token, from, to: from + index };
    if (character === "\\" && quote !== "'") {
      index += 1;
      token += input[index] ?? "";
    } else {
      token += character;
    }
  }
  return quote ? null : { token, from, to: command.length };
}

async function directoryExists(target: string): Promise<boolean> {
  try {
    return (await stat(target)).isDirectory();
  } catch {
    return false;
  }
}

async function resolveExecutable(executable: string, cwd: string, pathValue: string | undefined): Promise<string | null> {
  if (!executable) return null;
  if (executable.includes(path.sep)) {
    const candidate = path.isAbsolute(executable) ? executable : path.resolve(cwd, executable);
    return await executableFile(candidate) ? realpath(candidate) : null;
  }
  for (const directory of (pathValue ?? "").split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(directory, executable);
    if (await executableFile(candidate)) return realpath(candidate);
  }
  return null;
}

async function executableLaunchFingerprint(command: AgentCommand, executablePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(executablePath)) hash.update(chunk);
  return createHash("sha256").update(JSON.stringify({
    configuration: agentCommandExecutableFingerprint(command),
    executablePath,
    executableSha256: hash.digest("hex"),
  })).digest("hex");
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\"'\"")}'`;
}

async function executableFile(target: string): Promise<boolean> {
  try {
    await access(target, constants.X_OK);
    return (await stat(target)).isFile();
  } catch {
    return false;
  }
}
