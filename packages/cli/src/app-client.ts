import type { GraphTraversalRequest, GraphTraversalResult } from "@exograph/core";
import { readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";

import {
  EXOGRAPH_COMMAND_ROUTES,
  EXOGRAPH_COMMAND_TOKEN_HEADER,
  type ExographCommandIndexStatusResponse,
  type ExographCommandIndexSyncResponse,
  type ExographCommandIndexSyncRequest,
  type ExographCommandOkResponse,
  type ExographCommandTerminalCreateResponse,
  type ExographCommandTerminalListResponse,
  type ExographCommandTerminalReadResponse,
  type ExographCommandTerminalWriteRequest,
  type ExographCommandTerminalWriteResponse,
  type ExographCommandSearchRequest,
  type ExographCommandSearchResponse,
  type ExographCommandServerInfo,
  type ExographCommandStatusResponse,
  type ExographCommandStatusTerminalInfo,
  type ExographCommandStatusWithControlPlane,
  type ExographCommandTerminalInfo,
  type ExographCommandShowRequest,
  type ExographOpenFileRequest,
  type ExographSpawnAgentCommandRequest,
  type ExographSpawnAgentCommandResponse,
  type IndexedRoot,
  type IndexSearchResponse,
  type IndexStatus,
  type IndexSyncResult,
  type WorkspaceModel,
} from "@exograph/core";

const defaultRequestTimeoutMs = 2_000;
const defaultSearchRequestTimeoutMs = 30_000;
const defaultMaintenanceRequestTimeoutMs = 30 * 60_000;

export type AppClientDiscoveryFailureCode =
  | "runtime-root-missing"
  | "server-json-missing"
  | "server-json-invalid"
  | "server-stale"
  | "server-unreachable"
  | "server-liveness-unknown";

export interface AppClientDiscoveryMetadata {
  runtimeRoot: string;
  serverJsonPath: string;
  port?: number;
  pid?: number;
}

export interface AppClientDiscoveryFailure extends AppClientDiscoveryMetadata {
  code: AppClientDiscoveryFailureCode;
  message: string;
  causeMessage?: string;
  processCheck?: AppClientProcessCheckDiagnostic;
}

export interface AppClientProcessCheckDiagnostic {
  status: "alive" | "dead" | "blocked" | "unknown";
  code?: string;
  message?: string;
}

type ConnectedAppClientDiscovery = AppClientDiscoveryMetadata & { port: number; pid: number };

export type AppClientConnectResult =
  | {
    ok: true;
    client: AppClient;
    discovery: AppClientDiscoveryMetadata;
    status: ExographCommandStatusWithControlPlane;
  }
  | { ok: false; failure: AppClientDiscoveryFailure };

/**
 * HTTP client for communicating with the Exograph desktop app's command server.
 * Discovers the server port from .exograph/server.json.
 */
export class AppClient {
  private constructor(
    private baseUrl: string,
    private readonly discovery: ConnectedAppClientDiscovery,
    private readonly token: string,
    private readonly requestTimeoutMs = defaultRequestTimeoutMs,
    private readonly searchRequestTimeoutMs = defaultSearchRequestTimeoutMs,
    private readonly maintenanceRequestTimeoutMs = defaultMaintenanceRequestTimeoutMs,
  ) {}

  /**
   * Attempt to connect to a running Exograph desktop app.
   * Returns null if the app isn't running or server.json doesn't exist.
   */
  static async connect(runtimeRoot: string, env: NodeJS.ProcessEnv = process.env): Promise<AppClient | null> {
    const result = await AppClient.connectDetailed(runtimeRoot, env);
    return result.ok ? result.client : null;
  }

  static async connectDetailed(runtimeRoot: string, env: NodeJS.ProcessEnv = process.env): Promise<AppClientConnectResult> {
    const serverJsonPath = path.join(runtimeRoot, "server.json");
    let info: ExographCommandServerInfo;

    try {
      const runtimeRootStat = await stat(runtimeRoot);
      if (!runtimeRootStat.isDirectory()) {
        return discoveryFailure("runtime-root-missing", runtimeRoot, serverJsonPath);
      }
    } catch (error) {
      return discoveryFailure("runtime-root-missing", runtimeRoot, serverJsonPath, error);
    }

    try {
      const raw = await readFile(serverJsonPath, "utf-8");
      info = JSON.parse(raw);
      if (!isValidServerInfo(info)) {
        return discoveryFailure("server-json-invalid", runtimeRoot, serverJsonPath);
      }
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return discoveryFailure("server-json-missing", runtimeRoot, serverJsonPath, error);
      }
      return discoveryFailure("server-json-invalid", runtimeRoot, serverJsonPath, error);
    }

    const baseUrl = `http://127.0.0.1:${info.port}`;
    const requestTimeoutMs = parsePositiveInt(env.EXOGRAPH_APP_CLIENT_REQUEST_TIMEOUT_MS) ?? defaultRequestTimeoutMs;
    const searchRequestTimeoutMs = parsePositiveInt(env.EXOGRAPH_APP_CLIENT_SEARCH_TIMEOUT_MS) ?? defaultSearchRequestTimeoutMs;
    const maintenanceRequestTimeoutMs =
      parsePositiveInt(env.EXOGRAPH_APP_CLIENT_MAINTENANCE_TIMEOUT_MS) ?? defaultMaintenanceRequestTimeoutMs;
    const discovery: ConnectedAppClientDiscovery = { runtimeRoot, serverJsonPath, port: info.port, pid: info.pid };
    const client = new AppClient(baseUrl, discovery, info.token, requestTimeoutMs, searchRequestTimeoutMs, maintenanceRequestTimeoutMs);

    const initialProcessCheck = checkProcessLiveness(info.pid);
    if (initialProcessCheck.status === "dead") {
      await quarantineStaleDiscoveryFile(serverJsonPath);
      return discoveryFailure("server-stale", runtimeRoot, serverJsonPath, undefined, info, initialProcessCheck);
    }

    // Health check
    try {
      const status = await client.getStatus();
      return { ok: true, client, discovery, status };
    } catch (error) {
      const postFetchProcessCheck = checkProcessLiveness(info.pid);
      if (postFetchProcessCheck.status === "dead") {
        await quarantineStaleDiscoveryFile(serverJsonPath);
        return discoveryFailure("server-stale", runtimeRoot, serverJsonPath, error, info, postFetchProcessCheck);
      }
      if (postFetchProcessCheck.status === "blocked" || postFetchProcessCheck.status === "unknown") {
        return discoveryFailure("server-liveness-unknown", runtimeRoot, serverJsonPath, error, info, postFetchProcessCheck);
      }
      return discoveryFailure("server-unreachable", runtimeRoot, serverJsonPath, error, info, postFetchProcessCheck);
    }
  }

  async getStatus(): Promise<ExographCommandStatusWithControlPlane> {
    const status = await this.get(EXOGRAPH_COMMAND_ROUTES.status, decodeExographCommandStatusResponse);
    return {
      ...status,
      controlPlane: {
        runtimeRoot: this.discovery.runtimeRoot,
        serverJsonPath: this.discovery.serverJsonPath,
        pid: this.discovery.pid,
        port: this.discovery.port,
        baseUrl: this.baseUrl,
      },
    };
  }

  async openFile(filePath: string): Promise<void> {
    const request: ExographOpenFileRequest = { path: filePath };
    await this.post(EXOGRAPH_COMMAND_ROUTES.open, request, decodeExographCommandOkResponse);
  }

  async showWindow(): Promise<void> {
    const request: ExographCommandShowRequest = {};
    await this.post(EXOGRAPH_COMMAND_ROUTES.show, request, decodeExographCommandOkResponse);
  }

  async search(query: string, options: { limit?: number; offset?: number } = {}): Promise<ExographCommandSearchResponse> {
    const request: ExographCommandSearchRequest = { q: query, ...options };
    const params = new URLSearchParams({ q: request.q });
    if (request.limit) params.set("limit", String(request.limit));
    if (request.offset) params.set("offset", String(request.offset));
    return this.get(`${EXOGRAPH_COMMAND_ROUTES.search}?${params.toString()}`, decodeExographIndexSearchResponse, this.searchRequestTimeoutMs);
  }

  async traverseGraph(request: GraphTraversalRequest): Promise<GraphTraversalResult> {
    const result = await this.post(EXOGRAPH_COMMAND_ROUTES.graphTraverse, request, decodeGraphTraversalResponse, this.searchRequestTimeoutMs);
    if (result.workspace.root !== request.workspaceRoot) throw protocolShapeError("a traversal for the requested Workspace");
    if (result.status === "ok") {
      const query = result.request;
      if ((request.start !== undefined && query.start !== request.start) || query.direction !== (request.direction ?? "both") || query.maxDepth !== (request.maxDepth ?? 1) || query.maxResults !== (request.maxResults ?? 100) || query.limit !== (request.limit ?? 25) || query.predicate !== request.predicate) throw protocolShapeError("a traversal for the requested query");
      if (request.startPath !== undefined && result.execution.returnedOffset === 0 && result.nodes[0]?.filePath !== request.startPath) throw protocolShapeError("a traversal for the requested start path");
    }
    return result;
  }

  async getIndexStatus(): Promise<ExographCommandIndexStatusResponse> {
    return this.get(EXOGRAPH_COMMAND_ROUTES.indexStatus, decodeExographIndexStatusResponse);
  }

  async syncIndex(): Promise<ExographCommandIndexSyncResponse> {
    const request: ExographCommandIndexSyncRequest = {};
    return this.post(EXOGRAPH_COMMAND_ROUTES.indexSync, request, decodeExographIndexSyncResponse, this.maintenanceRequestTimeoutMs);
  }

  async spawnAgentCommand(handle: string, task: string): Promise<ExographSpawnAgentCommandResponse> {
    const request: ExographSpawnAgentCommandRequest = { handle, task };
    return this.post(EXOGRAPH_COMMAND_ROUTES.spawnAgentCommand, request, decodeExographSpawnAgentCommandResponse, this.maintenanceRequestTimeoutMs);
  }

  async listTerminals(): Promise<ExographCommandTerminalListResponse> {
    return this.get(EXOGRAPH_COMMAND_ROUTES.terminals, decodeExographCommandTerminalListResponse);
  }

  async createTerminal(): Promise<ExographCommandTerminalCreateResponse> {
    return this.post(EXOGRAPH_COMMAND_ROUTES.terminals, {}, decodeExographCommandTerminalCreateResponse);
  }

  async writeTerminal(id: string, input: string): Promise<ExographCommandTerminalWriteResponse> {
    const request: ExographCommandTerminalWriteRequest = { input };
    return this.post(`${EXOGRAPH_COMMAND_ROUTES.terminals}/${encodeURIComponent(id)}/write`, request, decodeExographCommandTerminalWriteResponse);
  }

  async readTerminal(id: string, cursor?: number): Promise<ExographCommandTerminalReadResponse> {
    return this.post(
      `${EXOGRAPH_COMMAND_ROUTES.terminals}/${encodeURIComponent(id)}/read`,
      cursor === undefined ? {} : { cursor },
      decodeExographCommandTerminalReadResponse,
    );
  }

  async stopTerminal(id: string): Promise<void> {
    await this.post(`${EXOGRAPH_COMMAND_ROUTES.terminals}/${encodeURIComponent(id)}/stop`, {}, decodeExographCommandOkResponse);
  }

  private async get<T>(path: string, decode: (value: unknown) => T, timeoutMs = this.requestTimeoutMs): Promise<T> {
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        headers: this.authHeaders(),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
      return decodeSuccessfulResponse(await res.text(), "GET", path, decode);
    } catch (error) {
      throw enhanceTimeoutError(error, "GET", path, timeoutMs);
    }
  }

  private async post<T>(path: string, body: object, decode: (value: unknown) => T, timeoutMs = this.requestTimeoutMs): Promise<T> {
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: { ...this.authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
      return decodeSuccessfulResponse(await res.text(), "POST", path, decode);
    } catch (error) {
      throw enhanceTimeoutError(error, "POST", path, timeoutMs);
    }
  }

  private authHeaders(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.token}`,
      [EXOGRAPH_COMMAND_TOKEN_HEADER]: this.token,
    };
  }
}

function decodeExographCommandStatusResponse(value: unknown): ExographCommandStatusResponse {
  if (!isExographCommandStatusResponse(value)) {
    throw protocolShapeError("a valid status response");
  }
  return value;
}

function decodeExographCommandOkResponse(value: unknown): ExographCommandOkResponse {
  if (!isExographCommandOkResponse(value)) {
    throw protocolShapeError("an { ok: true } response");
  }
  return value;
}

function decodeExographIndexSearchResponse(value: unknown): IndexSearchResponse {
  if (!isIndexSearchResponse(value)) {
    throw protocolShapeError("a valid search response");
  }
  return value;
}

function decodeExographIndexStatusResponse(value: unknown): IndexStatus {
  if (!isIndexStatus(value)) {
    throw protocolShapeError("a valid index status response");
  }
  return value;
}

function decodeExographIndexSyncResponse(value: unknown): IndexSyncResult {
  if (!isIndexSyncResult(value)) {
    throw protocolShapeError("a valid index sync response");
  }
  return value;
}

function decodeExographSpawnAgentCommandResponse(value: unknown): ExographSpawnAgentCommandResponse {
  if (!isExographSpawnAgentCommandResponse(value)) {
    throw protocolShapeError("a valid agent command spawn response");
  }
  return value;
}

function decodeExographCommandTerminalListResponse(value: unknown): ExographCommandTerminalListResponse {
  if (!isRecord(value) || !Array.isArray(value.terminals) || !value.terminals.every(isCommandTerminal)) {
    throw protocolShapeError("a valid terminal list response");
  }
  return value as unknown as ExographCommandTerminalListResponse;
}

function decodeExographCommandTerminalCreateResponse(value: unknown): ExographCommandTerminalCreateResponse {
  if (!isRecord(value) || !isCommandTerminal(value.terminal)) {
    throw protocolShapeError("a valid terminal create response");
  }
  return value as unknown as ExographCommandTerminalCreateResponse;
}

function decodeExographCommandTerminalWriteResponse(value: unknown): ExographCommandTerminalWriteResponse {
  if (!isRecord(value) || value.ok !== true || !isCommandTerminal(value.terminal) || !Number.isSafeInteger(value.writeId)) {
    throw protocolShapeError("a valid terminal write response");
  }
  return value as unknown as ExographCommandTerminalWriteResponse;
}

function decodeExographCommandTerminalReadResponse(value: unknown): ExographCommandTerminalReadResponse {
  if (!isRecord(value) || !isCommandTerminal(value.terminal) || typeof value.output !== "string" || typeof value.cursor !== "number" || !Number.isSafeInteger(value.cursor) || value.cursor < 0 || typeof value.truncated !== "boolean") {
    throw protocolShapeError("a valid terminal read response");
  }
  return value as unknown as ExographCommandTerminalReadResponse;
}

function decodeSuccessfulResponse<T>(body: string, method: string, targetPath: string, decode: (value: unknown) => T): T {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    throw protocolError(method, targetPath, "successful response was not valid JSON");
  }
  try {
    return decode(value);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw protocolError(method, targetPath, detail.replace("Exograph command-server protocol error: ", ""));
  }
}

function protocolShapeError(expected: string): Error {
  return new Error(`Exograph command-server protocol error: expected ${expected}`);
}

function protocolError(method: string, targetPath: string, detail: string): Error {
  return new Error(`Exograph command-server protocol error for ${method} ${targetPath}: ${detail}.`);
}

function isExographCommandStatusResponse(value: unknown): value is ExographCommandStatusResponse {
  return isRecord(value) && isWorkspaceModel(value.workspace) && Array.isArray(value.terminals) && value.terminals.every(isCommandStatusTerminal);
}

function isExographCommandOkResponse(value: unknown): value is ExographCommandOkResponse {
  return isRecord(value) && value.ok === true;
}

function isIndexSearchResponse(value: unknown): value is IndexSearchResponse {
  return isRecord(value) && typeof value.query === "string" && isIndexMode(value.mode) && isIndexBackend(value.source) && isStringArray(value.warnings) && Array.isArray(value.results) && value.results.every(isIndexSearchResult) && (value.hasMore === undefined || typeof value.hasMore === "boolean") && (value.incomplete === undefined || isIndexSearchIncomplete(value.incomplete));
}

function isIndexSearchIncomplete(value: unknown): boolean {
  return isRecord(value)
    && value.reason === "authorization_refill_limit"
    && typeof value.requested === "number"
    && typeof value.returned === "number";
}

function isIndexSyncResult(value: unknown): value is IndexSyncResult {
  return isRecord(value) && isIndexStatus(value.status) && Array.isArray(value.phases) && value.phases.every(isIndexSyncPhase) && isStringArray(value.warnings);
}

function isExographSpawnAgentCommandResponse(value: unknown): value is ExographSpawnAgentCommandResponse {
  return isRecord(value) && value.ok === true && isRecord(value.invocation) && typeof value.invocation.id === "string" && typeof value.invocation.status === "string" && typeof value.invocation.handle === "string" && typeof value.invocation.createdAt === "string" && isCommandTerminal(value.terminal);
}

function isWorkspaceModel(value: unknown): value is WorkspaceModel {
  return isRecord(value) && typeof value.workspaceRoot === "string" && typeof value.defaultTerminalCwd === "string" && Array.isArray(value.noteRoots) && value.noteRoots.every(isNoteRoot) && Array.isArray(value.indexedRoots) && value.indexedRoots.every(isIndexedRoot) && isIndexingConfig(value.indexing) && (value.searchEngine === undefined || isIndexBackend(value.searchEngine));
}

function isNoteRoot(value: unknown): boolean {
  return isRecord(value) && typeof value.id === "string" && typeof value.label === "string" && typeof value.path === "string";
}

function isIndexedRoot(value: unknown): value is IndexedRoot {
  return isRecord(value) && typeof value.id === "string" && typeof value.label === "string" && typeof value.path === "string" && isIndexedRootKind(value.kind) && typeof value.pattern === "string" && isStringArray(value.ignore) && isIndexBackend(value.backend);
}

function isIndexingConfig(value: unknown): boolean {
  return isRecord(value) && typeof value.enabled === "boolean" && isIndexMode(value.mode) && isIndexBackend(value.backend);
}

function isCommandStatusTerminal(value: unknown): value is ExographCommandStatusTerminalInfo {
  return isRecord(value) && isCommandTerminal(value) && value.kind === "shell" && (value.status === "running" || value.status === "exited") && typeof value.command === "string" && typeof value.attachGeneration === "number" && (value.health === undefined || value.health === "healthy" || value.health === "idle" || value.health === "unhealthy" || value.health === "exited") && (value.healthDetail === undefined || typeof value.healthDetail === "string") && (value.geometry === undefined || isTerminalGeometry(value.geometry));
}

function isCommandTerminal(value: unknown): value is ExographCommandTerminalInfo {
  return isRecord(value) && typeof value.id === "string" && typeof value.title === "string" && typeof value.cwd === "string" && typeof value.kind === "string" && typeof value.status === "string" && (value.command === undefined || typeof value.command === "string") && (value.exitCode === undefined || typeof value.exitCode === "number");
}

function isTerminalGeometry(value: unknown): boolean {
  return isRecord(value) && typeof value.cols === "number" && typeof value.rows === "number" && typeof value.reportedAt === "string" && (value.source === "renderer-fit" || value.source === "initial-default");
}

function isIndexStatus(value: unknown): value is IndexStatus {
  return isRecord(value) && typeof value.enabled === "boolean" && isIndexMode(value.mode) && isIndexBackend(value.backend) && typeof value.dbPath === "string" && typeof value.runtimePath === "string" && Array.isArray(value.indexedRoots) && value.indexedRoots.every(isIndexedRoot) && typeof value.documentCount === "number" && typeof value.pendingEmbeddings === "number" && typeof value.hasVectorIndex === "boolean" && (typeof value.lastUpdated === "string" || value.lastUpdated === null) && isStringArray(value.warnings) && isStringArray(value.errors) && (value.recentJobs === undefined || (Array.isArray(value.recentJobs) && value.recentJobs.every(isIndexJobMetric)));
}

function isIndexJobMetric(value: unknown): boolean {
  return isRecord(value) && typeof value.id === "string" && (value.kind === "sync" || value.kind === "update" || value.kind === "embed") && typeof value.reason === "string" && (value.status === "completed" || value.status === "failed") && typeof value.startedAt === "string" && typeof value.completedAt === "string" && typeof value.durationMs === "number" && (value.documentCount === undefined || typeof value.documentCount === "number") && (value.pendingEmbeddings === undefined || typeof value.pendingEmbeddings === "number") && (value.warnings === undefined || isStringArray(value.warnings)) && (value.error === undefined || typeof value.error === "string");
}

function isIndexSearchResult(value: unknown): boolean {
  return isRecord(value) && typeof value.filePath === "string" && typeof value.title === "string" && typeof value.snippet === "string" && typeof value.score === "number" && (value.docid === undefined || typeof value.docid === "string") && isIndexBackend(value.source) && (value.content === undefined || typeof value.content === "string");
}

function isIndexSyncPhase(value: unknown): boolean {
  return isRecord(value) && (value.name === "update" || value.name === "embed") && (value.status === "completed" || value.status === "skipped" || value.status === "failed") && typeof value.message === "string";
}

function isIndexMode(value: unknown): value is IndexSearchResponse["mode"] {
  return value === "off" || value === "lexical" || value === "semantic" || value === "hybrid";
}

function isIndexBackend(value: unknown): value is IndexSearchResponse["source"] {
  return value === "filesystem" || value === "qmd";
}

function isIndexedRootKind(value: unknown): boolean {
  return value === "notes" || value === "docs" || value === "code" || value === "mixed";
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function parsePositiveInt(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function enhanceTimeoutError(error: unknown, method: string, targetPath: string, timeoutMs: number): Error {
  if (isAbortError(error)) {
    return new Error(`Exograph command server ${method} ${targetPath} timed out after ${timeoutMs}ms.`);
  }
  return error instanceof Error ? error : new Error(String(error));
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && (error.name === "AbortError" || error.name === "TimeoutError");
}

function isValidServerInfo(value: unknown): value is ExographCommandServerInfo {
  if (!isRecord(value)) {
    return false;
  }
  const port = value.port;
  const pid = value.pid;
  const token = value.token;
  return Number.isInteger(port) && Number(port) > 0 && Number.isInteger(pid) && Number(pid) > 0 && typeof token === "string" && token.length >= 32;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function discoveryFailure(
  code: AppClientDiscoveryFailureCode,
  runtimeRoot: string,
  serverJsonPath: string,
  cause?: unknown,
  info?: Partial<ExographCommandServerInfo>,
  processCheck?: AppClientProcessCheckDiagnostic,
): AppClientConnectResult {
  const causeMessage = cause instanceof Error ? cause.message : cause ? String(cause) : undefined;
  return {
    ok: false,
    failure: {
      code,
      runtimeRoot,
      serverJsonPath,
      port: info?.port,
      pid: info?.pid,
      message: discoveryFailureMessage(code, serverJsonPath, info),
      causeMessage,
      processCheck,
    },
  };
}

export function formatAppClientDiscoveryFailure(failure: AppClientDiscoveryFailure): string {
  const lines = [
    failure.message,
    `Runtime root: ${failure.runtimeRoot}`,
    `Discovery file: ${failure.serverJsonPath}`,
  ];
  if (failure.pid) lines.push(`Recorded pid: ${failure.pid}`);
  if (failure.port) lines.push(`Recorded port: ${failure.port}`);
  if (failure.causeMessage) lines.push(`Cause: ${failure.causeMessage}`);
  if (failure.processCheck) {
    const parts = [`Process check: ${failure.processCheck.status}`];
    if (failure.processCheck.code) parts.push(`code=${failure.processCheck.code}`);
    if (failure.processCheck.message) parts.push(`message=${failure.processCheck.message}`);
    lines.push(parts.join("; "));
  }
  return `${lines.join("\n")}\n`;
}

function discoveryFailureMessage(
  code: AppClientDiscoveryFailureCode,
  serverJsonPath: string,
  info?: Partial<ExographCommandServerInfo>,
): string {
  switch (code) {
    case "runtime-root-missing":
      return `Exograph runtime root is missing or is not a directory. Start Exograph with \`exo start\`, run \`exo status\` to confirm the active workspace, or set EXOGRAPH_RUNTIME_ROOT.`;
    case "server-json-missing":
      return `Exograph command server discovery file is missing. Start Exograph with \`exo start\`, or set EXOGRAPH_RUNTIME_ROOT to the runtime containing server.json.`;
    case "server-json-invalid":
      return `Exograph command server discovery file is invalid. Remove or regenerate ${serverJsonPath} by restarting Exograph.`;
    case "server-stale":
      return `Exograph command server discovery is stale. The recorded process${info?.pid ? ` (${info.pid})` : ""} is no longer running; restart Exograph with \`exo start\`.`;
    case "server-unreachable":
      return `Exograph command server is unreachable${info?.port ? ` at http://127.0.0.1:${info.port}` : ""}. Restart Exograph with \`exo start\` or check that EXOGRAPH_RUNTIME_ROOT points at the active runtime.`;
    case "server-liveness-unknown":
      return `Exograph command server is unreachable${info?.port ? ` at http://127.0.0.1:${info.port}` : ""}, and Exograph could not verify whether the recorded process${info?.pid ? ` (${info.pid})` : ""} is alive. The discovery file was preserved because the process check was blocked or inconclusive. Run \`exo start\`, then retry; if Exograph is already open, confirm EXOGRAPH_RUNTIME_ROOT points to its active Workspace.`;
  }
}

