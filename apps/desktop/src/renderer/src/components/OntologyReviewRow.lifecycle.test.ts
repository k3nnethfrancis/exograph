import { act, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vitest";
import type { OntologyReviewState } from "@exograph/core";
import { OntologyReviewPresentation, OntologyReviewRow } from "./OntologyReviewRow";

const pending: OntologyReviewState = {
  library: [{ sourcePath: "ontologies/research.yaml", state: "valid", id: "research", label: "Research", revision: "revision" }],
  active: { state: "generic" },
  candidate: { state: "valid", sourcePath: "ontologies/research.yaml", id: "research", label: "Research", revision: "revision", pending: true, rejected: false },
  guard: { candidateSourcePath: "ontologies/research.yaml", candidateRevision: "revision", activationRevision: null, baseSnapshotId: "base" },
  diagnostics: [], omittedDiagnostics: 0,
};
let renderer: ReactTestRenderer | undefined;
afterEach(async () => { if (renderer) await act(async () => renderer!.unmount()); renderer = undefined; vi.unstubAllGlobals(); });

it("previews a selected source without changing the active ontology until Activate", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const previewOntology = vi.fn(async () => pending);
  const keepOntology = vi.fn(async () => ({ status: "applied", review: { ...pending, active: { state: "active", id: "research", label: "Research" }, candidate: { ...pending.candidate, pending: false } } }));
  vi.stubGlobal("window", { exograph: { workspace: { previewOntology, keepOntology, onOntologyCandidateChanged: () => () => {} } } });
  await act(async () => { renderer = create(createElement(OntologyReviewRow)); });
  await act(async () => renderer!.root.findByType("select").props.onChange({ target: { value: "source:0" } }));
  expect(previewOntology).toHaveBeenLastCalledWith("ontologies/research.yaml");
  expect(keepOntology).not.toHaveBeenCalled();
  expect(renderer!.root.findByProps({ className: "ontology-review__active" }).findByType("strong").children).toEqual(["Generic"]);
  expect(renderer!.root.findByProps({ className: "ontology-review__hint" }).children.join("")).toContain("Preview only");
  await act(async () => renderer!.root.findByProps({ "aria-label": "Activate ontology" }).props.onClick());
  expect(keepOntology).toHaveBeenCalledWith(pending.guard);
  expect(renderer!.root.findByProps({ className: "ontology-review__active" }).findByType("strong").children).toEqual(["Research"]);
  expect(renderer!.root.findAllByProps({ "aria-label": "Activate ontology" })).toHaveLength(0);
});

it("shows the active identity in the compact summary even when a different preview is selected", () => {
  const html = renderToStaticMarkup(createElement(OntologyReviewPresentation, {
    compact: true, busy: null, notice: null, reopened: false, review: pending,
    onKeep() {}, onReject() {}, onReopen() {}, onSelect() {},
  }));
  expect(html).toContain('aria-label="Ontology; active Generic"');
  expect(html).toMatch(/<summary[^>]*>Active: Generic<\/summary>/);
  expect(html).toContain('aria-label="Preview ontology"');
  expect(html).toContain('value="source:0" selected=""');
  expect(html).toContain('aria-label="Activate ontology"');
  expect(html).not.toMatch(/<details[^>]*\bopen/);
});

it("dismisses the compact review without leaking Escape or stealing outside-click focus", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  class Target {}
  vi.stubGlobal("Node", Target);
  let pointerdown: (event: { target: Target }) => void;
  const outside = new Target();
  let graphBottom = 390;
  let resized: () => void;
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: () => void) { resized = callback; }
    observe() {}
    disconnect() {}
  });
  const graph = { getBoundingClientRect: () => ({ bottom: graphBottom }) };
  const toolbar = { getBoundingClientRect: () => ({ bottom: 40 }) };
  const setProperty = vi.fn();
  const disclosure = { open: true, contains: (target: Target) => target !== outside,
    closest: (selector: string) => selector === ".spatial-graph" ? graph : toolbar,
    style: { setProperty },
  };
  const summary = { focus: vi.fn() };
  vi.stubGlobal("document", { addEventListener: (_: string, callback: typeof pointerdown) => { pointerdown = callback; }, removeEventListener() {} });
  await act(async () => {
    renderer = create(createElement(OntologyReviewPresentation, {
      compact: true, busy: null, notice: null, reopened: false, review: pending,
      onKeep() {}, onReject() {}, onReopen() {}, onSelect() {},
    }), { createNodeMock: element => element.type === "details" ? disclosure : element.type === "summary" ? summary : null });
  });
  expect(setProperty).toHaveBeenLastCalledWith("--ontology-review-height", "344px");
  graphBottom = 270;
  resized!();
  expect(setProperty).toHaveBeenLastCalledWith("--ontology-review-height", "224px");
  const key = (defaultPrevented: boolean) => ({ key: "Escape", defaultPrevented, preventDefault: vi.fn(), stopPropagation: vi.fn() });
  const consumed = key(true);
  renderer!.root.findByType("details").props.onKeyDown(consumed);
  expect(disclosure.open).toBe(true);
  const escape = key(false);
  renderer!.root.findByType("details").props.onKeyDown(escape);
  expect(disclosure.open).toBe(false);
  expect(escape.stopPropagation).toHaveBeenCalledOnce();
  expect(summary.focus).toHaveBeenCalledOnce();
  disclosure.open = true;
  pointerdown!({ target: outside });
  expect(disclosure.open).toBe(false);
  expect(summary.focus).toHaveBeenCalledOnce();
});
