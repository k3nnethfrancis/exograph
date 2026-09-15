import { encodeBrowserGraph } from "../../shared/browser-graph-wire";
import { WorkspaceFiles } from "@exograph/core";
import { randomBytes } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { readFile, realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { BrowserApi } from "../../shared/browser-api";

interface Session {
  scope: string;
  expires: number;
}
interface Options {
  api: BrowserApi;
  scope: () => string;
  assets: string;
}
const lifetime = 12 * 60 * 60 * 1000;
const token = () => randomBytes(32).toString("base64url");
const types: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".woff2": "font/woff2",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".avif": "image/avif",
};

/** Same-origin, authenticated loopback transport over existing workspace owners. */
export class BrowserWorkspaceServer {
  private server: Server | null = null;
  private starting: Promise<void> | null = null;
  private origin = "";
  private readonly cookie = `exo_browser_${token().slice(0, 12)}`;
  private readonly tickets = new Map<string, Session>();
  private readonly sessions = new Map<string, Session>();
  private readonly streams = new Map<ServerResponse, Session>();
  private readonly images = new Map<
    string,
    { source: string; target: string; lookup: boolean; session: Session }
  >();
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  constructor(private readonly options: Options) {}

  async open(): Promise<{ url: string }> {
    if (!this.server) this.starting ??= this.start();
    await this.starting;
    this.prune();
    const key = token();
    this.tickets.set(key, {
      scope: this.options.scope(),
      expires: Date.now() + 5 * 60_000,
    });
    return { url: `${this.origin}/#token=${key}` };
  }

  changed(): void {
    this.prune();
    for (const [stream, session] of this.streams) {
      if (!this.valid(session)) {
        stream.write("event: expired\ndata: {}\n\n");
        stream.end();
        this.streams.delete(stream);
      } else stream.write("event: changed\ndata: {}\n\n");
    }
  }

