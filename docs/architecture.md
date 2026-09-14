# Architecture

Exograph is a local Electron application that gives people and agents two
interfaces over the same user-owned Markdown, graph, Ontology, and Search
contracts. This document is the technical map for contributors: follow the
boundaries below rather than adding convenience paths around them.

## Read in this order

1. [`../README.md`](../README.md) for the supported product surface.
2. [`glossary.md`](glossary.md) for product language.
3. [`note-root-formats.md`](note-root-formats.md) and
   [`knowledge-graph.md`](knowledge-graph.md) for the canonical data model.
4. This document for package ownership.
5. The closest `AGENTS.md`, source module, and focused test before changing a
   subsystem.

## Canonical and derived data

```text
Markdown + frontmatter in a selected Note Root
  → format projection
  → WorkspaceGraph knowledge snapshot
  → optional reviewed ontology interpretation
  → derived views
      ├─ bounded Note-context reads
      └─ compact graph topology → WebGPU or Canvas Graph
```

Markdown is canonical. `.exograph/` holds local, rebuildable state: indexes,
command-server discovery, invocation review evidence, accepted ontology state,
and other runtime artifacts. It must never become a competing source of truth.

The basic objects are:

- a **Workspace**: one user-selected main wiki plus saved settings, local
  runtime state, commands, and trust decisions;
- a **Note**: an included Markdown file;
- a **Concept**: the graph identity projected from a Note;
- a **Relation**: an evidenced connection with `document`, `ontology`, or
  `inferred` origin;
- an **Artifact Reference**: a Markdown link to local code or an attachment
  that stays out of the Note/search/topology set.

Read [`knowledge-graph.md`](knowledge-graph.md) before changing graph shape,
identity, evidence, or ontology behavior.

## Runtime topology

```text
React renderer
  ⇅ typed preload API
Electron main process
  ├─ WorkspaceRuntimeCoordinator
  ├─ WorkspaceFiles / WorkspaceGraph / WorkspaceIndex
  ├─ InvocationRunner
  ├─ TerminalManager → node-pty
  ├─ CommandServerLifecycle → loopback command server
  └─ utility processes → QMD and cold graph work

packages/core
  ├─ workspace, Markdown, graph, ontology, search, invocation data models
  └─ pure parsing, validation, persistence helpers, and shared protocol types

packages/cli
  ├─ `exo` JSON command surface
  └─ read-only stdio MCP server
```

The renderer never reads files, launches processes, or imports Node-owned Core
entry points directly. It uses typed preload APIs and browser-safe Core
subpaths. Electron main owns operating-system authority; Core owns portable
domain logic.

## Deep modules

| Owner | Responsibility | Must not own |
| --- | --- | --- |
| `WorkspaceConfigStore` | canonical settings, workspace registry, revisioned atomic writes, unknown-key preservation, unsupported-format rejection | live runtime activation |
| `WorkspaceRuntimeCoordinator` | swaps expensive workspace authority when roots change | unrelated appearance/layout saves |
| `DocumentPersistence` + `useOpenDocuments` | exact-byte read revisions, guarded editor saves and exclusive copies; dirty buffers and explicit conflict resolution | filesystem authorization, invocation journals or crash recovery |
| `WorkspaceFiles` | canonical paths, Note Root containment, symlink policy, watchers | graph/search interpretation |
| `WorkspaceGraph` | graph snapshots, evidence, backlinks, ontology review and local context | rendering or direct UI state |
| `WorkspaceIndex` | provider selection, search health, sync, honest degradation | Note/graph identity |
| `OntologyDiscoveryCoordinator` | one serialized discovery transaction: explicit default-Command validation, frozen graph/Ontology identity, provider execution, validation, Candidate staging, and notification | renderer state, silent provider fallback, or direct Markdown mutation |
| `useWorkspaceBootstrap` + `OnboardingFlow` | one renderer setup model and its dedicated UI, including persisted resume/recovery and local CLI/MCP feedback | a second onboarding state machine or runtime activation authority |
| `TerminalManager` | direct PTY lifecycle and bounded reload tail | provider-specific agent semantics |
| `InvocationRunner` | command trust, process ownership, changesets, review, recovery | renderer UI decisions |
| `WorkspaceCanvas` | pane tree, focus, split/move/close, layout persistence | filesystem or process access |
| `CommandServerLifecycle` | local token-authenticated server discovery | search/graph semantics |

