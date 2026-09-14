import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";

import { collectListMetadata, collectOutlineFoldMetadata, markdownPreviewMetadata, updateListMetadataForChanges, updateMarkdownPreviewMetadataForChanges } from "./metadata";

describe("markdown live preview outline folding", () => {
  it("groups heading content until the next heading at the same or higher level", () => {
    const state = EditorState.create({
      doc: ["# One", "intro", "## Child", "detail", "### Grandchild", "more", "# Two", "after"].join("\n"),
    });

    expect([...collectOutlineFoldMetadata(state.doc).entries()]).toEqual([
      [1, { kind: "heading", startLine: 1, endLine: 6, depth: 0 }],
      [3, { kind: "heading", startLine: 3, endLine: 6, depth: 1 }],
      [5, { kind: "heading", startLine: 5, endLine: 6, depth: 2 }],
      [7, { kind: "heading", startLine: 7, endLine: 8, depth: 0 }],
    ]);
  });

  it("treats only a leading tag with indented children as a fold group", () => {
    const state = EditorState.create({
      doc: ["#project", "  owner: Kenneth", "  status: active", "paragraph #inline", "#empty", "next"].join("\n"),
    });

    expect([...collectOutlineFoldMetadata(state.doc).entries()]).toEqual([
      [1, { kind: "tag", startLine: 1, endLine: 3, depth: 0 }],
    ]);
  });

  it("keeps nested tag groups independent and stops at aligned siblings", () => {
    const state = EditorState.create({
      doc: ["#project", "  #phase", "    task", "  sibling", "outside"].join("\n"),
    });

    expect([...collectOutlineFoldMetadata(state.doc).entries()]).toEqual([
      [1, { kind: "tag", startLine: 1, endLine: 4, depth: 0 }],
      [2, { kind: "tag", startLine: 2, endLine: 3, depth: 2 }],
    ]);
  });
});

describe("markdown live preview metadata repair", () => {
  it("repairs list metadata locally across line joins and line-number shifts", () => {
    const initial = EditorState.create({
      doc: ["# Before", "", "- first", "  - nested", "", "Paragraph", "", "- distant"].join("\n"),
    });
    const joinAt = initial.doc.line(3).to;
    const transaction = initial.update({ changes: { from: joinAt, to: joinAt + 1, insert: " " } });

    const repaired = updateListMetadataForChanges(initial.doc, transaction.newDoc, transaction.changes, collectListMetadata(initial.doc));

    expect([...repaired].sort(([left], [right]) => left - right)).toEqual([...collectListMetadata(transaction.newDoc)]);
    expect(repaired.get(7)).toMatchObject({ marker: "-", isListStart: true });
  });

  it("repairs both list blocks when deleting their blank-line boundary", () => {
    const initial = EditorState.create({ doc: "- first\n\n  - second\ncontinuation" });
    const boundary = initial.doc.line(1).to;
    const transaction = initial.update({ changes: { from: boundary, to: boundary + 1 } });

    const repaired = updateListMetadataForChanges(initial.doc, transaction.newDoc, transaction.changes, collectListMetadata(initial.doc));

    expect([...repaired].sort(([left], [right]) => left - right)).toEqual([...collectListMetadata(transaction.newDoc)]);
  });

  it("remaps distant table and fence metadata without changing full-collection results", () => {
    const initial = EditorState.create({
      doc: ["# Before", "", "Paragraph above structures.", "", "| Name | Value |", "| --- | ---: |", "| alpha | 1 |", "", "```ts", "const answer = 42;", "```", "", "- item"].join("\n"),
    });
    const transaction = initial.update({ changes: { from: initial.doc.line(2).from, insert: "A new line.\n" } });

    const repaired = updateMarkdownPreviewMetadataForChanges(initial.doc, transaction.newDoc, transaction.changes, markdownPreviewMetadata(initial.doc));

    expect(repaired).toEqual(markdownPreviewMetadata(transaction.newDoc));
  });

  it("recollects table and fence metadata when their structure changes", () => {
    const tableInitial = EditorState.create({ doc: "# Tables\n\n| Name | Value |\n| --- | ---: |\n| alpha | 1 |\n" });
    const separator = tableInitial.doc.line(4);
    const tableTransaction = tableInitial.update({ changes: { from: separator.from, to: separator.to, insert: "not a table" } });
    const tableRepaired = updateMarkdownPreviewMetadataForChanges(tableInitial.doc, tableTransaction.newDoc, tableTransaction.changes, markdownPreviewMetadata(tableInitial.doc));
    expect(tableRepaired).toEqual(markdownPreviewMetadata(tableTransaction.newDoc));

    const fenceInitial = EditorState.create({ doc: "# Fence\n\n```ts\nconst answer = 42;\n```\n" });
    const closingFence = fenceInitial.doc.line(5);
    const fenceTransaction = fenceInitial.update({ changes: { from: closingFence.from, to: closingFence.to, insert: "plain text" } });
    const fenceRepaired = updateMarkdownPreviewMetadataForChanges(fenceInitial.doc, fenceTransaction.newDoc, fenceTransaction.changes, markdownPreviewMetadata(fenceInitial.doc));
    expect(fenceRepaired).toEqual(markdownPreviewMetadata(fenceTransaction.newDoc));
  });

  it("updates table content and remaps fence content without rescanning unrelated lines", () => {
    const initial = EditorState.create({
      doc: ["# Structured edits", "", "| Name | Value |", "| --- | ---: |", "| alpha | 1 |", "", "```ts", "const answer = 42;", "```"].join("\n"),
    });
    const tableCell = initial.doc.line(5);
    const fenceBody = initial.doc.line(8);
    const transaction = initial.update({ changes: [
      { from: tableCell.from + tableCell.text.indexOf("alpha"), to: tableCell.from + tableCell.text.indexOf("alpha") + 5, insert: "beta" },
      { from: fenceBody.from + fenceBody.text.indexOf("42"), to: fenceBody.from + fenceBody.text.indexOf("42") + 2, insert: "43" },
    ] });

    const repaired = updateMarkdownPreviewMetadataForChanges(initial.doc, transaction.newDoc, transaction.changes, markdownPreviewMetadata(initial.doc));

    expect(repaired).toEqual(markdownPreviewMetadata(transaction.newDoc));
    expect(repaired.tableContexts.get(5)?.rows).toEqual([["beta", "1"]]);
  });

  it("keeps aliased wikilinks together as one table cell", () => {
    const state = EditorState.create({ doc: [
      "| Task | Benchmark |",
      "| --- | --- |",
      "| Discovery | [[../public-benchmarks/astabench/README|AstaBench]] |",
    ].join("\n") });

    expect(markdownPreviewMetadata(state.doc).tableContexts.get(3)?.rows).toEqual([
      ["Discovery", "[[../public-benchmarks/astabench/README|AstaBench]]"],
    ]);
  });
});
