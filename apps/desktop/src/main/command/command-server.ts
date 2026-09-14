import { parseGraphTraversalRequest, type GraphTraversalRequest, type GraphTraversalResult } from "@exograph/core";
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdir } from "node:fs/promises";

import {
  EXOGRAPH_COMMAND_ROUTES,
  EXOGRAPH_COMMAND_TOKEN_HEADER,
  type ExographCommandBasicErrorResponse,
  type ExographCommandOkResponse,
  type ExographCommandTerminalCreateResponse,
  type ExographCommandTerminalInfo,
  type ExographCommandTerminalListResponse,
  type ExographCommandTerminalReadResponse,
  type ExographCommandTerminalWriteResponse,
  type ExographCommandServerInfo,
  type ExographCommandStatusResponse,
  type ExographSpawnAgentCommandResponse,
  type ExographSpawnAgentCommandErrorResponse,
  type IndexSearchResponse,
  type IndexSyncResult,
  type IndexStatus,
} from "@exograph/core";

import { InvocationRunnerError, type InvocationResult } from "../invocation/invocation-runner";

export interface CommandServerOptions {
  runtimeRoot: string;
  onGraphTraverse?: (request: GraphTraversalRequest) => Promise<GraphTraversalResult>;
  onShowWindow: () => void;
  onOpenPath: (filePath: string) => Promise<void>;
  onIndexSearch: (query: string, options: { limit?: number; offset?: number; intent?: string; includeContent?: boolean; maxLinesPerResult?: number }) => Promise<IndexSearchResponse>;
  onIndexStatus: () => Promise<IndexStatus>;
  onIndexSync: () => Promise<IndexSyncResult>;
  onGetStatus: () => ExographCommandStatusResponse;
  onSpawnAgentCommand: (input: { handle: string; task: string }) => Promise<InvocationResult>;
  onListTerminals: () => ExographCommandTerminalInfo[];
  onCreateTerminal: () => Promise<ExographCommandTerminalInfo>;
  onWriteTerminal: (input: { id: string; data: string }) => Promise<{ terminal: ExographCommandTerminalInfo | null; writeId?: number }>;
  onReadTerminal: (input: { id: string; cursor?: number }) => Promise<ExographCommandTerminalReadResponse | null>;
  onStopTerminal: (id: string) => Promise<boolean>;
}

export class CommandServer {
  private server: Server | null = null;
  private port = 0;
  private readonly token = randomBytes(32).toString("base64url");

  constructor(private options: CommandServerOptions) {
  }

  async start(): Promise<number> {
    await mkdir(this.options.runtimeRoot, { recursive: true });

    this.server = createServer((req, res) => this.handleRequest(req, res));

    return new Promise((resolve, reject) => {
      this.server!.listen(0, "127.0.0.1", () => {
        const address = this.server!.address();
        if (typeof address === "object" && address) {
          this.port = address.port;
          resolve(this.port);
        } else {
          reject(new Error("Failed to get server address"));
        }
      });

      this.server!.on("error", reject);
    });
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.port = 0;
    if (!server || !server.listening) {
      return;
    }
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }

  isListening(): boolean {
    return Boolean(this.server?.listening && this.port > 0);
  }

  getPort(): number | null {
    return this.isListening() ? this.port : null;
  }

