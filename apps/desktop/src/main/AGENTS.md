# Desktop main-process map

This directory owns Electron-process composition and lifecycle. It turns the
core model into local services and IPC; it does not define Markdown, graph,
search, command-wire, or renderer state contracts.

## Start with the owner

- Workspace activation and committed scope:
  `runtime/workspace-runtime-coordinator.ts`.
  Its candidate is private until one synchronous final commit; late work must
  not publish or degrade a replacement Workspace. Start at
  `runtime/workspace-runtime-coordinator.test.ts`.
- Settings effect ownership:
  `runtime/workspace-settings-apply-plan.ts`. Layout and appearance publish in
  place; terminal and index changes go only to those owners; only Workspace
  root authority replaces the full runtime.
- Workspace settings, filesystem service, and IPC wiring:
  `workspace/workspace-config-store.ts`, `workspace/workspace-notes-service.ts`,
  and `workspace/workspace-ipc.ts`. Core owns path containment and persistent
  model types.
- Watcher lifetime: `workspace/workspace-watchers.ts`. Filesystem freshness
  comes from this service, not renderer polling. Test
  `workspace/workspace-watchers.test.ts`.
- Derived indexing: `indexing/indexing-service.ts` and
  `indexing/derived-index-*.ts`; it stays asynchronous and must never make
  renderer interaction wait.
- Command-server lifecycle: `command/command-server-lifecycle.ts`; HTTP
  route/payload contracts belong in `packages/core/src/command-protocol.ts` and
  the transport implementation is `command/command-server.ts`.
- Invocation execution and review artifacts:
  `invocation/invocation-runner.ts` and `invocation/invocation-review.ts`. The
  renderer owns review presentation and decisions.
- Direct PTY lifecycle: `terminal/terminal-manager.ts` and
  `terminal/terminal-runtime*.ts`. Read
  `../../../../docs/adr/0009-direct-pty-terminal-runtime.md` before changing terminal
  behavior.

`index.ts` is composition only: assemble services, register IPC, and make no
second implementation of a named owner.

## Non-ownership and invariants

- Renderer code reaches this directory only through preload/shared IPC types;
  do not import renderer modules here.
- Do not widen Note Root authority in a main-process convenience path. Core
  containment rules apply to every read, write, preview, and watcher action.
- A command server for candidate B is not discoverable until the coordinator
  commits B. A stale watcher, index callback, or recovery task must be ignored.
- Keep terminal bytes and ordinary xterm scrollback intact; do not add tmux or
  harness-specific terminal transport.
- Do not add or change CLI/command-server routes or shared protocol shapes
  without the protected-contract approval recorded in the task brief.

## Focused gates

```bash
pnpm --filter @exograph/desktop exec vitest run src/main/runtime/workspace-runtime-coordinator.test.ts
pnpm --filter @exograph/desktop exec vitest run src/main/workspace/workspace-watchers.test.ts
pnpm --filter @exograph/desktop exec vitest run src/main/command/command-server-lifecycle.test.ts src/main/command/command-server.test.ts
pnpm --filter @exograph/desktop exec vitest run src/main/invocation/invocation-runner.test.ts src/main/invocation/invocation-review.test.ts
pnpm --filter @exograph/desktop typecheck
```

For a cross-process change, run the relevant Electron path; unit tests alone do
not prove main/preload/renderer agreement.
