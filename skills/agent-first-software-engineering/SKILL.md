---
name: agent-first-software-engineering
description: "Audit or improve Exograph so an external coding agent can understand, change, verify, and hand off work with minimal human relay. Use for contributor context, module ownership, commands and diagnostics, feedback speed, proof discovery, architecture ratchets, or whole-job agent-readiness. Treat standard CI/CD and releases as a separate delivery system. Do not use to evaluate the external agent host itself."
---

# Agent-First Software Engineering

Treat Exograph as the target software, not the agent harness. A capable external
agent should be able to take a representative job from request to verified
change without a person acting as its search engine, terminal relay, or QA
operator.

## Establish the job

Name the requested outcome, user-visible claim, authority granted, and affected
owners. Read the root `AGENTS.md`, `docs/architecture.md`, and the closest owner
map before proposing a generic framework.

## Audit four loops

1. **Know**
   - **Direction and context:** progressive routes to current, authoritative knowledge.
   - **Architecture and domain:** explicit owners, consistent concepts, completed
     migrations, and mechanically visible dependency directions.
2. **Change**
   - **Operable tools:** discoverable canonical commands, actionable output, and
     access to the real Electron or filesystem surface under change.
   - **Fast feedback:** focused tests, observable runtime state, useful traces,
     and latency short enough to guide the active trajectory.
3. **Prove**
   - **Proof discovery and execution:** the agent can identify the narrowest
     relevant check, run it at the real claim boundary, and distinguish source
     evidence from installed-product evidence.
   - **Evidence and handoff:** the agent can explain what its proof establishes,
     what remains unproven, and give the exact evidence to the human who owns
     merge or release.
4. **Improve**
   - **Cumulative learning:** recurring corrections move into the smallest durable
     owner: context, example, type, module interface, test, policy, or Skill.
   - **Whole-job effectiveness:** repeated fresh jobs measure accepted outcome,
     proof quality, human relay, repair cost, recurrence, and latency.

Score each capability from 0–5:

- `0` absent;
- `1` human-carried or ad hoc;
- `2` documented but dependent on memory;
- `3` repeatable through a canonical path;
- `4` mechanically enforced at the owning seam;
- `5` measured, feedback-controlled, and deliberately adapted.

Report the equal-weight mean and the lowest capability. Never let the average
hide the autonomy bottleneck. Prose, optional hooks, and non-required CI do not
earn enforcement.

## Keep CI/CD separate

[CI/CD and release safety](../../docs/ci-cd.md) owns delivery policy: normal
checks, merge protection, candidate identity, publishing authority, and
rollback. Its existence is a prerequisite, not a score in this rubric.

This Skill asks a narrower question: can an agent discover, execute, interpret,
and truthfully hand off the right proof without a person relaying QA work?
Score that capability here. Consult the CI/CD reference whenever a change
crosses contribution, promotion, or release policy.

## Improve the earliest owner

- missing context → repair the canonical route;
- wrong dependency direction → deepen the module or add a focused structural rule;
- human tool relay → expose a legible command or diagnostic;
- slow exploration → shorten the focused feedback loop;
- false confidence → move proof to the real claim boundary;
- recurring correction → encode the smallest durable ratchet;
- consequential action → narrow and stage authority;
- unproven autonomy → qualify representative whole jobs under a fixed worker setup.

Prefer deletion and consolidation over new frameworks. Route terminal and graph
changes through their repository Skills. Run the narrow owner gate before
`pnpm ci:check`; use packaged-app evidence when the claim crosses installation
or first-run behavior.

## Close substantive work

Before commit or handoff, state:

1. the changed user-visible or system claim;
2. the proof run at that claim's real boundary; and
3. the smallest durable ratchet added, or why none was justified.

Do not call comments, plans, or optional guidance mechanically enforced. A
ratchet must make a repeated violation harder or visible through an owning test,
type, boundary, required policy, or equivalent executable constraint.

When assessing whole-job effectiveness, follow
[`references/whole-job-qualification.md`](references/whole-job-qualification.md).
Keep individual receipts under ignored `docs/internal/`, then summarize them
with the bundled report script. Never commit model transcripts or private task
content.

## Report

Return the job and scope, eight scores with evidence, the lowest loop, ordered
interventions, proof actually run, remaining authority gates, and what should
deliberately remain human judgment. Keep temporary scorecards and trajectories
under ignored `docs/internal/`; do not commit review packets or agent logs.
