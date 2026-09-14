import { describe, expect, it } from "vitest";

import { routeMarkdownLink } from "./markdownLinkRouting";

describe("routeMarkdownLink", () => {
  it("routes relative PDFs to Preview without creating a Markdown target", () => {
    expect(routeMarkdownLink("papers/report.pdf")).toEqual({ kind: "pdf-preview", target: "papers/report.pdf" });
  });

  it("preserves ordinary Markdown link routing", () => {
    expect(routeMarkdownLink("project plan")).toEqual({ kind: "note", target: "project plan" });
  });
});
