# Browser workspace

Use Exo's live local notes in a browser, including a coding app's browser pane.
Start Exograph, select your Workspace, and run:

```sh
exo serve
```

Open the returned `url`. Exograph can remain in the background. This first
version uses the running desktop app's note, search, graph and filesystem
watcher services; it does not upload your Workspace or create a second copy.

The notes button opens the folder tree and search. Open a note to edit Markdown
and properties, follow links and backlinks, or switch to the graph. The graph
supports the same selection, orbit, zoom and keyboard navigation as desktop.
At narrow widths, the notes tree becomes a drawer.

Save with **Save** or **Cmd/Ctrl+S**. Browser edits are explicit saves. If a file
changes elsewhere while you have local edits, Exo keeps those edits and offers
a copy or reload instead of silently overwriting the file. Clean notes refresh
from filesystem events. Navigating away from an unsaved note asks you to save
or discard; closing the tab triggers the browser's unsaved-changes warning.

Search uses the Workspace's selected provider and displays its warnings. Agent
invocations, terminals, publishing setup and settings remain in the desktop app.

## Connection lifetime

The URL works on the same machine as Exograph. The server binds only to
`127.0.0.1`; it does not listen on your network. The link contains a single-use,
five-minute ticket. Opening it exchanges the ticket for a same-origin,
HttpOnly session cookie and removes the ticket from the visible URL. A session
lasts up to twelve hours and is valid only for its Workspace scope. App exit
ends the server; changing Workspace scope expires access. Run `exo serve`
again when prompted to reconnect. Keep the returned link private.

## Ownership and proof

- `apps/desktop/src/main/browser/browser-workspace-server.ts` owns local HTTP,
  session checks, Note Root authorization through Core `WorkspaceFiles`, static
  asset containment and event streaming. It dispatches a closed subset of the
  existing workspace handlers, never arbitrary Electron IPC.
- `apps/desktop/src/shared/browser-api.ts` derives that subset from the desktop
  domain API. `browser-graph-wire.ts` preserves typed graph buffers across JSON.
- `apps/desktop/src/renderer/src/browser/` owns the compact browser shell. It
  reuses `NoteEditor` and `SpatialGraphView` through explicit API inputs.
- `packages/core/src/command-protocol.ts` owns `/browser`; CLI discovery and URL
  validation remain in `packages/cli/src/app-client.ts`.

Build before launching a source app: browser assets are served from
`apps/desktop/dist/renderer` and do not currently have a separate hot-reload
server. Rebuild and reload after browser UI changes.

```sh
pnpm build
pnpm --filter @exograph/desktop exec vitest run src/main/browser/browser-workspace-server.test.ts src/main/browser/browser-graph-wire.test.ts src/main/command/command-server.test.ts
pnpm exec playwright install chromium
pnpm --filter @exograph/desktop exec playwright test tests/e2e/browser-workspace.spec.ts
```

The browser journey launches a real isolated Exograph app and a Chromium
browser. It exercises live reads, saves, outside edits, conflict preservation
and graph fit at a 560-pixel pane width. An existing Chromium executable can be
selected with `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` for local test environments.
