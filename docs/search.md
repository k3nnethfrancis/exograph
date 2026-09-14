# Search

Search is a replaceable subsystem over user-owned Markdown. Exograph currently
ships two local implementations behind one provider contract. Both share the
Workspace content policy: only Markdown selected as Workspace content becomes
a searchable Note.

## Immediate search

The workspace search field always starts with filename and path matches. It is fast because it uses loaded workspace metadata rather than parsing every Note body while you type.

## Indexed search

Choose **Settings → Search → QMD** to enable an optional local index. Choose a retrieval mode:

| Mode | Uses | Good for |
| --- | --- | --- |
| Lexical | words and phrases | exact names, terms, and paths |
| Semantic | local embeddings | related concepts with different wording |
| Hybrid | both | the normal default when semantic search is useful |

When **Use QMD when I press Enter in Explore** is enabled, Enter in the search field uses this index. The CLI and MCP search routes use the configured index only when the running app has the same resolved workspace; otherwise they use bounded filesystem retrieval and report that honestly.

## Index maintenance

**Sync documents** reconciles the current Markdown corpus. **Reconcile documents** is the recovery-oriented version when an index may be stale. **Build embeddings** fills semantic work that remains pending; it is unavailable in lexical mode.

Indexing runs outside the Electron main process. During maintenance, foreground retrieval can fall back to filesystem search rather than waiting behind the writer. Pending embeddings do not make Notes unavailable: lexical retrieval continues to work.

The QMD database is local derived state under the workspace `.exograph/` runtime. It can be rebuilt; it is not the source of truth. See [Durable state](durable-state.md) and [Performance contracts](performance-contracts.md) for the implementation and latency boundaries.

## Why Search is separate

The editor, graph, CLI, and MCP depend on Exograph's Search contract rather than
QMD internals. This keeps the corpus stable while retrieval changes. A user or
contributor can compare filesystem, lexical, semantic, hybrid, graph, and
ontology-aware strategies against the same Markdown without rebuilding the
product around one engine.

QMD is the first indexed engine, not a permanent ceiling. Custom embedding
models, rerankers, or trained retrieval components belong behind the same
provider boundary and must report their capabilities and degradation honestly.
Exograph does not yet expose model training as a product feature.
