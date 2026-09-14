import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { collectPackageEvidence, isForbiddenPayloadPath } from "./package-evidence.mjs";

test("package evidence inventories the staged app and emits license and SPDX evidence", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "exograph-package-evidence-"));
  try {
    const appPath = path.join(root, "Exograph.app");
    const outputPath = path.join(root, "evidence");
    await mkdir(path.join(appPath, "Contents", "Resources"), { recursive: true });
    await writeFile(path.join(appPath, "Contents", "Resources", "fixture.txt"), "fixture", "utf8");

    const result = await collectPackageEvidence(appPath, outputPath, {
      licenses: { MIT: [{ name: "fixture-package", versions: ["1.0.0"], license: "MIT" }] },
    });

    assert.equal(result.inventory.files[0].path, "Contents/Resources/fixture.txt");
    assert.equal(result.components[0].name, "fixture-package");
    assert.equal(JSON.parse(await readFile(path.join(outputPath, "sbom.spdx.json"), "utf8")).spdxVersion, "SPDX-2.3");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("package evidence rejects first-party tests and Windows native payloads", () => {
  assert.equal(isForbiddenPayloadPath("Contents/Resources/app.asar:/tests/e2e/shell.spec.ts"), true);
  assert.equal(isForbiddenPayloadPath("Contents/Resources/app.asar:/node_modules/pkg/prebuilds/win32-x64/native.node", "darwin-arm64"), true);
  assert.equal(isForbiddenPayloadPath("Contents/Resources/app.asar:/node_modules/pkg/prebuilds/darwin-arm64/native.node", "darwin-arm64"), false);
  assert.equal(isForbiddenPayloadPath("Contents/Resources/app.asar:/dist/main/index.js"), false);
});
