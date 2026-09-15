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

Choose **Set up website** in Settings → Publishing:

1. Choose the notes folder to publish.
2. Connect GitHub. Exo defaults to your personal account and lists your
   organizations; creation is disabled for accounts where GitHub reports that
   you cannot create repositories. Organization policy may further restrict
   public repository creation; GitHub reports that at setup.
3. Enter a repository name, such as `my-garden`. New repositories are public.
4. Optionally enter a custom domain. Otherwise use the GitHub Pages address.
5. Set up the website, then prepare and publish when ready.

New websites start with a pinned vanilla Quartz version. **Import an existing
Quartz site** is a separate migration option that copies a committed local
checkout. Existing custom domains and destination repository history are preserved.
Setup uploads site code and eligible exported content to GitHub; it does not
make the built website live until the explicit Publish action.

New local checkouts live at `published-sites/<owner>/<repository>/` under the
app profile, using lowercase GitHub names. Exo saves the actual path in settings.
Older checkouts with generated IDs remain valid at their saved locations; an
upgrade does not move a checkout that an editor or agent may be using.
Users need no additional local website checkout or manually installed workflow.

The website repository is self-contained: Quartz and customization code live at
its root, `garden/` holds the exported content, and its workflow builds one exact
publication commit. **Customize appearance** opens this editable checkout.
**Prepare publish** saves code edits locally and builds a snapshot; **Publish
website** deploys it. The selected notes folder stays authoritative. Edits in
exported `garden/` are rejected so they can be recovered into the source notes.

### Design recovery

Each website has one active design. Shared selectable presets are not part of
this flow. The managed marker records `vanillaCommit`, the stock Quartz baseline
selected at setup; older managed sites use the original pinned setup version.
Restoring vanilla is separate from upgrading Quartz.

- **Preview vanilla** builds a temporary checkout with the stock design and the
  current exported notes, leaving the active checkout's code and unsaved edits
  untouched. A vanilla preview cannot be published directly.
- **Restore vanilla** saves current code edits in Git, records a local recovery
  ref (`refs/exograph/design-recovery`), installs the target dependencies in a
  temporary checkout, and replaces only design files. Site identity, `CNAME`,
  exported `garden/`, and GitHub publishing automation are preserved. Failed
  dependency installation or concurrent edits leave the active design intact.
- **Undo restore** restores the saved customization. The recovery ref is local;
  saved commits remain in the site's Git history. Repeating Restore without
  design changes retains the previous recovery point.

Design changes invalidate a prepared publication. Preview, prepare, and publish
again to deploy the chosen design. Nothing in recovery automatically pushes or
deploys. A failed setup does not replace the saved active configuration.

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
