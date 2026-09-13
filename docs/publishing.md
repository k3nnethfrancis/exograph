# Publishing a folder of notes

Settings → Publishing selects a publication folder inside a Note Root, a Quartz
project outside all Note Roots, and the site's URL. These settings belong to the
Workspace and are saved with its other settings.

**Build preview** flushes editor changes, exports a fresh publication snapshot,
builds it with the selected site's adapter, and serves only the completed site on
a loopback URL. Open preview opens that URL in the browser. The preview remains
available when Settings closes; Stop preview, a publishing configuration change,
a Workspace replacement, another build, or quitting Exograph stops it.

**Prepare publish** creates a fresh site artifact and exposes its folder for
review. It does not deploy or contact GitHub Pages. Deployment of that reviewed
artifact remains a separate, explicit step. No build runs automatically on edits.
Closing or replacing a preview removes its temporary files; prepared artifacts
also last only until the next build, configuration change, or app exit. Copy a
reviewed artifact to its deployment project before ending that session.

The export preserves public-to-public links and ordinary external URLs. Local
references to private, excluded, ambiguous, or unavailable content are removed
from output, with diagnostics. Source notes are unchanged. Draft eligibility,
asset containment, and source/staged-byte verification belong to the Core
publication exporter. An export or build error never becomes a successful
publication. Changes observed during the build invalidate it; this verification
does not lock external editors or promise a filesystem transaction.

## Site adapter

The selected Quartz project supplies `scripts/exograph-publish.mjs`, its installed
dependencies, and its site design. Exograph invokes it using its Node runtime and
an argument array, with no command shell and no dependency installation:

```
node scripts/exograph-publish.mjs --input <snapshot/content> --output <fresh/site> --site-url <url> --action preview|prepare
```

The adapter must build only the supplied sanitized content, avoid mutating it,
write a fresh output directory including `index.html`, and exit nonzero on
failure. Standard output is one JSON object:

```json
{"ok":true,"outputPath":"<exact requested output>","action":"preview"}
```

Additional receipt fields are allowed. Progress and failure detail belong on
standard error. Build and deployment receipts belong outside the public output.
The project is trusted executable code selected by the user; staging its input
is not an operating-system sandbox for that code. Preview binds only to
`127.0.0.1`, rejects foreign Host headers and path/symlink escapes, and serves
neither source snapshots nor private Core receipts.

An optional `exograph-publishing.json` declares exact generated root-relative
routes needed by authored links, such as feeds or folder pages:

```json
{"schemaVersion":1,"generatedRoutes":["index.xml","sitemap.xml","tags"]}
```

These routes are passed to Core's resolver. They do not make a private source
note public or allow a generic fallback for every unresolved link. The site's
adapter owns compatibility between the generated route list and its output.

Builds have a five-minute timeout, bounded process output, and cancellation of
the child process group. Context changes discard late results from the previous
Workspace. Build requests compare the publication configuration and Note Root
scope; unrelated layout or appearance saves do not invalidate them. Private snapshots and receipts live under desktop user data, outside
all Note Roots; a configuration that cannot maintain that separation is rejected.

## Verification

`src/main/publishing/publishing-service.test.ts` covers real child processes,
cancellation, preview containment, settings normalization, and stale export
completion. `tests/e2e/settings-publishing.spec.ts` exercises real renderer,
preload, main, Core export, filesystem, child-process, and HTTP boundaries with
a deterministic site adapter. Actual Quartz visual/content parity is a separate
site-level gate; the fixture adapter does not establish it.
