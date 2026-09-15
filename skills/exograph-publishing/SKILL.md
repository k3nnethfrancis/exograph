---
name: exograph-publishing
description: Support an Exograph user's website publishing, Quartz theme changes, deployment failures, and publishing-folder cleanup. Locate the active machine configuration before editing notes, site code, or GitHub Pages setup.
---

# Exograph publishing

Start with the installed product's configuration, not a remembered checkout name.
A source checkout, installed app, and isolated review app may use different
versions and profiles. Do not infer that a feature exists from this skill alone.

## Locate the user's site

1. Use `exo workspaces` and `exo status --workspace <id|label|path>` when
   available to establish the selected workspace. Check `exo --help` before
   assuming a publishing command exists; current publishing operations live in
   Settings → Publishing.
2. Read that app's saved settings or its Settings → Publishing fields. For the
   CLI settings resolver, `EXOGRAPH_SETTINGS_PATH` overrides the settings file;
   `EXOGRAPH_USER_DATA_PATH` overrides the profile directory. The running app's
   actual profile and settings path are authoritative. Default profiles are:
   - macOS: `~/Library/Application Support/Exograph/`
   - Linux: `${XDG_CONFIG_HOME:-~/.config}/Exograph/`
   - Windows: `%APPDATA%/Exograph/`
   Settings are in `workspace-settings.json`; `workspace-registry.json` records
   other workspaces. Inspect only the relevant publishing fields, not an entire
   private workspace dump.
3. Resolve the `publishing` fields:

   | Field | Meaning |
   | --- | --- |
   | `publicationDirectory` | Canonical notes folder inside a Note Root |
   | `engineDirectory` | Installed Quartz code, theme, and configuration |
   | `destinationRepository` | GitHub `owner/repository` used for Pages |
   | `siteUrl` | Expected public website URL |

4. Inspect the engine's Git origin, current commit, working changes, and build
   configuration. Inspect the destination workflow to learn its actual content
   location and build inputs. Repository names need not match local folder names.
   Report a short map of content, theme code, destination, and generated output.

## Identify the deployment contract

Managed publishing starts at Settings → Publishing → Set up website. The user
chooses content, connects GitHub, selects an account (personal by default), and
names a repository. New sites use vanilla Quartz; importing a committed Quartz
site is a separate migration option. Setup returns the managed checkout
path into `publishing.engineDirectory`; do not reconstruct that path yourself.
The checkout is under the app profile's `published-sites/<owner>/<repository>/`, outside Note Roots.
Older generated-ID directories remain supported at their saved paths.

A managed checkout has `exograph-site.json` with `schemaVersion: 1`. Its website
repository owns Quartz/theme code, exported `garden/`, pinned dependencies, and
`.github/workflows/exograph-publish.yml`. GitHub Actions checks out one exact
publication commit, builds it, and uploads the finished site to Pages. Setup
installs the workflow but does not deploy. Customize appearance opens the managed
checkout; Prepare saves theme edits locally and builds a content snapshot;
Publish website explicitly deploys it. Canonical notes remain in the selected
source folder. The public derivative is not a second editing location.

Older configurations can still have a separate Quartz engine repository and a
two-checkout workflow. Inspect the marker and installed workflow rather than
assuming migration. Use managed setup to import the existing theme and preserve
the repository and domain. Never delete the old theme until the managed build
and deployment are verified and its local-only changes are preserved.

## Support the requested operation

- **Edit content:** edit the canonical publication folder. Generated snapshots
  are derivative, not a second authoring copy. Preserve normal drafts and explicit
  shared previews: `draft: true` excludes a note; `draft: true` plus
  `preview: true` publishes it unlisted and accessible by link.
- **Edit theme:** use the resolved engine/site checkout, preserving user changes.
  Legacy separate-engine publishing requires its reviewed commit to be clean
  and pushed to its GitHub origin; managed Prepare saves theme edits locally. Personal theme code does not belong in Exo's application source.
  Pin a tested Quartz version; offer upgrades explicitly rather than silently
  replacing a customized theme with upstream latest.
- **Inspect before deploying:** Build preview is a local whole-site build, not
  an unlisted preview post. Prepare publish creates a new reviewed snapshot;
  Publish website deploys it. Edits alone do not publish. Use the existing
  authorization for publishing; theme editing or diagnosis alone is not a request
  to deploy a live website.
- **Diagnose a failed publish:** check app status and the matching GitHub Actions
  run. A dispatched or timed-out run may still finish. Do not blindly dispatch
  again. Confirm success using a completed run and a receipt matching the content
  commit, engine commit, and configured URL; then verify the live page. A setup
  error can mean missing or outdated workflow/runner files, not bad credentials.
- **Verify content boundaries:** private links become plain text in the exported
  copy; public links remain. Never fix export defects by rewriting private source
  notes or publishing the entire vault/history. Check drafts, unlisted listings,
  referenced assets, and removed-page behavior when changing that boundary.
- **Clean up folders:** distinguish local checkout deletion from GitHub repository
  deletion. Identify current settings, Git worktree/shared-object dependencies,
  and uncommitted/untracked work before calling a checkout obsolete. Preserve
  local-only work. The Pages repository and active theme/content remain required
  even when an obsolete local copy is removable.

After moving an existing Quartz checkout, inspect its generated `.quartz/`
cache. Cached plugin symlinks can retain absolute paths to the old directory.
Archive that generated cache and rebuild if those paths are stale; preserve
`plugins/`, which contains source code. Verify custom styling and draft/unlisted
boundaries afterward: Quartz can exit successfully even when a custom plugin
was skipped because of a stale link.

## Design recovery

Each website owns one active customization in its own Git checkout. The marker's
`vanillaCommit` pins the default design independently of future engine upgrades.
**Preview vanilla** builds a temporary copy; **Restore vanilla** saves edits and
`refs/exograph/design-recovery` before replacing design code; **Undo restore**
recovers the saved customization. Notes, domain, repository identity, and Pages
workflow are preserved. These actions never publish. Prepare again after a design
change. Keep recovery commits and the local recovery ref when moving a checkout.

## Where implementation lives

In an Exograph source checkout, read `docs/publishing.md` and
`docs/publication-export.md` before changing the publishing contract. Owners:

- `apps/desktop/src/main/publishing/`: preparation, temporary builds and receipts.
- `apps/desktop/resources/publishing/`: Quartz runner and Pages deployment workflow.
- `apps/desktop/src/renderer/src/components/PublishingSection.tsx`: settings UI.
- `packages/core/src/`: publication export and saved workspace settings.

The installed macOS bundle carries the runner in
`Exograph.app/Contents/Resources/publishing/` and builds including this skill carry it under
`Contents/Resources/skills/exograph-publishing/`. Treat installed resources as
version evidence, not the user's editable theme. Source fixes go into the Exo
repository; theme fixes go into the resolved site project.

End with what changed, the actual site/deployment evidence, and any remaining
setup. Distinguish configured, locally built, deployed, and live-verified states.
