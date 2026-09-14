import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { WorkspaceGraph, EXOGRAPH_COMMAND_TOKEN_HEADER, type ExographCommandStatusResponse } from "@exograph/core";
import {
  AppClient,
  formatAppClientDiscoveryFailure,
} from "./app-client";

const tempPaths: string[] = [];
const TEST_COMMAND_TOKEN = "test-command-token-1234567890abcdef";

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await Promise.all(tempPaths.splice(0).map((target) => rm(target, { recursive: true, force: true })));
});

describe("AppClient", () => {
  it("decodes actual Core traversal and rejects malformed or cross-workspace transport responses", async () => {
    const runtimeRoot = await runtimeFixture();
    const notePath = path.join(runtimeRoot, "a.md");
    await writeFile(notePath, "# A\n[[b]]"); await writeFile(path.join(runtimeRoot, "b.md"), "# B");
    const model = { workspaceRoot: runtimeRoot, defaultTerminalCwd: runtimeRoot, noteRoots: [{ id: "notes", label: "Notes", path: runtimeRoot }], indexedRoots: [], indexing: { enabled: false, mode: "off" as const, backend: "qmd" as const } };
    const request = { workspaceRoot: runtimeRoot, startPath: notePath };
    const valid = await new WorkspaceGraph(model).traverse(request);
    let response: unknown = valid;
    stubCommandServer((url, init) => {
      if (url.pathname === "/status") return json(statusResponse());
      expect(url.pathname).toBe("/graph/traverse");
      expect(JSON.parse(String(init?.body))).toEqual(request);
      return json(response);
    });
    const client = await AppClient.connect(runtimeRoot);
    await expect(client!.traverseGraph(request)).resolves.toEqual(valid);
    if (valid.status !== "ok") throw new Error("Expected real graph success");
    for (const malformed of [
      { ...valid, request: { ...valid.request, direction: ["both"] } },
      { ...valid, nodes: [{ ...valid.nodes[0], filePath: 123 }, ...valid.nodes.slice(1)] },
      { ...valid, execution: { ...valid.execution, visitedCount: 1, returnedOffset: 99 } },
      { ...valid, request: { ...valid.request, start: "unrelated" } },
      { ...valid, request: { ...valid.request, maxDepth: 3 } },
    ]) {
      response = malformed;
      await expect(client!.traverseGraph(request)).rejects.toThrow();
    }
    response = { ...valid, events: [{ type: "visit", seq: 9, nodeId: "a", depth: 0 }] };
    await expect(client!.traverseGraph(request)).rejects.toThrow(/valid graph traversal/);
    response = { ...valid, workspace: { root: "/other", noteRootIds: [] } };
    await expect(client!.traverseGraph(request)).rejects.toThrow(/workspace/i);
    response = { schemaVersion: "exograph.graph-traversal.v1", workspace: { root: runtimeRoot, noteRootIds: [] }, snapshotId: "s", status: "error", code: "stale-cursor", message: "Changed" };
    await expect(client!.traverseGraph(request)).resolves.toMatchObject({ code: "stale-cursor" });
  });

  it("accepts the exact success bodies for every command route through the HTTP seam", async () => {
    const runtimeRoot = await runtimeFixture();
    stubCommandServer((targetUrl, init) => {
      if (targetUrl.pathname === "/status") return json(statusResponse());
      if (targetUrl.pathname === "/show" || targetUrl.pathname === "/open") return json({ ok: true });
      if (targetUrl.pathname === "/search") return json(searchResponse(targetUrl.searchParams.get("q") ?? ""));
      if (targetUrl.pathname === "/index/status") return json(indexStatusResponse());
      if (targetUrl.pathname === "/index/sync") {
        return json({
          status: indexStatusResponse(),
          phases: [{ name: "update", status: "completed", message: "Indexed notes." }],
          warnings: [],
        });
      }
      if (targetUrl.pathname === "/agent-commands/spawn") return json(spawnResponse());
      if (targetUrl.pathname === "/terminals" && (init?.method ?? "GET") === "GET") return json({ terminals: [terminalResponse()] });
      if (targetUrl.pathname === "/terminals" && init?.method === "POST") return json({ terminal: terminalResponse() });
      if (targetUrl.pathname === "/terminals/term-1/write") return json({ ok: true, terminal: terminalResponse(), writeId: 7 });
      if (targetUrl.pathname === "/terminals/term-1/read") return json({ terminal: terminalResponse(), output: "ready", cursor: 5, truncated: false });
      if (targetUrl.pathname === "/terminals/term-1/stop") return json({ ok: true });
      return json({ error: "not found" }, 404);
    });

    const client = await AppClient.connect(runtimeRoot);

    await expect(client?.getStatus()).resolves.toMatchObject(statusResponse());
    await expect(client?.showWindow()).resolves.toBeUndefined();
    await expect(client?.openFile("/workspace/note.md")).resolves.toBeUndefined();
    await expect(client?.search("roleplay")).resolves.toEqual(searchResponse("roleplay"));
    await expect(client?.getIndexStatus()).resolves.toEqual(indexStatusResponse());
    await expect(client?.syncIndex()).resolves.toMatchObject({ phases: [{ name: "update" }] });
    await expect(client?.spawnAgentCommand("@fable", "review the plan")).resolves.toEqual(spawnResponse());
    await expect(client?.listTerminals()).resolves.toEqual({ terminals: [terminalResponse()] });
    await expect(client?.createTerminal()).resolves.toEqual({ terminal: terminalResponse() });
    await expect(client?.writeTerminal("term-1", "echo ready\r")).resolves.toEqual({ ok: true, terminal: terminalResponse(), writeId: 7 });
    await expect(client?.readTerminal("term-1", 2)).resolves.toEqual({ terminal: terminalResponse(), output: "ready", cursor: 5, truncated: false });
    await expect(client?.stopTerminal("term-1")).resolves.toBeUndefined();
  });

  it("reports a missing runtime root", async () => {
    const runtimeRoot = path.join(os.tmpdir(), `exograph-cli-client-missing-${Date.now()}`);

    const result = await AppClient.connectDetailed(runtimeRoot);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.code).toBe("runtime-root-missing");
      expect(result.failure.message).toContain("runtime root is missing");
      expect(result.failure.serverJsonPath).toBe(path.join(runtimeRoot, "server.json"));
    }
  });

  it("reports a missing server.json", async () => {
    const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "exograph-cli-client-"));
    tempPaths.push(runtimeRoot);

    const result = await AppClient.connectDetailed(runtimeRoot);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.code).toBe("server-json-missing");
      expect(result.failure.message).toContain("discovery file is missing");
    }
  });

  it("reports an invalid server.json", async () => {
    const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "exograph-cli-client-"));
    tempPaths.push(runtimeRoot);
    await writeFile(path.join(runtimeRoot, "server.json"), "{nope", "utf8");

    const result = await AppClient.connectDetailed(runtimeRoot);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.code).toBe("server-json-invalid");
      expect(result.failure.message).toContain("discovery file is invalid");
    }
  });

  it("reports stale discovery when the recorded pid is gone", async () => {
    const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "exograph-cli-client-"));
    tempPaths.push(runtimeRoot);
    await writeServerInfo(runtimeRoot, { port: 12345, pid: 9_999_999 });

    const result = await AppClient.connectDetailed(runtimeRoot);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.code).toBe("server-stale");
      expect(result.failure.message).toContain("discovery is stale");
      expect(result.failure.port).toBe(12345);
      expect(result.failure.pid).toBe(9_999_999);
    }
  });

  it("quarantines stale server.json when the recorded pid is gone", async () => {
    const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "exograph-cli-client-"));
    tempPaths.push(runtimeRoot);
    await writeServerInfo(runtimeRoot, { port: 12345, pid: 9_999_999 });

    const result = await AppClient.connectDetailed(runtimeRoot);

    expect(result.ok).toBe(false);
    const entries = await readdir(runtimeRoot);
    expect(entries).not.toContain("server.json");
    expect(entries.some((entry) => entry.startsWith("server.json.stale-"))).toBe(true);
  });

  it("does not quarantine server.json when process liveness is blocked by permissions", async () => {
    const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "exograph-cli-client-"));
    tempPaths.push(runtimeRoot);
    await writeServerInfo(runtimeRoot, { port: 12345, pid: 14108 });
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("kill EPERM 14108"), { code: "EPERM" });
    });
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("fetch failed"))));

    const result = await AppClient.connectDetailed(runtimeRoot, {
      EXOGRAPH_APP_CLIENT_REQUEST_TIMEOUT_MS: "5",
    });

    expect(result.ok).toBe(false);
    const entries = await readdir(runtimeRoot);
    expect(entries).toContain("server.json");
    expect(entries.some((entry) => entry.startsWith("server.json.stale-"))).toBe(false);
    if (!result.ok) {
      expect(result.failure.code).toBe("server-liveness-unknown");
      expect(result.failure.processCheck).toMatchObject({ status: "blocked", code: "EPERM", message: "kill EPERM 14108" });
      expect(formatAppClientDiscoveryFailure(result.failure)).toContain("Process check: blocked; code=EPERM");
      expect(formatAppClientDiscoveryFailure(result.failure)).toContain("Run `exo start`, then retry");
    }
  });

  it("connects when process liveness is blocked but the command server is reachable", async () => {
    const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "exograph-cli-client-"));
    tempPaths.push(runtimeRoot);
    await writeServerInfo(runtimeRoot, { port: 12345, pid: 14108 });
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("kill EPERM 14108"), { code: "EPERM" });
    });
    stubCommandServer((targetUrl) => {
      if (targetUrl.pathname === "/status") {
        return json(statusResponse());
      }
      return json({ error: "not found" }, 404);
    });

    const result = await AppClient.connectDetailed(runtimeRoot);

    expect(result.ok).toBe(true);
    const entries = await readdir(runtimeRoot);
    expect(entries).toContain("server.json");
    expect(entries.some((entry) => entry.startsWith("server.json.stale-"))).toBe(false);
  });

  it("reports unreachable discovery when the recorded pid is alive but the port is not", async () => {
    const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "exograph-cli-client-"));
    tempPaths.push(runtimeRoot);
    await writeServerInfo(runtimeRoot, { port: 9, pid: process.pid });

    const result = await AppClient.connectDetailed(runtimeRoot, {
      EXOGRAPH_APP_CLIENT_REQUEST_TIMEOUT_MS: "5",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.code).toBe("server-unreachable");
      expect(result.failure.message).toContain("command server is unreachable");
      expect(result.failure.runtimeRoot).toBe(runtimeRoot);
    }
  });

  it("reports discovery without a token as invalid", async () => {
    const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "exograph-cli-client-"));
    tempPaths.push(runtimeRoot);
    await writeFile(path.join(runtimeRoot, "server.json"), JSON.stringify({ port: 12345, pid: process.pid }), "utf8");

    const result = await AppClient.connectDetailed(runtimeRoot);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.code).toBe("server-json-invalid");
    }
  });

  it("uses the search timeout instead of the general request timeout for search", async () => {
    const runtimeRoot = await runtimeFixture();
    stubCommandServer(async (targetUrl, init) => {
      if (targetUrl.pathname === "/status") {
        return json(statusResponse());
      }
      if (targetUrl.pathname === "/search") {
        await delayWithAbort(10, init?.signal);
        expect(authHeader(init)).toEqual(`Bearer ${TEST_COMMAND_TOKEN}`);
        expect(targetUrl.searchParams.get("limit")).toBe("7");
        return json({ query: targetUrl.searchParams.get("q"), mode: "lexical", source: "filesystem", warnings: [], results: [] });
      }
      return json({ error: "not found" }, 404);
    });

    const client = await AppClient.connect(runtimeRoot, {
      EXOGRAPH_APP_CLIENT_REQUEST_TIMEOUT_MS: "1",
      EXOGRAPH_APP_CLIENT_SEARCH_TIMEOUT_MS: "100",
    });

    await expect(client?.search("roleplay", { limit: 7 })).resolves.toMatchObject({ query: "roleplay", mode: "lexical" });
  });

  it("attaches command-server discovery metadata to status", async () => {
    const runtimeRoot = await runtimeFixture();
    stubCommandServer((targetUrl) => {
      if (targetUrl.pathname === "/status") {
        return json(statusResponse());
      }
      return json({ error: "not found" }, 404);
    });

    const client = await AppClient.connect(runtimeRoot);

    await expect(client?.getStatus()).resolves.toMatchObject({
      workspace: { workspaceRoot: "/workspace" },
      controlPlane: {
        runtimeRoot,
        serverJsonPath: path.join(runtimeRoot, "server.json"),
        pid: process.pid,
        port: 12345,
        baseUrl: "http://127.0.0.1:12345",
      },
    });
  });

  it("posts AgentCommand spawn requests with command-server auth", async () => {
    const runtimeRoot = await runtimeFixture();
    let spawnBody: unknown;
    stubCommandServer(async (targetUrl, init) => {
      if (targetUrl.pathname === "/status") {
        return json(statusResponse());
      }
      if (targetUrl.pathname === "/agent-commands/spawn" && init?.method === "POST") {
        expect(authHeader(init)).toEqual(`Bearer ${TEST_COMMAND_TOKEN}`);
        expect(commandTokenHeader(init)).toEqual(TEST_COMMAND_TOKEN);
        spawnBody = init.body ? JSON.parse(String(init.body)) : null;
        return json(spawnResponse());
      }
      return json({ error: "not found" }, 404);
    });

    const client = await AppClient.connect(runtimeRoot);

    await expect(client?.spawnAgentCommand("@fable", "review the plan")).resolves.toMatchObject({
      ok: true,
      invocation: { id: "inv-1" },
      terminal: { id: "term-1" },
    });
    expect(spawnBody).toEqual({ handle: "@fable", task: "review the plan" });
  });

  it("reports search timeout details", async () => {
    const runtimeRoot = await runtimeFixture();
    stubCommandServer(async (targetUrl, init) => {
      if (targetUrl.pathname === "/status") {
        return json(statusResponse());
      }
      if (targetUrl.pathname === "/search") {
        await delayWithAbort(100, init?.signal);
        return json({ results: [] });
      }
      return json({ error: "not found" }, 404);
    });

    const client = await AppClient.connect(runtimeRoot, {
      EXOGRAPH_APP_CLIENT_REQUEST_TIMEOUT_MS: "50",
      EXOGRAPH_APP_CLIENT_SEARCH_TIMEOUT_MS: "5",
    });

    await expect(client?.search("roleplay")).rejects.toThrow("GET /search?q=roleplay timed out after 5ms");
  });

  it("names the method and route for malformed successful JSON", async () => {
    const runtimeRoot = await runtimeFixture();
    let statusCalls = 0;
    stubCommandServer((targetUrl) => {
      if (targetUrl.pathname === "/status") {
        statusCalls += 1;
        return statusCalls === 1 ? json(statusResponse()) : new Response("{", { status: 200 });
      }
      return json({ error: "not found" }, 404);
    });

    const client = await AppClient.connect(runtimeRoot);

    await expect(client?.getStatus()).rejects.toThrow("Exograph command-server protocol error for GET /status: successful response was not valid JSON");
  });

  it("names the query-bearing GET route for a structurally invalid success response", async () => {
    const runtimeRoot = await runtimeFixture();
    stubCommandServer((targetUrl) => {
      if (targetUrl.pathname === "/status") return json(statusResponse());
      if (targetUrl.pathname === "/search") {
        return json({ query: "roleplay", mode: "lexical", source: "filesystem", results: [] });
      }
      return json({ error: "not found" }, 404);
    });

    const client = await AppClient.connect(runtimeRoot);

    await expect(client?.search("roleplay")).rejects.toThrow(
      "Exograph command-server protocol error for GET /search?q=roleplay: expected a valid search response",
    );
  });

  it("names the POST route for a structurally invalid success response", async () => {
    const runtimeRoot = await runtimeFixture();
    stubCommandServer((targetUrl) => {
      if (targetUrl.pathname === "/status") return json(statusResponse());
      if (targetUrl.pathname === "/open") return json({ ok: false });
      return json({ error: "not found" }, 404);
    });

    const client = await AppClient.connect(runtimeRoot);

    await expect(client?.openFile("/workspace/note.md")).rejects.toThrow(
      "Exograph command-server protocol error for POST /open: expected an { ok: true } response",
    );
  });

  it("preserves non-2xx command-server errors without treating them as protocol errors", async () => {
    const runtimeRoot = await runtimeFixture();
    stubCommandServer((targetUrl) => {
      if (targetUrl.pathname === "/status") return json(statusResponse());
      if (targetUrl.pathname === "/search") return json({ error: "Search is unavailable" }, 503);
      return json({ error: "not found" }, 404);
    });

    const client = await AppClient.connect(runtimeRoot);

    await expect(client?.search("roleplay")).rejects.toThrow('HTTP 503: {"error":"Search is unavailable"}');
  });
});

