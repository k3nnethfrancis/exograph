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
   - macOS: `~/Library/Application Support/@exograph/desktop/`
   - Linux: `${XDG_CONFIG_HOME:-~/.config}/@exograph/desktop/`
   - Windows: `%APPDATA%/@exograph/desktop/`
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

## Current deployment contract

The current flow uses a separate Quartz engine repository. The website repository
has its workflow/runner on `main` and exported `garden/` content on `publication`.
Exo supplies exact content and engine commits to
`.github/workflows/exograph-publish.yml`. GitHub Actions checks out both, builds
with Quartz, and uploads the finished HTML/CSS/JavaScript to GitHub Pages.
Pages serves those artifacts; it does not read the user's Mac.

The agreed next design is a self-contained website repository containing exported
content, Quartz/theme code, pinned dependencies, and the Pages workflow, with a
local checkout managed by Exo. Do not assume that onboarding or a managed checkout
exists until verified in the installed app. Do not invent its directory. When
that design ships, update this section and the location contract together.

## Support the requested operation

- **Edit content:** edit the canonical publication folder. Generated snapshots
  are derivative, not a second authoring copy. Preserve normal drafts and explicit
  shared previews: `draft: true` excludes a note; `draft: true` plus
  `preview: true` publishes it unlisted and accessible by link.
- **Edit theme:** use the resolved engine/site checkout, preserving user changes.
  Current publishing requires its reviewed commit to be clean and pushed to its
  GitHub origin. Personal theme code does not belong in Exo's application source.
  Pin a tested Quartz version; offer upgrades explicitly rather than silently
  replacing a customized theme with upstream latest.
- **Inspect before deploying:** Build preview is a local whole-site build, not
  an unlisted preview post. Prepare publish creates a new reviewed snapshot;
  Publish prepared site deploys it. Edits alone do not publish. Use the existing
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
