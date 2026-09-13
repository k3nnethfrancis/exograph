import type { AgentCommand } from "./agent-invocation";
import type { WorkspaceGraphContext } from "./workspace-graph";
import type { WorkspaceContentPolicy } from "./workspace-content-policy";

export type DocumentKind = "markdown" | "text";
export type ColorThemeId = "exograph-neutral" | "exograph-solar";

/** A user-authorized mutable Markdown root. */
export interface NoteRoot {
  id: string;
  label: string;
  path: string;
}

export interface WorkspaceModel {
  workspaceRoot: string;
  defaultTerminalCwd: string;
  noteRoots: NoteRoot[];
  indexedRoots: IndexedRoot[];
  indexing: IndexingConfig;
  /** Content scope shared by Explorer, graph, and search. Missing means generic Markdown scope. */
  contentPolicy?: WorkspaceContentPolicy;
  /** The user's chosen search engine. Undefined derives selection from indexing. */
  searchEngine?: SearchEngine;
}

export interface PublishingSettings {
  publicationDirectory: string;
  engineDirectory: string;
  siteUrl: string;
}

export interface WorkspaceSettings {
  publishing?: PublishingSettings;
  /** Forward-compatible persisted settings are retained except explicit unsupported fields. */
  [key: string]: unknown;
  workspaceRoot: string;
  defaultTerminalCwd: string;
  noteRoots: string[];
  agentCommands?: AgentCommand[];
  /** Command selected for Exograph-initiated agent features such as Ontology discovery. */
  defaultAgentCommandId?: string;
  /** Editable provider-neutral prompt template used for note invocations. */
  agentInvocationPrompt?: string;
  /** Optional override for Exograph's bundled read-only Ontology design prompt. */
  ontologyDiscoveryPrompt?: string;
  indexedRoots: IndexedRoot[];
  /** Editable content scope. A repository recommendation may populate this during onboarding. */
  contentPolicy?: WorkspaceContentPolicy;
  indexing: IndexingConfig;
  /** QMD configuration is retained when Simple search is selected. */
  searchEngine?: SearchEngine;
  appearanceMode: "system" | "light" | "dark";
  colorThemeId: ColorThemeId;
  editorFontSize: number;
  terminalFontSize: number;
  explorerScale: number;
  /** Reverse pointer-drag orbit direction in the spatial graph. */
  graphInverseNavigation: boolean;
  graphShowOverflowLabels: boolean;
  /** Per-workspace overrides for the global Mod-based shell shortcuts. */
  shortcutBindings?: WorkspaceShortcutBindings;
  exploreIndexSearchOnEnter: boolean;
  indexUpdateStrategy: IndexUpdateStrategy;
  layout?: WorkspaceLayoutSettings;
}

export type WorkspaceShortcutId = "explorer" | "utility" | "new-note" | "daily-note" | "terminal" | "save";

/** A Mod-based shortcut; Mod resolves to Command on macOS and Control elsewhere. */
export interface WorkspaceShortcutBinding {
  code: string;
  shift?: boolean;
  alt?: boolean;
}

export type WorkspaceShortcutBindings = Partial<Record<WorkspaceShortcutId, WorkspaceShortcutBinding>>;

export type WorkspaceSettingsRevision = string | null;

export interface WorkspaceSettingsSnapshot {
  settings: WorkspaceSettings;
  revision: WorkspaceSettingsRevision;
}

export interface WorkspaceSettingsSaveRequest {
  settings: WorkspaceSettings;
  expectedRevision: WorkspaceSettingsRevision;
}

export type WorkspaceLayoutSettings = WorkspaceCanvasLayoutSettings;

/** The single-canvas layout written by the current renderer. */
export interface WorkspaceCanvasLayoutSettings {
  version: 3;
  canvas: WorkspacePaneNode;
  sidebarCollapsed: boolean;
  sidebarWidth: number;
  utilityWidth: number;
}

export type WorkspacePaneNode = WorkspacePaneLeaf | WorkspacePaneSplit;

export interface WorkspacePaneLeaf {
  kind: "leaf";
  id: string;
  content: WorkspacePaneContent;
}

export interface WorkspacePaneSplit {
  kind: "split";
  id: string;
  direction: "horizontal" | "vertical";
  ratio: number;
  children: [WorkspacePaneNode, WorkspacePaneNode];
}

export type WorkspacePaneContent = WorkspaceEditorPaneContent | WorkspaceTerminalPaneContent | WorkspaceBrowserPaneContent | WorkspaceGraphPaneContent;

