import type { PreviewTarget } from "../../shared/api/workspace-filesystem";

export interface PreviewTab {
  id: string;
  target: PreviewTarget;
}

export interface PreviewTabsState {
  tabs: PreviewTab[];
  activeId: string | null;
}

export const EMPTY_PREVIEW_TABS: PreviewTabsState = { tabs: [], activeId: null };

export function addPreviewTab(state: PreviewTabsState, tab: PreviewTab): PreviewTabsState {
  const existing = state.tabs.find((candidate) => candidate.id === tab.id);
  return {
    tabs: existing
      ? state.tabs.map((candidate) => candidate.id === tab.id ? tab : candidate)
      : [...state.tabs, tab],
    activeId: tab.id,
  };
}

export function selectPreviewTab(state: PreviewTabsState, id: string): PreviewTabsState {
  return state.tabs.some((tab) => tab.id === id) ? { ...state, activeId: id } : state;
}

export function updatePreviewTabTarget(state: PreviewTabsState, id: string, target: PreviewTarget): PreviewTabsState {
  if (!state.tabs.some((tab) => tab.id === id)) return state;
  return {
    ...state,
    tabs: state.tabs.map((tab) => tab.id === id ? { ...tab, target } : tab),
  };
}

export function closePreviewTab(state: PreviewTabsState, id: string): PreviewTabsState {
  const index = state.tabs.findIndex((tab) => tab.id === id);
  if (index < 0) return state;
  const tabs = state.tabs.filter((tab) => tab.id !== id);
  if (state.activeId !== id) return { tabs, activeId: state.activeId };
  return { tabs, activeId: tabs[Math.min(index, tabs.length - 1)]?.id ?? null };
}
