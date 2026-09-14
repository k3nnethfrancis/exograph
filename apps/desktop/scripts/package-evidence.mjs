#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { listPackage } from "@electron/asar";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

export async function collectPackageEvidence(appPath, outputDirectory, options = {}) {
  const files = await inventoryFiles(appPath);
  const asarPath = path.join(appPath, "Contents", "Resources", "app.asar");
  const asarEntries = await fileExists(asarPath)
    ? listPackage(asarPath).map((entry) => `Contents/Resources/app.asar:${entry}`)
    : [];
  const payloadPaths = [...files.map((entry) => entry.path), ...asarEntries];
  const allowedNativePlatform = nativePlatformForApp(appPath);
  const forbiddenPaths = payloadPaths.filter((candidate) => isForbiddenPayloadPath(candidate, allowedNativePlatform));
  if (forbiddenPaths.length > 0) {
    throw new Error(`Packaged app contains forbidden payloads:\n${forbiddenPaths.join("\n")}`);
  }

  const licenses = options.licenses ?? await productionLicenses();
  const components = flattenLicenses(licenses);
  const generatedAt = new Date().toISOString();
  const appVersion = JSON.parse(await readFile(path.join(repoRoot, "apps/desktop/package.json"), "utf8")).version;
  const inventory = {
    schemaVersion: 1,
    generatedAt,
    app: { name: "Exograph", version: appVersion, path: path.resolve(appPath) },
    files,
    asarEntries,
    forbiddenPayloadRules: forbiddenPayloadRules(allowedNativePlatform).map(({ name, pattern }) => ({ name, pattern: pattern.source })),
  };
  const sbom = createSpdxDocument({ appVersion, components, generatedAt });

  await mkdir(outputDirectory, { recursive: true });
  await Promise.all([
    writeFile(path.join(outputDirectory, "package-inventory.json"), `${JSON.stringify(inventory, null, 2)}\n`, "utf8"),
    writeFile(path.join(outputDirectory, "sbom.spdx.json"), `${JSON.stringify(sbom, null, 2)}\n`, "utf8"),
    writeFile(path.join(outputDirectory, "third-party-licenses.json"), `${JSON.stringify({
      schemaVersion: 1,
      generatedAt,
      basis: "pnpm production dependency closure for @exograph/desktop",
      components,
    }, null, 2)}\n`, "utf8"),
  ]);

  return { inventory, sbom, components };
}

export function isForbiddenPayloadPath(candidate, allowedNativePlatform = `${process.platform}-${process.arch}`) {
  return forbiddenPayloadRules(allowedNativePlatform).some((rule) => rule.pattern.test(candidate));
}

function forbiddenPayloadRules(allowedNativePlatform) {
  return [
    { name: "first-party tests", pattern: /app\.asar:\/(?:tests?|fixtures?|__tests__)(?:\/|$)/i },
    { name: "internal project documents", pattern: /app\.asar:\/docs\/internal(?:\/|$)/i },
    {
      name: "foreign native prebuild",
      pattern: new RegExp(`/prebuilds/(?!${escapeRegExp(allowedNativePlatform)}(?:/|$))[^/]+(?:/|$)`, "i"),
    },
    { name: "Windows executable", pattern: /\.(?:exe|pdb)$/i },
  ];
}

function nativePlatformForApp(appPath) {
  const outputName = path.basename(path.dirname(appPath));
  if (outputName.endsWith("-x64")) return "darwin-x64";
  if (outputName.endsWith("-arm64")) return "darwin-arm64";
  return `${process.platform}-${process.arch}`;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function inventoryFiles(root) {
  const entries = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(absolutePath);
        continue;
      }
      if (!entry.isFile()) continue;
      const [metadata, bytes] = await Promise.all([stat(absolutePath), readFile(absolutePath)]);
      entries.push({
        path: path.relative(root, absolutePath).split(path.sep).join("/"),
        size: metadata.size,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
    }
  }
  await visit(root);
  return entries.sort((left, right) => left.path.localeCompare(right.path));
}

function productionLicenses() {
  return new Promise((resolve, reject) => {
    const child = spawn("pnpm", ["--filter", "@exograph/desktop", "licenses", "list", "--prod", "--json"], {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`Unable to collect production licenses: ${stderr.trim()}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (error) {
        reject(new Error(`Unable to parse production licenses: ${error instanceof Error ? error.message : String(error)}`));
      }
    });
  });
}

function flattenLicenses(licenses) {
  const components = [];
  for (const [licenseGroup, packages] of Object.entries(licenses)) {
    for (const packageRecord of packages) {
      for (const version of packageRecord.versions ?? ["unknown"]) {
        components.push({
          name: packageRecord.name,
          version,
          license: packageRecord.license ?? licenseGroup,
          homepage: packageRecord.homepage ?? null,
        });
      }
    }
  }
  return components.sort((left, right) => `${left.name}@${left.version}`.localeCompare(`${right.name}@${right.version}`));
}

function createSpdxDocument({ appVersion, components, generatedAt }) {
  const documentNamespace = `https://exograph.com/spdx/${appVersion}/${randomUUID()}`;
  const packages = components.map((component) => ({
    SPDXID: spdxId(component.name, component.version),
    name: component.name,
    versionInfo: component.version,
    downloadLocation: "NOASSERTION",
    filesAnalyzed: false,
    licenseConcluded: "NOASSERTION",
    licenseDeclared: component.license || "NOASSERTION",
    copyrightText: "NOASSERTION",
    ...(component.homepage ? { homepage: component.homepage } : {}),
  }));
  return {
    spdxVersion: "SPDX-2.3",
    dataLicense: "CC0-1.0",
    SPDXID: "SPDXRef-DOCUMENT",
    name: `Exograph-${appVersion}`,
    documentNamespace,
    creationInfo: { created: generatedAt, creators: ["Tool: Exograph package-evidence"] },
    packages,
    relationships: packages.map((component) => ({
      spdxElementId: "SPDXRef-DOCUMENT",
      relationshipType: "DESCRIBES",
      relatedSpdxElement: component.SPDXID,
    })),
  };
}

function spdxId(name, version) {
  return `SPDXRef-Package-${createHash("sha256").update(`${name}@${version}`).digest("hex").slice(0, 16)}`;
}

async function fileExists(targetPath) {
  try {
    await stat(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const [appPath, outputDirectory] = process.argv.slice(2);
  if (!appPath || !outputDirectory) {
    throw new Error("Usage: package-evidence.mjs <Exograph.app> <output-directory>");
  }
  await collectPackageEvidence(appPath, outputDirectory);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
