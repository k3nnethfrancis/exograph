# Exograph contributor map

This file is provider-neutral guidance for coding agents. Do not add
provider-specific instructions or duplicate this map in harness-specific files.

## Start here

1. [README.md](README.md) — supported product surface and setup.
2. [docs/glossary.md](docs/glossary.md) — product vocabulary.
3. [docs/architecture.md](docs/architecture.md) — package boundaries and runtime ownership.
4. [docs/README.md](docs/README.md) — current product and maintainer contracts.

If `docs/internal/` exists locally, read the relevant task, plan, roadmap, or
ledger before planning work. It is an ignored maintainer workspace: use it for
private operational context, but never commit it or cite it as public product
documentation.

## Repository map

- `apps/desktop` — Electron main process, preload, renderer, and shared API.
- `packages/core` — Workspace, Markdown graph, search, invocations, and shared protocol types.
- `packages/cli` — local CLI and MCP presentation.
- `evals/graph` — Exograph's internal graph-rendering regression suite.
- `skills` — reusable provider-neutral instructions for contributors and coding agents.
- `scripts` and `.github/workflows` — repository installation, release, and CI.
  Package-specific build helpers stay with their package.

Subdirectory `AGENTS.md` files identify the closest source and test owner.

## Progressive disclosure

Read only the contract that owns the change, then its focused tests:

- Markdown, filesystem authority, graph, search, ontology, or invocation data:
  [`packages/core/AGENTS.md`](packages/core/AGENTS.md).
- Electron lifecycle, watcher/index services, command server, invocation
  execution, or terminals:
  [`apps/desktop/src/main/AGENTS.md`](apps/desktop/src/main/AGENTS.md).
- Editor, pane layout, graph interaction, or review presentation:
  [`apps/desktop/src/renderer/src/AGENTS.md`](apps/desktop/src/renderer/src/AGENTS.md).
- CLI, MCP, app-off fallback, or transport:
  [`packages/cli/AGENTS.md`](packages/cli/AGENTS.md).

For a cross-cutting proposal, read `docs/architecture.md` and the two relevant
owners before adding a new seam. Do not use a broad `App.tsx` change to bypass
an existing domain owner.

For contributor context, repository structure, developer commands,
architectural ratchets, or autonomous coding-agent workflows, use
[`skills/agent-first-software-engineering/SKILL.md`](skills/agent-first-software-engineering/SKILL.md).
Exograph is the target software in that rubric; the external coding-agent host
is a separate harness. The canonical conceptual explanation is
[`artifacts/exograph-agent-contribution-first-principles.html`](artifacts/exograph-agent-contribution-first-principles.html).
For normal CI/CD, release authority, or promotion policy, read
[`docs/ci-cd.md`](docs/ci-cd.md) and its owning workflows. Use the agent-first
Skill only when the question is whether an agent can independently discover,
run, and interpret the relevant proof.

## Invariants

- A Workspace has explicit Note Roots. No convenience path may widen filesystem authority.
- Markdown and frontmatter are canonical. Derived indexes, proposals, inference, activity, and provenance remain under `.exograph/` until accepted.
- Renderer code never touches filesystem or processes directly; use typed preload APIs.
- A Format projects Markdown, an optional Ontology interprets it afterward, and graph views only affect presentation.
- Commands are provider-neutral executable configurations. Invocation is explicit and reviewable.
- The terminal is one direct, byte-faithful `node-pty` lifecycle; do not restore tmux or durable transcript ownership.
- Public CLI flags, command-server routes, and shared protocol types require focused tests and review.

## Validation

```bash
pnpm ci:check
pnpm check
```

Use `pnpm dev` for source iteration, `pnpm dev:qa` for isolated source QA, and
a packaged `Exograph.app` for first-run or installed-app evidence. Pull requests
run the canonical harness plus one real Electron smoke. Main pushes produce a
read-only unsigned candidate artifact; only the explicit, version-matched macOS
release workflow may create a draft release. Run focused owner tests before the
broad gate and update public documentation for user-visible changes.

## Completion protocol

Before committing or handing off a substantive implementation, bug fix,
performance pass, or architectural review, use the agent-first engineering
Skill and report three things:

1. the user-visible or system claim that changed;
2. the proof that exercised the boundary where that claim is experienced; and
3. the smallest durable ratchet added, or why no ratchet was justified.

A comment, plan, or instruction is context, not mechanical enforcement. Prefer
a focused test, type, module boundary, required workflow, or other check that
fails when the learned constraint is violated. Do not manufacture a ratchet for
trivial edits or duplicate an invariant already enforced by its owner.

File bugs and feature requests in GitHub Issues. Keep plans, review packets,
agent logs, and private operational notes outside this repository.
