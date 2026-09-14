import type { IndexSearchResponse, IndexStatus, IndexSyncResult, WorkspaceModel } from "./types";

export const EXOGRAPH_COMMAND_ROUTES = {
  status: "/status",
  graphTraverse: "/graph/traverse",
  show: "/show",
  search: "/search",
  indexStatus: "/index/status",
  indexSync: "/index/sync",
  open: "/open",
  spawnAgentCommand: "/agent-commands/spawn",
  terminals: "/terminals",
} as const;

export const EXOGRAPH_COMMAND_TOKEN_HEADER = "x-exograph-command-token";

export interface ExographCommandServerInfo {
  port: number;
  pid: number;
  token: string;
}

/** The successful `/status` body emitted by the desktop command server. */
export interface ExographCommandStatusResponse {
  workspace: WorkspaceModel;
  terminals: ExographCommandStatusTerminalInfo[];
}

/** Discovery facts added locally by the CLI after a successful `/status` response. */
export interface ExographCommandStatusControlPlane {
  runtimeRoot: string;
  serverJsonPath: string;
  pid: number;
  port: number;
  baseUrl: string;
}

export interface ExographCommandStatusWithControlPlane extends ExographCommandStatusResponse {
  controlPlane: ExographCommandStatusControlPlane;
}

/** The full terminal representation currently returned by `/status`. */
export interface ExographCommandStatusTerminalInfo extends ExographCommandTerminalInfo {
  command: string;
  kind: "shell";
  status: "running" | "exited";
  attachGeneration: number;
  health?: "healthy" | "idle" | "unhealthy" | "exited";
  healthDetail?: string;
  geometry?: {
    cols: number;
    rows: number;
    reportedAt: string;
    source: "renderer-fit" | "initial-default";
  };
}

export interface ExographCommandTerminalInfo {
  id: string;
  title: string;
  cwd: string;
  kind: string;
  command?: string;
  status: string;
  exitCode?: number;
}

export interface ExographCommandOkResponse {
  ok: true;
}

/** A bounded, opaque cursor over the live in-memory terminal tail. */
export interface ExographCommandTerminalReadResponse {
  terminal: ExographCommandTerminalInfo;
  output: string;
  /** Pass this value back to request output produced after this read. */
  cursor: number;
  /** True when the requested cursor predates the retained live tail. */
  truncated: boolean;
}

export interface ExographCommandTerminalWriteResponse extends ExographCommandOkResponse {
  terminal: ExographCommandTerminalInfo;
  writeId: number;
}

export interface ExographCommandTerminalCreateResponse {
  terminal: ExographCommandTerminalInfo;
}

export interface ExographCommandTerminalListResponse {
  terminals: ExographCommandTerminalInfo[];
}

export type ExographCommandShowRequest = Record<string, never>;
export type ExographCommandIndexSyncRequest = Record<string, never>;

export interface ExographCommandSearchRequest {
  q: string;
  limit?: number;
  offset?: number;
  intent?: string;
  includeContent?: boolean;
  maxLinesPerResult?: number;
}

export type ExographCommandSearchResponse = IndexSearchResponse;
export type ExographCommandIndexStatusResponse = IndexStatus;
export type ExographCommandIndexSyncResponse = IndexSyncResult;

export interface ExographOpenFileRequest {
  path: string;
}

export interface ExographSpawnAgentCommandRequest {
  handle: string;
  task: string;
}

export interface ExographCommandTerminalWriteRequest {
  input: string;
}

export interface ExographSpawnAgentCommandResponse {
  ok: true;
  invocation: {
    id: string;
    status: string;
    handle: string;
    createdAt: string;
  };
  terminal: ExographCommandTerminalInfo;
}

/** The error envelope shared by routes that report only a human-readable failure. */
export interface ExographCommandBasicErrorResponse {
  error: string;
}

/** The structured failure envelope emitted only by `/agent-commands/spawn`. */
export interface ExographSpawnAgentCommandErrorResponse {
  ok: false;
  code: string;
  error: string;
  [key: string]: unknown;
}

export type { GraphTraversalRequest as ExographCommandGraphTraverseRequest, GraphTraversalResult as ExographCommandGraphTraverseResponse } from "./graph-traversal";
