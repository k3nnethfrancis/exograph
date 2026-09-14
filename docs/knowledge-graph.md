# Knowledge graph

Exograph derives a live, evidence-aware graph from ordinary Markdown. People
explore it spatially; Search and future agent traversal use the same Concept and
Relation model. The graph remains a projection over the files rather than a
second knowledge store.

## What becomes a graph object

In the default **Generic Markdown** format:

- each included Markdown file becomes one **Concept**;
- its first H1 may label that Concept, but headings do not create Concepts;
- wikilinks and Markdown links create document relations when they resolve;
- tags create shared tag Concepts in the semantic graph;
- frontmatter remains properties of the existing Concept.

`type: project` therefore classifies one Note. It does not create a `project` node or an edge by itself. A local link to code or an attachment is preserved as an **artifact reference**: it is evidence of a relationship, but not a Note, search document, or topology node.

## Why a relation exists

Every graph relation has an **origin** and evidence:

| Origin | Meaning |
| --- | --- |
| `document` | The relationship appears directly in Markdown. |
| `ontology` | The active ontology interpreted an existing property by a named rule. |
| `inferred` | A versioned derived process observed a possible relationship. It is not durable knowledge until a person accepts a Markdown change. |

Evidence can point to a Markdown span, a property, a path, an ontology rule, or a versioned model observation. This answers “why is this line here?” without pretending to prove authorship or truth.

## Views are not the graph

Note context and Graph are derived presentations over the same Workspace graph.
The active editor **Note** and the transiently inspected **Graph Concept** are
separate interaction states: selecting a node may inspect it without replacing
the editor, while opening that node synchronizes both states to its Note. Note
context groups headings, links, Artifacts, Tags, and earned history; Graph lays
out the Workspace topology and fetches detail only for the inspected Concept.
Neither changes a Note or creates knowledge on its own.

The hot rendering path uses compact numeric topology. Labels, paths,
properties, findings, and relation evidence are cold, bounded reads. WebGPU and
the deterministic Canvas fallback consume the same scene, keeping large graph
interaction responsive without weakening the semantic model.

That separation also creates the boundary for agent traversal. A future CLI
surface can return bounded paths, relation direction, origin, evidence, and
stable cursors without scraping the visual renderer or inventing a second graph
representation. The desktop graph ships now; bounded CLI graph traversal does
not yet.

## Add more meaning deliberately

An optional workspace `ontology.yaml` can declare property shapes, path-default types, reference-valued relations, and validation rules. Exograph previews its exact effects and requires the explicit Activate action (Keep) before using it. One ontology is active at a time; switching never rewrites Notes. Read [Workspace ontology](workspace-ontology.md).

For the base reading rules and OKF compatibility, read [Note Root Formats](note-root-formats.md).