  getServerInfo(): ExographCommandServerInfo {
    if (!this.isListening()) {
      throw new Error("Command server is not listening.");
    }
    return { port: this.port, pid: process.pid, token: this.token };
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${this.port}`);
    const pathname = url.pathname;
    const method = req.method ?? "GET";

    try {
      if (!isLoopbackRemote(req.socket.remoteAddress)) {
        json(res, { error: "Command server only accepts loopback requests." } satisfies ExographCommandBasicErrorResponse, 403);
        return;
      }

      if (!this.isAuthenticated(req)) {
        json(res, { error: "Missing or invalid Exograph command token." } satisfies ExographCommandBasicErrorResponse, 401);
        return;
      }

      if (method === "GET" && pathname === EXOGRAPH_COMMAND_ROUTES.status) {
        json(res, this.options.onGetStatus());
        return;
      }

      if (method === "POST" && pathname === EXOGRAPH_COMMAND_ROUTES.show) {
        this.options.onShowWindow();
        json(res, { ok: true } satisfies ExographCommandOkResponse);
        return;
      }

      if (method === "POST" && pathname === EXOGRAPH_COMMAND_ROUTES.graphTraverse) {
        const body = await readBody(req);
        let request: GraphTraversalRequest;
        try { request = parseGraphTraversalRequest(body); }
        catch (error) { throw new CommandServerHttpError(400, error instanceof Error ? error.message : String(error)); }
        if (request.workspaceRoot !== this.options.onGetStatus().workspace.workspaceRoot) throw new CommandServerHttpError(409, "Traversal Workspace does not match the active Workspace.");
        if (!this.options.onGraphTraverse) throw new CommandServerHttpError(503, "Graph traversal is unavailable in this runtime.");
        json(res, await this.options.onGraphTraverse(request));
        return;
      }

      if (method === "GET" && pathname === EXOGRAPH_COMMAND_ROUTES.search) {
        const query = url.searchParams.get("q") ?? "";
        if (!query) {
          json(res, { error: "Missing query parameter ?q=" } satisfies ExographCommandBasicErrorResponse, 400);
          return;
        }
        const limit = parseOptionalNumber(url.searchParams.get("limit"));
        const offset = parseOptionalNumber(url.searchParams.get("offset"));
        const results = await this.options.onIndexSearch(query, {
          limit,
          offset,
          intent: url.searchParams.get("intent") ?? undefined,
          includeContent: url.searchParams.get("includeContent") === "1",
          maxLinesPerResult: parseOptionalNumber(url.searchParams.get("maxLinesPerResult")),
        });
        json(res, results);
        return;
      }

      if (method === "GET" && pathname === EXOGRAPH_COMMAND_ROUTES.indexStatus) {
        json(res, await this.options.onIndexStatus());
        return;
      }

      if (method === "POST" && pathname === EXOGRAPH_COMMAND_ROUTES.indexSync) {
        json(res, await this.options.onIndexSync());
        return;
      }

      if (method === "POST" && pathname === EXOGRAPH_COMMAND_ROUTES.open) {
        const body = await readBody(req);
        const filePath = isRecord(body) && typeof body.path === "string" ? body.path : undefined;
        if (!filePath) {
          json(res, { error: "Missing path in body" } satisfies ExographCommandBasicErrorResponse, 400);
          return;
        }
        try {
          await this.options.onOpenPath(filePath);
        } catch (error) {
          json(res, { error: error instanceof Error ? error.message : String(error) } satisfies ExographCommandBasicErrorResponse, 400);
          return;
        }
        json(res, { ok: true } satisfies ExographCommandOkResponse);
        return;
      }

      if (method === "POST" && pathname === EXOGRAPH_COMMAND_ROUTES.spawnAgentCommand) {
        const body = await readBody(req);
        const handle = isRecord(body) && typeof body.handle === "string" ? body.handle : undefined;
        const task = isRecord(body) && typeof body.task === "string" ? body.task : undefined;
        if (!handle || !task) {
          json(
            res,
            { ok: false, code: "missing-agent-command-spawn-input", error: "Missing handle or task in body." } satisfies ExographSpawnAgentCommandErrorResponse,
            400,
          );
          return;
        }
        try {
          const result = await this.options.onSpawnAgentCommand({ handle, task });
          if (!result.terminal) {
            throw new Error("CLI agent invocation did not create a terminal session.");
          }
          json(res, {
            ok: true,
            invocation: {
              id: result.invocation.id,
              status: result.invocation.status,
              handle: result.invocation.command.handle,
              createdAt: result.invocation.createdAt,
            },
            terminal: {
              id: result.terminal.id,
              title: result.terminal.title,
              cwd: result.terminal.cwd,
              kind: result.terminal.kind,
              ...(result.terminal.command ? { command: result.terminal.command } : {}),
              status: result.terminal.status,
              ...(result.terminal.exitCode === undefined ? {} : { exitCode: result.terminal.exitCode }),
            },
          } satisfies ExographSpawnAgentCommandResponse);
        } catch (error) {
          if (error instanceof InvocationRunnerError) {
            json(
              res,
              { ok: false, code: error.code, error: error.message, ...error.details } satisfies ExographSpawnAgentCommandErrorResponse,
              error.code === "agent-command-untrusted" ? 403 : 400,
            );
            return;
          }
          throw error;
        }
        return;
      }

      if (method === "GET" && pathname === EXOGRAPH_COMMAND_ROUTES.terminals) {
        json(res, { terminals: this.options.onListTerminals() } satisfies ExographCommandTerminalListResponse);
        return;
      }

      if (method === "POST" && pathname === EXOGRAPH_COMMAND_ROUTES.terminals) {
        json(res, { terminal: await this.options.onCreateTerminal() } satisfies ExographCommandTerminalCreateResponse);
        return;
      }

      const terminalMatch = pathname.match(/^\/terminals\/([^/]+)\/(read|write|stop)$/);
      if (terminalMatch && method === "POST") {
        const [, id, action] = terminalMatch;
        if (!id || !action) throw new CommandServerHttpError(400, "Missing terminal id or action.");
        const body = await readBody(req);
        if (action === "read") {
          const cursor = isRecord(body) && typeof body.cursor === "number" && Number.isSafeInteger(body.cursor) && body.cursor >= 0
            ? body.cursor
            : undefined;
          const result = await this.options.onReadTerminal({ id, cursor });
          if (!result) throw new CommandServerHttpError(404, "Terminal was not found.");
          json(res, result);
          return;
        }
        if (action === "write") {
          const input = isRecord(body) && typeof body.input === "string" ? body.input : undefined;
          if (input === undefined) throw new CommandServerHttpError(400, "Missing input in body.");
          const result = await this.options.onWriteTerminal({ id, data: input });
          if (!result.terminal || result.writeId === undefined) throw new CommandServerHttpError(404, "Terminal was not found or cannot receive input.");
          json(res, { ok: true, terminal: result.terminal, writeId: result.writeId } satisfies ExographCommandTerminalWriteResponse);
          return;
        }
        const stopped = await this.options.onStopTerminal(id);
        if (!stopped) throw new CommandServerHttpError(404, "Terminal was not found.");
        json(res, { ok: true } satisfies ExographCommandOkResponse);
        return;
      }

      json(res, { error: "Not found" } satisfies ExographCommandBasicErrorResponse, 404);
    } catch (error) {
      const status = error instanceof CommandServerHttpError ? error.status : 500;
      json(res, { error: error instanceof Error ? error.message : String(error) } satisfies ExographCommandBasicErrorResponse, status);
    }
  }

  private isAuthenticated(req: IncomingMessage): boolean {
    const headerToken = req.headers[EXOGRAPH_COMMAND_TOKEN_HEADER];
    if (typeof headerToken === "string" && headerToken === this.token) {
      return true;
    }

    const authHeader = req.headers.authorization;
    if (typeof authHeader === "string" && authHeader === `Bearer ${this.token}`) {
      return true;
    }

    return false;
  }
}

function parseOptionalNumber(value: string | null): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function json(res: ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const contentType = String(req.headers["content-type"] ?? "");
    if (contentType && !contentType.toLowerCase().includes("application/json")) {
      reject(new CommandServerHttpError(415, "Command server request body must be application/json."));
      return;
    }

    const chunks: Buffer[] = [];
    let byteLength = 0;
    req.on("data", (chunk: Buffer) => {
      byteLength += chunk.byteLength;
      if (byteLength > MAX_COMMAND_SERVER_BODY_BYTES) {
        reject(new CommandServerHttpError(413, "Command server request body is too large."));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        const text = Buffer.concat(chunks).toString("utf-8");
        resolve(text ? JSON.parse(text) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

const MAX_COMMAND_SERVER_BODY_BYTES = 1_000_000;

class CommandServerHttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function isLoopbackRemote(remoteAddress: string | undefined): boolean {
  return !remoteAddress || remoteAddress === "127.0.0.1" || remoteAddress === "::1" || remoteAddress === "::ffff:127.0.0.1";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
