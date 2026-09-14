import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  createDefaultClaudeAgentCommand,
  createDefaultCodexAgentCommand,
  type IndexStatus,
} from "@exograph/core";

import {
  WorkspaceSettingsDialog,
  loadAgentCommandContinuityState,
  indexSettingsStatusCopy,
  workspaceSettingsDialogIntroCopy,
  workspaceSettingsSavedFooterCopy,
} from "./WorkspaceSettingsDialog";
import { workspaceSettingsStructuralDraftKey } from "../workspaceSettingsModel";
import { workspaceSettingsDialogFixture } from "../workspaceSettingsTestFixtures";

describe("workspace settings footer copy", () => {
  it("returns a visible error when saved command context cannot load", async () => {
    await expect(loadAgentCommandContinuityState("claude", async () => {
      throw new Error("context unavailable");
    })).resolves.toEqual({
      hasContext: false,
      busy: false,
      error: "context unavailable",
    });
  });

  it("only mentions Apply when structural changes are pending", () => {
    expect(workspaceSettingsSavedFooterCopy(true)).toBe("Apply to save workspace and search changes. Closing Settings discards unapplied changes.");
    expect(workspaceSettingsSavedFooterCopy(false)).toBe("Settings saved.");
  });

  it("keeps the dialog intro from mentioning Apply when no Apply action is visible", () => {
    expect(workspaceSettingsDialogIntroCopy("index", false)).not.toContain("Apply");
    expect(workspaceSettingsDialogIntroCopy("index", false)).toContain("Choose how Exograph searches");
    expect(workspaceSettingsDialogIntroCopy("appearance", false)).not.toContain("Apply");
    expect(workspaceSettingsDialogIntroCopy("index", true)).toContain("apply");
  });

  it("keeps invocation configuration in the Settings dialog", () => {
    const html = renderToStaticMarkup(
      <WorkspaceSettingsDialog
        indexBusy={null}
        indexStatus={null}
        onChooseFolder={() => {}}
        onClose={() => {}}
        onOpenWorkspaceSwitcher={() => {}}
        onRunIndexUpdate={() => {}}
        onSave={() => {}}
        settings={workspaceSettingsDialogFixture({
          section: "agents",
          agentCommands: [createDefaultClaudeAgentCommand(), createDefaultCodexAgentCommand()],
          defaultAgentCommandId: "codex",
        })}
        setSettings={() => {}}
        structuralDraftKey={workspaceSettingsStructuralDraftKey}
      />,
    );

    expect(html).toContain("Agents");
    expect(html).toContain("Default agent");
    expect(html).toContain('<option value="codex" selected="">Codex</option>');
    expect(html).toContain("@claude");
    expect(workspaceSettingsDialogIntroCopy("agents", false)).toBe("Configure the agents available from @ mentions.");
    expect(html).toContain("claude -p");
    expect(html).toContain("Keep context");
    expect(html).toContain("Fresh each time");
    expect(html).toContain("Add Custom");
  });

  it("keeps inverse navigation in a dedicated Graph section", () => {
    const html = renderToStaticMarkup(
      <WorkspaceSettingsDialog
        indexBusy={null}
        indexStatus={null}
        onChooseFolder={() => {}}
        onClose={() => {}}
        onOpenWorkspaceSwitcher={() => {}}
        onRunIndexUpdate={() => {}}
        onSave={() => {}}
        settings={workspaceSettingsDialogFixture({ section: "graph", graphInverseNavigation: false })}
        setSettings={() => {}}
        structuralDraftKey={workspaceSettingsStructuralDraftKey}
      />,
    );

    expect(html).toContain("Show overflow labels");
    expect(html).toContain("Place labels away from their nodes when there is not enough room.");
    expect(html).toContain('data-testid="workspace-settings-graph-overflow-labels"');
    expect(html).toContain("Inverse navigation");
    expect(html).toContain("Reverse orbit direction while dragging.");
    expect(html).toContain('data-testid="workspace-settings-graph-inverse-navigation"');
    expect(html).toContain("Advanced");
    expect(html).toContain("Ontology prompt");
    expect(html).toContain("Used by Discover structure");
    expect(html).toContain('data-testid="workspace-settings-ontology-prompt"');
    expect(workspaceSettingsDialogIntroCopy("graph", false)).toBe("Adjust graph navigation and labels.");
  });

  it("keeps Markdown scope editable from Workspace settings", () => {
    const html = renderToStaticMarkup(
      <WorkspaceSettingsDialog
        indexBusy={null}
        indexStatus={null}
        onChooseFolder={() => {}}
        onClose={() => {}}
        onOpenWorkspaceSwitcher={() => {}}
        onRunIndexUpdate={() => {}}
        onSave={() => {}}
        settings={workspaceSettingsDialogFixture({ section: "workspace" })}
        setSettings={() => {}}
        structuralDraftKey={workspaceSettingsStructuralDraftKey}
      />,
    );

    expect(html).toContain("Content scope");
    expect(html).toContain("Repository Markdown");
    expect(html).toContain("All Markdown");
  });

  it("explains pending embeddings after a failed sync instead of only saying pending", () => {
    const copy = indexSettingsStatusCopy(indexStatusFixture({
      pendingEmbeddings: 12,
      recentJobs: [
        {
          id: "index-job-1",
          kind: "sync",
          reason: "settings",
          status: "completed",
          startedAt: "2026-07-03T10:00:00.000Z",
          completedAt: "2026-07-03T10:00:02.000Z",
          durationMs: 2_000,
          documentCount: 42,
          pendingEmbeddings: 12,
          warnings: ["Embedding failed (no such module: vec0); lexical search remains available."],
        },
      ],
    }), null);

    expect(copy?.text).toContain("12 content embeddings waiting after embedding failed");
    expect(copy?.text).toContain("Build embeddings");
    expect(copy?.text).toContain("lexical search remains available");
    expect(copy?.text).not.toContain("ready");
  });

  it("shows in-progress index action status before a fresh status arrives", () => {
    expect(indexSettingsStatusCopy(null, "syncing")?.text).toContain("Status will refresh when it finishes");
    expect(indexSettingsStatusCopy(indexStatusFixture({ mode: "lexical" }), "syncing")?.text).toBe("Sync is reconciling included documents. Status will refresh when it finishes.");
    expect(indexSettingsStatusCopy(indexStatusFixture(), "updating")?.text).toContain("Embedding status will update");
    expect(indexSettingsStatusCopy(indexStatusFixture(), "embedding")?.text).toContain("semantic embeddings");
    expect(indexSettingsStatusCopy(indexStatusFixture(), "embedding")?.text).toContain("QMD");
    expect(indexSettingsStatusCopy(indexStatusFixture(), "syncing")?.text).not.toContain("rebuild");
  });

  it("explains automatic and manual pending-embedding behavior without adding a setting", () => {
    const pending = indexStatusFixture({ pendingEmbeddings: 3 });
    const automatic = indexSettingsStatusCopy(pending, null, "on-save")?.text;
    const manual = indexSettingsStatusCopy(pending, null, "manual")?.text;

    expect(automatic).toContain("3 content embeddings waiting");
    expect(automatic).toContain("catch up automatically while Exograph is idle");
    expect(automatic).toContain("lexical search remains available");
    expect(automatic).toContain("Build embeddings runs now");
    expect(manual).toContain("3 content embeddings waiting");
    expect(manual).toContain("Automatic updates are paused");
    expect(manual).toContain("lexical search remains available");
    expect(manual).toContain("Sync now or Build embeddings");
  });


  it("keeps provider failures out of the settings surface", () => {
    const copy = indexSettingsStatusCopy(indexStatusFixture({ errors: ["ENOENT: mkdir '/.exograph'"] }), null);

    expect(copy?.text).toBe("QMD is unavailable. Simple search still works; switch engines or sync QMD to recover.");
    expect(copy?.text).not.toContain("ENOENT");
  });

  it("renders index guidance and precise activity labels", () => {
    const html = renderToStaticMarkup(
      <WorkspaceSettingsDialog
        indexBusy={null}
        indexStatus={indexStatusFixture({
          pendingEmbeddings: 3,
          recentJobs: [
            {
              id: "index-job-1",
              kind: "sync",
              reason: "settings",
              status: "completed",
              startedAt: "2026-07-03T10:00:00.000Z",
              completedAt: "2026-07-03T10:00:02.000Z",
              durationMs: 2_000,
              documentCount: 10,
              pendingEmbeddings: 3,
              warnings: [],
            },
          ],
        })}
        onChooseFolder={() => {}}
        onClose={() => {}}
        onOpenWorkspaceSwitcher={() => {}}
        onRunIndexUpdate={() => {}}
        onSave={() => {}}
        settings={workspaceSettingsDialogFixture({
          section: "index",
          indexedRoots: [{ id: "index-root-1", label: "notes", path: "/workspace/notes", kind: "notes", pattern: "**/*.md", ignore: [], backend: "qmd" }],
          indexMode: "hybrid",
          searchEngine: "qmd",
          appliedWorkspaceKey: workspaceSettingsStructuralDraftKey(workspaceSettingsDialogFixture({
            indexedRoots: [{ id: "index-root-1", label: "notes", path: "/workspace/notes", kind: "notes", pattern: "**/*.md", ignore: [], backend: "qmd" }],
            indexMode: "hybrid",
            searchEngine: "qmd",
          })),
        })}
        setSettings={() => {}}
        structuralDraftKey={workspaceSettingsStructuralDraftKey}
      />,
    );

    expect(html).toContain("3 content embeddings waiting");
    expect(html).toContain("catch up automatically while Exograph is idle");
    expect(html).toContain("Search engine");
    expect(html).toContain("Search mode");
    expect(html).not.toContain("3 pending embeddings");
    expect(html).toContain("Search maintenance");
    expect(html).toContain("QMD");
    expect(html).not.toContain("Press Apply");
  });

  it("describes maintenance against the applied mode while a different mode is drafted", () => {
    const html = renderSearchSettings(indexStatusFixture({ mode: "lexical" }));
    expect(html).toContain("Update indexed documents.");
    expect(html).toContain("Actions use the applied search settings.");
    expect(html).toContain("Apply a meaning-based search mode to enable embeddings.");
    const embed = html.match(/<button[^>]*data-testid="workspace-settings-embed-index"[^>]*>/)?.[0];
    expect(embed).toContain('disabled=""');
    expect(html).toContain('<option value="hybrid" selected="">Keywords + meaning</option>');
  });

  it.each(["syncing", "updating", "embedding"] as const)("disables index actions and identifies the running %s operation", (busy) => {
    const html = renderSearchSettings(indexStatusFixture(), busy);
    const buttons = html.match(/<button[^>]*data-testid="workspace-settings-(?:sync|update|embed)-index"[^>]*>/g)!;
    expect(buttons).toHaveLength(3);
    expect(buttons.every(button => button.includes('disabled=""'))).toBe(true);
    expect(buttons.filter(button => button.includes('aria-busy="true"'))).toHaveLength(1);
  });

  it.each([{ enabled: false, indexedRoots: [] }, { mode: "off" as const }])("explains unavailable index actions without claiming the draft index is ready: %j", (status) => {
    const html = renderSearchSettings(indexStatusFixture(status));
    expect(html).toContain("Apply QMD settings to enable index actions.");
    const buttons = html.match(/<button[^>]*data-testid="workspace-settings-(?:sync|update|embed)-index"[^>]*>/g)!;
    expect(buttons.every(button => button.includes('disabled=""'))).toBe(true);
  });

  it("keeps QMD maintenance out of Simple search settings", () => {
    const html = renderToStaticMarkup(
      <WorkspaceSettingsDialog
        indexBusy={null}
        indexStatus={indexStatusFixture()}
        onChooseFolder={() => {}}
        onClose={() => {}}
        onOpenWorkspaceSwitcher={() => {}}
        onRunIndexUpdate={() => {}}
        onSave={() => {}}
        settings={workspaceSettingsDialogFixture({ section: "index", searchEngine: "filesystem" })}
        setSettings={() => {}}
        structuralDraftKey={workspaceSettingsStructuralDraftKey}
      />,
    );

    expect(html).toContain("Filenames and paths");
    expect(html).not.toContain("Search maintenance");
    expect(html).not.toContain("Sync now");
  });

  it("does not present an embedding backlog as document work in lexical mode", () => {
    const html = renderToStaticMarkup(
      <WorkspaceSettingsDialog
        indexBusy={null}
        indexStatus={indexStatusFixture({ mode: "lexical", pendingEmbeddings: 303 })}
        onChooseFolder={() => {}}
        onClose={() => {}}
        onOpenWorkspaceSwitcher={() => {}}
        onRunIndexUpdate={() => {}}
        onSave={() => {}}
        settings={workspaceSettingsDialogFixture({ section: "index", indexMode: "lexical", searchEngine: "qmd" })}
        setSettings={() => {}}
        structuralDraftKey={workspaceSettingsStructuralDraftKey}
      />,
    );

    expect(html).toContain("Apply a meaning-based search mode to enable embeddings.");
    expect(html).not.toContain("303 content embeddings waiting");
    expect(html).not.toContain("303 notes waiting");
  });
});

