#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const JOBS = new Set([
  "renderer-visible-fix",
  "core-cli-contract",
  "packaged-first-run",
]);
const OUTCOMES = new Set(["accepted", "rejected"]);
const PROOF = new Set(["matched", "partial", "mismatched"]);
const RATCHETS = new Set(["added", "not-needed", "missed"]);

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

export function validateReceipt(receipt, source = "receipt") {
  requireValue(receipt && typeof receipt === "object", `${source}: expected an object`);
  requireValue(receipt.version === 1, `${source}: version must be 1`);
  requireValue(JOBS.has(receipt.job), `${source}: unknown job ${receipt.job}`);
  requireValue(receipt.worker?.freshSession === true, `${source}: worker must use a fresh session`);
  requireValue(typeof receipt.worker?.harness === "string", `${source}: worker.harness is required`);
  requireValue(typeof receipt.worker?.model === "string", `${source}: worker.model is required`);
  requireValue(OUTCOMES.has(receipt.outcome), `${source}: invalid outcome`);
  requireValue(PROOF.has(receipt.proof), `${source}: invalid proof`);
  requireValue(RATCHETS.has(receipt.ratchet), `${source}: invalid ratchet`);
  for (const key of ["humanRelayCount", "repairCycles", "durationMinutes"]) {
    requireValue(
      Number.isFinite(receipt[key]) && receipt[key] >= 0,
      `${source}: ${key} must be a non-negative number`,
    );
  }
  return receipt;
}

function rate(count, total) {
  return total === 0 ? 0 : Number((count / total).toFixed(3));
}

function median(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Number(((sorted[middle - 1] + sorted[middle]) / 2).toFixed(2))
    : sorted[middle];
}

export function summarizeReceipts(receipts) {
  const valid = receipts.map((receipt, index) => validateReceipt(receipt, `receipt ${index + 1}`));
  const summary = {
    runs: valid.length,
    acceptedRate: rate(valid.filter((item) => item.outcome === "accepted").length, valid.length),
    matchedProofRate: rate(valid.filter((item) => item.proof === "matched").length, valid.length),
    zeroRelayRate: rate(valid.filter((item) => item.humanRelayCount === 0).length, valid.length),
    ratchetDecisionRate: rate(valid.filter((item) => item.ratchet !== "missed").length, valid.length),
    medianRepairCycles: median(valid.map((item) => item.repairCycles)),
    medianDurationMinutes: median(valid.map((item) => item.durationMinutes)),
    byJob: {},
  };

  for (const job of JOBS) {
    const runs = valid.filter((item) => item.job === job);
    summary.byJob[job] = {
      runs: runs.length,
      acceptedRate: rate(runs.filter((item) => item.outcome === "accepted").length, runs.length),
      matchedProofRate: rate(runs.filter((item) => item.proof === "matched").length, runs.length),
      zeroRelayRate: rate(runs.filter((item) => item.humanRelayCount === 0).length, runs.length),
    };
  }
  return summary;
}

export function formatMarkdown(summary) {
  const percent = (value) => `${Math.round(value * 100)}%`;
  const rows = Object.entries(summary.byJob)
    .map(([job, result]) => `| ${job} | ${result.runs} | ${percent(result.acceptedRate)} | ${percent(result.matchedProofRate)} | ${percent(result.zeroRelayRate)} |`)
    .join("\n");
  return [
    "# Agent-first qualification",
    "",
    `**${summary.runs} runs** · accepted ${percent(summary.acceptedRate)} · matched proof ${percent(summary.matchedProofRate)} · zero relay ${percent(summary.zeroRelayRate)} · ratchet decision ${percent(summary.ratchetDecisionRate)}`,
    "",
    `Median repair cycles: **${summary.medianRepairCycles}** · median duration: **${summary.medianDurationMinutes} min**`,
    "",
    "| Job | Runs | Accepted | Matched proof | Zero relay |",
    "| --- | ---: | ---: | ---: | ---: |",
    rows,
  ].join("\n");
}

async function main(paths) {
  requireValue(paths.length > 0, "Pass one or more qualification receipt JSON files.");
  const receipts = [];
  for (const filePath of paths) {
    const value = JSON.parse(await readFile(filePath, "utf8"));
    receipts.push(...(Array.isArray(value) ? value : [value]));
  }
  process.stdout.write(`${formatMarkdown(summarizeReceipts(receipts))}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
