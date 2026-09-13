import { useEffect, useId, useState, type ComponentType, type Dispatch, type SetStateAction } from "react";
import { Bot, Globe, FolderOpen, Keyboard, Palette, Search, TerminalSquare, X } from "lucide-react";
import type { AgentCommand, IndexStatus, WorkspaceSettings } from "@exograph/core";
import { normalizeDefaultAgentCommandId } from "@exograph/core/agent-command-configuration";
import { defaultWorkspaceContentPolicy, repositoryWorkspaceContentPolicy } from "@exograph/core/workspace-content-policy";
import type { AgentCommandContinuityStatus } from "../../../shared/api";

import { useSettingsDialogFocus } from "../hooks/useSettingsDialogFocus";
import type { AppearanceMode } from "../appearance";
import { THEME_FAMILIES, normalizeColorThemeId } from "../theme/registry";
import type { ColorThemeId } from "../theme/types";
import type { IndexBusyState, WorkspaceSettingsDialogState, WorkspaceSettingsSection } from "../workspaceSettingsDialogTypes";
import { selectWorkspaceSettingsSearchEngine } from "../workspaceSettingsModel";
import { PathList } from "./PathList";
import { AgentInvocationPromptEditor } from "./AgentInvocationPromptEditor";
import { DEFAULT_ONTOLOGY_DESIGN_PROMPT } from "../../../shared/ontology-design-prompt";
import { AgentCommandConfigurator } from "./AgentCommandConfigurator";
import { DefaultAgentSelector } from "./DefaultAgentSelector";
import { OntologyReviewRow } from "./OntologyReviewRow";
import { ExographMark } from "./ExographMark";
import { PublishingSection } from "./PublishingSection";
import { ShortcutsSection } from "./ShortcutsSection";

interface WorkspaceSettingsDialogProps {
  indexBusy: IndexBusyState;
  indexStatus: IndexStatus | null;
  onChooseFolder: (target: "workspaceRoot" | "defaultTerminalCwd" | "noteRoot") => void | Promise<void>;
  onClose: () => void;
  onOpenWorkspaceSwitcher: () => void | Promise<void>;
  onRunIndexUpdate: (kind: Exclude<IndexBusyState, null>) => void | Promise<void>;
  onSave: (settingsDialog: WorkspaceSettingsDialogState, options: { includeStructural: boolean }) => void | Promise<void>;
  settings: WorkspaceSettingsDialogState;
  setSettings: Dispatch<SetStateAction<WorkspaceSettingsDialogState | null>>;
  structuralDraftKey: (settings: WorkspaceSettingsDialogState) => string;
}

const SETTINGS_SECTIONS: Array<{
  id: WorkspaceSettingsSection;
  label: string;
  description: string;
  icon: ComponentType<{ size?: number }>;
}> = [
  { id: "workspace", label: "Workspace", description: "Folders and roots", icon: FolderOpen },
  { id: "index", label: "Search", description: "Search behavior", icon: Search },
  { id: "appearance", label: "Appearance", description: "Theme and editor", icon: Palette },
  { id: "graph", label: "Graph", description: "Navigation", icon: ExographMark },
  { id: "terminal", label: "Terminal", description: "Display", icon: TerminalSquare },
  { id: "shortcuts", label: "Shortcuts", description: "App commands", icon: Keyboard },
  { id: "publishing", label: "Publishing", description: "Site and preview", icon: Globe },
  { id: "agents", label: "Agents", description: "@ mentions and commands", icon: Bot },
];

