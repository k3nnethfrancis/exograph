import { describe, expect, it } from "vitest";

import { mergeTreeRootsWithMaterializedBranches } from "./workspaceTree";

describe("mergeTreeRootsWithMaterializedBranches", () => {
  it("retains a previously loaded deep branch when a shallow root refresh reaches its depth boundary", () => {
    const current = {
      "/notes": [{
        id: "/notes/projects",
        name: "projects",
        path: "/notes/projects",
        kind: "directory" as const,
        children: [{
          id: "/notes/projects/research-agent-eval",
          name: "research-agent-eval",
          path: "/notes/projects/research-agent-eval",
          kind: "directory" as const,
          children: [{ id: "/notes/projects/research-agent-eval/plan.md", name: "plan.md", path: "/notes/projects/research-agent-eval/plan.md", kind: "file" as const }],
        }],
      }],
    };
    const refreshed = {
      "/notes": [{
        id: "/notes/projects",
        name: "projects",
        path: "/notes/projects",
        kind: "directory" as const,
        children: [{
          id: "/notes/projects/research-agent-eval",
          name: "research-agent-eval",
          path: "/notes/projects/research-agent-eval",
          kind: "directory" as const,
          children: [],
        }],
      }],
    };

    expect(mergeTreeRootsWithMaterializedBranches(current, refreshed)).toEqual(current);
  });

  it("removes a branch that no longer exists in the refreshed root tree", () => {
    const current = {
      "/notes": [{ id: "/notes/removed", name: "removed", path: "/notes/removed", kind: "directory" as const, children: [] }],
    };

    expect(mergeTreeRootsWithMaterializedBranches(current, { "/notes": [] })).toEqual({ "/notes": [] });
  });
});
