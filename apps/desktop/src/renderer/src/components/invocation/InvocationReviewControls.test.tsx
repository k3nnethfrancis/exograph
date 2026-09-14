import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  InvocationReviewControls,
  clampReviewIndex,
  reviewOperationLabel,
  type InvocationReviewItemProjection,
} from "./InvocationReviewControls";

const items: readonly InvocationReviewItemProjection[] = [
  {
    id: "created",
    path: "/notes/generated/chart.png",
    operation: "created",
    mediaType: "binary",
    summary: "Claude added an illustration.",
  },
  {
    id: "renamed",
    path: "/notes/research/final.md",
    previousPath: "/notes/research/draft.md",
    operation: "renamed",
  },
  {
    id: "deleted",
    path: "/notes/old.md",
    operation: "deleted",
  },
];

const callbacks = {
  onKeepCurrent: () => {},
  onRejectCurrent: () => {},
};

describe("InvocationReviewControls", () => {
  it("keeps a single-file decision direct and identifies created binary files", () => {
    const html = renderToStaticMarkup(
      <InvocationReviewControls queue={{ items: [items[0]!], currentIndex: 0 }} {...callbacks} />,
    );

    expect(html).toContain('aria-label="Review invocation changes"');
    expect(html).toContain("Created");
    expect(html).toContain("Binary");
    expect(html).toContain('aria-label="Reject"');
    expect(html).toContain('aria-label="Keep"');
    expect(html).not.toContain("Previous file");
    expect(html).not.toContain("All 1 files");
    expect(html).not.toContain("<dialog");
    expect(html).not.toContain("@@");
  });

  it("keeps the provider session handoff inside the same review surface", () => {
    const html = renderToStaticMarkup(
      <InvocationReviewControls
        queue={{ items: [items[0]!], currentIndex: 0 }}
        onResume={() => {}}
        {...callbacks}
      />,
    );

    expect(html).toContain('aria-label="Open agent session"');
    expect(html).toContain("lucide-arrow-up-right");
  });

  it("presents a navigable multi-file queue with bulk decisions behind disclosure", () => {
    const html = renderToStaticMarkup(
      <InvocationReviewControls
        queue={{ items, currentIndex: 1 }}
        onKeepAll={() => {}}
        onNavigate={() => {}}
        onRejectAll={() => {}}
        {...callbacks}
      />,
    );

    expect(html).toContain("Renamed");
    expect(html).toContain("draft.md → final.md");
    expect(html).toContain("2 of 3");
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('aria-label="Previous file"');
    expect(html).toContain('aria-label="Next file"');
    expect(html).toContain("<details");
    expect(html).toContain("All 3 files");
    expect(html).toContain('aria-label="Reject all"');
    expect(html).toContain('aria-label="Keep all"');
  });

  it("turns conflicts into an explicit non-destructive recovery state", () => {
    const html = renderToStaticMarkup(
      <InvocationReviewControls
        queue={{
          currentIndex: 0,
          items: [{ ...items[2]!, conflict: "The file changed after the agent finished." }],
        }}
        onOpenConflict={() => {}}
        onKeepConflict={() => {}}
        onRefreshConflict={() => {}}
        {...callbacks}
      />,
    );

    expect(html).toContain("Deleted");
    expect(html).toContain("File changed");
    expect(html).toContain("The file changed after the agent finished.");
    expect(html).toContain('aria-label="Refresh review"');
    expect(html).toContain('aria-label="Open file"');
    expect(html).toContain('aria-label="Keep current"');
    expect(html).not.toContain('aria-label="Reject"');
    expect(html).not.toContain('aria-label="Keep"');
    expect(html).not.toContain("All 1 files");
  });

  it("accepts constrained anchor geometry for narrow editor panes", () => {
    const html = renderToStaticMarkup(
      <InvocationReviewControls
        position={{ left: 18, top: 42, origin: "bottom right", maxWidth: 280 }}
        queue={{ items, currentIndex: 0 }}
        onNavigate={() => {}}
        {...callbacks}
      />,
    );

    expect(html).toContain('data-positioned="true"');
    expect(html).toContain('data-narrow="true"');
    expect(html).toContain("--invocation-review-left:18px");
    expect(html).toContain("--invocation-review-top:42px");
    expect(html).toContain("--invocation-review-origin:bottom right");
    expect(html).toContain("--invocation-review-max-width:280px");
  });

  it("keeps keyboard traversal in visual reading order", () => {
    const html = renderToStaticMarkup(
      <InvocationReviewControls
        queue={{ items, currentIndex: 1 }}
        onKeepAll={() => {}}
        onNavigate={() => {}}
        onRejectAll={() => {}}
        {...callbacks}
      />,
    );
    const focusOrder = [
      'aria-label="Previous file"',
      'aria-label="Next file"',
      'aria-label="Reject"',
      'aria-label="Keep"',
      "All 3 files",
      'aria-label="Reject all"',
      'aria-label="Keep all"',
    ].map((value) => html.indexOf(value));

    expect(focusOrder.every((position) => position >= 0)).toBe(true);
    expect(focusOrder).toEqual([...focusOrder].sort((left, right) => left - right));
    expect(html).toContain('title="Previous file"');
    expect(html).toContain('title="Keep"');
  });

  it("normalizes stale queue indexes and labels all supported operations", () => {
    expect(clampReviewIndex(-3, 3)).toBe(0);
    expect(clampReviewIndex(7, 3)).toBe(2);
    expect(clampReviewIndex(1.8, 3)).toBe(1);
    expect(["modified", "created", "deleted", "renamed"].map((operation) =>
      reviewOperationLabel(operation as InvocationReviewItemProjection["operation"]),
    )).toEqual(["Edited", "Created", "Deleted", "Renamed"]);
  });

  it("shows frontmatter-only and permission-only changes without replacing the page diff", () => {
    const html = renderToStaticMarkup(
      <InvocationReviewControls
        queue={{
          currentIndex: 0,
          items: [{
            id: "metadata",
            path: "/notes/example.md",
            operation: "modified",
            metadataChanges: [{ key: "status", before: "draft", after: "ready" }],
            permissionChange: { before: "0644", after: "0755" },
          }],
        }}
        {...callbacks}
      />,
    );

    expect(html).toContain('aria-label="File metadata changes"');
    expect(html).toContain('aria-label="status: draft to ready"');
    expect(html).toContain('aria-label="Permissions changed from 0644 to 0755"');
    expect(html).toContain("draft");
    expect(html).toContain("ready");
    expect(html).not.toContain("@@");
  });

  it("disables exact decisions while the editor save barrier is settling", () => {
    const html = renderToStaticMarkup(
      <InvocationReviewControls
        decisionPending
        queue={{ items: [items[2]!], currentIndex: 0 }}
        {...callbacks}
      />,
    );

    expect(html).toContain('aria-label="Reject"');
    expect(html).toContain('aria-label="Keep"');
    expect(html).toContain('aria-busy="true"');
    expect(html.match(/disabled=""/g)).toHaveLength(2);
  });

});
