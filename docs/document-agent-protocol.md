# Agent invocation protocol

**Status:** Current document-envelope and Changeset review contract.

Exograph keeps Markdown as the canonical user document. It adds two inert, XML-like envelopes so a human request and an agent's durable result can be identified
without turning the note into a proprietary chat object.

```md
<exograph-invocation id="4f86cda4-0b11-4d83-873c-166ba38ab378" agent="claude" status="sent">
@claude Compare these alternatives and recommend one.
</exograph-invocation>

<exograph-agent-response invocation="4f86cda4-0b11-4d83-873c-166ba38ab378" agent="claude">
## Recommendation

Choose the first approach because it preserves ordinary Markdown portability.
</exograph-agent-response>
```

## Grammar and rendering

- New invocation envelopes require a UUID `id`, a normalized configured-command
  `agent` handle, and `status="sent"`.
- A response names its parent invocation through `invocation` and repeats the
  responding `agent` handle.
- The live editor hides only the envelope lines and renders their contents as
  page-native tinted prose. Raw Markdown exposes the exact source.
- Notes created before the product rename may retain `exo-invocation` and
  `exo-agent-response`. Exograph renders those durable names without rewriting
  their Markdown; new envelopes use the canonical `exograph-*` names above.
- Invocation envelopes without an `id` remain inert, render-only user-authored
  Markdown. They cannot identify, launch, or be removed as a V1 invocation.
- Malformed or unpaired markup is ordinary visible Markdown, never executable
  protocol state.

## Ownership and safety

The protocol is data, not authority.

- A human can authorize a run only through Exograph's explicit invocation action;
  parsing an invocation tag never launches a command.
- Exograph owns command trust, executable identity, lifecycle state, local invocation
  records, provider session provenance, and changed-file review.
- The configured agent may write one linked response envelope and ordinary
  Markdown/file edits. It cannot grant itself trust, claim a diff was accepted,
  or change invocation lifecycle state through a tag.
- Exograph's filesystem observer and stored before/after snapshots remain the
  authority for reviewable changes. A response block is useful durable prose,
  not evidence that an edit happened.

The invoked Command is an explicitly authorized native process, not a sandbox.
It can use the files, credentials, network, and provider tools available to the
current operating-system user. Note Roots bound what Exograph snapshots, reviews,
and restores; they do not restrict what that process can read or write. Trust is
Workspace-scoped and bound to the executable fingerprint, so a changed binary
requires a new decision before its pre-exec gate opens. Exograph resolves and hashes
the canonical executable immediately before release, then launches that exact
path rather than asking the shell to resolve `PATH` again.

Exograph reports exact file state, not guessed authorship. Launch and settled
manifests produce one Changeset of created, modified, deleted, and conservatively
proven-renamed files. Every Keep or Reject decision is hash-guarded and
serialized. Dirty editor buffers drain before a decision; newer bytes become an
explicit conflict rather than an overwrite. Process Stop and recovery must
prove the owned process group dead before settlement or root unlock. Filesystem
mutations revalidate immutable launch roots and reject symlinked ancestors, but
this defense-in-depth is not a sandbox against a separately authorized
same-user native process. Node/Electron on macOS does not expose
directory-handle-relative mutation APIs that could make Exograph's path check and
mutation atomic.

## Agent instruction contract

For a V1 inline run, Exograph sends the saved document snapshot and the exact
invocation UUID. The configured command is instructed to preserve the request
envelope, do the requested durable workspace work, and append exactly one
linked response envelope directly after the request. For direct-edit work the
response can be a short receipt; for analysis, research, and planning it holds
the durable result. Terminal stdout remains only a concise session summary.

Prompt and Skill delivery supply instructions, not authority. A product workflow
may use a saved prompt override or resolve a provider-native, Exograph-bundled,
or exact inline Skill copy, but every run still follows the same executable trust, filesystem
scope, observed-change, and review contracts. Repository contributor Skills are
separate guidance for coding agents working on Exograph itself.

## App lifecycle

The document shows one invocation surface at a time. First-run authorization is
a compact confirmation anchored beside the invocation and closes as soon as the
user chooses Run or Cancel. It is not a progress surface.

| State | Surface | Exit |
| --- | --- | --- |
| Checking | Same-frame cursor-adjacent acknowledgement while Exograph verifies executable identity and trust | Run, authorize, or restore the draft |
| Running | One compact activity state anchored to the invocation | Stop the full process tree |
| Review | The same anchored surface becomes Keep/Reject/Open session as soon as a settled file proposal exists, even if the provider process is still finishing | Resolve every file or explicitly keep a drifted current file |
| Completed | Brief result; the response keeps a subtle hover/focus session handoff when the provider returned resumable identity | Dismiss or resume session |
| Failed | Compact actionable failure; details only on request | Dismiss or resume session |

One invocation owns one exact Changeset across all authorized Note Roots.
Created, modified, deleted, and proven-renamed files are reviewed in a
deterministic queue. Review decisions and content-addressed snapshots survive a
restart. Reject is hash-guarded and never overwrites a path that drifted after
settlement; that file remains an explicit conflict until the user keeps the
current bytes.

After settlement, Exograph compacts invocation artifacts to the clean base and exact
before/after snapshots referenced by the Changeset. Unrelated whole-Workspace
capture objects are removed only after every retained object passes integrity
validation; cleanup failure leaves all review and History bytes intact and is
reported separately from invocation success.

Provider resume is an explicit handoff. Exograph exposes a single outward-arrow
action, opens the configured resume command in Terminal, and otherwise keeps
the command and session identifier out of the ordinary surface. Invocation
history and document envelopes remain durable; the transient activity surface
does not.

For an inline note invocation, exiting successfully without a linked response
or any reviewable edit is a protocol failure rather than a silent success. A
non-note configured Command may complete with no filesystem change and needs no
review controls.

## Deliberate limits

- No automatic execution from document text.
- No generic tag language, nested workflow engine, or provider-specific markup.
- No claim that a response block is accepted or trustworthy without the normal
  diff-review path.
- No rewriting of user-authored Markdown envelopes; raw source stays portable
  in every Markdown editor.

-- Exograph | 2026-07-13

### Custom command appearance

In Settings → Agents, Custom commands can have a color and an uploaded PNG or
JPEG icon. The icon appears beside the command in suggestions, the send control,
authorization, activity, and Invocation History. Names and handles remain visible
so color is never the only identifier. Remove icon and Reset color restore the
default appearance.

Uploads are limited to 2 MB and 4096 × 4096 pixels. Exograph decodes the selected
image, scales it to at most 128 pixels per side, and stores a PNG of at most
64 KiB directly in workspace settings. Transparency is preserved. The original
file is not needed afterward. Persisted icons must have a bounded PNG envelope
and dimensions; an image that cannot render falls back to the command's default
icon. Appearance changes do not change the executable fingerprint or command
version and do not require trusting the command again.
