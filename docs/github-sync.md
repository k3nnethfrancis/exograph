# GitHub sync

GitHub sync keeps your notes in a **private GitHub repository**. Open
**Workspace Settings → GitHub sync** and connect GitHub. Notes sync shares your
account with Publishing, but does not require website workflow permissions or
select a website destination.

Exograph inspects the current notes folder first. If it already has a GitHub
remote, choose the repository shown and enable sync. The existing branch and
upstream are preserved, including differently named local and remote branches.
When there is no destination, **Create private repository** initializes Git if
needed, adds private-file ignore rules, creates the personal-account repository,
and starts syncing. Existing Git commit identity is preserved; missing identity
is configured for this repository using your connected GitHub account, never in
global Git settings. **Use existing repository** lists writable private repos and
accepts a GitHub URL. Search follows older pages before reporting no matches.

**Hourly** is the initial setup choice; Daily and Manual are available. Saved
schedules remain in place until changed. **Pause sync** retains the connected
repository, history and successful revision for Resume. **Git details** exposes
technical overrides for complex existing configurations.

The selected Note Root must be the repository's top-level folder. Public,
read-only, detached, staged, or partially merged repositories need attention
before setup proceeds. A populated unrelated destination produces a review
message and offers a separate download; Exograph does not silently merge
unrelated histories or replace either source.

A sync fetches remote changes, saves open documents and queued editorial notes,
commits local changes, merges compatible remote changes, and uploads the saved
snapshot. Existing Git history is retained. The editor is briefly frozen during
the save/commit/merge step; it remains usable during downloads and uploads.
Edits made during an upload wait for the next run. The status identifies the
uploaded commit, last successful run, next scheduled attempt, and any errors.

## Set up another Mac

1. Install Exograph or clone its source repository and follow the
   [development setup](../README.md). Keep source code separate from notes.
2. Choose **Open from GitHub** during workspace opening or **Use existing
   repository** in GitHub sync. Sign into GitHub on this Mac and select your
   private notes repository.
3. Download into a chosen parent folder. Exograph creates a new child named
   after the repository and opens it through the normal workspace transition.
   Existing folders, symlinks and locations inside another notes folder or Git
   repository are refused. No current notes or workspace settings are replaced
   when a download fails or is cancelled. A completed download remains available
   if opening it later fails.
4. Continue local setup and enable sync for the new workspace. Editorial notes
   under `.exograph/editorial/v1/` travel with your Markdown; indexes are rebuilt
   locally. Run **Sync now** on each Mac before continuing work there.
5. Restore your portable publishing source/theme and configure their local
   paths in Publishing. See [publishing](publishing.md). Syncing notes does not
   deploy a website. Reconfigure local agent executable paths and grant command
   trust independently on the new Mac.

Sync configuration is specific to this Mac and the exact Note Root. It does not
copy machine paths, trust decisions, credentials, or app settings to another
computer. Guided setup can create or download repositories after explicit selection.
Sync never switches branches or rewrites history.

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

## Setup recovery

Creation records a local intent before the request and the immutable GitHub
repository ID after success. Retrying a failed upload reuses that repository.
An unknown creation outcome may reuse an empty destination; a populated
repository without confirmed identity requires separate review. Exograph never
uses a matching name alone as authority to combine existing notes.

Large first uploads may exceed GitHub server limits even when the connection is
healthy. Failures remain visible, local commits remain available, and retry uses
the same repository. Setup does not claim success until the normal sync finishes.
Downloads expose cancellation and clean up only their own temporary folder.
Workspace save conflicts and queued annotation writes are handled by the same
save barrier as ongoing sync, before local setup and snapshots.