function indexStatusFixture(overrides: Partial<IndexStatus> = {}): IndexStatus {
  return {
    enabled: true,
    mode: "hybrid",
    backend: "qmd",
    dbPath: "/workspace/.exograph/qmd/index.sqlite",
    runtimePath: "/workspace/.exograph/qmd",
    indexedRoots: [
      {
        id: "index-root-1",
        label: "notes",
        path: "/workspace/notes",
        kind: "mixed",
        pattern: "**/*.md",
        ignore: [],
        backend: "qmd",
      },
    ],
    documentCount: 10,
    pendingEmbeddings: 0,
    hasVectorIndex: true,
    lastUpdated: "2026-07-03T10:00:00.000Z",
    warnings: [],
    errors: [],
    ...overrides,
  };
}

function renderSearchSettings(status: IndexStatus, busy: "syncing" | "updating" | "embedding" | null = null) {
  return renderToStaticMarkup(<WorkspaceSettingsDialog
    indexBusy={busy} indexStatus={status} onChooseFolder={() => {}} onClose={() => {}}
    onOpenWorkspaceSwitcher={() => {}} onRunIndexUpdate={() => {}} onSave={() => {}}
    settings={workspaceSettingsDialogFixture({ section: "index", indexMode: "hybrid", searchEngine: "qmd" })}
    setSettings={() => {}} structuralDraftKey={workspaceSettingsStructuralDraftKey}
  />);
}
