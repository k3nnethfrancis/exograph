# Publishing a folder of notes

Agent support: [exograph-publishing](../skills/exograph-publishing/SKILL.md)
explains how to locate the active user profile, content, theme, and deployment.

The default macOS profile is `~/Library/Application Support/Exograph/`.
On upgrade, Exo copies the former `@exograph/desktop/` profile, relocates saved
managed-site paths, and retains the original for rollback. Quit the older app
before upgrading. Explicit `EXOGRAPH_USER_DATA_PATH` overrides are unchanged.
The local checkout is the editable copy; the GitHub repository is its remote
counterpart and the source GitHub Pages builds.

## Managed setup

Choose **Set up website** in Settings → Publishing, then select a content folder,
connect GitHub, and create or choose a website repository. New repositories are
public. Choose the pinned Quartz default or import an existing committed Quartz
project. Existing custom domains and repository history are preserved. Exo
creates a local checkout under the app profile's `published-sites/` and saves
its actual location in the workspace settings. Users need no separate local
website checkout or manually installed Pages workflow.

The managed website repository is self-contained: Quartz and theme code live at
its root, `garden/` holds the exported content, and its workflow builds one exact
publication commit. **Customize theme** opens the editable checkout. **Prepare
publish** saves theme edits locally and builds a snapshot; **Publish website**
deploys it. The selected notes folder stays authoritative. Edits in the exported
`garden/` copy are rejected during theme preparation so they can be recovered
into the source notes instead of silently overwritten.

Setup never deploys the site. A failed setup retains recoverable work and does
not replace the active configuration. Existing separate-engine configurations
continue to work and can be migrated through setup by importing their theme.

## Existing separate-engine setup

Settings → Publishing selects a publication folder inside a Note Root, an
installed Quartz 5 project outside your notes, the site's URL, and an optional
GitHub destination repository in `owner/repository` format. Your Quartz project
owns the design; Exograph owns the export, build runner, and deployment adapter.
A vanilla Quartz 5 checkout works after its dependencies are installed with
`npm ci`. No personal theme or deployment profile is required.

**Build preview** saves editor changes, exports a fresh sanitized snapshot, and
builds a temporary site served on a loopback URL. The preview remains available
when Settings closes. Stop preview, a publishing configuration change, another
build, workspace replacement, or quitting Exograph removes temporary artifacts.

**Prepare publish** builds a fresh site for review without contacting GitHub.
**Publish prepared site** deploys that reviewed snapshot only after an explicit
click. Publishing requires a clean committed Quartz project with a GitHub
`origin`, a destination repository, and its reviewed workflow installation.
Missing setup leaves local previews available. No publication runs automatically
on edits; changed source bytes, engine commit/origin, or destination require a
new preparation. Unrelated appearance and layout saves do not invalidate it.

## Notes and themes

Core selects eligible files and projects Markdown references before Quartz sees
any content. Public links and external URLs remain; local references to private,
excluded, ambiguous, or unavailable content lose their link while keeping the
label. Source notes are unchanged. Drafts are excluded except `draft: true` with
`preview: true`, which become accessible unlisted pages. See
[the export contract](publication-export.md) for eligibility and diagnostics.

The default runner reads Quartz 5 YAML or legacy JSON configuration, preserves
the site's title, colors, plugins, and custom files, and builds in a temporary
working directory. It applies the configured site URL, disables analytics for
preview, and sets standard CrawlLinks resolution to relative because Core has
already resolved local references. Unlisted pages require the enabled Quartz
`unlisted-pages` plugin; shared previews clear `draft` only in the derivative
build input. Stock generated links to absent unlisted-only folders/tags become
readable text, and empty folder entries disappear. Content indexing, feeds,
backlinks, and listings follow Quartz's unlisted filtering. The original engine
configuration and Core snapshot are unchanged.

A customized project may optionally provide `scripts/exograph-publish.mjs`.
Exograph invokes this fixed hook with `--input`, `--output`, `--site-url`, and
`--action preview|prepare`. The hook must build only the supplied sanitized
content, honor the site URL and unlisted semantics, preserve input bytes, and
write a fresh output directory with `index.html`. Exit nonzero on failure and
send progress to stderr. This hook owns custom compatibility such as legacy URL
aliases; it is never required of a vanilla project.

An optional `exograph-publishing.json` declares exact generated routes for
Core's resolver, for example:

```json
{"schemaVersion":1,"generatedRoutes":["index.xml","sitemap.xml","tags"]}
```

These routes do not make private notes public or permit arbitrary missing-link
fallback. The theme owns compatibility between this list and generated output.

The selected engine is trusted executable code. Temporary input separation is
not an operating-system sandbox. Core checks source and staged bytes before and
after the build; it does not lock external editors. Receipts stay outside the
web root. Preview serves only generated files on `127.0.0.1`, rejects foreign
Host headers, and confines paths and symlinks. Builds have a five-minute timeout
and process-group cancellation; stale completions cannot replace current state.

## GitHub Pages setup

The destination repository keeps its site administration on `main` and sanitized
notes/assets under `garden/` on the ordinary `publication` branch. Exograph
creates each publication commit as a child of the preceding publication (or
`main` initially), replacing the content tree so removed notes disappear. It
uses a normal fast-forward push. Concurrent updates are rejected without force
pushes or automatic retries. The user's vault Git history is never read.

Install these reviewed Exograph resources on the destination's `main` branch:

| Exograph resource in `apps/desktop/resources/publishing/` | Destination path |
| --- | --- |
| `github-pages.yml` | `.github/workflows/exograph-publish.yml` |
| `quartz-build.mjs` | `.github/scripts/exograph-quartz-build.mjs` |

Enable GitHub Pages with GitHub Actions and authenticate `gh` locally for the
destination. A private engine repository needs a destination secret named
`EXOGRAPH_ENGINE_TOKEN` with read access to that engine. The engine's reviewed
commit must be pushed to its GitHub `origin` before publishing.

Exograph checks the installed workflow and runner bytes before uploading the
snapshot. A missing or changed setup reports **setup required**, with no upload.
Updating the app's publishing contract may require reviewing and updating those
two destination files. The workflow checks out the exact publication and engine
SHAs, installs the engine dependencies, runs the same generic runner, deploys
Pages, and records a receipt. Success requires that completed receipt to match
the snapshot, engine, run, and configured site URL; dispatch alone is not success.

The twenty-minute local wait can be stopped, but a dispatched workflow may still
finish remotely. Check GitHub before trying again. No automatic deployment retry
occurs, and a confirmed prepared artifact cannot be deployed twice.

## Verification

The desktop tests exercise real child processes, Core snapshots, scope changes,
cancellation, default/custom configuration, unlisted handling, and typed receipt
validation. Neutral deployment tests use real bare Git repositories and fake
GitHub responses to verify incremental history, deleted files, concurrent push
rejection, and setup/receipt mismatches. Electron tests cover actual preload,
main, Core, child, and HTTP boundaries, including an app-owned deployment adapter
with isolated fake GitHub commands. Actual vanilla Quartz rendering and personal
theme parity are separate real-engine gates; no test deploys a live site.
