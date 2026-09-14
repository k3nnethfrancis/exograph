import { constants, existsSync } from "node:fs";
import { access, chmod, lstat, mkdir, readFile, readlink, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import type { CliInstallationStatus } from "../shared/api";
import { commandEnvironment } from "./command/command-environment";

const LEGACY_SHIM_MARKER = "packages/cli/dist/index.cjs";
const PACKAGED_SHIM_MARKER = "exograph-packaged-cli";

export interface InspectCliInstallationOptions {
  env?: NodeJS.ProcessEnv;
  sourceProjectRoot?: string;
  packagedCli?: PackagedCliPaths;
}

export interface PackagedCliPaths {
  appExecutablePath: string;
  scriptPath: string;
}

/**
 * Return only a real source checkout that can supply the repo-backed CLI.
 * Packaged Resources is not a source checkout. Require the actual launcher and
 * installer instead of inferring source identity from an unrelated directory.
 */
export function findSourceProjectRoot(candidates: string[]): string | undefined {
  return candidates.find((candidate) =>
    existsSync(path.join(candidate, "package.json"))
    && existsSync(path.join(candidate, "packages", "cli", "bin", "exograph"))
    && existsSync(path.join(candidate, "scripts", "install-local")),
  );
}

/**
 * Classify the first executable `exo` visible to the desktop app. This is
 * deliberately diagnostic only: installation remains an explicit shell step.
 */
export async function inspectCliInstallation(
  { env = process.env, sourceProjectRoot, packagedCli }: InspectCliInstallationOptions = {},
): Promise<CliInstallationStatus> {
  const sourcePath = sourceProjectRoot
    ? path.join(sourceProjectRoot, "packages", "cli", "bin", "exograph")
    : undefined;
  const installCommand = sourceProjectRoot ? `cd ${shellQuote(sourceProjectRoot)} && ./scripts/install-local` : undefined;
  const shellCommandPath = await findExecutable("exo", env.PATH);
  const commandPath = await findExecutable("exo", commandEnvironment(env).PATH);

  if (!commandPath) {
    return sourcePath
      ? { state: "missing", shellPathAvailable: false, sourcePath, installCommand }
      : { state: "unavailable", shellPathAvailable: false };
  }

  const shellPathAvailable = shellCommandPath !== undefined
    && path.resolve(shellCommandPath) === path.resolve(commandPath);
  const common = {
    commandPath,
    shellPathAvailable,
    ...(!shellPathAvailable ? { shellPathCommand: shellPathInstruction(commandPath, env) } : {}),
    ...(sourcePath ? { sourcePath, installCommand } : {}),
  };
  if (packagedCli && await isPackagedExographCli(commandPath)) {
    return { state: "current", ...common };
  }
  if (!sourcePath) return { state: "unavailable", ...common };

  try {
    const entry = await lstat(commandPath);
    if (!entry.isSymbolicLink()) return { state: "non-exograph", ...common };

    const linkTarget = await readlink(commandPath);
    const resolvedTarget = path.resolve(path.dirname(commandPath), linkTarget);
    if (path.resolve(sourcePath) === resolvedTarget) return { state: "current", ...common };

    try {
      const content = await readFile(resolvedTarget, "utf8");
      if (content.includes(LEGACY_SHIM_MARKER)) return { state: "legacy-exograph", ...common };
    } catch {
      if (
        linkTarget.endsWith("/bin/exo")
        || linkTarget === "bin/exo"
        || linkTarget.endsWith("/bin/exograph")
        || linkTarget === "bin/exograph"
      ) return { state: "legacy-exograph", ...common };
    }
    return { state: "non-exograph", ...common };
  } catch {
    return { state: "unavailable", ...common };
  }
}

/**
 * The desktop application owns this small launcher. It deliberately installs
 * only into the user's local bin and refuses to replace another command.
 */
export async function installPackagedCli(
  packagedCli: PackagedCliPaths,
  { env = process.env }: Pick<InspectCliInstallationOptions, "env"> = {},
): Promise<CliInstallationStatus> {
  const home = env.HOME || process.env.HOME;
  if (!home) throw new Error("Exograph could not determine your home folder for the CLI install.");
  const binDirectory = path.join(home, ".local", "bin");
  const target = path.join(binDirectory, "exo");
  const existing = await existingCliKind(target);
  if (existing === "other") {
    throw new Error(`Refusing to replace the existing command at ${target}.`);
  }

  await mkdir(binDirectory, { recursive: true });
  const temporary = `${target}.tmp-${process.pid}`;
  await writeFile(temporary, packagedCliLauncher(packagedCli), { encoding: "utf8", mode: 0o755 });
  await chmod(temporary, 0o755);
  await rename(temporary, target);
  return inspectCliInstallation({ env, packagedCli });
}

async function findExecutable(name: string, pathValue: string | undefined): Promise<string | undefined> {
  for (const directory of (pathValue ?? "").split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(directory, name);
    try {
      if ((await lstat(candidate)).isSymbolicLink()) return candidate;
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Keep looking: a PATH entry may contain a non-executable file.
    }
  }
  return undefined;
}

async function existingCliKind(target: string): Promise<"missing" | "current" | "other"> {
  try {
    await lstat(target);
  } catch {
    return "missing";
  }
  return await isPackagedExographCli(target) ? "current" : "other";
}

async function isPackagedExographCli(candidate: string): Promise<boolean> {
  try {
    const content = await readFile(candidate, "utf8");
    return content.includes(PACKAGED_SHIM_MARKER);
  } catch {
    return false;
  }
}

function packagedCliLauncher(packagedCli: PackagedCliPaths): string {
  return [
    "#!/bin/sh",
    `# ${PACKAGED_SHIM_MARKER}`,
    `exec env ELECTRON_RUN_AS_NODE=1 ${shellQuote(packagedCli.appExecutablePath)} ${shellQuote(packagedCli.scriptPath)} \"$@\"`,
    "",
  ].join("\n");
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\\"'\\\"'")}'`;
}

function shellPathInstruction(commandPath: string, env: NodeJS.ProcessEnv): string {
  const directory = path.dirname(commandPath);
  const home = env.HOME || process.env.HOME;
  if (home && directory === path.join(home, ".local", "bin")) {
    return 'export PATH="$HOME/.local/bin:$PATH"';
  }
  return `export PATH=${shellQuote(directory)}:"$PATH"`;
}
