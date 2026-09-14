import assert from "node:assert/strict";
import test from "node:test";

import {
  formatMarkdown,
  summarizeReceipts,
  validateReceipt,
} from "./qualification-report.mjs";

function receipt(overrides = {}) {
  return {
    version: 1,
    job: "renderer-visible-fix",
    worker: {
      harness: "codex",
      model: "gpt-5.6",
      configuration: "high",
      freshSession: true,
    },
    outcome: "accepted",
    proof: "matched",
    humanRelayCount: 0,
    repairCycles: 1,
    durationMinutes: 20,
    ratchet: "added",
    notes: "",
    ...overrides,
  };
}

test("summarizes comparable whole-job receipts without hiding empty job classes", () => {
  const summary = summarizeReceipts([
    receipt(),
    receipt({
      job: "core-cli-contract",
      proof: "partial",
      humanRelayCount: 2,
      repairCycles: 3,
      durationMinutes: 40,
      ratchet: "not-needed",
    }),
  ]);

  assert.equal(summary.runs, 2);
  assert.equal(summary.acceptedRate, 1);
  assert.equal(summary.matchedProofRate, 0.5);
  assert.equal(summary.zeroRelayRate, 0.5);
  assert.equal(summary.medianRepairCycles, 2);
  assert.equal(summary.medianDurationMinutes, 30);
  assert.deepEqual(summary.byJob["packaged-first-run"], {
    runs: 0,
    acceptedRate: 0,
    matchedProofRate: 0,
    zeroRelayRate: 0,
  });
  assert.match(formatMarkdown(summary), /packaged-first-run \| 0/);
});

test("rejects receipts that were not produced by a fresh session", () => {
  assert.throws(
    () => validateReceipt(receipt({ worker: { harness: "codex", model: "gpt-5.6", freshSession: false } })),
    /fresh session/,
  );
});
