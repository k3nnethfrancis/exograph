import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { InvocationActivitySurface, activityTitle } from "./InvocationActivitySurface";

describe("InvocationActivitySurface", () => {
  it.each([
    ["working", "Working"],
    ["review", "Review"],
    ["checking", "Starting"],
    ["done", "Done"],
    ["stopped", "Stopped"],
    ["failed", "Failed"],
  ] as const)("presents %s with bounded copy", (kind, expected) => {
    expect(activityTitle(kind)).toBe(expected);
  });

  it("exposes one polite running state and a true Stop action", () => {
    const html = renderToStaticMarkup(
      <InvocationActivitySurface
        commandHandle="claude"
        commandLabel="Claude"
        kind="working"
        label="Reading tasks.md"
        onStop={() => {}}
      />,
    );

    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain("Working");
    expect(html).toContain("Reading tasks.md");
    expect(html).toContain('aria-label="Stop"');
    expect(html).toContain("lucide-circle-stop");
    expect(html).not.toContain("lucide-square");
    expect(html).not.toContain("Details");
  });

  it("keeps failure recovery compact and accessible", () => {
    const html = renderToStaticMarkup(
      <InvocationActivitySurface
        commandHandle="codex"
        commandLabel="Codex"
        errorDetail="Command not found"
        kind="failed"
        onDismiss={() => {}}
        onResume={() => {}}
        onRetry={() => {}}
        onShowDetails={() => {}}
      />,
    );

    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain("Command not found");
    expect(html).toContain('aria-label="Retry"');
    expect(html).toContain('aria-label="Resume in Terminal"');
    expect(html).toContain('aria-label="Dismiss"');
    expect(html).toContain("Details");
  });
});
