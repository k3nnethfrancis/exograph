import readline from "node:readline";
import path from "node:path";

import {
  filesystemSearchProvider,
  loadActiveWorkspaceSettings,
  listWorkspaceRegistryEntries,
  resolveWorkspaceModel,
  workspaceEnvOverrides,
  workspaceModelFromSettings,
  WORKSPACE_RUNTIME_DIRECTORY,
  type WorkspaceModel,
} from "@exograph/core";

import { AppClient } from "./app-client";
import { agentSearchResponse, boundedSearchLimit, parseSearchCursor } from "./search-response";
import { workspaceMatches } from "./workspace-match";

const MCP_PROTOCOL_VERSION = "2025-06-18";
const MAX_SEARCH_RESULTS = 20;

type JsonRecord = Record<string, unknown>;
type JsonRpcId = string | number | null;
type AppClientLike = Pick<AppClient, "getStatus" | "getIndexStatus" | "search">;

type WorkspaceScope =
  | {
      status: "resolved";
      source: "environment" | "caller-cwd" | "single-workspace-fallback";
      cwd: string;
      workspaceId: string | null;
      workspaceLabel: string | null;
      model: WorkspaceModel;
    }
  | { status: "unresolved" | "ambiguous"; cwd: string; candidateCount: number };

/**
 * Read-only MCP adapter for the active Exograph Workspace. The same command-server
 * client is used when the app is running; filesystem retrieval is the honest
 * app-off fallback. This is intentionally not a mutation or agent-launch API.
 */
export async function runExographMcpServer(options: {
  env?: NodeJS.ProcessEnv;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  error?: NodeJS.WritableStream;
  /** Test seam; production uses the authenticated desktop-app client. */
  connectApp?: (runtimeRoot: string, env: NodeJS.ProcessEnv) => Promise<AppClientLike | null>;
  /** The MCP child process's cwd; callers may override it only for tests. */
  cwd?: string;
} = {}): Promise<void> {
  const env = options.env ?? process.env;
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const error = options.error ?? process.stderr;
  const operations = await createOperations(env, options.cwd ?? process.cwd(), options.connectApp ?? AppClient.connect);
  const lines = readline.createInterface({ input, crlfDelay: Infinity });

  for await (const line of lines) {
    if (!line.trim()) continue;
    try {
      const request = JSON.parse(line) as JsonRecord;
      const response = await handleRequest(request, operations);
      if (response) output.write(`${JSON.stringify(response)}\n`);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      error.write(`[exograph mcp] ${message}\n`);
      output.write(`${JSON.stringify(jsonRpcError(null, -32700, "Parse error"))}\n`);
    }
  }
}

interface ExographMcpOperations {
  status(): Promise<JsonRecord>;
  search(query: string, input: { limit: number; cursor?: string }): Promise<object>;
}

async function createOperations(
  env: NodeJS.ProcessEnv,
  cwd: string,
  connectApp: (runtimeRoot: string, env: NodeJS.ProcessEnv) => Promise<AppClientLike | null>,
): Promise<ExographMcpOperations> {
  async function currentOperations(): Promise<ExographMcpOperations> {
    const scope = await resolveWorkspaceScope(env, cwd);
    if (scope.status !== "resolved") {
      return {
        status: async () => workspaceStatus(scope, false, null),
        search: async () => {
          throw new Error(scopeError(scope));
        },
      };
    }

    const { model } = scope;
    const runtimeRoot = env.EXOGRAPH_RUNTIME_ROOT ?? path.join(model.workspaceRoot, WORKSPACE_RUNTIME_DIRECTORY);
    const client = await connectApp(runtimeRoot, env).catch(() => null);
    if (client && (await clientMatchesWorkspace(client, model))) {
      return {
        status: async () => workspaceStatus(scope, true, await client.getIndexStatus()),
        search: async (query, input) => {
          const offset = parseSearchCursor(input.cursor, query);
          const response = await client.search(query, { limit: input.limit, offset });
          return agentSearchResponse(model, response, { limit: input.limit, offset });
        },
      };
    }
    return {
      status: async () => filesystemStatus(scope, model, runtimeRoot),
      search: async (query, input) => {
        const offset = parseSearchCursor(input.cursor, query);
        return filesystemSearch(model, runtimeRoot, query, input.limit, offset);
      },
    };
  }

  return {
    status: async () => (await currentOperations()).status(),
    search: async (query, input) => (await currentOperations()).search(query, input),
  };
}

async function filesystemStatus(scope: Extract<WorkspaceScope, { status: "resolved" }>, model: WorkspaceModel, runtimeRoot: string): Promise<JsonRecord> {
  return workspaceStatus(scope, false, await filesystemSearchProvider.getStatus(model, runtimeRoot));
}

async function filesystemSearch(
  model: WorkspaceModel,
  runtimeRoot: string,
  query: string,
  limit: number,
  offset: number,
): Promise<object> {
  const response = await filesystemSearchProvider.search(model, runtimeRoot, query, { limit, offset });
  return agentSearchResponse(model, response, { limit, offset });
}

async function clientMatchesWorkspace(client: AppClientLike, model: WorkspaceModel): Promise<boolean> {
  try {
    return workspaceMatches(model, (await client.getStatus()).workspace);
  } catch {
    return false;
  }
}

function workspaceStatus(scope: WorkspaceScope, appAvailable: boolean, search: unknown): JsonRecord {
  if (scope.status !== "resolved") {
    return {
      ok: true,
      app: { available: false },
      workspace: { status: scope.status, callerCwd: scope.cwd, candidateCount: scope.candidateCount },
      search,
    };
  }
  const { model } = scope;
  return {
    ok: true,
    app: { available: appAvailable },
    workspace: {
      status: "resolved",
      resolution: scope.source,
      callerCwd: scope.cwd,
      id: scope.workspaceId,
      label: scope.workspaceLabel,
      root: model.workspaceRoot,
      noteRoots: model.noteRoots.map((root) => ({ id: root.id, label: root.label, path: root.path })),
      indexing: model.indexing,
    },
    search,
  };
}

