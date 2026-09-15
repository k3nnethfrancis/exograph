import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { WorkspaceGraph, EXOGRAPH_COMMAND_TOKEN_HEADER, type IndexStatus, type WorkspaceSettings } from "@exograph/core";

import { CommandServer, type CommandServerOptions } from "./command-server";

const tempPaths: string[] = [];

afterEach(async () => {
  await Promise.all(tempPaths.splice(0).map((target) => rm(target, { recursive: true, force: true })));
});

describe("CommandServer operator contract", () => {
  it("issues browser links only through the authenticated CLI route", async () => {
    const url = "http://127.0.0.1:43210/#token=browser-ticket";
    const browserRoot = await mkdtemp(path.join(os.tmpdir(), "exo-browser-cli-")); tempPaths.push(browserRoot);
    const workspace = { ...commandStatusResponse().workspace, workspaceRoot: browserRoot, noteRoots: [{ id: "note-root-1", label: "Notes", path: browserRoot }] };
    const { server, runtimeRoot, token, port } = await startServer({ onOpenBrowser: async () => ({ url }), onGetStatus: () => ({ workspace, terminals: [] }) });
    await writeFile(path.join(runtimeRoot, "server.json"), JSON.stringify(server.getServerInfo()));
    try {
      expect((await fetch(`http://127.0.0.1:${port}/browser`, { method: "POST" })).status).toBe(401);
      expect(await (await commandFetch(token, port, "/browser", { method: "POST" })).json()).toEqual({ url });
      const repo = path.resolve(import.meta.dirname, "../../../../..");
      const { stdout } = await promisify(execFile)(process.execPath, ["--import", "tsx", path.join(repo, "packages/cli/src/index.ts"), "serve"], {
        cwd: repo, env: { ...process.env, EXOGRAPH_WORKSPACE_ROOT: browserRoot, EXOGRAPH_NOTE_ROOTS: browserRoot, EXOGRAPH_RUNTIME_ROOT: runtimeRoot },
      });
      expect(JSON.parse(stdout)).toEqual({ url });
    } finally { await server.stop(); }
  });

  it("runs a real CLI child through authenticated HTTP to the Core filesystem graph", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "exo-http-traversal-")); tempPaths.push(root);
    const startPath = path.join(root, "a.md");
    await writeFile(startPath, "# A\n[[b]] [[b]]"); await writeFile(path.join(root, "b.md"), "# B");
    const model = { workspaceRoot: root, defaultTerminalCwd: root, noteRoots: [{ id: "note-root-1", label: "Notes", path: root }], indexedRoots: [], indexing: { enabled: false, mode: "off" as const, backend: "qmd" as const } };
    const graph = new WorkspaceGraph(model);
    const { server, runtimeRoot } = await startServer({ onGetStatus: () => ({ workspace: model, terminals: [] }), onGraphTraverse: (request) => graph.traverse(request) });
    await writeFile(path.join(runtimeRoot, "server.json"), JSON.stringify(server.getServerInfo()));
    try {
      const repo = path.resolve(import.meta.dirname, "../../../../..");
      const { stdout } = await promisify(execFile)(process.execPath, ["--import", "tsx", path.join(repo, "packages/cli/src/index.ts"), "graph", "traverse", "--start-path", startPath, "--limit", "1"], {
        cwd: repo,
        env: { ...process.env, EXOGRAPH_WORKSPACE_ROOT: root, EXOGRAPH_NOTE_ROOTS: root, EXOGRAPH_RUNTIME_ROOT: runtimeRoot },
      });
      const result = JSON.parse(stdout);
      expect(result.status).toBe("ok");
      expect(result.workspace.root).toBe(root);
      expect(result.nodes[0].relativePath).toBe("a.md");
      expect(result.edges).toHaveLength(2);
      expect(result.events.filter((event: { type: string }) => event.type === "visit")).toHaveLength(2);
      expect(result.nextCursor).toEqual(expect.any(String));
    } finally { await server.stop(); }
  });

  it("authorizes and validates traversal before invoking the scoped graph owner", async () => {
    const calls: unknown[] = [];
    const { server, port, token } = await startServer({ onGraphTraverse: async (request) => {
      calls.push(request);
      return { schemaVersion: "exograph.graph-traversal.v1", workspace: { root: request.workspaceRoot, noteRootIds: [] }, snapshotId: "s", status: "error", code: "missing-start", message: "Not found" };
    } });
    const body = JSON.stringify({ workspaceRoot: "/workspace", start: "note:a" });
    try {
      expect((await fetch(`http://127.0.0.1:${port}/graph/traverse`, { method: "POST", body })).status).toBe(401);
      for (const request of [{ workspaceRoot: "/workspace", start: "a", maxDepth: 4 }, { workspaceRoot: "/workspace", start: "a", unknown: true }]) {
        expect((await commandFetch(token, port, "/graph/traverse", { method: "POST", body: JSON.stringify(request) })).status).toBe(400);
      }
      expect((await commandFetch(token, port, "/graph/traverse", { method: "POST", body: JSON.stringify({ workspaceRoot: "/elsewhere", start: "a" }) })).status).toBe(409);
      expect(calls).toHaveLength(0);
      const response = await commandFetch(token, port, "/graph/traverse", { method: "POST", body });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ status: "error", code: "missing-start" });
      expect(calls).toEqual([{ workspaceRoot: "/workspace", start: "note:a" }]);
    } finally { await server.stop(); }
  });

  it("keeps the exact status success body on the wire", async () => {
    const expected = commandStatusResponse();
    const { server, port, token } = await startServer({ onGetStatus: () => expected });
    try {
      const response = await commandFetch(token, port, "/status");
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual(expected);
    } finally {
      await server.stop();
    }
  });

  it("requires its runtime token", async () => {
    const { server, port, token } = await startServer();
    try {
      const response = await fetch(`http://127.0.0.1:${port}/status`);
      expect(response.status).toBe(401);
      await expect(response.json()).resolves.toMatchObject({ error: "Missing or invalid Exograph command token." });
    } finally {
      server.stop();
    }
  });

  it("exposes bounded terminal lifecycle routes through the authenticated command server", async () => {
    const writes: Array<{ id: string; data: string }> = [];
    const terminal = { id: "term-1", title: "Shell", cwd: "/workspace", kind: "shell", command: "/bin/zsh", status: "running" };
    const { server, port, token } = await startServer({
      onListTerminals: () => [terminal],
      onCreateTerminal: async () => terminal,
      onWriteTerminal: async ({ id, data }) => {
        writes.push({ id, data });
        return id === terminal.id ? { terminal, writeId: 7 } : { terminal: null };
      },
      onReadTerminal: async ({ id, cursor }) => id === terminal.id
        ? { terminal, output: cursor === 4 ? " next" : "ready next", cursor: 9, truncated: false }
        : null,
      onStopTerminal: async (id) => id === terminal.id,
    });
    try {
      await expect(fetchJson(token, port, "/terminals")).resolves.toEqual({ terminals: [terminal] });
      await expect(fetchJson(token, port, "/terminals", { method: "POST", body: "{}" })).resolves.toEqual({ terminal });
      await expect(fetchJson(token, port, "/terminals/term-1/write", { method: "POST", body: JSON.stringify({ input: "echo hi\r" }) }))
        .resolves.toEqual({ ok: true, terminal, writeId: 7 });
      expect(writes).toEqual([{ id: "term-1", data: "echo hi\r" }]);
      await expect(fetchJson(token, port, "/terminals/term-1/read", { method: "POST", body: JSON.stringify({ cursor: 4 }) }))
        .resolves.toEqual({ terminal, output: " next", cursor: 9, truncated: false });
      await expect(fetchJson(token, port, "/terminals/term-1/stop", { method: "POST", body: "{}" })).resolves.toEqual({ ok: true });
      const missing = await commandFetch(token, port, "/terminals/missing/read", { method: "POST", body: "{}" });
      expect(missing.status).toBe(404);
    } finally {
      server.stop();
    }
  });

  it("does not report a path open until the app authorizes it", async () => {
    const opened: string[] = [];
    const { server, port, token } = await startServer({
      onOpenPath: async (filePath) => {
        if (filePath === "/outside.md") throw new Error("Refusing to access a path outside configured note roots.");
        opened.push(filePath);
      },
    });
    try {
      const denied = await commandFetch(token, port, "/open", {
        method: "POST",
        body: JSON.stringify({ path: "/outside.md" }),
      });
      expect(denied.status).toBe(400);
      await expect(denied.json()).resolves.toEqual({ error: "Refusing to access a path outside configured note roots." });
      expect(opened).toEqual([]);

      const accepted = await commandFetch(token, port, "/open", {
        method: "POST",
        body: JSON.stringify({ path: "/wiki/note.md" }),
      });
      expect(accepted.status).toBe(200);
      await expect(accepted.json()).resolves.toEqual({ ok: true });
      expect(opened).toEqual(["/wiki/note.md"]);
    } finally {
      await server.stop();
    }
  });

  it("treats a non-object open body as the existing missing-path request error", async () => {
    const { server, port, token } = await startServer();
    try {
      const response = await commandFetch(token, port, "/open", {
        method: "POST",
        body: "null",
      });

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: "Missing path in body" });
    } finally {
      await server.stop();
    }
  });

  it("rejects a wrong-typed open path before calling the typed handler", async () => {
    let handlerCalled = false;
    const { server, port, token } = await startServer({
      onOpenPath: async () => {
        handlerCalled = true;
      },
    });
    try {
      const response = await commandFetch(token, port, "/open", {
        method: "POST",
        body: JSON.stringify({ path: 123 }),
      });

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: "Missing path in body" });
      expect(handlerCalled).toBe(false);
    } finally {
      await server.stop();
    }
  });

  it("treats a non-object spawn body as the existing structured missing-input error", async () => {
    const { server, port, token } = await startServer();
    try {
      const response = await commandFetch(token, port, "/agent-commands/spawn", {
        method: "POST",
        body: "null",
      });

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        ok: false,
        code: "missing-agent-command-spawn-input",
        error: "Missing handle or task in body.",
      });
    } finally {
      await server.stop();
    }
  });

  it("rejects wrong-typed spawn fields before calling the typed handler", async () => {
    let handlerCalled = false;
    const { server, port, token } = await startServer({
      onSpawnAgentCommand: async () => {
        handlerCalled = true;
        throw new Error("wrong-typed spawn input reached the handler");
      },
    });
    try {
      const response = await commandFetch(token, port, "/agent-commands/spawn", {
        method: "POST",
        body: JSON.stringify({ handle: 123, task: 456 }),
      });

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        ok: false,
        code: "missing-agent-command-spawn-input",
        error: "Missing handle or task in body.",
      });
      expect(handlerCalled).toBe(false);
    } finally {
      await server.stop();
    }
  });

  it("returns a stable invocation launch summary instead of the internal review record", async () => {
    const { server, port, token } = await startServer({
      onSpawnAgentCommand: async () => ({
        ok: true,
        invocation: {
          id: "inv-1",
          status: "running",
          context: "cli",
          message: "review the plan",
          mentionProvenance: "unknown",
          promptDelivery: "stdin",
          command: {
            id: "fable",
            label: "Fable",
            handle: "fable",
            command: "claude -p",
            adapter: "claude-code",
            continuityPolicy: "fresh",
            cwdPolicy: "workspace_root",
            promptDelivery: "stdin",
            version: 1,
            enabled: true,
            executableFingerprint: "a".repeat(64),
          },
          cwd: "/tmp/workspace",
          createdAt: "2026-07-20T00:00:00.000Z",
          continuity: { policy: "fresh", outcome: "fresh" },
          changeset: { version: 1, status: "no-change", files: [], settledAt: "2026-07-20T00:00:00.000Z" },
        },
        terminal: {
          id: "term-1",
          title: "Fable",
          cwd: "/tmp/workspace",
          kind: "shell",
          command: "claude -p",
          status: "running",
          attachGeneration: 1,
        },
      }),
    });
    try {
      const response = await commandFetch(token, port, "/agent-commands/spawn", {
        method: "POST",
        body: JSON.stringify({ handle: "fable", task: "review the plan" }),
      });
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        ok: true,
        invocation: {
          id: "inv-1",
          status: "running",
          handle: "fable",
          createdAt: "2026-07-20T00:00:00.000Z",
        },
        terminal: {
          id: "term-1",
          title: "Fable",
          cwd: "/tmp/workspace",
          kind: "shell",
          command: "claude -p",
          status: "running",
        },
      });
    } finally {
      server.stop();
    }
  });
});

