# Desktop renderer map

This directory owns rendered interaction, local state, and presentation. It
never owns filesystem/process access or a second version of core domain rules;
use `window.exograph` through preload/shared API types.

## Start with the owner

- `App.tsx` composes the shell. It coordinates features but should not absorb a
  feature state machine or deterministic transform.
- Canvas document opening, focus, graph return state, and path remapping live
  in `hooks/useCanvasDocumentNavigation.ts`; focused pane selection is the sole
  current-document authority. Test
  `hooks/useCanvasDocumentNavigation.test.ts` and
  `latestPaneNavigation.test.ts`.
- Invocation review queue, hydration, accept/reject, and workspace-race guards
  live in `hooks/useInvocationReviewController.ts` with
  `invocationReviewQueue.ts`. Identity must change during render when a new
  Workspace is rendered; do not wait for a passive effect to release an older
  request. Test `hooks/useInvocationReviewController.test.ts` and
  `invocationReviewQueue.test.ts`.
- Markdown live preview's only public compatibility import is the two-line
  `components/markdownLivePreview.ts` adapter. Its private command, metadata,
  widget, and decoration owners live under
  `components/markdown-live-preview/`; test
  `components/markdown-live-preview/index.test.ts` and
  `../../../tests/e2e/markdown-rules.spec.ts`.
- Pane topology is `hooks/usePaneTree.ts` plus `paneTreeSelectors.ts`; keep
  pure tree transforms free of React and preload calls.
- Graph scene/layout/interaction is owned by `graphSceneFoundation.ts`,
  `graphLayoutSimulation.ts`, `graphInteraction.ts`, and renderer hosts. Read
  `../../../../../docs/architecture.md` before changing a graph layer.

## Non-ownership and invariants

- `../../shared/api.ts` is the one desktop aggregate seam for main, preload,
  and renderer API types. Do not duplicate shared IPC definitions in feature
  files.
- Do not add Node or Electron imports to renderer code.
- A pane's focus is not the same as historical navigation context. Preserve
  that distinction when adding graph/editor behavior.
- Keep document editing and navigation synchronous enough for the rendered
  frame; move indexing, loading, and non-interactive work off the hot path.
- Do not turn the markdown adapter into a second implementation or introduce
  private-folder imports from outside its owning feature.

## Focused gates

```bash
pnpm --filter @exograph/desktop exec vitest run src/renderer/src/hooks/useCanvasDocumentNavigation.test.ts
pnpm --filter @exograph/desktop exec vitest run src/renderer/src/hooks/useInvocationReviewController.test.ts src/renderer/src/invocationReviewQueue.test.ts
pnpm --filter @exograph/desktop exec vitest run src/renderer/src/components/markdown-live-preview/index.test.ts
pnpm --filter @exograph/desktop exec vitest run src/renderer/src/renderer-authority-boundary.test.ts
pnpm --filter @exograph/desktop exec playwright test tests/e2e/markdown-rules.spec.ts
pnpm --filter @exograph/desktop typecheck
```

Use the real Electron renderer for UI/terminal changes. A browser-only route
does not provide `window.exograph` and cannot prove IPC behavior.
