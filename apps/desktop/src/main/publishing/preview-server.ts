import { createServer, type Server } from "node:http";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";

export function within(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

/** Serves only the completed build; source snapshots and receipts are siblings. */
export async function servePublication(directory: string, basePath = "/"): Promise<{ url: string; close: () => void }> {
  const root = await realpath(directory);
  const prefix = `/${basePath.split("/").filter(Boolean).join("/")}`.replace(/\/$/, "");
  let server: Server;
  server = createServer(async (request, response) => {
    try {
      if (request.method !== "GET" && request.method !== "HEAD") {
        response.writeHead(405).end();
        return;
      }
      // Require our loopback origin, including the port, to resist DNS rebinding.
      const address = server.address();
      if (!address || typeof address === "string" || request.headers.host !== `127.0.0.1:${address.port}`) {
        response.writeHead(403).end();
        return;
      }
      const pathname = decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname);
      if (pathname.includes("\0") || pathname.includes("\\")) throw new Error("Invalid path");
      if (prefix && pathname !== prefix && !pathname.startsWith(`${prefix}/`)) throw new Error("Outside site prefix");
      let target = path.resolve(root, `.${pathname.slice(prefix.length) || "/"}`);
      if (!within(root, target)) throw new Error("Outside build");
      let info;
      try { info = await stat(target); } catch {
        target += ".html";
        info = await stat(target);
      }
      if (info.isDirectory()) target = path.join(target, "index.html");
      target = await realpath(target);
      if (!within(root, target) || !(await stat(target)).isFile()) throw new Error("Outside build");
      const body = await readFile(target);
      response.writeHead(200, {
        "Content-Type": contentType(target), "Content-Length": body.length,
        "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
      });
      response.end(request.method === "HEAD" ? undefined : body);
    } catch { response.writeHead(404).end("Not found"); }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Preview did not start");
  return { url: `http://127.0.0.1:${address.port}${prefix}/`, close: () => { server.closeAllConnections(); server.close(); } };
}

function contentType(file: string): string {
  const types: Record<string, string> = {
    ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8",
    ".json": "application/json", ".xml": "application/xml", ".svg": "image/svg+xml", ".png": "image/png",
    ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif", ".ico": "image/x-icon",
    ".woff": "font/woff", ".woff2": "font/woff2", ".pdf": "application/pdf", ".txt": "text/plain; charset=utf-8",
  };
  return types[path.extname(file).toLowerCase()] ?? "application/octet-stream";
}
