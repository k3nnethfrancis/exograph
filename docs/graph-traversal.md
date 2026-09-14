# CLI graph traversal

`exo graph traverse` performs a bounded breadth-first traversal of the existing
Workspace knowledge graph. It reads the same canonical Concepts, Relations and
Evidence used by the app; it does not infer new relationships.

```sh
exo graph traverse --workspace my-workspace --start-path /notes/start.md \
  --direction both --max-depth 2 --max-results 40 --limit 10 --offline
```

Select a registered Workspace by ID, label or root using `--workspace`, or use the
existing explicit `EXOGRAPH_WORKSPACE_ROOT` and `EXOGRAPH_NOTE_ROOTS` development
configuration. Do not combine these selection mechanisms. Arbitrary paths do not
register or authorize a new Workspace. `--start-path` must match a Note in that
Workspace's graph; alternatively supply its canonical Concept ID with `--start`.
Frontmatter IDs are not substitutes for canonical Concept IDs.

Without `--offline`, the command requires the app serving that same Workspace.
Both adapters call the Core traversal owner. The authenticated app route is
`POST /graph/traverse`; its request uses `workspaceRoot`, `start` or `startPath`,
`direction`, `predicate`, `maxDepth`, `maxResults`, `limit`, and optional `cursor`.
Unknown fields and out-of-range limits are rejected.

## Bounds and identity

- Direction is `outgoing`, `incoming`, or `both` (default). Undirected Relations
  can be followed from either endpoint. `--predicate` matches an exact predicate;
  ordinary document links use `references`.
- Depth is 1–3 (default 1). Node budget is 1–100 (default 100); the start at depth
  zero counts. Page size is 1–100 (default 25). Each invocation follows at most
  1,000 adjacency steps and returns at most 1 MiB of JSON.
- Only resolved Concepts and Relations are traversed. Missing, ambiguous,
  external and Artifact references are excluded. Duplicate graph identities
  produce an explicit error.
- Every followed Relation retains canonical source, target, family, origin,
  predicate and evidence. Parallel link occurrences retain distinct edge IDs.
  Traversal direction is separately recorded in `follow` events.
- Evidence handles are snapshot-scoped occurrence identities. Evidence and nodes
  include Note-root-relative citation paths where the graph provides them.

## Pagination and traces

The `exograph.graph-traversal.v1` response includes `workspace`, `snapshotId`,
normalized `request`, `nodes`, `edges`, `evidence`, `events`, `traversalId`,
`execution`, `completion` and `nextCursor`. Pass `nextCursor` with the same request
for the next node page. Cursors are opaque and bound to Workspace, graph snapshot
and query; stale or mismatched cursors fail explicitly. The snapshot identifies
projected graph state, not all arbitrary bytes in every Note.

Graph projection and adjacency preparation can still scan the Workspace; traversal
budgets bound visits, follows and response size, not total indexing work.

Only `nodes` are paginated. Each invocation replays the complete bounded BFS and
returns all actual visit/follow events and followed edges/evidence, including work
repeated for later pages. `execution.kind` is `deterministic-replay`;
`execution.visitedCount` counts this invocation's visits, and `returnedOffset`
identifies its node-page offset. Events are in execution order with contiguous
`seq` values; their enclosing `traversalId` and `snapshotId` identify the run.
A `visit` means discovery into the BFS queue. Each canonical Concept is visited
once per invocation; cycles and repeated links can produce additional follows.

`completion.reason` distinguishes `page-limit`, `max-results`, `edge-limit`, and
`complete-within-depth`. `truncated` includes both later pages and a stopped
bounded search. Exhausting pagination does not imply the whole graph was explored.
Consumers must count all replay events when reporting execution cost. Full
properties and repeated evidence can make responses large even with small node
pages; reduce `maxResults` to bound traversal work. This version returns a finished
trace; it does not stream live events or persist traversal history.

Successful results exit 0. Typed traversal errors exit 1 and preserve their JSON
envelope (`scope-mismatch`, `stale-cursor`, `invalid-cursor`, `missing-start`,
`invalid-graph`, `too-large`). Invalid CLI arguments and unreachable app failures
use the existing CLI error path.