async function resolveWorkspaceScope(env: NodeJS.ProcessEnv, cwd: string): Promise<WorkspaceScope> {
  const resolvedCwd = path.resolve(cwd);
  if (workspaceEnvOverrides(env)) {
    return {
      status: "resolved",
      source: "environment",
      cwd: resolvedCwd,
      workspaceId: null,
      workspaceLabel: null,
      model: resolveWorkspaceModel(env),
    };
  }
  const activeSettings = await loadActiveWorkspaceSettings(env);
  const workspaces = await listWorkspaceRegistryEntries(env, activeSettings);
  const matches = workspaces.filter((workspace) =>
    workspace.settings.noteRoots.some((root) => isWithin(root, resolvedCwd)),
  );
  if (matches.length === 1) {
    const workspace = matches[0];
    return {
      status: "resolved",
      source: "caller-cwd",
      cwd: resolvedCwd,
      workspaceId: workspace.id,
      workspaceLabel: workspace.label,
      model: workspaceModelFromSettings(workspace.settings),
    };
  }
  if (matches.length > 1) return { status: "ambiguous", cwd: resolvedCwd, candidateCount: matches.length };
  if (workspaces.length === 1) {
    const workspace = workspaces[0];
    return {
      status: "resolved",
      source: "single-workspace-fallback",
      cwd: resolvedCwd,
      workspaceId: workspace.id,
      workspaceLabel: workspace.label,
      model: workspaceModelFromSettings(workspace.settings),
    };
  }
  return { status: "unresolved", cwd: resolvedCwd, candidateCount: workspaces.length };
}

function isWithin(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), target);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function scopeError(scope: Extract<WorkspaceScope, { status: "unresolved" | "ambiguous" }>): string {
  return scope.status === "ambiguous"
    ? `Caller cwd matches ${scope.candidateCount} Exograph Workspaces; search is refused until the scope is unambiguous.`
    : `No Exograph Workspace matches caller cwd (${scope.cwd}); search is refused.`;
}

async function handleRequest(request: JsonRecord, operations: ExographMcpOperations): Promise<JsonRecord | null> {
  const method = typeof request.method === "string" ? request.method : "";
  const id = isJsonRpcId(request.id) ? request.id : null;
  if (!method) return jsonRpcError(id, -32600, "Invalid request");
  if (request.id === undefined) return null;

  if (method === "initialize") {
    return jsonRpcResult(id, {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "exograph", version: "0.1.0-alpha.3" },
      instructions: "Use Exograph to orient within the current Markdown workspace. Search returns paths, metadata, and an optional next_cursor; use returned paths with your native file tools only when your own permissions allow it. Exograph MCP tools do not read or write notes.",
    });
  }
  if (method === "ping") return jsonRpcResult(id, {});
  if (method === "tools/list") return jsonRpcResult(id, { tools: toolDefinitions() });
  if (method === "tools/call") return jsonRpcResult(id, await callTool(request.params, operations));
  return jsonRpcError(id, -32601, `Method not found: ${method}`);
}

function toolDefinitions(): JsonRecord[] {
  return [
    {
      name: "workspace_status",
      description: "Describe the current Exograph workspace: its roots and indexing configuration, application availability, and retrieval health.",
      inputSchema: { type: "object", additionalProperties: false, properties: {} },
    },
    {
      name: "search_notes",
      description: "Search the current Exograph workspace. Returns one bounded, ranked page of note metadata and an optional next_cursor. Read returned paths with native file tools when permitted; Exograph does not read or write notes through MCP.",
      inputSchema: {
        type: "object", additionalProperties: false,
        properties: { query: { type: "string", minLength: 1 }, limit: { type: "integer", minimum: 1, maximum: MAX_SEARCH_RESULTS }, cursor: { type: "string", minLength: 1 } },
        required: ["query"],
      },
    },
  ];
}

async function callTool(rawParams: unknown, operations: ExographMcpOperations): Promise<JsonRecord> {
  const params = isRecord(rawParams) ? rawParams : {};
  const name = typeof params.name === "string" ? params.name : "";
  const args = isRecord(params.arguments) ? params.arguments : {};
  try {
    if (name === "workspace_status") return toolResult(await operations.status());
    if (name === "search_notes") {
      const query = requiredString(args.query, "query");
      return toolResult(await operations.search(query, {
        limit: boundedSearchLimit(boundedInteger(args.limit, 10, 1, MAX_SEARCH_RESULTS)),
        ...(typeof args.cursor === "string" ? { cursor: args.cursor } : {}),
      }));
    }
    return toolError(`Unknown Exograph tool: ${name || "(missing name)"}`);
  } catch (cause) {
    return toolError(cause instanceof Error ? cause.message : String(cause));
  }
}

function toolResult(value: unknown): JsonRecord {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function toolError(message: string): JsonRecord {
  return { content: [{ type: "text", text: message }], isError: true };
}

function jsonRpcResult(id: JsonRpcId, result: JsonRecord): JsonRecord {
  return { jsonrpc: "2.0", id, result };
}

function jsonRpcError(id: JsonRpcId, code: number, message: string): JsonRecord {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function isJsonRpcId(value: unknown): value is JsonRpcId {
  return value === null || typeof value === "string" || typeof value === "number";
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required.`);
  return value.trim();
}

function boundedInteger(value: unknown, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined) return fallback;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) throw new Error(`Expected an integer from ${minimum} to ${maximum}.`);
  return parsed;
}
