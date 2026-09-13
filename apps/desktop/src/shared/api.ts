import type { PublishingApi } from "./api/publishing";
export { publicationScope } from "./api/publishing";
export type { PublishingStatus, PublicationAction, PublicationDiagnostic, PublishingBuildRequest, PublishingScope, PublicationDeployResult } from "./api/publishing";
import type { WorkspaceFilesystemApi } from "./api/workspace-filesystem";
import type { WorkspaceIndexApi } from "./api/workspace-index";
import type { WorkspaceInvocationApi } from "./api/invocation-commands";
import type { NotesGraphApi } from "./api/notes-graph";
import type { ShellApi } from "./api/shell";
import type { TerminalsApi } from "./api/terminal";
import type { WorkspaceSetupApi } from "./api/workspace-setup";

export type {
  AgentCommandContinuityStatus,
  AgentCommandLaunchFacts,
  AgentInvocationAuthorizationFacts,
  CliInstallationStatus,
  InvocationFileReviewPayload,
  InvocationHistoryItem,
  InvocationReviewListItem,
  LaunchAgentInvocationInput,
  LaunchAgentInvocationResponse,
  ProviderMcpSetupInput,
  ProviderMcpSetupResult,
  PreparedGraphMaintenanceSkill,
  OntologyDiscoveryResult,
  RendererEditorDiagnostic,
} from "./api/invocation-commands";
export type { FileStatInfo, ResolvedMarkdownImage } from "./api/notes-graph";
export type {
  TerminalCreateOptions,
  TerminalDataEvent,
  TerminalGeometryRecord,
  TerminalHealthState,
  TerminalKind,
  TerminalSessionInfo,
  TerminalWriteResult,
} from "./api/terminal";
export type {
  WorkspaceSettingsRuntimeApplyOutcome,
  WorkspaceSettingsSaveOutcome,
  WorkspaceSettingsSection,
  WorkspaceSetupState,
} from "./api/workspace-setup";
export type { WorkspaceRegistryEntry } from "@exograph/core";
export type { IndexSyncStateEvent } from "./api/workspace-index";

/**
 * The renderer's single desktop bridge contract. Domain definitions remain
 * private to this directory; callers keep importing this stable aggregate seam.
 */
export interface DesktopApi {
  /** Present only in explicit test launches; absent from ordinary production. */
  test?: { graphHooks: true };
  workspace: WorkspaceSetupApi & WorkspaceIndexApi & WorkspaceFilesystemApi & WorkspaceInvocationApi;
  publishing: PublishingApi;
  notes: NotesGraphApi;
  terminals: TerminalsApi;
  shell: ShellApi;
}
