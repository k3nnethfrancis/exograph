# Note Root Formats

A Note Root Format tells Exograph how to read a folder of Markdown into the base
graph. It is not an Ontology, a graph theme, or a request to rewrite files.

The normal experience is **Generic Markdown**. It needs no marker or setup:

```md
---
type: project
status: active
---

# Exograph

See [[Graph work]].

#product #research
```

This creates one Concept for the Markdown file. The first H1 may supply its
label, but it is not another Concept. `[[Graph work]]` resolves to the one
Concept for that target file; every other link to it joins the same target.
Aliased wikilinks such as `[[nested/Cedar|Cedar alias]]` use the part before
`|` to resolve the Note and the part after it as the link label. Aliases do not
create additional Concepts.
Tags are shared tag Concepts in the semantic graph; the default spatial view
groups tagged Notes rather than drawing tag hubs. Frontmatter is preserved as Properties. In this
example `type: project` classifies the same Note; it does not create a
`project` Concept or a relation by itself.

Generic Markdown treats every Markdown file as a Concept, including
`index.md` and `log.md`. That is intentional: ordinary Markdown has no
universal rule that makes those files less meaningful than any other Note.

## Open Knowledge Format 0.1

Exograph also has a permissive **OKF 0.1** compatibility interpreter for existing
Open Knowledge Format workspaces. It is not the default, is not selected
automatically, and is not yet a user-facing workspace setting. Its purpose is
to faithfully read an existing OKF workspace when that compatibility path is
explicitly used and tested.

For an OKF Note Root, Exograph applies the external convention while leaving every
source file alone:

- absolute Markdown links resolve from the Note Root;
- `index.md` and `log.md` stay normal Notes—openable, searchable, and
  editable—but are excluded from the Concept graph;
- a resolved Concept without a `type` receives an OKF missing-type Finding;
- arbitrary frontmatter remains preserved and readable.

The reserved-file rule is an OKF convention, not an Exograph judgment about normal
Markdown. A normal Exograph Workspace therefore keeps its indexes and logs in the
base graph unless an explicitly chosen format says otherwise.

## Format, Ontology, and Graph View

These layers answer different questions:

| Layer | Question | Example |
| --- | --- | --- |
| Note Root Format | How should Exograph read this Markdown folder? | Generic Markdown or OKF 0.1 |
| Workspace Ontology | What do selected properties mean here? | `supports` is a reference relation to a `claim` |
| Graph View | How should the graph be presented? | a neighborhood layout or a type color |

An optional Workspace Ontology applies after Format projection. It can explain
that a frontmatter property is a reference-valued Relation or that a type needs
particular Properties. It cannot modify the Markdown, select a Format, or
control visual presentation. See [Workspace Ontology](./workspace-ontology.md)
for the reviewed `ontology.yaml` contract.

Internally, the closed `NoteRootFormat` boundary owns built-in Format selection.
It is not public product vocabulary and does not represent a second user-facing
configuration system.
