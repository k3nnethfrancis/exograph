import { access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** App-owned executables; never resolve deployment code from the user's engine. */
export async function publishingResource(name: "quartz-build.mjs" | "quartz-deploy.mjs" | "github-pages.yml"): Promise<string> {
  const candidates = [
    ...(process.resourcesPath ? [path.join(process.resourcesPath, "publishing", name)] : []),
    fileURLToPath(new URL(`../../../resources/publishing/${name}`, import.meta.url)),
    fileURLToPath(new URL(`../publishing/${name}`, import.meta.url)),
  ];
  for (const candidate of candidates) {
    try { await access(candidate); return candidate; } catch { /* Source, built, and packaged layouts differ. */ }
  }
  throw new Error("Exograph publishing resources are missing. Rebuild or reinstall the app.");
}