When a change crosses two rows, start with the owner that already owns the
invariant. Add a new abstraction only after two concrete call sites prove the
same contract.

## Critical boundaries

### Editor saves and external writers

Desktop Note reads return a SHA-256 revision of the exact bytes parsed. Every
editor save supplies that revision. `DocumentPersistence` serializes editor
saves by canonical path and compares current bytes before writing through an
existing file handle. A missing file is never recreated by autosave. A mismatch
returns a typed conflict; the renderer retains the latest dirty buffer and
pauses autosave until the person saves an exclusive copy or explicitly discards
local edits and reloads the current file. A late conflict reopens its editor.
Normal quit, reload, Workspace activation and root-authority changes flush while
editing is frozen, and stop if any buffer cannot save.

External tools and invocation writers do not participate in the editor save
queue. Revision checking detects observed changes; it is not atomic filesystem
compare-and-swap against an uncooperative writer. A path check after writing
also catches an observed replacement of the open file. There remains a race
with outside writes during or immediately after the check/write sequence.
Buffers and conflicts remain in renderer memory: renderer crashes, force-kill,
power loss and failed partial filesystem writes have no new recovery guarantee.
This boundary creates no recovery store or invocation journal entries.

### Workspace and filesystem authority

A Workspace has an explicit Note Root. No UI route, CLI convenience argument,
or command cwd may widen Exograph's read/write authority. The current onboarding
experience configures one main wiki; Core remains defensive around persisted
root lists for migration and command-line environments.

The content policy narrows which Markdown files become Notes. Explorer, graph,
Folder Overview, and index ingestion must share it. It is not a sandbox and it
does not alter files.

### Graph and ontology

Formats read a Note Root; ontology interprets selected existing properties;
views present derived topology. These are separate layers. An ontology may
declare reference-valued properties and validation rules, but cannot mutate
Markdown, execute code, configure agents, or control presentation. One source
is active only after explicit review.

Graph rendering receives compact numeric topology. It requests labels, paths,
properties, findings, and evidence through bounded, snapshot-qualified cold
reads. Canvas and WebGPU are equivalent renderers over that scene; neither may
invent semantic facts.

### Search and derived work

Filename/path navigation must use loaded metadata. QMD search, embedding,
index maintenance, graph rebuilds, and other expensive derived work run outside
Electron main with cancellation and visible degradation. A foreground search
never queues behind a maintenance writer; it uses bounded filesystem retrieval
when necessary.

See [`performance-contracts.md`](performance-contracts.md) and ADR 0008 for
the protected latency budgets.

### Commands and review

A configured Command is a provider-neutral local executable. Its trust is
workspace-scoped and bound to the executable fingerprint. Invocation is always
explicit. Exograph snapshots and reviews changes inside Note Roots; a command may
have broader same-user operating-system access, so Exograph never claims to have
reviewed external writes.

Inline invocations use a document envelope and a headless process. CLI
`exo invoke` instead opens a visible terminal task. Both paths share command
validation; only the inline path has document context and in-note review.

### Terminal

There is one production terminal runtime: xterm over direct `node-pty`. App
exit ends PTYs. A bounded in-memory tail helps renderer reload but is not a
durable transcript or terminal-restoration system. See
[`ADR 0009`](adr/0009-direct-pty-terminal-runtime.md).

## Testing and change discipline

Start with the narrowest owner test. Then run:

```sh
pnpm ci:check
```

Use Electron journeys for desktop-visible behavior; browser-only tests cannot
prove preload IPC. Graph renderer work additionally uses
[`../evals/graph/README.md`](../evals/graph/README.md). Public command-server
routes, CLI flags, preload types, and shared protocol types are contracts:
change their focused tests and docs in the same patch.

The renderer authority ratchet
[`renderer-authority-boundary.test.ts`](../apps/desktop/src/renderer/src/renderer-authority-boundary.test.ts)
mechanically rejects production renderer imports of Node, Electron, Electron
main, or preload implementations. Renderer features cross the typed shared/preload
interface instead of widening their own authority.

For persisted state ownership and recovery, read [`durable-state.md`](durable-state.md).
