import { describe, expect, it } from "vitest";

import {
  addPreviewTab,
  closePreviewTab,
  EMPTY_PREVIEW_TABS,
  selectPreviewTab,
  updatePreviewTabTarget,
} from "./previewTabsModel";

describe("preview tabs model", () => {
  it("adds and selects previews without sharing terminal state", () => {
    const first = addPreviewTab(EMPTY_PREVIEW_TABS, { id: "one", target: { kind: "web", source: "url", url: "about:blank" } });
    const second = addPreviewTab(first, { id: "two", target: { kind: "web", source: "url", url: "http://localhost:4321" } });

    expect(second.tabs.map((tab) => tab.id)).toEqual(["one", "two"]);
    expect(second.activeId).toBe("two");
    expect(selectPreviewTab(second, "one").activeId).toBe("one");
  });

  it("updates only the addressed preview", () => {
    const state = addPreviewTab(
      addPreviewTab(EMPTY_PREVIEW_TABS, { id: "one", target: { kind: "web", source: "url", url: "about:blank" } }),
      { id: "two", target: { kind: "web", source: "url", url: "about:blank" } },
    );

    expect(updatePreviewTabTarget(state, "one", { kind: "web", source: "url", url: "http://localhost:3000" }).tabs).toEqual([
      { id: "one", target: { kind: "web", source: "url", url: "http://localhost:3000" } },
      { id: "two", target: { kind: "web", source: "url", url: "about:blank" } },
    ]);
  });

  it("selects the adjacent preview when the active tab closes", () => {
    const state = addPreviewTab(
      addPreviewTab(EMPTY_PREVIEW_TABS, { id: "one", target: { kind: "web", source: "url", url: "about:blank" } }),
      { id: "two", target: { kind: "web", source: "url", url: "about:blank" } },
    );

    expect(closePreviewTab(state, "two")).toEqual({
      tabs: [{ id: "one", target: { kind: "web", source: "url", url: "about:blank" } }],
      activeId: "one",
    });
    expect(closePreviewTab(closePreviewTab(state, "two"), "one")).toEqual(EMPTY_PREVIEW_TABS);
  });
});