  async stop(): Promise<void> {
    await this.starting;
    if (this.heartbeat) clearInterval(this.heartbeat);
    for (const stream of this.streams.keys()) stream.end();
    this.streams.clear();
    this.sessions.clear();
    this.tickets.clear();
    this.images.clear();
    const server = this.server;
    this.server = null;
    this.starting = null;
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  private async start(): Promise<void> {
    const server = createServer((req, res) => {
      void this.handle(req, res);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("Browser server did not bind a port.");
      this.origin = `http://127.0.0.1:${address.port}`;
      this.server = server;
      this.heartbeat = setInterval(() => {
        this.prune();
        for (const [stream, session] of this.streams) {
          if (!this.valid(session)) {
            stream.write("event: expired\ndata: {}\n\n");
            stream.end();
            this.streams.delete(stream);
          } else stream.write(": heartbeat\n\n");
        }
      }, 15_000);
      this.heartbeat.unref();
    } catch (error) {
      server.close();
      this.starting = null;
      throw error;
    }
  }
  private valid(session: Session | undefined): session is Session {
    return (
      !!session &&
      session.expires > Date.now() &&
      session.scope === this.options.scope()
    );
  }
  private prune(): void {
    for (const records of [this.sessions, this.tickets])
      for (const [key, session] of records)
        if (!this.valid(session)) records.delete(key);
    for (const [key, image] of this.images)
      if (!this.valid(image.session)) this.images.delete(key);
  }
  private async handle(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:; connect-src 'self'; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    );
    try {
      if (
        req.socket.remoteAddress !== "127.0.0.1" ||
        req.headers.host !== new URL(this.origin).host ||
        (req.headers.origin && req.headers.origin !== this.origin)
      )
        return json(res, 403, {
          error:
            "Browser workspace only accepts same-origin loopback requests.",
        });
      const url = new URL(req.url ?? "/", this.origin);
      if (req.method === "POST" && req.headers.origin !== this.origin)
        return json(res, 403, { error: "Same-origin request required." });
      if (req.method === "POST" && url.pathname === "/session") {
        const body = await bodyJson(req);
        const ticket = this.tickets.get(string(body.token));
        this.tickets.delete(body.token as string);
        if (!this.valid(ticket))
          return json(res, 401, {
            error: "This browser link expired. Run exo serve for a fresh link.",
          });
        const key = token();
        this.sessions.set(key, {
          scope: ticket.scope,
          expires: Date.now() + lifetime,
        });
        res.setHeader(
          "Set-Cookie",
          `${this.cookie}=${key}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${lifetime / 1000}`,
        );
        return json(res, 200, { ok: true });
      }
      const key = req.headers.cookie
        ?.split(";")
        .map((x) => x.trim())
        .find((x) => x.startsWith(`${this.cookie}=`))
        ?.slice(this.cookie.length + 1);
      const session = this.sessions.get(key ?? "");
      if (
        url.pathname.startsWith("/api/") ||
        url.pathname === "/events" ||
        url.pathname.startsWith("/image/")
      ) {
        if (!this.valid(session))
          return json(res, 401, {
            error: "Workspace connection expired. Run exo serve to reconnect.",
          });
        if (req.method === "GET" && url.pathname === "/events") {
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            Connection: "keep-alive",
          });
          res.write("event: changed\ndata: {}\n\n");
          this.streams.set(res, session);
          req.on("close", () => this.streams.delete(res));
          return;
        }
        if (req.method === "GET" && url.pathname.startsWith("/image/")) {
          const image = this.images.get(url.pathname.slice(7));
          if (!image || image.session !== session)
            return json(res, 404, { error: "Image not found." });
          // Re-authorize the authored reference on every load, never accept an arbitrary file path.
          const resolved = await this.options.api.resolveMarkdownImage(
            image.source,
            image.target,
            image.lookup,
          );
          const file = fileURLToPath(resolved.url);
          const extension = path.extname(file).toLowerCase();
          if (!types[extension]?.startsWith("image/"))
            throw new Error("Unsupported image type.");
          const bytes = await readFile(file);
          if (!this.valid(session))
            return json(res, 401, { error: "Workspace changed." });
          res.setHeader("Content-Type", types[extension]);
          res.end(bytes);
          return;
        }
        if (req.method !== "POST" || !url.pathname.startsWith("/api/"))
          return json(res, 404, { error: "Unknown browser operation." });
        const body = await bodyJson(req);
        if (!Array.isArray(body.args))
          throw new Error("Expected an argument list.");
        if (!this.valid(session))
          return json(res, 401, { error: "Workspace changed." });
        const result = await this.call(
          url.pathname.slice(5),
          body.args,
          session,
        );
        if (!this.valid(session))
          return json(res, 401, {
            error: "Workspace changed. Reconnect to continue.",
          });
        return json(res, 200, { result });
      }
      if (req.method !== "GET") return json(res, 404, { error: "Not found." });
      const requested =
        url.pathname === "/"
          ? "browser.html"
          : decodeURIComponent(url.pathname.slice(1));
      if (requested !== "browser.html" && !requested.startsWith("assets/"))
        return json(res, 404, { error: "Not found." });
      const root = await realpath(this.options.assets);
      const file = await realpath(path.resolve(root, requested));
      if (!file.startsWith(root + path.sep))
        return json(res, 403, { error: "Invalid asset path." });
      const type = types[path.extname(file)];
      if (!type) return json(res, 404, { error: "Not found." });
      res.setHeader("Content-Type", type);
      res.end(await readFile(file));
    } catch (error) {
      if (!res.headersSent)
        json(res, 400, {
          error: error instanceof Error ? error.message : String(error),
        });
      else res.end();
    }
  }

  private async call(
    method: string,
    args: unknown[],
    session: Session,
  ): Promise<unknown> {
    const api = this.options.api;
    const model = await api.bootstrap();
    const files = new WorkspaceFiles(model.noteRoots.map((root) => root.path));
    if (
      [
        "listTree",
        "read",
        "getGraphContext",
        "resolveTarget",
        "suggestTargets",
        "resolveMarkdownImage",
      ].includes(method)
    )
      args[0] = await files.existing(string(args[0]));
    if (method === "save" || method === "saveCopy") {
      if (!/\.md$/i.test(string(args[0])))
        throw new Error("Browser editing is limited to Markdown notes.");
      args[0] = await files.writable(string(args[0]));
    }
    if (!this.valid(session)) throw new Error("Workspace changed.");
    switch (method) {
      case "bootstrap":
        return api.bootstrap();
      case "listTree":
        return api.listTree(string(args[0]), {
          markdownOnly: true,
          maxDepth: 1,
          includeEmptyDirectories: true,
        });
      case "search":
        return api.search(string(args[0]), { limit: 30 });
      case "read":
        return api.read(string(args[0]));
      case "save":
        return api.save(
          string(args[0]),
          object(args[1]),
          string(args[2]),
          string(args[3]),
        );
      case "saveCopy":
        return api.saveCopy(string(args[0]), object(args[1]), string(args[2]));
      case "getGraphContext":
        return api.getGraphContext(string(args[0]));
      case "getGraphTopology":
        return encodeBrowserGraph(await api.getGraphTopology());
      case "getGraphConceptSummaries": {
        if (!Array.isArray(args[0]) || args[0].length > 500)
          throw new Error("Invalid graph indexes.");
        return api.getGraphConceptSummaries(
          args[0].map(integer),
          string(args[1]),
        );
      }
      case "getGraphConceptDetailByIndex":
        return api.getGraphConceptDetailByIndex(
          integer(args[0]),
          string(args[1]),
        );
      case "graphConceptLookup": {
        const ref = object(args[0]);
        if (typeof ref.conceptId === "string" && ref.filePath === undefined)
          return api.graphConceptLookup(
            { conceptId: ref.conceptId },
            string(args[1]),
          );
        if (typeof ref.filePath === "string" && ref.conceptId === undefined)
          return api.graphConceptLookup(
            { filePath: ref.filePath },
            string(args[1]),
          );
        throw new Error("Invalid graph reference.");
      }
      case "resolveTarget":
        return api.resolveTarget(string(args[0]), string(args[1]));
      case "suggestTargets":
        return api.suggestTargets(string(args[0]), string(args[1]));
      case "resolveMarkdownImage": {
        const source = string(args[0]),
          target = string(args[1]),
          lookup = args[2] === true;
        await api.resolveMarkdownImage(source, target, lookup);
        if (!this.valid(session)) throw new Error("Workspace changed.");
        if (this.images.size > 2048)
          this.images.delete(this.images.keys().next().value!);
        const key = token();
        this.images.set(key, { source, target, lookup, session });
        return { url: `/image/${key}` };
      }
      default:
        throw new Error("Unknown browser operation.");
    }
  }
}
function string(value: unknown): string {
  if (typeof value !== "string") throw new Error("Expected text.");
  return value;
}
function integer(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    throw new Error("Expected a graph index.");
  return value as number;
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected an object.");
  return value as Record<string, unknown>;
}
async function bodyJson(
  req: IncomingMessage,
): Promise<Record<string, unknown>> {
  if (!req.headers["content-type"]?.startsWith("application/json"))
    throw new Error("JSON required.");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 2 * 1024 * 1024) throw new Error("Request too large.");
    chunks.push(chunk);
  }
  return object(JSON.parse(Buffer.concat(chunks).toString("utf8")));
}
function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}
