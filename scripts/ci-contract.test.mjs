import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workflows = new URL("../.github/workflows/", import.meta.url);

async function workflow(name) {
  return readFile(new URL(name, workflows), "utf8");
}

function requiresAll(source, requirements) {
  for (const [label, pattern] of requirements) {
    assert.match(source, pattern, `missing CI contract: ${label}`);
  }
}

test("pull-request CI preserves canonical source and real-Electron proof", async () => {
  const source = await workflow("ci.yml");
  requiresAll(source, [
    ["pull-request trigger", /^\s*pull_request:/m],
    ["read-only repository authority", /permissions:\s*\n\s*contents: read/],
    ["supported Node 24", /node-version: 24/],
    ["canonical harness", /run: pnpm ci:check/],
    ["real Electron smoke", /tests\/e2e\/gate-d-gpu-terminal-smoke\.spec\.ts/],
    ["failure trace retention", /if: failure\(\)[\s\S]*apps\/desktop\/test-results/],
  ]);
});

test("candidate packaging preserves exact packaged-app and artifact proof", async () => {
  const source = await workflow("package-macos.yml");
  requiresAll(source, [
    ["reusable package workflow", /^\s*workflow_call:/m],
    ["canonical source validation", /run: pnpm ci:check/],
    ["packaged containment", /pnpm test:packaged:containment/],
    ["packaged onboarding", /completes and restarts the real packaged first-run journey/],
    ["packaged Electron smoke", /EXOGRAPH_PACKAGED_APP_PATH[\s\S]*gate-d-gpu-terminal-smoke/],
    ["packaged QMD smoke", /EXOGRAPH_PACKAGED_APP_PATH[\s\S]*packaged-qmd-smoke/],
    ["checksums", /shasum -a 256 -c SHA256SUMS\.txt/],
    ["isolated candidate upload", /path: release-assets\/\*/],
  ]);
});

test("release publication stays explicit, identity-bound, and minimally authorized", async () => {
  const source = await workflow("release-macos.yml");
  requiresAll(source, [
    ["manual versioned release", /workflow_dispatch:[\s\S]*version:/],
    ["main-only release", /refs\/heads\/main/],
    ["current-main identity", /GITHUB_SHA[\s\S]*MAIN_SHA/],
    ["version identity", /REQUESTED_VERSION[\s\S]*PACKAGE_VERSION/],
    ["verified package dependency", /needs:\s*\n\s*- validate\s*\n\s*- package/],
    ["checksum verification", /sha256sum -c SHA256SUMS\.txt/],
    ["draft prerelease", /--prerelease[\s\S]*--draft/],
  ]);
  assert.equal(source.match(/contents: write/g)?.length, 1, "write authority must exist only in the publish job");
});