async function runtimeFixture(): Promise<string> {
  const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "exograph-cli-client-"));
  tempPaths.push(runtimeRoot);
  await mkdir(runtimeRoot, { recursive: true });
  await writeServerInfo(runtimeRoot, { port: 12345, pid: process.pid });
  return runtimeRoot;
}

async function writeServerInfo(runtimeRoot: string, info: { port: number; pid: number; token?: string }): Promise<void> {
  await writeFile(path.join(runtimeRoot, "server.json"), JSON.stringify({
    token: TEST_COMMAND_TOKEN,
    ...info,
  }), "utf8");
}

function stubCommandServer(handler: (targetUrl: URL, init?: RequestInit) => Promise<Response> | Response) {
  vi.stubGlobal("fetch", vi.fn((input: string | URL | Request, init?: RequestInit) => {
    const rawUrl = typeof input === "string" || input instanceof URL ? String(input) : input.url;
    return Promise.resolve(handler(new URL(rawUrl), init));
  }));
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function statusResponse(): ExographCommandStatusResponse {
  return {
    workspace: {
      workspaceRoot: "/workspace",
      defaultTerminalCwd: "/workspace",
      noteRoots: [],
      indexedRoots: [],
      indexing: { enabled: true, mode: "hybrid", backend: "qmd" },
      searchEngine: "qmd",
    },
    terminals: [{
      id: "term-1",
      title: "Shell",
      cwd: "/workspace",
      kind: "shell",
      command: "/bin/zsh",
      status: "running",
      attachGeneration: 1,
      geometry: { cols: 120, rows: 40, reportedAt: "2026-07-24T00:00:00.000Z", source: "initial-default" },
    }],
  };
}

function searchResponse(query: string) {
  return { query, mode: "lexical" as const, source: "filesystem" as const, warnings: [], results: [] };
}

function indexStatusResponse() {
  return {
    enabled: true,
    mode: "hybrid" as const,
    backend: "qmd" as const,
    dbPath: "/workspace/.exograph/index.sqlite",
    runtimePath: "/workspace/.exograph",
    indexedRoots: [],
    documentCount: 1,
    pendingEmbeddings: 0,
    hasVectorIndex: true,
    lastUpdated: "2026-07-24T00:00:00.000Z",
    warnings: [],
    errors: [],
  };
}

function spawnResponse() {
  return {
    ok: true,
    invocation: { id: "inv-1", status: "running", handle: "fable", createdAt: "2026-07-24T00:00:00.000Z" },
    terminal: { id: "term-1", title: "Fable", cwd: "/workspace", kind: "shell", status: "running" },
  };
}

function terminalResponse() {
  return { id: "term-1", title: "Shell", cwd: "/workspace", kind: "shell", command: "/bin/zsh", status: "running" };
}

function authHeader(init: RequestInit | undefined): string | null {
  return headerValue(init, "authorization");
}

function commandTokenHeader(init: RequestInit | undefined): string | null {
  return headerValue(init, EXOGRAPH_COMMAND_TOKEN_HEADER);
}

function headerValue(init: RequestInit | undefined, key: string): string | null {
  const headers = new Headers(init?.headers);
  return headers.get(key);
}

function delayWithAbort(ms: number, signal?: AbortSignal | null): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timeout);
      reject(signal.reason ?? new DOMException("The operation was aborted.", "AbortError"));
    }, { once: true });
  });
}
