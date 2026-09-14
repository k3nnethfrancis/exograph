# Core domain map

`@exograph/core` owns portable domain rules and shared data contracts. It must stay
free of Electron, renderer, CLI process, and user-machine assumptions.

## Start with the owner

- Workspace scope, Note Roots, and path containment:
  `workspace-files.ts`, `workspace.ts`, `workspace-settings.ts`, and
  `path-containment.ts`. Start with `__tests__/workspace-files.test.ts`.
- Markdown graph projection and graph integrity: `workspace-graph.ts`,
  `graph-projection.ts`, and `graph-integrity.ts`; core preserves authored
  evidence and never lets renderer layout become a knowledge fact. Tests live
  in `__tests__/workspace-graph.test.ts` and
  `__tests__/graph-integrity.test.ts`.
- Formats and ontology interpretation: `note-root-format.ts`,
  `workspace-ontology.ts`, and `ontology-review.ts`. Formats project Markdown;
  ontology interprets afterward and must preserve unknown user data. Start at
  `__tests__/ontology-review.test.ts`.
- Search/index capability boundary: `workspace-index.ts` and
  `search-provider.ts`. Providers are adapters, and indexing is derived work.
- Invocation records, prompt envelope, continuity, and artifacts:
  `agent-invocation.ts`, `document-agent-protocol.ts`, and `invocation-*.ts`.
- Shared desktop/CLI command routes and exact payload unions:
  `command-protocol.ts`. Its tests and the desktop transport tests are the
  contract evidence; it is a protected public surface.

## Non-ownership and invariants

- Markdown/frontmatter is canonical. Derived facts, indexes, proposals, and
  activity artifacts stay derived until accepted.
- A Workspace accepts only explicit Note Roots; no helper may silently expand
  that authority to arbitrary filesystem paths.
- Keep `document | ontology | inferred` relation origin separate from writer
  provenance. Do not use renderer-local numeric kinds as ontology types.
- Prefer closed unions when a wire or persisted shape has a finite contract;
  runtime decoders must reject unknown aliases rather than accepting structural
  lookalikes.
- Export only an earned cross-package contract. A convenience export is not a
  reason to widen the public API.

## Focused gates

```bash
pnpm --filter @exograph/core exec vitest run src/__tests__/workspace-files.test.ts
pnpm --filter @exograph/core exec vitest run src/__tests__/workspace-graph.test.ts src/__tests__/ontology-review.test.ts
pnpm --filter @exograph/core typecheck
pnpm --filter @exograph/core check:unused
```

For graph changes, read `../../docs/architecture.md`,
`../../docs/note-root-formats.md`, and `../../docs/workspace-ontology.md`
before editing.

Editor persistence is owned by `src/document-persistence.ts`: exact-byte read
revisions, serialized revision-checked saves and exclusive copies. It relies on
callers to enforce `WorkspaceFiles` containment. Its queue covers editor saves;
external and invocation writers remain outside it. Do not claim filesystem CAS
or durable dirty-buffer recovery. Test `src/document-persistence.test.ts`.
