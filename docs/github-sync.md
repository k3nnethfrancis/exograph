# GitHub sync

GitHub sync keeps an existing **private GitHub repository** in sync with the
active Workspace's Note Root. Configure it in **Workspace Settings → GitHub
sync**, then choose **Sync now**, **Hourly**, or **Daily**. Save the configuration
before the first run. The selected Note Root must be the repository's top-level
folder and its checked-out branch must match the saved branch.

A sync fetches remote changes, saves open documents and queued editorial notes,
commits local changes, merges compatible remote changes, and uploads the saved
snapshot. Existing Git history is retained. The editor is briefly frozen during
the save/commit/merge step; it remains usable during downloads and uploads.
Edits made during an upload wait for the next run. The status identifies the
uploaded commit, last successful run, next scheduled attempt, and any errors.

## Set up another Mac

1. Clone your private notes repository and the Exograph source repository into
   separate folders. Follow the [development setup](../README.md) to build and
   install Exograph, or install a released app.
2. Open the cloned notes repository's top-level folder as a Workspace. Editorial
   annotations under `.exograph/editorial/v1/` travel with the notes; indexing is
   rebuilt locally.
3. Configure your Git commit identity in the cloned notes repository with
   `git config user.name "Your Name"` and `git config user.email "you@example.com"`
   (a GitHub-provided private email is also suitable). Connect GitHub from the sync panel (or `gh auth login`). Authentication uses
   GitHub CLI and Git's credential support. Tokens are not stored in your notes
   or in sync configuration.
4. Select the existing remote, such as `origin`, and the checked-out branch,
   enable sync, choose a cadence, and save. Run **Sync now** on each Mac before
   continuing work there.
5. Restore your portable publishing source/theme and configure their local
   paths in Publishing. See [publishing](publishing.md). Syncing notes does not
   deploy a website. Reconfigure local agent executable paths and grant command
   trust independently on the new Mac.

Sync configuration is specific to this Mac and the exact Note Root. It does not
copy machine paths, trust decisions, credentials, or app settings to another
computer. Existing repositories/remotes are used; sync does not initialize,
clone, switch branches, create repositories, or rewrite history for you.

## Scheduling and stopping

Hourly and daily runs operate on the **active Workspace while Exograph is
open**. An overdue run starts after the Workspace is ready on app startup or
wake. Inactive Workspaces and a closed app do not sync; no background system
daemon is installed. The scheduler checks at most once a minute and serializes
manual and scheduled runs. A failed run stays visible and retries at the next
configured interval; **Sync now** retries immediately.

**Stop sync** is available during destination checks, downloads, and uploads.
The short local save/merge step must finish first. Cancellation and network
failures preserve saved local commits so a later attempt can continue. Network
commands allow up to four hours for large attachment uploads; local commands
are bounded to two minutes. Quitting the app waits for an active sync to settle;
stop its network phase first if you need to quit immediately.

## What is included

Saved notes, images, attachments, authored configuration, and portable editorial
sidecars are included according to Git's ignore rules. Ensure your `.gitignore`
allows `.exograph/editorial/v1/` if you want annotations on another Mac. For
example, when ignoring the rest of Exograph runtime state:

```gitignore
.exograph/*
!.exograph/editorial/
.exograph/editorial/*
!.exograph/editorial/v1/
```

Safe Obsidian application/appearance/hotkey settings, plugin code and manifests,
and deliberately sanitized `data.portable.json` files can travel with the
repository. Original plugin `data.json` files, workspace layout files and caches
are excluded because they can contain machine state or credentials.

Exograph additionally excludes runtime state under `.exograph/` outside
`editorial/v1`, Obsidian runtime/credential data, `.claude/settings.local.json`,
`.env` files, conventional credential/private-key filenames, dependency folders,
Python environments, and caches. The panel lists exclusions. An excluded file
already tracked in the local or incoming tree stops sync instead of silently
uploading or deleting it. Remove it from Git tracking while preserving the
local file and add an ignore rule before retrying. This does not remove it from
historical commits. These filename rules are not a general secret scanner;
review files before adding secrets to any repository, including a private one.

Symlinks, submodules, and nested repositories are rejected rather than following
paths outside the selected Note Root. Save ordinary files in the repository or
keep another repository separate.

## Conflicts and recovery

Compatible changes from two computers merge normally. If both changed the same
passage, sync commits your saved local work and fetches the other version, then
stops **before placing conflict markers in your document**. Resolve the merge
with Git, commit the resolution, then Sync now. The fetched branch is available
as `FETCH_HEAD`; Exograph never force-pushes or resets author files.

Existing staged changes, merge/rebase/cherry-pick operations, unresolved editor
save conflicts, active agent writers, and pending agent reviews stop the local
snapshot step. Finish that work first. Git errors are shown in the panel.
Detached HEAD, an unavailable remote, changed branch, changed destination, or
unverified/public repository also stop the operation. Re-save configuration if
you intentionally change the repository.

An interrupted sync retains its settings and attempt status. If interrupted
while staging or committing, inspect Git status and finish or unstage that work
before retrying. Exograph preserves it rather than guessing whether staged work
belongs to you. Normal file revision checks protect editor saves, but unrelated
external programs do not participate in Exograph's editor barrier. Git refuses
merges that would overwrite a changed working file; coordinate other writers
while syncing.

## Ownership and verification

`GitHubSyncService` owns local per-root settings, serialized scheduling and
status. `GitSyncRepository` owns Git operations, private-destination validation,
exclusions, conflict preflight and the repository lock. The existing desktop
save barrier owns editor and annotation persistence. Renderer code uses typed
preload APIs and never invokes Git directly.

Settings and status are versioned JSON under app user-data `github-sync/`, keyed
by canonical Note Root. They are written by temporary-file rename. Unknown
versions or malformed settings are preserved and rejected. GitHub authentication
is owned by GitHub CLI. A PID-qualified `.git/exograph-sync.lock` serializes
Exograph processes; an interrupted owner's lock is recovered only after its
process is confirmed absent.

Focused proof:

```sh
pnpm --filter @exograph/desktop exec vitest run src/main/github-sync/
pnpm --filter @exograph/desktop exec vitest run src/renderer/src/components/GitHubSyncSection.test.tsx
pnpm --filter @exograph/desktop exec playwright test tests/e2e/github-sync.spec.ts
```

Repository tests use real temporary bare remotes and two clones. Electron tests
exercise the production main/preload/renderer bridge with fixture-only GitHub
authentication and a local remote; they do not upload test content to GitHub.
