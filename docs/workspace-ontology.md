# Workspace ontology

Exograph recognizes user-owned Ontology sources at:

```text
<Workspace Root>/ontology.yaml
<Workspace Root>/ontologies/*.yaml
```

An Ontology is a passive interpreter for existing Markdown. It never owns or
rewrites Notes, executes code, chooses models, or controls presentation. A
Workspace without an explicitly kept Ontology keeps its ordinary base graph;
there is simply no additional ontology interpretation.

`ontology.yaml` is the portable semantic contract between a person's files,
the visual graph, Search, and agent tools. It names which existing fields carry
meaning without hiding that meaning in an application database or a model
prompt. The same source can therefore guide human inspection, validation,
retrieval experiments, and future bounded agent traversal.

## Start with the base graph

Exograph does not require an Ontology for its knowledge graph to work. In Generic Markdown,
each resolved Markdown file becomes one Concept. Headings label or structure
that Note; they do not create additional Concepts. Authored wikilinks and
Markdown links connect the existing file Concepts, and tags form shared tag
Concepts.

Frontmatter is preserved even when nothing interprets it:

```md
---
type: project
status: active
---

# Exograph
```

Here `type: project` is an open classification of the Exograph Note. It is not a
second `project` node or an edge. The optional Ontology gives selected existing
fields a precise, workspace-local meaning; it never replaces the Note, its
frontmatter, or its authored links.

## Supported candidate shape

```yaml
ontology_schema: 1
id: personal-research
version: 1
label: Personal research
type_property: type

types:
  paper:
    label: Paper
    paths: [papers/**]
  claim:
    label: Claim

properties:
  status:
    value: string
    allowed: [draft, published]
  supports:
    value: reference[]
    predicate: supports
    direction: outgoing
    targets: [claim]

rules:
  - id: paper-basics
    type: paper
    require: [title]
    recommend: [status]
```

Required top-level fields are `ontology_schema`, `id`, and `version`.
`type_property` defaults to `type`; reference direction defaults to `outgoing`.
Supported Property shapes are `string`, `string[]`, `number`, `number[]`,
`boolean`, `boolean[]`, `reference`, and `reference[]`.

Identifiers and unknown YAML keys are open vocabulary and retained in the
parsed source. Unknown Concept Types remain valid. Candidate validation is
atomic: an invalid rule prevents the whole candidate from compiling, while the
original file remains untouched.

## Library, Candidate, and Active are different

The root source and direct, regular `.yaml` files in `ontologies/` form a flat
library. Nested directories, symlinks, arbitrary paths, inheritance, merging,
and simultaneous activation are unsupported. Exactly one saved source or
Generic Markdown may be active.

Selecting or changing a source creates a **Candidate**. It never changes the
active graph by itself. The core store compares exact source path, candidate,
active, and base-graph identities for Keep and Reject, preventing a stale
review from accepting newer bytes.

An explicitly kept source and revision are atomically persisted under the
Workspace runtime's `.exograph/ontology/activation.json`. This is reproducible
derived state, not canonical knowledge. It allows restart to preserve the last
kept interpreter while the user-owned candidate changes. A missing or invalid
kept state falls back explicitly to the existing base graph without additional
Ontology interpretation.

Settings → Graph and the Graph toolbar expose the same preview and review controls.
The active identity is shown separately from the preview selection. The UI labels
the explicit Keep action **Activate**; selecting a preview never activates it.
The review reports bounded typed-Concept, Ontology-Relation, and Finding effects. Keep
and Reject are explicit; stale Candidate, Active, or Markdown revisions require
a fresh review. Keep atomically persists the exact accepted source and source
identity, then publishes the already-reviewed graph. Reject preserves Active.
Both actions compare an exact content-derived Markdown manifest, so they do not
depend on filesystem-watcher timing.

Candidate edits alone remain inert. Their dedicated watcher notification does
not invalidate Note caches, refresh Explorer, or replace graph identity. A
successful Keep emits one ordinary graph-changed event. Authored Links and
Backlinks remain authored facts; resolved local Ontology Relations appear only
in the production Graph and bounded Note-context reads with their Ontology
origin and Evidence preserved.

## Optional discovery

The sparkle action in Settings or Graph uses the Workspace's explicit default
Claude or Codex Command to inspect a disposable Markdown-only snapshot. The
Command must be enabled and trusted before discovery begins. Exograph supplies
its bundled `ontology-design` prompt, or the user's override from
**Settings → Graph → Advanced**. Discovery preparation never writes a Skill or
hidden instruction file into the Note Root. The provider receives the prompt,
a schema-bound response contract, read-only tools/sandboxing, and no live
Workspace write authority. Generic Commands are not accepted by this
early-access path.

The Exograph host validates the returned source, rechecks the exact graph,
Candidate, and Active identities observed before the run, and is the only
writer allowed to stage root `ontology.yaml`. A proposal is still only a
Candidate: the active graph does not change until Keep. Abstention, questions,
malformed output, provider failure, or stale identity write nothing.

Graph maintenance is separate. The link action on a selected graph Note asks
the chosen Command to use the native
`find-and-connect-relevant-context` Skill, then opens an ordinary inline
Invocation prefilled with bounded graph evidence and the exact active Ontology
identity. Exograph uses the harness's installed copy when available, otherwise
its bundled, versioned copy, with an exact inline fallback when neither delivery
path is available. Preparing the action never writes this Skill into the Note
Root. Command+Return runs the existing trust, activity, Changeset, and
Keep/Reject path. Skill delivery changes instructions only: it grants no
authority, and the Skill cannot edit Ontology sources.

## Interpretation contract

The pure compiler supports explicit and bounded path-default Concept Types,
Property shape/allowed-value Findings, reference-valued Relations, target-type
expectations, and required/recommended Properties. Every ontology-origin
Relation cites both the source Property and exact Ontology rule/revision.
Unresolved references return explicit unresolved Concept endpoints, so an
interpreted Relation never dangles. Interpretation does not mutate input
Concepts or Notes.

For example, this rule makes an existing property legible as a relation:

```yaml
types:
  project: {}
  claim: {}

properties:
  supports:
    value: reference[]
    predicate: supports
    targets: [claim]
```

If a project Note contains a `supports` frontmatter value pointing at a claim
Note, Exograph may add a `supports` Relation with `ontology` origin. The Relation
still cites the source property and the exact Ontology rule. An ordinary
wikilink remains a `document`-origin Relation whether or not an Ontology is
active.

Relation origin is:

- `document`: present directly in Markdown;
- `ontology`: interpreted from Markdown by an Ontology rule;
- `inferred`: observed by a versioned derived producer.

## Separate contracts

A **Format** reads a Note Root, currently Generic Markdown or permissive OKF
0.1. The **Workspace Ontology** interprets meaning after Format projection. A
**Graph View** controls layout, labels, color, physics, and interaction. The
Ontology cannot contain visual hints, inference policy, executable rules,
prompts, or file mutations. See [Note Root Formats](./note-root-formats.md)
for the base-reading boundary and OKF compatibility behavior.
