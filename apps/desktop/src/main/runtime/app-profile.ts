import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, renameSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/** Copy before switching profiles, retaining the entire old profile for rollback. */
export function prepareAppProfile(appData: string, override?: string): string {
  if (override) return override;
  const destination = path.join(appData, "Exograph");
  const legacy = path.join(appData, "@exograph", "desktop");
  if (existsSync(destination) || !existsSync(legacy)) return destination;
  if (!lstatSync(legacy).isDirectory()) throw new Error(`Expected a profile directory at ${legacy}`);
  // Chromium's singleton lock identifies the old process. Never copy a live database.
  const lock = path.join(legacy, "SingletonLock");
  try {
    const owner = readlinkSync(lock);
    const match = /^(.*)-(\d+)$/.exec(owner);
    if (!match || match[1] !== os.hostname()) throw new Error("Close the older Exograph app before migrating its profile.");
    try { process.kill(Number(match[2]), 0); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return migrate(); throw error; }
    throw new Error("Close the older Exograph app before migrating its profile.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return migrate();

  function migrate(): string {
    mkdirSync(appData, { recursive: true });
    const stage = mkdtempSync(path.join(appData, ".Exograph-migration-"));
    try {
      cpSync(legacy, stage, { recursive: true, verbatimSymlinks: true, filter: source => {
        const relative = path.relative(legacy, source);
        return !["SingletonLock", "SingletonCookie", "SingletonSocket", "DevToolsActivePort"].includes(relative);
      } });
      const oldSites = path.join(stage, "publishing-sites");
      if (existsSync(oldSites)) {
        if (existsSync(path.join(stage, "published-sites"))) throw new Error("Both site directories exist; refusing to overwrite either.");
        renameSync(oldSites, path.join(stage, "published-sites"));
      }
      const relocate = (value: unknown): unknown => {
        if (typeof value === "string") {
          if (value !== legacy && !value.startsWith(legacy + path.sep)) return value;
          const relative = path.relative(legacy, value);
          return path.join(destination, relative === "publishing-sites" || relative.startsWith("publishing-sites" + path.sep)
            ? relative.replace(/^publishing-sites/, "published-sites") : relative);
        }
        if (Array.isArray(value)) return value.map(relocate);
        if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, relocate(item)]));
        return value;
      };
      for (const file of ["workspace-settings.json", "workspace-registry.json", "onboarding-state.json", "agent-command-trust.json"]) {
        const target = path.join(stage, file);
        if (existsSync(target)) {
          if (!lstatSync(target).isFile()) throw new Error(`Expected a regular profile file: ${file}`);
          writeFileSync(target, JSON.stringify(relocate(JSON.parse(readFileSync(target, "utf8"))), null, 2) + "\n", { mode: 0o600 });
        }
      }
      // Promotion is atomic. A competing migration cannot replace a populated profile.
      renameSync(stage, destination);
      return destination;
    } finally { rmSync(stage, { recursive: true, force: true }); }
  }
}