function checkProcessLiveness(pid: number): AppClientProcessCheckDiagnostic {
  try {
    process.kill(pid, 0);
    return { status: "alive" };
  } catch (error) {
    if (isNodeError(error)) {
      const message = error.message || String(error);
      if (error.code === "ESRCH") {
        return { status: "dead", code: error.code, message };
      }
      if (error.code === "EPERM") {
        return { status: "blocked", code: error.code, message };
      }
      return { status: "unknown", code: error.code, message };
    }
    return { status: "unknown", message: error instanceof Error ? error.message : String(error) };
  }
}

async function quarantineStaleDiscoveryFile(serverJsonPath: string): Promise<void> {
  const stalePath = `${serverJsonPath}.stale-${Date.now()}`;
  try {
    await rename(serverJsonPath, stalePath);
  } catch {
    await rm(serverJsonPath, { force: true }).catch(() => {});
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function decodeGraphTraversalResponse(value: unknown): GraphTraversalResult {
  const fail = () => { throw protocolShapeError("a valid graph traversal response"); };
  if (!isRecord(value) || value.schemaVersion !== "exograph.graph-traversal.v1" || typeof value.snapshotId !== "string" || !isRecord(value.workspace) || typeof value.workspace.root !== "string" || !isStringArray(value.workspace.noteRootIds)) return fail();
  if (value.status === "error") {
    if (!["scope-mismatch", "stale-cursor", "invalid-cursor", "missing-start", "invalid-graph", "too-large"].includes(typeof value.code === "string" ? value.code : "") || typeof value.message !== "string") return fail();
    return value as unknown as GraphTraversalResult;
  }
  if (value.status !== "ok" || !isRecord(value.request) || !optionalStrings(value.request, ["predicate"]) || typeof value.request.start !== "string" || !["outgoing", "incoming", "both"].includes(typeof value.request.direction === "string" ? value.request.direction : "") || !Number.isInteger(value.request.maxDepth) || Number(value.request.maxDepth) < 1 || Number(value.request.maxDepth) > 3 || !Number.isInteger(value.request.maxResults) || Number(value.request.maxResults) < 1 || Number(value.request.maxResults) > 100 || !Number.isInteger(value.request.limit) || Number(value.request.limit) < 1 || Number(value.request.limit) > 100) return fail();
  if (!Array.isArray(value.nodes) || value.nodes.length > Number(value.request.limit) || !value.nodes.every((node) => isRecord(node) && optionalStrings(node, ["noteId", "filePath", "rootId", "relativePath"]) && typeof node.id === "string" && typeof node.label === "string" && node.resolution === "resolved" && isStringArray(node.conceptTypes) && isStringArray(node.tags) && isRecord(node.properties))) return fail();
  if (!Array.isArray(value.edges) || value.edges.length > 1000 || !value.edges.every((edge) => isRecord(edge) && optionalStrings(edge, ["predicate", "label"]) && (edge.confidence === undefined || typeof edge.confidence === "number") && typeof edge.id === "string" && typeof edge.source === "string" && typeof edge.target === "string" && ["link", "property-reference", "tag-membership", "hierarchy", "semantic"].includes(typeof edge.family === "string" ? edge.family : "") && ["document", "ontology", "inferred"].includes(typeof edge.origin === "string" ? edge.origin : "") && edge.resolution === "resolved" && typeof edge.directed === "boolean" && Array.isArray(edge.evidence) && edge.evidence.every(isTraversalEvidence))) return fail();
  if (!Array.isArray(value.evidence) || !value.evidence.every((item) => isRecord(item) && optionalStrings(item, ["noteId", "rootId", "relativePath"]) && typeof item.id === "string" && typeof item.edgeId === "string" && Number.isInteger(item.index) && Number(item.index) >= 0 && isTraversalEvidence(item.evidence))) return fail();
  if (typeof value.traversalId !== "string" || !Array.isArray(value.events) || value.events.length > 1100 || !value.events.every((event, index) => isRecord(event) && optionalStrings(event, ["fromNodeId", "viaEdgeId"]) && event.seq === index && typeof event.nodeId === "string" && Number.isInteger(event.depth) && Number(event.depth) >= 0 && Number(event.depth) <= 3 && (event.type === "visit" || (event.type === "follow" && typeof event.fromNodeId === "string" && typeof event.edgeId === "string" && ["incoming", "outgoing"].includes(typeof event.direction === "string" ? event.direction : ""))))) return fail();
  if (!isRecord(value.execution) || value.execution.kind !== "deterministic-replay" || !Number.isInteger(value.execution.visitedCount) || Number(value.execution.visitedCount) < 1 || Number(value.execution.visitedCount) > Number(value.request.maxResults) || !Number.isInteger(value.execution.returnedOffset) || Number(value.execution.returnedOffset) < 0 || (value.nextCursor !== null && typeof value.nextCursor !== "string") || !isRecord(value.completion) || !["page-limit", "max-results", "edge-limit", "complete-within-depth"].includes(typeof value.completion.reason === "string" ? value.completion.reason : "") || typeof value.completion.truncated !== "boolean") return fail();
  const result = value as unknown as Extract<GraphTraversalResult, { status: "ok" }>;
  const visits = result.events.filter((event) => event.type === "visit");
  const offset = result.execution.returnedOffset;
  if (visits.length !== result.execution.visitedCount || visits[0]?.nodeId !== result.request.start || visits[0]?.depth !== 0 || offset >= visits.length || offset % result.request.limit !== 0 || result.nodes.length !== Math.min(result.request.limit, visits.length - offset) || result.nodes.some((node, index) => node.id !== visits[offset + index].nodeId) || (result.nextCursor !== null) !== (offset + result.nodes.length < visits.length)) return fail();
  if (new Set(visits.map((event) => event.nodeId)).size !== visits.length || new Set(result.edges.map((edge) => edge.id)).size !== result.edges.length) return fail();
  const edges = new Map(result.edges.map((edge) => [edge.id, edge]));
  for (const event of result.events) {
    if (event.type !== "follow") continue;
    const edge = edges.get(event.edgeId);
    if (!edge || (event.direction === "outgoing" ? edge.source !== event.fromNodeId || edge.target !== event.nodeId : edge.target !== event.fromNodeId || edge.source !== event.nodeId)) return fail();
  }
  return result;
}

function optionalStrings(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return keys.every((key) => value[key] === undefined || typeof value[key] === "string");
}

function isTraversalEvidence(value: unknown): boolean {
  if (!isRecord(value) || !["source-span", "property", "path", "ontology-rule", "model"].includes(typeof value.kind === "string" ? value.kind : "")) return false;
  if (value.noteId !== undefined && typeof value.noteId !== "string") return false;
  if (value.property !== undefined && typeof value.property !== "string") return false;
  if (value.sourceRange !== undefined && (!isRecord(value.sourceRange) || !Number.isInteger(value.sourceRange.from) || Number(value.sourceRange.from) < 0 || !Number.isInteger(value.sourceRange.to) || Number(value.sourceRange.to) < Number(value.sourceRange.from))) return false;
  if (value.producer !== undefined && (!isRecord(value.producer) || typeof value.producer.id !== "string" || typeof value.producer.version !== "string")) return false;
  return value.detail === undefined || typeof value.detail === "string";
}
