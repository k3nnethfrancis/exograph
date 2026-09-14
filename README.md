# Exograph

**The open-source exocortex. A Markdown editor that builds a knowledge graph with a custom ontology and tunable search. Terminal agents use the same workspace headlessly through the CLI.**

Exograph opens a folder of Markdown as a local workspace for writing, search, graph exploration, terminals, and agent work. Your notes remain ordinary files on disk; Exograph adds structure and interfaces around them without moving the corpus into a hosted or proprietary knowledge base.

> **Pre-release alpha.** The currently qualified packaged path is an unsigned
> Apple silicon macOS app. Build from source to evaluate it.

## Quick start

Requirements: Apple silicon macOS, Node.js 24, and pnpm 11.2.2 or newer within
the 11.x line.

```sh
git clone --branch dev https://github.com/k3nnethfrancis/exograph.git
cd exograph
pnpm install
pnpm dev:qa
```

Choose a Markdown folder during onboarding. Exograph will open it as a
Workspace without importing or converting its files.

To build and install the current unsigned app and the `exo` command:

```sh
./scripts/install-mac-app --with-cli
```

The app installs to `~/Applications`; the CLI installs to `~/.local/bin`.

## What Exograph adds

- **A local Markdown workspace** — live editing, links, backlinks, properties,
  outlines, images, panes, previews, and real PTY terminals.
- **An explorable knowledge graph** — Markdown links, tags, and frontmatter
  become an evidence-aware graph rendered through WebGPU with a Canvas fallback.
- **A portable ontology** — an optional `ontology.yaml` interprets existing
  paths and properties as types, relations, and validation findings. Exograph
  previews changes before activating them and never rewrites notes to apply it.
- **Tunable local search** — immediate filesystem retrieval and optional QMD
  lexical, semantic, or hybrid search share one replaceable provider boundary.
- **Document-native agents** — invoke Claude, Codex, or another configured local
  command from a note, then review its file changes before keeping or rejecting
  them.
- **Headless agent access** — the structured `exo` CLI exposes workspace status,
  search, indexing, note opening, agent commands, and live terminal control. A
  small read-only MCP server exposes workspace status and note search.

After onboarding, try the source CLI in another shell:

```sh
pnpm exo status
pnpm exo search "knowledge graph"
```

See [CLI and MCP](docs/cli.md) for the complete command surface and app-off
behavior.

## Trust boundary

Markdown is canonical; indexes, graph projections, and proposals are derived.
Configured agent commands are native processes with the permissions of your
local user account—they are not sandboxed. Exograph can review and restore
observed changes inside the selected Note Root, but it does not claim authority
over writes elsewhere on the machine.

## Documentation

- [Using Exograph](docs/using-exograph.md)
- [Knowledge graph](docs/knowledge-graph.md)
- [Workspace ontology](docs/workspace-ontology.md)
- [Search](docs/search.md)
- [Agent invocation](docs/document-agent-protocol.md)
- [Architecture and contributor docs](docs/README.md)

## Contributing

Start with [AGENTS.md](AGENTS.md), then read the closest subsystem guide. Run
the narrowest relevant test first and the canonical repository gate before
handoff:

```sh
pnpm ci:check
```

## License

Exograph is available under the [Apache License 2.0](LICENSE).
