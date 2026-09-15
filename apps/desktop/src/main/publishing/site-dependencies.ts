import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { commandEnvironment } from "../command/command-environment";

/** Use the packaged npm and Node runtime, including in a GUI-launched installation. */
export async function installSiteDependencies(directory: string, signal: AbortSignal): Promise<void> {
  const bin = await mkdtemp(path.join(path.dirname(directory), ".npm-bin-"));
  try {
    const quote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
    await writeFile(path.join(bin, "node"), `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec ${quote(process.execPath)} "$@"\n`, { mode: 0o700 });
    const npm = path.join(path.dirname(createRequire(import.meta.url).resolve("npm/package.json")), "bin", "npm-cli.js");
    await promisify(execFile)(process.execPath, [npm, "ci", "--no-audit", "--no-fund"], {
      cwd: directory, signal, timeout: 600_000, maxBuffer: 8_388_608,
      env: { ...commandEnvironment(), ELECTRON_RUN_AS_NODE: "1", PATH: `${bin}${path.delimiter}${commandEnvironment().PATH}` },
    });
  } finally { await rm(bin, { recursive: true, force: true }); }
}