export function WorkspaceSettingsDialog({
  indexBusy,
  indexStatus,
  onChooseFolder,
  onClose,
  onOpenWorkspaceSwitcher,
  onRunIndexUpdate,
  onSave,
  settings,
  setSettings,
  structuralDraftKey,
}: WorkspaceSettingsDialogProps) {
  const titleId = useId();
  const { dialogRef, closeRef, onKeyDown } = useSettingsDialogFocus(onClose);
  const hasStructuralChanges = structuralDraftKey(settings) !== settings.appliedWorkspaceKey;

  return (
    <div className="dialog-overlay" data-testid="workspace-settings-overlay">
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} onKeyDown={onKeyDown} className="dialog-card dialog-card--settings" data-testid="workspace-settings-dialog">
        <div className="dialog-card__header">
          <div id={titleId} className="dialog-card__title">Workspace Settings</div>
          <button
            ref={closeRef}
            aria-label="Close workspace settings"
            className="dialog-card__close"
            data-testid="workspace-settings-close"
            onClick={onClose}
            title="Close"
            type="button"
          >
            <X size={16} />
          </button>
        </div>
        <div className="dialog-card__message" aria-live="polite">
          {workspaceSettingsDialogIntroCopy(settings.section, hasStructuralChanges)}
        </div>
        <div className="workspace-settings-layout" data-testid="workspace-settings-body">
          <nav className="settings-nav" role="tablist" aria-label="Workspace settings sections">
            {SETTINGS_SECTIONS.map((section) => {
              const Icon = section.icon;
              return (
                <button
                  aria-selected={settings.section === section.id}
                  className={`settings-nav__button ${settings.section === section.id ? "settings-nav__button--active" : ""}`}
                  data-testid={`workspace-settings-tab-${section.id}`}
                  key={section.id}
                  onClick={() => setSettings((current) => (current ? { ...current, section: section.id } : current))}
                  role="tab"
                  type="button"
                >
                  <Icon size={16} />
                  <span>
                    <strong>{section.label}</strong>
                    <small>{section.description}</small>
                  </span>
                </button>
              );
            })}
          </nav>
          <div className="dialog-form workspace-settings-panel">
            {settings.section === "workspace" ? (
              <WorkspaceSection settings={settings} setSettings={setSettings} onChooseFolder={onChooseFolder} onOpenWorkspaceSwitcher={onOpenWorkspaceSwitcher} />
            ) : null}
            {settings.section === "index" ? (
              <IndexSection
                indexBusy={indexBusy}
                indexStatus={indexStatus}
                settings={settings}
                setSettings={setSettings}
                onRunIndexUpdate={onRunIndexUpdate}
              />
            ) : null}
            {settings.section === "appearance" ? <AppearanceSection settings={settings} setSettings={setSettings} /> : null}
            {settings.section === "graph" ? <GraphSection settings={settings} setSettings={setSettings} /> : null}
            {settings.section === "terminal" ? <TerminalSection settings={settings} setSettings={setSettings} /> : null}
            {settings.section === "shortcuts" ? <ShortcutsSection bindings={settings.shortcutBindings} onChange={(shortcutBindings) => setSettings((current) => current ? { ...current, shortcutBindings, saveStatus: "idle" } : current)} /> : null}
            {settings.section === "publishing" ? <PublishingSection settings={settings} setSettings={setSettings} /> : null}
            {settings.section === "agents" ? <AgentsSection settings={settings} setSettings={setSettings} /> : null}
          </div>
        </div>
        <div className="dialog-card__footer">
          {hasStructuralChanges ? (
            <div className="dialog-card__apply-row">
              <div className="dialog-card__status">Workspace path and search engine changes are ready to apply.</div>
              <button
                className="toolbar-button"
                data-testid="workspace-settings-apply"
                disabled={settings.applyStatus === "applying"}
                onClick={() => void onSave(settings, { includeStructural: true })}
                type="button"
              >
                {settings.applyStatus === "applying" ? "Applying..." : "Apply"}
              </button>
            </div>
          ) : null}
          {settings.applyStatus === "applied" ? (
            <div className="dialog-card__status" data-testid="workspace-settings-apply-status">
              Changes applied.
            </div>
          ) : null}
          {settings.applyStatus === "error" && settings.applyErrorMessage ? (
            <div className="dialog-card__status dialog-card__status--error">{settings.applyErrorMessage}</div>
          ) : null}
          {settings.saveStatus === "saving" ? (
            <div className="dialog-card__status" data-testid="workspace-settings-status">
              Saving...
            </div>
          ) : null}
          {settings.saveStatus === "saved" ? (
            <div className="dialog-card__status" data-testid="workspace-settings-status">
              {workspaceSettingsSavedFooterCopy(hasStructuralChanges)}
            </div>
          ) : null}
          {settings.saveStatus === "error" && settings.errorMessage ? (
            <div className="dialog-card__status dialog-card__status--error">{settings.errorMessage}</div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export function workspaceSettingsSavedFooterCopy(hasStructuralChanges: boolean): string {
  return hasStructuralChanges ? "Apply to save workspace and search changes. Closing Settings discards unapplied changes." : "Settings saved.";
}

export function workspaceSettingsDialogIntroCopy(section: WorkspaceSettingsSection, hasStructuralChanges: boolean): string {
  if (hasStructuralChanges) {
    return section === "index"
      ? "Search engine changes are ready to apply."
      : "Workspace changes are ready to apply.";
  }

  if (section === "publishing") return "Build a website from a folder of notes.";
  if (section === "index") {
    return "Choose how Exograph searches this workspace.";
  }

  if (section === "workspace") {
    return "Choose where Exograph reads notes and opens terminals.";
  }

  if (section === "appearance") {
    return "Adjust how Exograph looks and reads.";
  }
  if (section === "graph") {
    return "Adjust graph navigation and labels.";
  }
  if (section === "terminal") {
    return "Adjust terminal text.";
  }
  if (section === "shortcuts") {
    return "Choose the shortcuts Exograph uses in this workspace.";
  }
  return "Configure the agents available from @ mentions.";
}

function WorkspaceSection({
  onChooseFolder,
  onOpenWorkspaceSwitcher,
  settings,
  setSettings,
}: Pick<WorkspaceSettingsDialogProps, "onChooseFolder" | "onOpenWorkspaceSwitcher" | "settings" | "setSettings">) {
  return (
    <>
      <label className="dialog-field dialog-field--section">
        <span className="dialog-field__label">Workspace</span>
        <div className="settings-control-row">
          <input
            className="dialog-card__input"
            data-testid="workspace-settings-workspace-root"
            value={settings.workspaceRoot}
            onChange={(event) =>
              setSettings((current) =>
                current ? { ...current, workspaceRoot: event.target.value, applyStatus: "idle", applyErrorMessage: null } : current,
              )
            }
          />
          <button className="toolbar-button" onClick={() => void onChooseFolder("workspaceRoot")} type="button">
            Select
          </button>
        </div>
      </label>
      <label className="dialog-field dialog-field--section">
        <span className="dialog-field__label">Default terminal</span>
        <div className="settings-control-row">
          <input
            className="dialog-card__input"
            data-testid="workspace-settings-terminal-cwd"
            value={settings.defaultTerminalCwd}
            onChange={(event) =>
              setSettings((current) =>
                current ? { ...current, defaultTerminalCwd: event.target.value, applyStatus: "idle", applyErrorMessage: null } : current,
              )
            }
          />
          <button className="toolbar-button" onClick={() => void onChooseFolder("defaultTerminalCwd")} type="button">
            Select
          </button>
        </div>
      </label>
      <div className="dialog-field dialog-field--section">
        <div className="dialog-field__header">
          <span className="dialog-field__label">Notes folder</span>
          <button className="toolbar-button" onClick={() => void onOpenWorkspaceSwitcher()} type="button">
            Switch workspace
          </button>
        </div>
        <PathList
          emptyLabel="No notes folder selected."
          paths={settings.noteRoots}
          testId="workspace-settings-note-roots"
          onRemove={() => setSettings((current) => (current ? { ...current, noteRoots: [], applyStatus: "idle", applyErrorMessage: null } : current))}
        />
      </div>
      <div className="dialog-field dialog-field--section">
        <div className="dialog-field__label">Content scope</div>
        <div className="settings-control-row" role="group" aria-label="Content scope">
          <button
            aria-pressed={(settings.contentPolicy?.excludedPaths.length ?? 0) > 0}
            className="toolbar-button"
            data-testid="workspace-settings-content-scope-notes"
            onClick={() => setSettings((current) => current ? {
              ...current,
              contentPolicy: repositoryWorkspaceContentPolicy(),
              applyStatus: "idle",
              applyErrorMessage: null,
            } : current)}
            type="button"
          >
            Repository Markdown
          </button>
          <button
            aria-pressed={(settings.contentPolicy?.excludedPaths.length ?? 0) === 0}
            className="toolbar-button"
            data-testid="workspace-settings-content-scope-all"
            onClick={() => setSettings((current) => current ? {
              ...current,
              contentPolicy: defaultWorkspaceContentPolicy(),
              applyStatus: "idle",
              applyErrorMessage: null,
            } : current)}
            type="button"
          >
            All Markdown
          </button>
        </div>
        <div className="onboarding-section__hint">Code files never become Notes. Repository Markdown skips tool folders such as build, dist, coverage, node_modules, release, and vendor.</div>
      </div>
      <OntologyReviewRow />
    </>
  );
}

function IndexSection({
  indexBusy,
  indexStatus,
  onRunIndexUpdate,
  settings,
  setSettings,
}: Pick<WorkspaceSettingsDialogProps, "indexBusy" | "indexStatus" | "onRunIndexUpdate" | "settings" | "setSettings">) {
  const statusCopy = indexSettingsStatusCopy(indexStatus, indexBusy, settings.indexUpdateStrategy);
  const qmdSelected = settings.searchEngine === "qmd";

  function selectSearchEngine(searchEngine: "qmd" | "filesystem") {
    setSettings((current) =>
      current ? selectWorkspaceSettingsSearchEngine(current, searchEngine) : current);
  }

  return (
    <>
      <div className="dialog-field dialog-field--section">
        <div className="dialog-field__label">Search engine</div>
        <label className="dialog-check">
          <input checked={qmdSelected} data-testid="workspace-settings-search-engine-qmd" onChange={() => selectSearchEngine("qmd")} type="radio" name="workspace-search-engine" />
          <span>QMD <small>Recommended · local indexed search</small></span>
        </label>
        <label className="dialog-check">
          <input checked={!qmdSelected} data-testid="workspace-settings-search-engine-simple" onChange={() => selectSearchEngine("filesystem")} type="radio" name="workspace-search-engine" />
          <span>Simple search <small>Immediate filename and path matches</small></span>
        </label>
      </div>
      {!qmdSelected ? (
        <div className="onboarding-section__hint" data-testid="workspace-settings-simple-search-note">
          Simple search matches filenames and paths. Choose QMD for indexed search.
        </div>
      ) : null}
      {qmdSelected ? (
        <>
          <div className="index-summary">
            <div className="index-summary__stats">
              <span>QMD</span>
              <span>{indexStatus?.mode ?? settings.indexMode}</span>
              <span>
                {indexStatus?.indexedRoots.length ?? settings.indexedRoots.length} root
                {(indexStatus?.indexedRoots.length ?? settings.indexedRoots.length) === 1 ? "" : "s"}
              </span>
              <span>{indexStatus?.documentCount ?? 0} docs</span>
              {(indexStatus?.mode ?? settings.indexMode) !== "lexical" ? (
                <span>{waitingEmbeddingsCopy(indexStatus?.pendingEmbeddings ?? 0)}</span>
              ) : (
                <span>semantic off</span>
              )}
            </div>
          </div>
          {statusCopy ? (
            <div className={`onboarding-section__hint ${statusCopy.tone === "error" ? "dialog-card__status--error" : ""}`} data-testid="workspace-settings-index-status-note">
              {statusCopy.text}
            </div>
          ) : null}
          <label className="dialog-field dialog-field--section">
            <span className="dialog-field__label">QMD retrieval</span>
        <select
          className="dialog-card__input"
          data-testid="workspace-settings-index-mode"
          value={settings.indexMode}
          onChange={(event) => {
            const nextMode = event.target.value as Exclude<WorkspaceSettings["indexing"]["mode"], "off">;
            setSettings((current) =>
              current
                ? {
                  ...current,
                  indexMode: nextMode,
                    applyStatus: "idle",
                    applyErrorMessage: null,
                  }
                : current,
            );
          }}
        >
          <option value="lexical">Lexical</option>
          <option value="semantic">Semantic</option>
          <option value="hybrid">Hybrid</option>
        </select>
          </label>
      <label className="dialog-check">
        <input
          checked={settings.exploreIndexSearchOnEnter}
          data-testid="workspace-settings-explore-index-enter"
          onChange={(event) =>
            setSettings((current) => (current ? { ...current, exploreIndexSearchOnEnter: event.target.checked, saveStatus: "idle", errorMessage: null } : current))
          }
          type="checkbox"
        />
        <span>Use QMD when I press Enter in Explore.</span>
      </label>
      <label className="dialog-field dialog-field--section">
        <span className="dialog-field__label">Search updates</span>
        <select
          className="dialog-card__input"
          data-testid="workspace-settings-index-update-strategy"
          value={settings.indexUpdateStrategy}
          onChange={(event) =>
            setSettings((current) =>
              current ? { ...current, indexUpdateStrategy: event.target.value as WorkspaceSettings["indexUpdateStrategy"], saveStatus: "idle", errorMessage: null } : current,
            )
          }
        >
          <option value="on-save">On save</option>
          <option value="manual">Manual only</option>
        </select>
      </label>
      <div className="dialog-field dialog-field--section">
        <div className="dialog-field__header">
          <span className="dialog-field__label">Documents</span>
        </div>
        <div className="dialog-card__actions dialog-card__actions--split">
          <button
            className="toolbar-button"
            data-testid="workspace-settings-sync-index"
            disabled={indexBusy !== null || !indexStatus?.enabled || indexStatus.indexedRoots.length === 0}
            onClick={() => void onRunIndexUpdate("syncing")}
            type="button"
          >
            {indexBusy === "syncing" ? "Syncing..." : "Sync documents"}
          </button>
        </div>
      </div>
      <details className="dialog-details dialog-details--section settings-maintenance">
        <summary>Search maintenance</summary>
        <p className="dialog-card__hint">Use these controls when QMD is stale or embeddings are incomplete.</p>
        {indexStatus?.recentJobs?.length ? (
          <div className="index-activity" data-testid="workspace-settings-index-activity">
            <div className="index-activity__title">Recent activity</div>
            {indexStatus.recentJobs.slice(0, 3).map((job) => (
              <div className="index-activity__row" key={job.id}>
                <span>{job.kind}</span>
                <span>{formatDuration(job.durationMs)}</span>
                <span>{formatRelativeTime(job.completedAt)}</span>
                <span>{job.status === "failed" ? "failed" : job.pendingEmbeddings === undefined ? "complete" : `${job.pendingEmbeddings} embeddings waiting`}</span>
              </div>
            ))}
          </div>
        ) : null}
        <div className="dialog-card__actions dialog-card__actions--split">
          <button
            className="toolbar-button"
            data-testid="workspace-settings-update-index"
            disabled={indexBusy !== null || !indexStatus?.enabled || indexStatus.indexedRoots.length === 0}
            onClick={() => void onRunIndexUpdate("updating")}
            type="button"
          >
            {indexBusy === "updating" ? "Refreshing..." : "Reconcile documents"}
          </button>
          <button
            className="toolbar-button"
            data-testid="workspace-settings-embed-index"
            disabled={indexBusy !== null || !indexStatus?.enabled || indexStatus.mode === "lexical" || indexStatus.indexedRoots.length === 0}
            onClick={() => void onRunIndexUpdate("embedding")}
            type="button"
          >
            {indexBusy === "embedding" ? "Embedding..." : "Build embeddings"}
          </button>
        </div>
      </details>
        </>
      ) : null}
    </>
  );
}

export function indexSettingsStatusCopy(
  indexStatus: IndexStatus | null,
  indexBusy: IndexBusyState,
  indexUpdateStrategy: WorkspaceSettings["indexUpdateStrategy"] = "on-save",
): { text: string; tone: "info" | "warn" | "error" } | null {
  if (indexBusy === "syncing") {
    return indexStatus?.mode === "lexical"
      ? { tone: "info", text: "Sync is reconciling included documents. Status will refresh when it finishes." }
      : { tone: "info", text: "Sync is refreshing documents and building pending embeddings. Status will refresh when it finishes." };
  }
  if (indexBusy === "updating") {
    return { tone: "info", text: "Refreshing QMD notes. Embedding status will update when it finishes." };
  }
  if (indexBusy === "embedding") {
    return { tone: "info", text: "Building pending QMD semantic embeddings. Status will update when it finishes." };
  }
  if (!indexStatus) {
    return null;
  }
  if (indexStatus.errors.length > 0) {
    return { tone: "error", text: "QMD is unavailable. Simple search still works; switch engines or sync QMD to recover." };
  }
  if (!indexStatus.enabled || indexStatus.mode === "off" || indexStatus.indexedRoots.length === 0) {
    return null;
  }
  if ((indexStatus.mode === "semantic" || indexStatus.mode === "hybrid") && indexStatus.pendingEmbeddings > 0) {
    const lastJob = indexStatus.recentJobs?.[0];
    const failedEmbeddingJob = lastJob && (lastJob.kind === "sync" || lastJob.kind === "embed") && (
      lastJob.status === "failed" ||
      lastJob.error ||
      lastJob.warnings?.some((warning) => warning.toLowerCase().includes("embedding failed"))
    );
    if (failedEmbeddingJob) {
      return {
        tone: "warn",
        text: `${waitingEmbeddingsCopy(indexStatus.pendingEmbeddings)} after embedding failed; lexical search remains available. Build embeddings retries now.`,
      };
    }
    if (indexUpdateStrategy === "manual") {
      return {
        tone: "warn",
        text: `${waitingEmbeddingsCopy(indexStatus.pendingEmbeddings)}. Automatic updates are paused; lexical search remains available. Use Sync now or Build embeddings.`,
      };
    }
    return {
      tone: "warn",
      text: `${waitingEmbeddingsCopy(indexStatus.pendingEmbeddings)}. Small changes catch up automatically while Exograph is idle; lexical search remains available. Build embeddings runs now.`,
    };
  }
  return null;
}

function waitingEmbeddingsCopy(count: number): string {
  return `${count} content embedding${count === 1 ? "" : "s"} waiting`;
}

function AppearanceSection({
  settings,
  setSettings,
}: Pick<WorkspaceSettingsDialogProps, "settings" | "setSettings">) {
  return (
    <div className="dialog-form__grid">
      <label className="dialog-field">
        <span className="dialog-field__label">Mode</span>
        <select
          className="dialog-card__input"
          data-testid="workspace-settings-appearance"
          value={settings.appearanceMode}
          onChange={(event) =>
            setSettings((current) => (current ? { ...current, appearanceMode: event.target.value as AppearanceMode, saveStatus: "idle", errorMessage: null } : current))
          }
        >
          <option value="system">System</option>
          <option value="light">Light</option>
          <option value="dark">Dark</option>
        </select>
      </label>
      <label className="dialog-field">
        <span className="dialog-field__label">Color theme</span>
        <select
          className="dialog-card__input"
          data-testid="workspace-settings-color-theme"
          value={settings.colorThemeId}
          onChange={(event) =>
            setSettings((current) =>
              current
                ? { ...current, colorThemeId: normalizeColorThemeId(event.target.value as ColorThemeId), saveStatus: "idle", errorMessage: null }
                : current,
            )
          }
        >
          {THEME_FAMILIES.map((theme) => (
            <option key={theme.id} value={theme.id}>
              {theme.label}
            </option>
          ))}
        </select>
      </label>
      <label className="dialog-field">
        <span className="dialog-field__label">Editor font</span>
        <input
          className="dialog-card__input"
          data-testid="workspace-settings-editor-font-size"
          type="number"
          min={11}
          max={24}
          value={settings.editorFontSize}
          onChange={(event) => setSettings((current) => (current ? { ...current, editorFontSize: event.target.value, saveStatus: "idle", errorMessage: null } : current))}
        />
      </label>
      <label className="dialog-field">
        <span className="dialog-field__label">Explorer scale</span>
        <input
          className="dialog-card__input"
          data-testid="workspace-settings-explorer-scale"
          type="number"
          min={0.82}
          max={1.35}
          step={0.01}
          value={settings.explorerScale}
          onChange={(event) => setSettings((current) => (current ? { ...current, explorerScale: event.target.value, saveStatus: "idle", errorMessage: null } : current))}
        />
      </label>
    </div>
  );
}

function TerminalSection({
  settings,
  setSettings,
}: Pick<WorkspaceSettingsDialogProps, "settings" | "setSettings">) {
  return (
    <div className="dialog-form__grid dialog-form__grid--compact">
      <label className="dialog-field">
        <span className="dialog-field__label">Terminal font</span>
        <input
          className="dialog-card__input"
          data-testid="workspace-settings-terminal-font-size"
          type="number"
          min={10}
          max={22}
          value={settings.terminalFontSize}
          onChange={(event) => setSettings((current) => (current ? { ...current, terminalFontSize: event.target.value, saveStatus: "idle", errorMessage: null } : current))}
        />
      </label>
    </div>
  );
}

function GraphSection({
  settings,
  setSettings,
}: Pick<WorkspaceSettingsDialogProps, "settings" | "setSettings">) {
  return (
    <div className="dialog-form__grid dialog-form__grid--compact" data-testid="workspace-settings-graph">
      <label className="dialog-check">
        <input
          checked={settings.graphInverseNavigation}
          data-testid="workspace-settings-graph-inverse-navigation"
          onChange={(event) => setSettings((current) => current ? {
            ...current,
            graphInverseNavigation: event.target.checked,
            saveStatus: "idle",
            errorMessage: null,
          } : current)}
          type="checkbox"
        />
        <span>
          <strong>Inverse navigation</strong>
          <small>Reverse orbit direction while dragging.</small>
        </span>
      </label>
      <label className="dialog-check">
        <input
          checked={settings.graphShowOverflowLabels}
          aria-labelledby="graph-overflow-labels-title"
          aria-describedby="graph-overflow-labels-description"
          data-testid="workspace-settings-graph-overflow-labels"
          onChange={(event) => setSettings((current) => current ? {
            ...current,
            graphShowOverflowLabels: event.target.checked,
            saveStatus: "idle",
            errorMessage: null,
          } : current)}
          type="checkbox"
        />
        <span>
          <strong id="graph-overflow-labels-title">Show overflow labels</strong>
          <small id="graph-overflow-labels-description">Place labels away from their nodes when there is not enough room.</small>
        </span>
      </label>
      <details className="agent-invocation-prompt-disclosure">
        <summary>Advanced</summary>
        <AgentInvocationPromptEditor
          ariaLabel="Ontology design prompt"
          defaultValue={DEFAULT_ONTOLOGY_DESIGN_PROMPT}
          hint="Used only when Exograph asks the default agent to propose an Ontology."
          onSave={(ontologyDiscoveryPrompt) => setSettings((current) => current ? {
            ...current,
            ontologyDiscoveryPrompt,
            saveStatus: "idle",
            errorMessage: null,
          } : current)}
          promptName="ontology prompt"
          subtitle="Used by Discover structure"
          testId="workspace-settings-ontology-prompt"
          title="Ontology prompt"
          value={settings.ontologyDiscoveryPrompt}
        />
      </details>
    </div>
  );
}

function AgentsSection({
  settings,
  setSettings,
}: Pick<WorkspaceSettingsDialogProps, "settings" | "setSettings">) {
  return (
    <div className="agent-command-list" data-testid="workspace-settings-agents">
      <DefaultAgentSelector
        commands={settings.agentCommands}
        onChange={(defaultAgentCommandId) => setSettings((current) => current ? {
          ...current,
          defaultAgentCommandId: defaultAgentCommandId ?? undefined,
          saveStatus: "idle",
          errorMessage: null,
        } : current)}
        testId="workspace-settings-default-agent"
        value={settings.defaultAgentCommandId}
      />
      <AgentCommandConfigurator
        commands={settings.agentCommands}
        onChange={(agentCommands) => setSettings((current) => current ? {
          ...current,
          agentCommands,
          defaultAgentCommandId: normalizeDefaultAgentCommandId(current.defaultAgentCommandId, agentCommands),
          saveStatus: "idle",
          errorMessage: null,
        } : current)}
        testId="workspace-settings-agents-config"
      />
      <AgentCommandContinuityControls commands={settings.agentCommands} />
      <details className="agent-invocation-prompt-disclosure">
        <summary>Advanced</summary>
        <AgentInvocationPromptEditor
          onSave={(agentInvocationPrompt) => setSettings((current) => current ? {
            ...current,
            agentInvocationPrompt,
            saveStatus: "idle",
            errorMessage: null,
          } : current)}
          testId="workspace-settings-invocation-prompt"
          value={settings.agentInvocationPrompt}
        />
      </details>
    </div>
  );
}

function AgentCommandContinuityControls({ commands }: { commands: AgentCommand[] }) {
  const continuousCommands = commands.filter((command) => command.adapter === "claude-code");
  if (continuousCommands.length === 0) return null;
  return (
    <section className="agent-command-continuity-settings" aria-label="Saved command context">
      <div className="dialog-field__label">Saved command context</div>
      {continuousCommands.map((command) => <AgentCommandContinuityRow command={command} key={command.id} />)}
    </section>
  );
}

function AgentCommandContinuityRow({ command }: { command: AgentCommand }) {
  const [hasContext, setHasContext] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadNonce, setReloadNonce] = useState(0);
  useEffect(() => {
    let active = true;
    setError(null);
    void loadAgentCommandContinuityState(command.id, window.exograph.workspace.getAgentCommandContinuity)
      .then((state) => {
        if (!active) return;
        setHasContext(state.hasContext);
        setBusy(state.busy);
        setError(state.error);
      });
    return () => { active = false; };
  }, [command.id, reloadNonce]);

  return (
    <div className="agent-command-continuity-settings__row">
      <span>@{command.handle}</span>
      <span>{error ? "Context unavailable" : hasContext ? "Context saved" : "No saved context"}</span>
      {error ? (
        <button className="toolbar-button" onClick={() => setReloadNonce((current) => current + 1)} type="button">
          Retry
        </button>
      ) : hasContext ? (
        <button
          className="toolbar-button"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            setError(null);
            void window.exograph.workspace.resetAgentCommandContinuity(command.id)
              .then(() => setHasContext(false))
              .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
              .finally(() => setBusy(false));
          }}
          type="button"
        >
          Reset
        </button>
      ) : null}
      {error ? <span className="dialog-field__error">{error}</span> : null}
    </div>
  );
}

export async function loadAgentCommandContinuityState(
  commandId: string,
  load: (commandId: string) => Promise<AgentCommandContinuityStatus>,
): Promise<{ hasContext: boolean; busy: boolean; error: string | null }> {
  try {
    const status = await load(commandId);
    return { hasContext: status.hasHead, busy: status.active, error: null };
  } catch (error) {
    return {
      hasContext: false,
      busy: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1000) {
    return `${durationMs}ms`;
  }
  return `${(durationMs / 1000).toFixed(durationMs < 10_000 ? 1 : 0)}s`;
}

function formatRelativeTime(value: string): string {
  const elapsedMs = Date.now() - new Date(value).getTime();
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) {
    return "just now";
  }
  if (elapsedMs < 60_000) {
    return `${Math.max(1, Math.round(elapsedMs / 1000))}s ago`;
  }
  if (elapsedMs < 3_600_000) {
    return `${Math.round(elapsedMs / 60_000)}m ago`;
  }
  return `${Math.round(elapsedMs / 3_600_000)}h ago`;
}
