# Troubleshooting

Start with the smallest repair. Your Markdown is canonical; Exograph's indexes,
layouts, and review artifacts are derived state.

## A file is missing from Explorer, search, or graph

Check that it is a Markdown file under the workspace's main wiki, then open
**Settings → Workspace** and confirm the content scope includes its path.
**Markdown notes** intentionally excludes code-oriented and generated paths in
a repository; **All Markdown** includes every Markdown file below the selected
folder. A local code or attachment link may appear as an artifact reference,
but is not a searchable Note or graph node.

## Search is not returning the result I expect

The search field begins with filename/path matches. Press Enter only after
enabling QMD in **Settings → Search** and choosing **Use QMD when I press Enter
in Explore**. Lexical search favors exact terms; semantic search favors related
meaning; hybrid uses both.

If QMD is catching up or recovering, Exograph keeps foreground retrieval available
through its simple filesystem path and reports that state. Use **Sync documents**
for the current corpus or **Reconcile documents** when the index may be stale.
If status reports a native ABI mismatch, do not load the app's Electron-built
SQLite module from shell Node. Rebuild and reinstall the managed app runtime in
one step with `./scripts/install-mac-app --with-cli`.
Read [Search](search.md) before changing a retrieval mode or rebuilding
embeddings.

## An `@` request cannot run

Confirm the command is enabled in **Settings → Agents** and that its executable
is installed and reachable by the desktop app. Exograph asks for explicit trust when
the executable or its fingerprint changes. It can review changes inside the
workspace's Note Root, but it does not sandbox the native command.

If a command was removed, its old History entries remain readable but new
`@handle` requests are rejected until that handle is configured again.

Inline requests run headlessly and must produce a linked response envelope or a
reviewable file change. When a provider returns a resumable session, Exograph exposes
the terminal handoff after the run settles. Read [Agent invocations](document-agent-protocol.md)
for the full lifecycle and review rules.

## MCP installation or the CLI does not work

MCP and the CLI are independent:

- Install the local `exo` command with `./scripts/install-local`, or install
  the macOS app and CLI together with `./scripts/install-mac-app --with-cli`.
- The selected provider's own CLI must be installed before Exograph can add its MCP
  configuration.
- An existing provider registration means the server is already installed; MCP
  setup does not replace the local `exo` command.

`exo status` and `exo search` can work without the desktop app. `exo show`,
`exo index`, `exo open`, and `exo invoke` require the resident app. See [CLI and
MCP](cli.md) for the exact command surface, installation steps, scope, and
security boundaries.
