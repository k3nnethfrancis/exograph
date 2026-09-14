# Using Exograph

Exograph works over Markdown you control. It brings the editor, Ontology,
Search, visual graph, and terminal agents into one Workspace while keeping the
files usable in any other editor or shell.

## Set up a workspace

On first launch, choose one **main wiki**: the Markdown folder Exograph will show in the Explorer, edit, search, and graph. A workspace saves that choice together with its search, appearance, terminal, and agent-command settings. You can create and switch between independent workspaces later.

When the folder resembles a code repository, Exograph asks what should become a Note:

- **Markdown notes** is the safe repository default. It keeps documentation in scope while excluding generated and code-oriented paths.
- **All Markdown** makes every Markdown file under the selected folder a Note.

This is a content decision, not an access-control change. You can change it in **Settings → Workspace**. Local code or attachment links in an in-scope Note remain visible as artifact references; they do not become searchable Notes or graph nodes. PDFs inside a Note Root appear in Explorer as read-only attachments: open one directly or use a relative link such as `[[research.pdf]]` to read it in Preview, with page, zoom, fit-to-width, and selectable-text controls.

## Notes, folders, links, and properties

Every included Markdown file is a Note. Its filename/path gives it a primary home; its first H1 can supply a title. A heading does not create a separate graph node.

- Use `[[A note]]` to link to another Note. Select a suggestion to create a normal Markdown wikilink.
- Use `#tags` in body text or frontmatter to classify a Note. Tags are clickable and open their related Notes.
- Add frontmatter through the property control. `title`, `date`, and `tags` are useful conventional fields, but Exograph preserves arbitrary properties.
- Type `/today` or `/tomorrow`, then press Enter, to create an ordinary date wikilink. Opening it creates or opens that daily Note through the usual link path.

Double-click a folder to open its Overview. An `index.md` can describe that folder, but viewing never creates one. Create it only when you want durable folder metadata or guidance; Exograph hides it as a duplicate Explorer row, not from the filesystem.

## Search

The centered search field is immediate filename/path search. If you choose the QMD search engine and enable **Use QMD when I press Enter in Explore**, Enter runs local indexed search instead. QMD can use lexical, semantic, or hybrid retrieval; simple search remains available when indexing is off or recovering.

Read [Search](search.md) before changing index settings or interpreting embedding status.

## Note context and Graph

Open **Note context** for the active Note's outline, inbound and outbound links, Artifacts, Tags, and earned invocation history. Select an Outline heading to focus the editor and reveal that exact section. Open **Graph** from the utility rail or the editor's Graph action to explore the production workspace graph, with the active Note selected inside an elevated overview of the settled graph. Drag to orbit; right-drag or modified drag to pan; and use the mouse wheel, trackpad scroll, or trackpad pinch to zoom. Panning follows the grabbed content on both axes. Zoom keeps the graph point under the pointer fixed, while keyboard zoom uses the center of the graph viewport. Two-finger touch gestures combine that same pointer-centered zoom with direct pan. Select a node to inspect it, and double-click a Note node to open it. **Settings → Graph** can reverse the drag-orbit direction.

When the Graph canvas has keyboard focus, brackets select the previous or next Note, arrow keys orbit, `+` and `-` zoom, Space or `F` focuses the selection, `O` frames the graph, Enter opens the selection, and Escape returns to the prior editor context. The same controls remain available after Canvas fallback.

A framed graph fits again when the pane changes size. After you pan, orbit, zoom, or focus, resizing preserves your camera direction and target, moving back within the zoom range when needed to keep a previously visible selection in view. Use **Frame graph** to restore the overview.

Turn off **Settings → Graph → Show overflow labels** to hide labels placed away from crowded nodes. Labels that fit beside their nodes remain visible. This preference is saved for the workspace. The selected Note's title and link count stay below the graph; expand **Details** for its type, path, properties, and connection tools.

The graph is evidence-aware. It distinguishes a relation written in Markdown, one interpreted by an active ontology, and a machine-derived signal. It does not silently turn semantic similarity into a durable fact. Read [Knowledge graph](knowledge-graph.md) for the model and [Workspace ontology](workspace-ontology.md) for optional property interpretation.

## Panes and shortcuts

Workspace Settings initially focuses Close. Tab and Shift+Tab stay within the dialog; Escape follows the same save checks as Close and returns focus to the opener.

Rename a Markdown Note from its Explorer context menu. The rename dialog shows the resulting filename and preserves `.md` when omitted, including names containing dots (for example, `draft.v2` becomes `draft.v2.md`). Renaming folders does not add a file extension.

Closing a Note tab lets pending saves finish, including edits made while an earlier save was in progress.

The Explorer is on the left. The utility rail switches one destination among Preview, Terminal, Graph, and Note context; Preview and Terminal keep their own tabs. Drag a Note, terminal, or preview into the editor canvas when you want a split view.

| Action | macOS | Other platforms |
| --- | --- | --- |
| Toggle Explorer | `⌘ B` | `Ctrl B` |
| Toggle utility rail | `⌘ ⌥ B` | `Ctrl Alt B` |
| New Note | `⌘ N` | `Ctrl N` |
| New daily Note | `⌘ ⇧ N` | `Ctrl Shift N` |
| New terminal | `⌘ T` | `Ctrl T` |
| Save active Note | `⌘ S` | `Ctrl S` |
| Send inline agent request | `⌘ Return` | `Ctrl Enter` |
| Zoom the whole app | `⌘ +`, `⌘ -`, `⌘ 0` | `Ctrl +`, `Ctrl -`, `Ctrl 0` |

`⌘ N` / `Ctrl N` creates and opens `untitled.md`. If that file already exists,
Exograph creates `untitled-2.md`, then the next available name; it never
overwrites an existing Note. The Explorer's New Note flow also starts from
`untitled.md` but lets you choose a name first.

The lower workspace menu has the current keyboard and CLI reference. Change
global app shortcuts per Workspace in **Settings → Shortcuts**. Select the displayed shortcut, press a combination, or press Escape to cancel; conflicts name the existing command. **Reset all** restores defaults. System and editor-native combinations remain reserved. Help always
shows the active bindings.

## Ask an agent

Configure local CLI commands in onboarding or **Settings → Agents**. Claude and
Codex begin as editable recommended templates; you can disable either, replace
its executable and arguments, or add one provider-neutral Custom command with
its own `@` handle. Removing a configuration requires confirmation and does not
remove that command's existing Invocation History.

Choose a **Default agent** for Exograph-initiated features such as **Discover
structure**. Inline `@` invocations continue to use the agent named in the Note.

In a Note, type `@`, select an enabled command, write the request inline, then
press `⌘ Return` / `Ctrl Enter`. Exograph asks for authorization when needed, runs
the command headlessly, and shows changed files as a reviewable Changeset.

The command is a native process with the permissions available to your local user account. Exograph's review is authoritative only inside the workspace's Note Root. Saving or editing a Note never invokes a command automatically.

Read [Agent invocations](document-agent-protocol.md) for response envelopes,
review behavior, failed runs, and session resume.
