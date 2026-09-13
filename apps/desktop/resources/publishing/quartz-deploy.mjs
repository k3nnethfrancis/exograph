#!/usr/bin/env node
import { parseArgs } from "node:util";
import { deploySnapshot } from "./deploy.mjs";
try {
  const { values } = parseArgs({ options: Object.fromEntries(["engine", "input", "snapshot-hash", "engine-commit", "site-url", "repository", "engine-repository", "workflow", "build-script"].map(key => [key, { type: "string" }])) });
  const result = await deploySnapshot({ engineDirectory: values.engine, input: values.input, snapshotHash: values["snapshot-hash"], engineCommit: values["engine-commit"], siteUrl: values["site-url"], repository: values.repository, engineRepository: values["engine-repository"], workflowPath: values.workflow, buildScriptPath: values["build-script"] });
  process.stdout.write(JSON.stringify(result) + "\n");
  process.exitCode = result.status === "setup-required" ? 2 : 0;
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, status: "failed", message: error.message, runId: error.runId, snapshotCommit: error.snapshotCommit }) + "\n");
  process.exitCode = 1;
}