async function startServer(overrides: Partial<CommandServerOptions> = {}) {
  const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "exograph-command-server-"));
  tempPaths.push(runtimeRoot);
  const server = new CommandServer({ ...options(runtimeRoot), ...overrides });
  return { runtimeRoot, server, port: await server.start(), token: server.getServerInfo().token };
}

async function commandFetch(token: string, port: number, route: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set(EXOGRAPH_COMMAND_TOKEN_HEADER, token);
  headers.set("Content-Type", "application/json");
  return fetch(`http://127.0.0.1:${port}${route}`, { ...init, headers });
}

async function fetchJson(token: string, port: number, route: string, init: RequestInit = {}): Promise<unknown> {
  const response = await commandFetch(token, port, route, init);
  expect(response.ok).toBe(true);
  return response.json();
}

function options(runtimeRoot: string): CommandServerOptions {
  const status: IndexStatus = {
    enabled: true,
    mode: "hybrid",
    backend: "qmd",
    dbPath: "/workspace/.exograph/index.sqlite",
    runtimePath: "/workspace/.exograph",
    indexedRoots: [],
    documentCount: 0,
    pendingEmbeddings: 0,
    hasVectorIndex: false,
    lastUpdated: null,
    warnings: [],
    errors: [],
  };
  return {
    runtimeRoot, onShowWindow: () => {}, onOpenPath: async () => {}, onIndexSearch: async () => ({ mode: "lexical", source: "filesystem", query: "", results: [], warnings: [] }), onIndexStatus: async () => status, onIndexSync: async () => ({ status, phases: [], warnings: [] }), onGetStatus: () => ({ workspace: { workspaceRoot: "/workspace", defaultTerminalCwd: "/workspace", noteRoots: [], indexedRoots: [], indexing: { enabled: true, mode: "hybrid", backend: "qmd" } }, terminals: [] }), onSpawnAgentCommand: async () => { throw new Error("not used"); }, onListTerminals: () => [], onCreateTerminal: async () => { throw new Error("not used"); }, onWriteTerminal: async () => ({ terminal: null }), onReadTerminal: async () => null, onStopTerminal: async () => false,
  };
}

function commandStatusResponse() {
  return {
    workspace: {
      workspaceRoot: "/workspace",
      defaultTerminalCwd: "/workspace",
      noteRoots: [],
      indexedRoots: [],
      indexing: { enabled: true, mode: "hybrid" as const, backend: "qmd" as const },
    },
    terminals: [{
      id: "term-1",
      title: "Shell",
      cwd: "/workspace",
      kind: "shell" as const,
      command: "/bin/zsh",
      status: "running" as const,
      attachGeneration: 1,
    }],
  };
}
