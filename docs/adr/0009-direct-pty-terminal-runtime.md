# ADR 0009: Direct PTY is the terminal runtime

**Status:** Accepted and implemented  
**Date:** 2026-07-25

## Context

Exograph previously explored tmux control mode, process restoration, durable
transcripts, a built-in agent harness, and provider-specific terminal paths.
Those approaches divided ownership of the live screen and process lifecycle,
made input fidelity harder to prove, and encouraged terminal core to understand
agent providers.

The product needs one terminal path with an honest lifetime, byte-faithful
input, ordinary xterm behavior, and a deterministic testing boundary.

## Decision

Exograph has one production terminal runtime: a direct `node-pty` process
rendered by xterm.js.

```text
xterm.js
  <-> renderer terminal bridge
  <-> TerminalManager
  <-> direct node-pty process
  <-> shell or configured Command
```

The tmux control-mode, restore, transcript, built-in harness, and
provider-specific terminal architectures are superseded. They are not
fallbacks and must not shape new code.

### Ownership

- xterm owns the live screen, viewport, selection, alternate-screen behavior,
  and ordinary scrollback.
- The direct PTY owns process lifetime, byte-faithful input/output, resize, and
  exit.
- `TerminalManager` owns app-facing session metadata and lifecycle operations.
- A bounded in-memory tail supports renderer reload and explicit operator
  reads. It is not a transcript or a second screen.
- Configured Commands and `InvocationRunner` own agent/tool launch and review.
  Terminal core does not identify providers or interpret prompts.

### Lifetime

Closing and reopening the Exograph window does not end a PTY while the desktop
process remains alive. Quitting Exograph ends its PTYs. Renderer reload may
replay bounded memory, but Exograph does not promise process persistence across
app exit.

Users who need durable shell sessions may run tmux themselves inside a normal
Exograph terminal. Provider-native resume remains provider-owned.

### Input and scroll

Input passes through byte-for-byte. Spaces, paste, Enter, Ctrl-C, Escape,
arrows, mouse reports, and resize are not translated into tmux or
provider-specific commands.

Ordinary shell wheel, trackpad, and selection stay with xterm. A full-screen TUI
may own wheel input only while mouse mode is active; Exograph must make that
ownership visible and provide a documented modifier escape to local
scrollback.

### Testing boundary

The production factory is direct `node-pty`; a deterministic fake exists only
for tests. Automated coverage uses local shells and fake Commands, never live
model inference.

Required proof covers input fidelity, resize, ordinary and mouse-mode
scrolling, mounted-tab preservation, bounded reload replay, Command launch, and
honest app-exit behavior. Run the focused terminal Electron journey as part of
any terminal-runtime change.

## Consequences

- Terminal behavior has one production owner path and one lifetime contract.
- Terminal core stays provider-neutral; agent launch and review remain Command
  concerns.
- Reload assistance remains bounded and must not become durable history or a
  second terminal model.
- App exit intentionally ends PTYs. Durable sessions remain an explicit
  user-owned shell choice rather than an Exograph restoration promise.
