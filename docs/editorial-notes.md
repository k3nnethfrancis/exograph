# Editorial notes

Editorial feedback stays separate from author prose. A grey vertical marker at
the right edge of a passage indicates commentary; red indicates a proposed edit.
Click a marker to select its note in **Note context → Editing**. General notes
and notes covering several passages are listed there too.

Select author text and click **Add editorial note** in the editor toolbar, or
press **Command–Shift–E** (Control–Shift–E on Windows/Linux). Without a selection,
the same action adds a general note. In Editing, write the comment, attach
additional selected passages, and enter proposed wording. Passage and note
controls appear progressively rather than interrupting the essay.

## Read and preview

The Editing pane keeps three display choices available:

- **Original** shows author prose with passage markers.
- **Show diff** shows the selected note's proposed insertions and deletions in
  its passages, while preserving the original source.
- **Preview change** displays the selected proposal inline with a muted grey
  highlight. Markdown formatting is projected safely. This mode is read-only;
  choose Original or Show diff to write author prose.

Display preferences persist across selections, documents and app restarts.
**Hide markers** hides annotations and inline projections without deleting any
notes. Raw Markdown mode retains its ordinary editing behavior.

A grouped proposal projects all its passages together. Changed, missing,
ambiguous or overlapping targets suppress the proposal's inline projection.
The pane shows the captured wording and target state. **Rebase to current text**
explicitly accepts uniquely identified changed wording as the new base; review
the proposal afterward. Otherwise select the intended passage and **Retarget to
selection**. Repair does not apply proposed wording.

## Apply and retain

**Apply proposal** writes the selected proposal's exact changes to author prose
and resolves its note as one paired application. Every target is verified first;
an invalid target blocks the whole group. Empty replacement strings explicitly
mean deletion. Existing unrelated prose is preserved.

Undo restores both prose and annotation state together; Redo reapplies the
application. Author edits made afterward use the ordinary editor undo flow.
Revision conflicts stop the operation and retain the author's buffer.

**Resolve** closes a note without applying its wording. **Dismiss** sets it
aside. Either can be reopened. Completed notes retain **View proposal**, a
read-only view of captured passages and suggested changes, so inspection does
not require changing their status.

## Ask the default agent

**Draft suggestion with agent** and **Revise suggestion with agent** use the
enabled default agent selected in Settings. The request includes current editor
text, the selected note and its captured targets. Exograph’s drafting flow does not write author
Markdown or insert an invocation envelope. The source editor and its queued
autosave are paused through staged settlement; a pre-existing dirty buffer is
preserved.

The agent returns a staged proposal. **Keep draft** imports its allowed annotation
changes; **Reject draft** discards that staged result. Neither applies wording to
author prose. Review the accepted proposal and use Apply when ready. Runtime
validation rejects out-of-scope changes, and ordinary invocation trust, activity,
errors and cancellation remain available. Native commands retain their current
filesystem permissions. Observed source changes and annotation drift are checked
at settlement; these checks do not create an operating-system sandbox.

## Portable storage and existing comments

Annotations live under the authorized Note Root's
`.exograph/editorial/v1/` directory, with stable document and note identities and
a relative-path catalog. Copy that directory with the Note Root to carry them
across devices. A bare Markdown copy or Save Copy creates a new document without
copying annotations; a whole Note Root copy includes them. Include the catalog
and `documents/` in private backup or Git rules if `.exograph/` is ignored.
Creating notes, editing comments and proposed wording, hiding,
previewing, resolving and agent drafting leave author Markdown unchanged.

Annotation saves are serialized per document. Pending or conflicted edits remain
available when changing documents; normal shutdown and workspace transitions
wait for them. A conflict retains local edits and offers **Retry annotation
changes** against the latest notes, preserving unrelated annotations.

File and folder renames within the Note Root keep annotation identity. Moves
of files with stored annotations between Note Roots stop rather than separate prose from its annotations. Ordinary unannotated moves remain available. Uncertain external
moves are not guessed. When available, **Notes from moved files** offers an
explicit **Associate with this document** action. Captured targets still require
review and repair after association.

Earlier `editorial` fences and top-level blockquotes headed **Editorial comment**
or **Editorial note** appear as feedback in Editing. Their source remains intact
until an explicitly requested migration. When inline notes exist, expand
**Inline notes** and choose **Move notes out of Markdown** to move them into the
portable annotation store. This preserves prose and editorial history and has
the same paired Undo/Redo as Apply. Nothing migrates just by opening a document. Invalid JSON and incomplete fences
remain raw and editable. Live cursor navigation skips valid hidden metadata.

Annotations are excluded from publishing exports. Exograph also removes legacy
editorial fences and agent provenance from exported Markdown while preserving
workspace source. Other Markdown renderers may display legacy inline comments;
publishing settings and authorization remain separate from editor actions.
