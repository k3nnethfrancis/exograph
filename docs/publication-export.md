# Publication export boundary

Core `exportPublication({model, publicationDirectory, stagingParent,
generatedRoutes?})` creates a fresh, owned `stagingRoot` with public Markdown and
referenced approved assets in `directory` (`stagingRoot/content`). The selected
folder must be inside an authorized Note Root; staging must be outside every Note
Root. The caller owns cleanup of the returned stagingRoot. Neither export nor
verification writes to source Notes.

`PublicationSnapshot` contains a private manifest and source verification state.
Keep that object out of Quartz's content/output. Its manifest records paths,
listed/unlisted visibility, source/output SHA-256 hashes, source timestamps,
generated routes and diagnostics. `verifyPublicationSnapshot(snapshot)` rejects
changed source membership/bytes/timestamps, modified manifests, unexpected stage
files or symlinks, and modified staged bytes. Verify before the site build and
again before any publication decision. This is detection between operations,
not filesystem CAS or a deployment transaction.

YAML frontmatter accepts a UTF-8 BOM and an explicit `---yaml`/`---yml` delimiter.
Malformed or unsupported frontmatter fails before eligibility checks rather than
becoming public body text.

Normal Notes are listed. `draft: true` is excluded unless `preview: true` is also
set (boolean or string `true`, matching the existing site). Those shared previews
retain their draft/preview fields and gain `unlisted: true`; native unlisted Notes
also retain that status. Tags/aliases remain authored metadata. Quartz must honor
unlisted membership when generating search, graph, backlinks, tags and feeds.

Markdown is parsed into an AST. Offset edits leave code literals and unrelated
body text intact. Standard links, references, wiki links/embeds, parsed HTML URL
attributes, non-code HTML text, and known frontmatter image fields resolve in the original source
inventory, before publication eligibility is applied. Explicit paths never fall
back to a basename. Ambiguous short names are unlinked, not guessed. Excluded
links retain authored display text without private target titles; excluded embeds
never expand. Ordinary external web links remain external. Diagnostics identify
the public source page without copying private target metadata.

Only reached resources inside the selected publication folder are copied:
images, SVG, PDF, audio and video. Symlinks are not followed. SVG attributes use
the same resource projection. Inline styles and local SVG fragment references
are supported; scripts, SVG animation setters, srcdoc/srcset, CSS imports/resource functions and unknown
frontmatter resource fields fail with explicit PublicationExportError diagnostics
rather than leave unsafe references. External iframe src URLs are supported.
HTML and arbitrary executable assets are not exported as opaque attachments.

The initial adapter is Quartz: folder ancestor and tag routes derive from listed
Notes. An adapter may additionally approve exact generated routes such as
`index.xml` and `sitemap.xml`; arbitrary missing paths are still unlinked. Engine
code and node_modules are not publication content. Hidden files and node_modules
are excluded from source inventory, while ordinary content folders such as
artifacts remain eligible. Outside the selected folder only Markdown contributes
to name resolution; unrelated private binaries do not invalidate the snapshot.
Malformed private metadata cannot block export but prevents unverifiable short
wiki-name resolution.

Fresh staging preserves source mtime and emits explicit created/modified fallback
metadata where those fields are absent. This fallback uses source filesystem
timestamps, not git history. A historical-site migration must first establish
its authoritative dates as explicit metadata in its reviewed content candidate;
otherwise freshly extracted files would acquire extraction dates. Canonical
frontmatter dates take precedence over fallback. Source originals remain intact.
