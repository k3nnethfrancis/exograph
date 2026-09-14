# Whole-job qualification

Use this protocol to learn whether a fresh external coding agent can complete a
real Exograph job without a person becoming its context, terminal, or QA relay.
This is an operational study, not a synthetic benchmark or a unit-test suite.
It evaluates agent-first readiness; `docs/ci-cd.md` separately owns ordinary
merge, candidate, and release policy.

## Fixed conditions

- Start each run in a fresh agent session from the same reviewed commit.
- Record the harness, model, and reasoning configuration.
- Give the worker the real issue and normal repository access, not hidden hints.
- Let repository guidance and ordinary tool output provide orientation.
- Count every material human clarification, command relay, product observation,
  or verification step as human relay.
- Accept or reject the outcome against the original claim and its real boundary.

## Three representative jobs

1. **Renderer-visible fix** — repair a genuine editor, pane, graph, or invocation
   behavior and prove it in Electron at the affected interaction boundary.
2. **Core/CLI contract** — change a real Core behavior consumed by CLI or MCP,
   preserving filesystem authority, response contracts, focused tests, and docs.
3. **Packaged first run** — repair a genuine installation, onboarding, native
   runtime, or relaunch behavior and prove the exact packaged application.

Use current real work. Do not invent defects merely to complete the exercise.
If no suitable job exists, leave that class unqualified.

## Receipt

Write one ignored JSON file per run under `docs/internal/agent-first/`:

```json
{
  "version": 1,
  "job": "renderer-visible-fix",
  "worker": {
    "harness": "codex",
    "model": "gpt-5.6",
    "configuration": "high",
    "freshSession": true
  },
  "outcome": "accepted",
  "proof": "matched",
  "humanRelayCount": 0,
  "repairCycles": 1,
  "durationMinutes": 24,
  "ratchet": "added",
  "notes": "Focused Electron journey and canonical gate passed."
}
```

Allowed outcomes are `accepted` or `rejected`; proof is `matched`, `partial`, or
`mismatched`; ratchet is `added`, `not-needed`, or `missed`.

Summarize one or more runs:

```sh
node skills/agent-first-software-engineering/scripts/qualification-report.mjs \
  docs/internal/agent-first/*.json
```

Read the acceptance rate together with matched proof, zero-relay completion,
repair cycles, duration, and ratchet decisions. A high average cannot conceal a
job class that still depends on the human. Three successful examples establish
a baseline; repeated fresh runs are required before claiming measured autonomy.
