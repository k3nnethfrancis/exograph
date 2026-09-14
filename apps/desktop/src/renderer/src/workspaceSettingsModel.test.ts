import { describe, expect, it } from "vitest";
import { normalizeWorkspaceSettings } from "@exograph/core";

import { workspaceSettingsFromDialog } from "./hooks/useWorkspaceSettingsController";
import {
  clampNumber,
  resolveSettingsTerminalRuntime,
  selectWorkspaceSettingsSearchEngine,
  workspaceSettingsImmediateDraftKey,
  workspaceSettingsStructuralDraftFromSettings,
  workspaceSettingsStructuralDraftKey,
  workspaceSettingsStructuralKeyFromSettings,
} from "./workspaceSettingsModel";
import { workspaceSettingsDialogFixture } from "./workspaceSettingsTestFixtures";

describe("workspace settings renderer model", () => {
  it("does not add retired terminal settings through dialog saves", () => {
    const current = normalizeWorkspaceSettings({
      workspaceRoot: "/workspace",
      defaultTerminalCwd: "/workspace",
      noteRoots: ["/workspace/notes"],
      indexedRoots: [],
      indexing: { enabled: false, mode: "off", backend: "qmd" },
    });

    expect(current).not.toBeNull();
    const next = workspaceSettingsFromDialog(
      workspaceSettingsDialogFixture({ appearanceMode: "dark", terminalFontSize: "16" }),
      { includeStructural: false },
      current,
    );

    expect(next).toMatchObject({ appearanceMode: "dark", terminalFontSize: 16 });
    expect(next).not.toHaveProperty("terminalHistoryLines");
    expect(next).not.toHaveProperty("terminalTranscriptRetention");
    expect(next).not.toHaveProperty("terminalTranscriptRetentionDays");
  });

  it("keeps structural draft keys aligned with saved settings keys", () => {
    const settings = normalizeWorkspaceSettings({
      workspaceRoot: "/workspace",
      defaultTerminalCwd: "/workspace/project",
      noteRoots: ["/workspace/notes"],
      indexedRoots: [{
        id: "index-notes",
        label: "notes",
        path: "/workspace/notes",
        kind: "notes",
        pattern: "**/*.md",
        ignore: [],
        backend: "qmd",
      }],
      indexing: { enabled: true, mode: "lexical", backend: "qmd" },
    });

    expect(settings).not.toBeNull();
    expect(workspaceSettingsStructuralDraftKey({
      section: "workspace",
      settingsRevision: null,
      workspaceRoot: "/workspace",
      defaultTerminalCwd: "/workspace/project",
      noteRoots: ["/workspace/notes"],
      indexedRoots: [{ id: "index-notes", label: "notes", path: "/workspace/notes", kind: "notes", pattern: "**/*.md", ignore: [], backend: "qmd" }],
      indexMode: "lexical",
      searchEngine: "qmd",
      appearanceMode: "system",
      colorThemeId: "exograph-neutral",
      editorFontSize: "15",
      terminalFontSize: "13",
      explorerScale: "1",
      graphInverseNavigation: true,
      graphShowOverflowLabels: true,
      exploreIndexSearchOnEnter: true,
      indexUpdateStrategy: "on-save",
      agentCommands: [],
      saveStatus: "idle",
      errorMessage: null,
      appliedWorkspaceKey: "",
      applyStatus: "idle",
      applyErrorMessage: null,
    })).toBe(workspaceSettingsStructuralKeyFromSettings(settings!));
  });

  it("tracks every editable Indexed Root policy field in structural drafts", () => {
    const root = {
      id: "research",
      label: "Research",
      path: "/workspace/notes/research",
      kind: "docs" as const,
      pattern: "**/*.mdx",
      ignore: ["private/**"],
      backend: "qmd" as const,
    };
    const draft = workspaceSettingsDialogFixture({ indexedRoots: [root] });

    expect(workspaceSettingsStructuralDraftKey({
      ...draft,
      indexedRoots: [{ ...root, pattern: "**/*.md" }],
    })).not.toBe(workspaceSettingsStructuralDraftKey(draft));
    expect(workspaceSettingsStructuralDraftKey({
      ...draft,
      indexedRoots: [{ ...root, ignore: ["private/**", "archive/**"] }],
    })).not.toBe(workspaceSettingsStructuralDraftKey(draft));
  });

  it("preserves retained Indexed Roots when re-enabling QMD", () => {
    const roots = [
      {
        id: "research",
        label: "Research",
        path: "/workspace/notes/research",
        kind: "docs" as const,
        pattern: "**/*.mdx",
        ignore: ["private/**"],
        backend: "qmd" as const,
      },
      {
        id: "code",
        label: "Code",
        path: "/workspace/notes/code",
        kind: "code" as const,
        pattern: "**/*.ts",
        ignore: ["generated/**"],
        backend: "qmd" as const,
      },
    ];
    const current = workspaceSettingsDialogFixture({
      indexedRoots: roots,
      indexMode: "off",
      searchEngine: "filesystem",
    });

    const next = selectWorkspaceSettingsSearchEngine(current, "qmd");

    expect(next.indexMode).toBe("lexical");
    expect(next.indexedRoots).toEqual(roots);
  });

  it("defaults empty QMD roots once and keeps repeated selection idempotent", () => {
    const current = workspaceSettingsDialogFixture({
      noteRoots: ["/workspace/notes"],
      indexedRoots: [],
      indexMode: "off",
      searchEngine: "filesystem",
    });

    const enabled = selectWorkspaceSettingsSearchEngine(current, "qmd");
    const selectedAgain = selectWorkspaceSettingsSearchEngine(enabled, "qmd");

    expect(enabled.indexedRoots).toEqual([{
      id: "index-root-1",
      label: "notes",
      path: "/workspace/notes",
      kind: "mixed",
      pattern: "**/*.md",
      ignore: [],
      backend: "qmd",
    }]);
    expect(selectedAgain).toEqual(enabled);
  });

  it("rehydrates canonical structural fields from saved settings", () => {
    const settings = normalizeWorkspaceSettings({
      workspaceRoot: "/workspace",
      defaultTerminalCwd: "/workspace",
      noteRoots: ["/workspace/notes"],
      indexedRoots: [{
        id: "research",
        label: "Research",
        path: "/workspace/notes/research",
        kind: "docs",
        pattern: "**/*.mdx",
        ignore: ["private/**"],
        backend: "qmd",
      }],
      indexing: { enabled: true, mode: "lexical", backend: "qmd" },
      searchEngine: "qmd",
    });
    expect(settings).not.toBeNull();

    const canonical = workspaceSettingsStructuralDraftFromSettings(settings!);

    expect(workspaceSettingsStructuralDraftKey({
      ...workspaceSettingsDialogFixture(),
      ...canonical,
    })).toBe(workspaceSettingsStructuralKeyFromSettings(settings!));
  });

  it("tracks color theme in immediate settings saves", () => {
    const base = {
      section: "appearance" as const,
      settingsRevision: null,
      workspaceRoot: "/workspace",
      defaultTerminalCwd: "/workspace",
      noteRoots: ["/workspace/notes"],
      indexedRoots: [],
      indexMode: "off" as const,
      searchEngine: "filesystem" as const,
      appearanceMode: "system" as const,
      colorThemeId: "exograph-neutral" as const,
      editorFontSize: "15",
      terminalFontSize: "13",
      explorerScale: "1",
      graphInverseNavigation: true,
      graphShowOverflowLabels: true,
      exploreIndexSearchOnEnter: false,
      indexUpdateStrategy: "on-save" as const,
      agentCommands: [],
      saveStatus: "idle" as const,
      errorMessage: null,
      appliedWorkspaceKey: "",
      applyStatus: "idle" as const,
      applyErrorMessage: null,
    };

    expect(workspaceSettingsImmediateDraftKey(base)).not.toBe(
      workspaceSettingsImmediateDraftKey({ ...base, colorThemeId: "exograph-solar" }),
    );
    expect(workspaceSettingsImmediateDraftKey(base)).not.toBe(
      workspaceSettingsImmediateDraftKey({ ...base, graphInverseNavigation: false }),
    );
    expect(workspaceSettingsImmediateDraftKey(base)).not.toBe(
      workspaceSettingsImmediateDraftKey({ ...base, graphShowOverflowLabels: false }),
    );
  });

  it("uses fixed internal scrollback while preserving unknown forward metadata", () => {
    const settings = normalizeWorkspaceSettings({
      workspaceRoot: "/workspace",
      defaultTerminalCwd: "/workspace",
      noteRoots: ["/workspace/notes"],
      indexedRoots: [],
      indexing: { enabled: false, mode: "off", backend: "qmd" },
      futureTerminalMetadata: { retained: true },
    });

    expect(settings ? resolveSettingsTerminalRuntime(settings).scrollbackLines : null).toBe(100_000);
    expect(settings?.futureTerminalMetadata).toEqual({ retained: true });
    expect(clampNumber(Number.NaN, 10, 20)).toBe(10);
    expect(clampNumber(25, 10, 20)).toBe(20);
    expect(clampNumber(15, 10, 20)).toBe(15);
  });
});
