# Exograph documentation

Exograph is an open-source exocortex built from user-owned Markdown, an optional
portable Ontology, replaceable local Search, an explorable knowledge graph, and
provider-neutral terminal agents. People use these systems through the desktop
workspace; agents address the same scoped context through the CLI and MCP.

The documentation has two audiences: people using a Workspace and people
changing the software. Start with the document that matches your job; deeper
contracts are linked from there.

## Use Exograph

- [Using Exograph](using-exograph.md) — workspaces, Notes, navigation, panes, keyboard shortcuts, and daily work.
- [Publishing](publishing.md) — folder exports, Quartz previews, and preparing a site for review.
- [Search](search.md) — immediate search, optional QMD indexing, and recovery.
- [Knowledge graph](knowledge-graph.md) — what the graph represents and what it deliberately does not.
- [Agent invocations](document-agent-protocol.md) — inline `@` requests, review, durable response blocks, and session handoff.
- [CLI and MCP](cli.md) — shell commands, app-off behavior, and the bounded MCP server.
- [CLI graph traversal](graph-traversal.md) — bounded graph queries, snapshot cursors, and execution traces.
- [Workspace ontology](workspace-ontology.md) — optional `ontology.yaml` interpretation and review.
- [Note Root Formats](note-root-formats.md) — Generic Markdown and OKF 0.1 compatibility.
- [Troubleshooting](troubleshooting.md) — first repairs for workspace scope, search, invocations, MCP, and CLI.

## Contribute to Exograph

- [Architecture](architecture.md) — runtime topology, deep modules, boundaries, and reading order.
- [Durable state](durable-state.md) — persistence owners and recovery rules.
- [Performance contracts](performance-contracts.md) — protected latency budgets and focused gates.
- [How Exograph helps agents contribute good code](../artifacts/exograph-agent-contribution-first-principles.html) — the canonical first-principles explainer for context, ownership, proof, CI/CD, and durable learning.
- [CI/CD and release safety](ci-cd.md) — local checks, GitHub workflows, release authority, and remaining launch safeguards.
- [Terminal runtime ADR](adr/0009-direct-pty-terminal-runtime.md) — direct-PTY design constraints.
- [Architecture decisions](adr/) — accepted decisions that remain live.
- [Contributor skills](../skills/README.md) — reusable, provider-neutral working instructions.

The repository root has [setup and contribution guidance](../README.md) plus
[agent guidance](../AGENTS.md). `docs/internal/`, when it exists locally, is
ignored maintainer context; it is never public product documentation.
