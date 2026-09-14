import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { NoteDocument } from "@exograph/core";

import { extractOutline, InspectorDock, InvocationHistoryTab } from "./InspectorDock";

const note: NoteDocument = {
  filePath: "/notes/alpha.md",
  title: "Alpha",
  kind: "markdown",
  frontmatter: { status: "draft", tags: ["exograph"] },
  body: "# Heading\n\n[[Beta]]",
};

describe("Note context", () => {
  it("keeps note properties in the editor and only reveals History when records exist", () => {
    const html = renderToStaticMarkup(
      <InspectorDock
        document={note}
        graphContext={null}
        open
        activeTag={null}
        tagResults={[]}
        invocationHistory={[]}
        onOpenInvocationHistory={() => {}}
        onResumeInvocation={() => {}}
        onToggle={() => {}}
        onOpenTarget={() => {}}
        onOpenExternal={() => {}}
        onOpenTag={() => {}}
        onOpenHeading={() => {}}
      />,
    );

    expect(html).toContain("Note context");
    expect(html).not.toContain("Properties");
    expect(html).toContain('role="tablist"');
    expect(html).toContain("connections-tab-outline");
    expect(html).not.toContain("connections-tab-graph");
    expect(html).not.toContain("connections-tab-activity");
    expect(html).not.toContain("connections-tab-history");
    expect(html).toContain("Heading");
    expect(html).toContain("connections-outline__link");
    expect(html).toContain("outline-panel");
  });

  it("renders compact invocation History with a resume affordance", () => {
    const html = renderToStaticMarkup(
      <InspectorDock
        document={note}
        graphContext={null}
        open
        activeTag={null}
        tagResults={[]}
        invocationHistory={[{ invocationId: "i-1", createdAt: new Date().toISOString(), command: { handle: "claude", label: "Claude" }, outcome: "kept", changedFileCount: 2, changeIds: ["a", "b"], providerSessionId: "session" }]}
        onOpenInvocationHistory={() => {}}
        onResumeInvocation={() => {}}
        onToggle={() => {}}
        onOpenTarget={() => {}}
        onOpenExternal={() => {}}
        onOpenTag={() => {}}
        onOpenHeading={() => {}}
      />,
    );
    expect(html).toContain("connections-tab-history");
  });

  it("retains exact source lines for duplicate headings", () => {
    expect(extractOutline("# One\n\n## Repeated\ntext\n## Repeated")).toEqual([
      { level: 1, text: "One", line: 1 },
      { level: 2, text: "Repeated", line: 3 },
      { level: 2, text: "Repeated", line: 5 },
    ]);
  });

  it("renders failed zero-change History as status with Resume but no dead Open action", () => {
    const html = renderToStaticMarkup(
      <InvocationHistoryTab
        items={[{ invocationId: "i-failed", createdAt: new Date().toISOString(), command: { handle: "claude", label: "Claude" }, outcome: "failed", changedFileCount: 0, changeIds: [], providerSessionId: "session" }]}
        onOpen={() => {}}
        onResume={() => {}}
      />,
    );
    expect(html).toContain("invocation-history__open--status");
    expect(html).not.toContain("<button class=\"invocation-history__open\"");
    expect(html).toContain("Resume Claude in Terminal");
  });

  it("renders a recoverable Invocation History refresh failure", () => {
    const html = renderToStaticMarkup(
      <InvocationHistoryTab
        error="History unavailable"
        items={[]}
        onOpen={() => {}}
        onResume={() => {}}
        onRetry={() => {}}
      />,
    );
    expect(html).toContain("History unavailable");
    expect(html).toContain("Retry");
  });
});