export interface WorkspaceEditorPaneContent {
  kind: "editor";
  openPaths: string[];
  activePath: string | null;
}

export interface WorkspaceTerminalPaneContent {
  kind: "terminal";
  terminalIds: string[];
  activeTerminalId: string | null;
}

export interface WorkspaceBrowserPaneContent {
  kind: "browser";
  url: string;
}

export interface WorkspaceGraphPaneContent {
  kind: "graph";
}

export interface TreeNode {
  id: string;
  name: string;
  path: string;
  kind: "file" | "directory";
  children?: TreeNode[];
}

/** Read-only derived view of one authorized folder. Viewing it never creates index.md. */
export interface FolderOverview {
  directoryPath: string;
  indexPath: string;
  title: string;
  frontmatter: Record<string, unknown>;
  indexExists: boolean;
  children: FolderOverviewEntry[];
  graphContext: WorkspaceGraphContext | null;
}

export interface FolderOverviewEntry {
  path: string;
  name: string;
  kind: "file" | "directory";
}

export interface NoteDocument {
  filePath: string;
  title: string;
  frontmatter: Record<string, unknown>;
  body: string;
  kind: DocumentKind;
}

export interface WikilinkReference {
  label: string;
  target: string;
  sourceRange: { from: number; to: number };
}

export interface MarkdownLinkReference {
  label: string;
  target: string;
  sourceRange: { from: number; to: number };
}

export interface TagReference {
  tag: string;
  source: "body" | "frontmatter";
  sourceRange?: { from: number; to: number };
  occurrences: ReadonlyArray<{
    source: "body" | "frontmatter";
    sourceRange?: { from: number; to: number };
  }>;
}

export interface SearchResult {
  filePath: string;
  title: string;
  snippet: string;
  kind: "note" | "tag";
}

export interface SemanticSearchResult {
  filePath: string;
  title: string;
  snippet: string;
  score: number;
  docid: string;
}

export type IndexedRootKind = "notes" | "docs" | "code" | "mixed";
export type IndexMode = "off" | "lexical" | "semantic" | "hybrid";
export type IndexBackend = "filesystem" | "qmd";
export type SearchEngine = "filesystem" | "qmd";
export type IndexUpdateStrategy = "manual" | "on-save";

export interface IndexedRoot {
  id: string;
  label: string;
  path: string;
  kind: IndexedRootKind;
  pattern: string;
  ignore: string[];
  backend: IndexBackend;
}

export interface IndexingConfig {
  enabled: boolean;
  mode: IndexMode;
  backend: IndexBackend;
}

export interface IndexStatus {
  enabled: boolean;
  mode: IndexMode;
  backend: IndexBackend;
  dbPath: string;
  runtimePath: string;
  indexedRoots: IndexedRoot[];
  documentCount: number;
  pendingEmbeddings: number;
  hasVectorIndex: boolean;
  lastUpdated: string | null;
  warnings: string[];
  errors: string[];
  recentJobs?: IndexJobMetric[];
}

export interface IndexJobMetric {
  id: string;
  kind: "sync" | "update" | "embed";
  reason: string;
  status: "completed" | "failed";
  startedAt: string;
  completedAt: string;
  durationMs: number;
  documentCount?: number;
  pendingEmbeddings?: number;
  warnings?: string[];
  error?: string;
}

export interface IndexSyncPhase {
  name: "update" | "embed";
  status: "completed" | "skipped" | "failed";
  message: string;
}

export interface IndexSyncResult {
  status: IndexStatus;
  phases: IndexSyncPhase[];
  warnings: string[];
}

export interface IndexSearchResult {
  filePath: string;
  title: string;
  snippet: string;
  score: number;
  docid?: string;
  source: "qmd" | "filesystem";
  content?: string;
}

export interface IndexSearchResponse {
  query: string;
  mode: IndexMode;
  source: "qmd" | "filesystem";
  warnings: string[];
  results: IndexSearchResult[];
  hasMore?: boolean;
  incomplete?: {
    reason: "authorization_refill_limit";
    requested: number;
    returned: number;
  };
}

export interface IndexReadResponse {
  target: string;
  filePath: string;
  title: string;
  body: string;
  fromLine?: number;
  maxLines?: number;
  source: "qmd" | "filesystem";
}

export interface WorkspaceSearchResults {
  notes: SearchResult[];
  tags: SearchResult[];
  semantic?: SemanticSearchResult[];
}
