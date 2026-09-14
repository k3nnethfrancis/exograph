import { act, createElement } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BoundedGraphConceptDetail } from "@exograph/core";

import { GraphConceptDetailPanel } from "./GraphConceptDetailPanel";

const detail: BoundedGraphConceptDetail = {
  concept: { id: "cedar", label: "Cedar", conceptTypes: ["Project"], resolution: "resolved", filePath: "/notes/cedar.md", relativePath: "cedar.md", tags: [] },
  properties: [{ key: "owner", value: "Synthetic Owner" }],
  relations: [],
  findings: [{ id: "finding", code: "missing-reference", message: "A reference needs attention", severity: "warning", conceptIds: ["cedar"], relationIds: [], evidence: [] }],
  format: { id: "generic-markdown", version: "1", label: "Markdown", source: "built-in", state: "active" },
  ontology: { state: "generic" },
  omitted: { properties: 0, relations: 0, findings: 0, evidence: 0 },
};
let renderer: ReactTestRenderer | undefined;

beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
afterEach(async () => {
  if (renderer) await act(async () => renderer!.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

async function mount(selected = detail) {
  const onOpenTarget = vi.fn();
  const onStartMaintenance = vi.fn();
  await act(async () => {
    renderer = create(createElement(GraphConceptDetailPanel, {
      detail: selected, detailStatus: "Partial metadata available", degree: -1, topology: null,
      onOpenTarget, onStartMaintenance,
    }));
  });
  return { root: renderer!.root, onOpenTarget, onStartMaintenance };
}

describe("selected graph concept panel", () => {
  it("keeps the title and link count visible while native Details hides metadata and maintenance by default", async () => {
    const { root } = await mount();
    const disclosure = root.findByType("details");
    expect(disclosure.props.open).toBeUndefined();
    expect(disclosure.findByType("summary").children).toEqual(["Details"]);
    expect(disclosure.findByProps({ className: "spatial-graph__detail-meta" }).children).toEqual(["Project"]);
    expect(disclosure.findByProps({ className: "spatial-graph__path" }).children).toEqual(["cedar.md"]);
    expect(disclosure.findByProps({ className: "spatial-graph__detail-properties" })).toBeTruthy();
    expect(disclosure.findByType("button").children).toContain("Find relevant connections");
    const heading = root.findByProps({ className: "spatial-graph__detail-heading" });
    expect(heading.findByType("button").children).toEqual(["Cedar"]);
    expect(heading.findByProps({ className: "spatial-graph__detail-count" }).children).toEqual(["0", " links"]);
    const findings = root.findAllByProps({ className: "spatial-graph__finding" });
    expect(findings.map(finding => finding.children.join(""))).toEqual(["A reference needs attention", "Partial metadata available"]);
    expect(findings.every(finding => finding.parent === disclosure.parent)).toBe(true);
  });

  it("opens the selected Note and sends maintenance the exact Note path", async () => {
    const { root, onOpenTarget, onStartMaintenance } = await mount();
    await act(async () => root.findByProps({ className: "spatial-graph__detail-title" }).props.onClick());
    expect(onOpenTarget).toHaveBeenCalledWith("/notes/cedar.md");
    expect(onStartMaintenance).not.toHaveBeenCalled();
    await act(async () => root.findByType("details").findByType("button").props.onClick());
    expect(onStartMaintenance).toHaveBeenCalledWith("/notes/cedar.md");
  });

  it("keeps unresolved references non-openable", async () => {
    const { root } = await mount({ ...detail, concept: { ...detail.concept, filePath: undefined, relativePath: undefined, resolution: "unresolved" } });
    expect(root.findAllByType("button")).toHaveLength(0);
    expect(root.findByProps({ className: "spatial-graph__detail-title spatial-graph__detail-title--reference" }).children).toEqual(["Cedar"]);
  });
});
