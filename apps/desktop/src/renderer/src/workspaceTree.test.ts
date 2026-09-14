import { describe, expect, it } from "vitest";

import { mergeTreeRootsWithMaterializedBranches, replaceTreeChildrenInRoots } from "./workspaceTree";

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

describe("replaceTreeChildrenInRoots", () => {
  it("replaces a note-root's direct children during an external filesystem refresh", () => {
    const roots = {
      "/notes": [{ id: "/notes/old.md", name: "old.md", path: "/notes/old.md", kind: "file" as const }],
    };
    const children = [{ id: "/notes/new.md", name: "new.md", path: "/notes/new.md", kind: "file" as const }];

    expect(replaceTreeChildrenInRoots(roots, "/notes", children)).toEqual({ "/notes": children });
  });

  it("replaces an expanded directory's immediate children so renamed paths do not linger", () => {
    const roots = {
      "/notes": [{
        id: "/notes/project",
        name: "project",
        path: "/notes/project",
        kind: "directory" as const,
        children: [{ id: "/notes/project/partner-traces", name: "partner-traces", path: "/notes/project/partner-traces", kind: "directory" as const, children: [] }],
      }],
    };
    const children = [{ id: "/notes/project/traces", name: "traces", path: "/notes/project/traces", kind: "directory" as const, children: [] }];

    expect(replaceTreeChildrenInRoots(roots, "/notes/project", children)).toEqual({
      "/notes": [{ ...roots["/notes"][0], children }],
    });
  });
});
