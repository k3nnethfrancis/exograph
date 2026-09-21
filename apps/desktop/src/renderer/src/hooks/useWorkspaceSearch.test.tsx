import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useWorkspaceSearch } from "./useWorkspaceSearch";

let renderer: ReactTestRenderer | undefined;

beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));

afterEach(async () => {
  if (renderer) await act(async () => renderer!.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

describe("useWorkspaceSearch", () => {
  it.each(["semantic", "hybrid"] as const)("passes the configured %s mode through to the provider", async (mode) => {
    const searchIndex = vi.fn(async () => ({
      query: "meaning",
      mode,
      source: "qmd" as const,
      warnings: [],
      results: [{ filePath: "/notes/meaning.md", title: "Meaning", snippet: "A result", score: 1, source: "qmd" as const }],
    }));
    vi.stubGlobal("window", {
      exograph: {
        workspace: {
          searchWorkspace: vi.fn(async () => ({ notes: [], tags: [] })),
          searchIndex,
        },
      },
    });

    let controller!: ReturnType<typeof useWorkspaceSearch>;
    function Harness() {
      controller = useWorkspaceSearch({ indexedOnEnter: true, qmdSelected: true });
      return null;
    }

    await act(async () => {
      renderer = create(<Harness />);
    });
    await act(async () => {
      controller.setQuery("meaning");
    });
    await act(async () => {
      await controller.runIndexedSearch();
    });

    expect(searchIndex).toHaveBeenCalledWith("meaning", { limit: 30 });
    expect(controller.resultMode).toBe("index");
    expect(controller.results.notes).toEqual([{ filePath: "/notes/meaning.md", title: "Meaning", snippet: "A result", kind: "note" }]);
  });
});
