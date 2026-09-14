import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  saveWorkspaceSettings,
  type WorkspaceSettings,
  type ExographCommandIndexStatusResponse,
  type ExographCommandIndexSyncResponse,
  type ExographCommandSearchResponse,
  type ExographCommandStatusWithControlPlane,
  type ExographSpawnAgentCommandResponse,
  type ExographCommandTerminalCreateResponse,
  type ExographCommandTerminalListResponse,
  type ExographCommandTerminalReadResponse,
  type ExographCommandTerminalWriteResponse,
} from "@exograph/core";
import { EXOGRAPH_CLI_COMMANDS } from "@exograph/core/operator-help";
import { AppClient } from "./app-client";
import { runCli } from "./index";

const client = {
  getStatus: async (): Promise<ExographCommandStatusWithControlPlane> => statusResponse(),
  showWindow: async () => {},
  search: async (query: string): Promise<ExographCommandSearchResponse> => ({ query, mode: "lexical", source: "filesystem", warnings: [], results: [] }),
  getIndexStatus: async (): Promise<ExographCommandIndexStatusResponse> => indexStatusResponse(),
  syncIndex: async (): Promise<ExographCommandIndexSyncResponse> => ({ status: indexStatusResponse(), phases: [], warnings: [] }),
  openFile: async () => {},
  spawnAgentCommand: async (): Promise<ExographSpawnAgentCommandResponse> => spawnResponse(),
  listTerminals: async (): Promise<ExographCommandTerminalListResponse> => ({ terminals: [] }),
  createTerminal: async (): Promise<ExographCommandTerminalCreateResponse> => ({ terminal: terminalResponse() }),
  writeTerminal: async (_id: string, _input: string): Promise<ExographCommandTerminalWriteResponse> => ({ ok: true, terminal: terminalResponse(), writeId: 1 }),
  readTerminal: async (_id: string, _cursor?: number): Promise<ExographCommandTerminalReadResponse> => ({ terminal: terminalResponse(), output: "", cursor: 0, truncated: false }),
  stopTerminal: async (_id: string) => {},
} satisfies Pick<AppClient, "getStatus" | "showWindow" | "search" | "getIndexStatus" | "syncIndex" | "openFile" | "spawnAgentCommand" | "listTerminals" | "createTerminal" | "writeTerminal" | "readTerminal" | "stopTerminal">;
const connect = async () => client;
const matchingClientEnv = {
  ...process.env,
  EXOGRAPH_WORKSPACE_ROOT: "/workspace",
  EXOGRAPH_NOTE_ROOTS: "/workspace",
};

describe("minimal Exograph operator CLI", () => {
  it("traverses real offline notes with explicit scope and snapshot-bound pagination", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "exo-cli-traverse-"));
    try {
      await writeFile(path.join(root, "a.md"), "# A\n[[b]] [[b]]");
      await writeFile(path.join(root, "b.md"), "# B\n");
      let output = "";
      const options = { env: { EXOGRAPH_WORKSPACE_ROOT: root, EXOGRAPH_NOTE_ROOTS: root, EXOGRAPH_RUNTIME_ROOT: path.join(root, ".runtime") }, stdout: { write: (text: string) => { output += text; } } };
      const args = ["node", "exo", "graph", "traverse", "--offline", "--start-path", path.join(root, "a.md"), "--limit", "1"];
      expect(await runCli(args, options)).toBe(0);
      const first = JSON.parse(output);
      expect(first.nodes[0].relativePath).toBe("a.md");
      expect(first.edges).toHaveLength(2);
      output = "";
      expect(await runCli([...args, "--cursor", first.nextCursor], options)).toBe(0);
      const second = JSON.parse(output);
      expect(second.nodes[0].relativePath).toBe("b.md");
      expect(second.snapshotId).toBe(first.snapshotId);
      expect(second.execution.visitedCount).toBe(2);
      expect(second.traversalId).not.toBe(first.traversalId);
      output = "";
      expect(await runCli([...args, "--cursor", "invalid"], options)).toBe(1);
      expect(JSON.parse(output).code).toBe("invalid-cursor");
      await expect(runCli([...args, "--max-depth", "4"], options)).rejects.toThrow();
      await expect(runCli(args, { env: {} })).rejects.toThrow(/explicit/i);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("prints every command from the shared operator catalog", async () => {
    let help = "";
    expect(await runCli(["node", "exograph", "--help"], { stderr: { write: (text) => { help += text; } } })).toBe(0);
    for (const command of EXOGRAPH_CLI_COMMANDS) {
      expect(help).toContain(command.usageToken);
    }
  });

  it.each([
    ["search", "exo search <query>"],
    ["status", "exo status"],
    ["index", "exo index"],
    ["mcp", "exo mcp serve"],
  ])("prints subcommand help for %s without executing it", async (command, expectedUsage) => {
    let help = "";
    const connector = vi.fn(async () => client);

    expect(await runCli(["node", "exograph", command, "--help"], {
      stderr: { write: (text) => { help += text; } },
      connectAppClient: connector,
    })).toBe(0);

    expect(help).toContain(`Usage: ${expectedUsage}`);
    expect(connector).not.toHaveBeenCalled();
  });

  it("rejects unknown flags, missing flag values, stray arguments, and invalid limits", async () => {
    const options = { stderr: { write: () => {} }, connectAppClient: connect };

    await expect(runCli(["node", "exograph", "search", "needle", "--wat", "nope"], options))
      .rejects.toThrow("Unknown option: --wat");
    await expect(runCli(["node", "exograph", "status", "--workspace"], options))
      .rejects.toThrow("Missing value for --workspace");
    await expect(runCli(["node", "exograph", "search", "needle", "--cursor"], options))
      .rejects.toThrow("Missing value for --cursor");
    await expect(runCli(["node", "exograph", "status", "stray"], options))
      .rejects.toThrow("Unexpected argument: stray");
    for (const value of ["-1", "0", "21", "1.5", "many"]) {
      await expect(runCli(["node", "exograph", "search", "needle", "--limit", value], options))
        .rejects.toThrow("Expected --limit to be an integer from 1 to 20");
    }
  });

  it("routes the compact search/index/open/invoke contract", async () => {
    let output = "";
    const openedPaths: string[] = [];
    const openingClient = { ...client, openFile: async (filePath: string) => { openedPaths.push(filePath); } };
    const options = {
      env: matchingClientEnv,
      stdout: { write: (text: string) => { output += text; } },
      stderr: { write: () => {} },
      connectAppClient: async () => openingClient,
    };
    expect(await runCli(["node", "exograph", "search", "hello"], options)).toBe(0);
    expect(await runCli(["node", "exograph", "index", "sync"], options)).toBe(0);
    expect(await runCli(["node", "exograph", "open", "note.md"], options)).toBe(0);
    expect(await runCli(["node", "exograph", "invoke", "@review", "check", "this"], options)).toBe(0);
    expect(openedPaths).toEqual(["/workspace/note.md"]);
    expect(output).toContain("exograph.search.v1");
  });

  it("controls a referenced terminal through the app-backed CLI contract", async () => {
    let output = "";
    const calls: string[] = [];
    const terminalClient = {
      ...client,
      getStatus: async (): Promise<ExographCommandStatusWithControlPlane> => statusResponse(),
      listTerminals: async () => { calls.push("list"); return { terminals: [terminalResponse()] }; },
      createTerminal: async () => { calls.push("create"); return { terminal: terminalResponse() }; },
      writeTerminal: async (id: string, input: string) => { calls.push(`write:${id}:${JSON.stringify(input)}`); return { ok: true as const, terminal: terminalResponse(), writeId: 3 }; },
      readTerminal: async (id: string, cursor?: number) => { calls.push(`read:${id}:${cursor ?? ""}`); return { terminal: terminalResponse(), output: "ready", cursor: 5, truncated: false }; },
      stopTerminal: async (id: string) => { calls.push(`stop:${id}`); },
    } satisfies typeof client;
    const options = {
      env: matchingClientEnv,
      stdout: { write: (text: string) => { output += text; } },
      stderr: { write: () => {} },
      connectAppClient: async () => terminalClient,
    };

    expect(await runCli(["node", "exograph", "terminals", "list"], options)).toBe(0);
    expect(await runCli(["node", "exograph", "terminals", "create"], options)).toBe(0);
    expect(await runCli(["node", "exograph", "terminals", "write", "term-1", "echo", "hi", "--newline"], options)).toBe(0);
    expect(await runCli(["node", "exograph", "terminals", "write", "term-1", "--newline"], options)).toBe(0);
    expect(await runCli(["node", "exograph", "terminals", "read", "term-1", "--cursor", "2"], options)).toBe(0);
    expect(await runCli(["node", "exograph", "terminals", "stop", "term-1"], options)).toBe(0);

    expect(calls).toEqual(["list", "create", "write:term-1:\"echo hi\"", "write:term-1:\"\\r\"", "write:term-1:\"\\r\"", "read:term-1:2", "stop:term-1"]);
    expect(output).toContain('"cursor": 5');
  });

  it("advances through page six and offset 100 with the CLI-owned cursor", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "exograph-cli-cursor-"));
    const resultPaths = Array.from({ length: 120 }, (_, index) =>
      path.join(workspaceRoot, `result-${String(index).padStart(3, "0")}.md`));
    const offsets: number[] = [];
    const pagingClient = {
      ...client,
      getStatus: async () => statusResponse(workspaceRoot),
      search: async (query: string, options: { limit?: number; offset?: number } = {}): Promise<ExographCommandSearchResponse> => {
        const limit = options.limit ?? 20;
        const offset = options.offset ?? 0;
        offsets.push(offset);
        const results = resultPaths.slice(offset, offset + limit).map((filePath, index) => ({
          filePath,
          title: path.basename(filePath, ".md"),
          snippet: "",
          score: 1 - (offset + index) / 10,
          source: "qmd" as const,
        }));
        return {
          query,
          mode: "lexical" as const,
          source: "qmd" as const,
          warnings: [],
          results,
          hasMore: resultPaths.length > offset + results.length,
        };
      },
    } satisfies typeof client;
    const env = {
      ...process.env,
      EXOGRAPH_WORKSPACE_ROOT: workspaceRoot,
      EXOGRAPH_NOTE_ROOTS: workspaceRoot,
    };

    try {
      let cursor: string | null = null;
      let firstCursor: string | null = null;
      const seenPaths: string[] = [];
      for (let pageIndex = 0; pageIndex < 6; pageIndex += 1) {
        let output = "";
        await runCli([
          "node",
          "exograph",
          "search",
          "result",
          "--limit",
          "20",
          ...(cursor ? ["--cursor", cursor] : []),
        ], {
          env,
          stdout: { write: (text) => { output += text; } },
          stderr: { write: () => {} },
          connectAppClient: async () => pagingClient,
        });
        const page = JSON.parse(output) as {
          page: { returned: number; next_cursor: string | null };
          results: Array<{ path: string }>;
        };
        seenPaths.push(...page.results.map((result) => result.path));
        cursor = page.page.next_cursor;
        firstCursor ??= cursor;
        expect(page.page.returned).toBe(20);
        expect(page.page.next_cursor).toEqual(pageIndex === 5 ? null : expect.any(String));
      }

      expect(offsets).toEqual([0, 20, 40, 60, 80, 100]);
      expect(seenPaths).toEqual(resultPaths);
      expect(new Set(seenPaths).size).toBe(120);
      await expect(runCli([
        "node",
        "exograph",
        "search",
        "different query",
        "--cursor",
        firstCursor!,
      ], {
        env,
        stderr: { write: () => {} },
        connectAppClient: async () => pagingClient,
      })).rejects.toThrow("Invalid search cursor");
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("rejects deleted families instead of preserving aliases", async () => {
    for (const command of ["read", "spawn", "preview", "config"]) {
      await expect(runCli(["node", "exograph", command], { stderr: { write: () => {} }, connectAppClient: connect })).rejects.toThrow("Usage:");
    }
  });

  it("starts the installed macOS app through the explicit bootstrap command", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "exograph-cli-start-"));
    const appPath = path.join(home, "Exograph.app");
    await mkdir(appPath);
    let launchedPath = "";

    try {
      const exitCode = await runCli(["node", "exograph", "start"], {
        env: { ...process.env, HOME: home, EXOGRAPH_APP_PATH: appPath },
        stderr: { write: () => {} },
        launchApp: async (target) => { launchedPath = target; },
      });

      expect(exitCode).toBe(0);
      expect(launchedPath).toBe(appPath);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("keeps status and search useful when the resident app is unavailable", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "exograph-cli-offline-"));
    const noteRoot = path.join(workspaceRoot, "notes");
    const notePath = path.join(noteRoot, "orientation.md");
    await mkdir(noteRoot);
    await writeFile(notePath, "# Orientation\n\nThe local-first workspace.\n", "utf8");
    const env = {
      ...process.env,
      EXOGRAPH_WORKSPACE_ROOT: workspaceRoot,
      EXOGRAPH_NOTE_ROOTS: noteRoot,
      EXOGRAPH_USER_DATA_PATH: path.join(workspaceRoot, "user-data"),
    };
    let discoveredRuntimeRoot = "";
    const unavailable = async (runtimeRoot: string) => {
      discoveredRuntimeRoot = runtimeRoot;
      return null;
    };

    try {
      let output = "";
      const options = {
        env,
        stdout: { write: (text: string) => { output += text; } },
        stderr: { write: () => {} },
        connectAppClient: unavailable,
      };
      expect(await runCli(["node", "exograph", "status"], options)).toBe(0);
      expect(await runCli(["node", "exograph", "search", "local-first"], options)).toBe(0);

      expect(output).toContain('"available": false');
      expect(output).toContain('"reason": "desktop-app-unavailable"');
      expect(output).toContain("orientation.md");
      expect(output).toContain('"path"');
      expect(discoveredRuntimeRoot).toBe(path.join(workspaceRoot, ".exograph"));
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("reports the live QMD health with app-backed status", async () => {
    let output = "";
    expect(await runCli(["node", "exograph", "status"], {
      env: matchingClientEnv,
      stdout: { write: (text) => { output += text; } },
      stderr: { write: () => {} },
      connectAppClient: connect,
    })).toBe(0);

    expect(JSON.parse(output)).toMatchObject({
      workspace: { indexing: { backend: "qmd", mode: "hybrid" } },
      search: { backend: "qmd", mode: "hybrid", errors: [] },
    });
  });

  it("adds a machine-readable discovery diagnostic while preserving app-off status and search", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "exograph-cli-runtime-diagnostic-"));
    const runtimeRoot = path.join(workspaceRoot, ".exograph");
    const notePath = path.join(workspaceRoot, "orientation.md");
    await mkdir(runtimeRoot);
    await writeFile(notePath, "# Orientation\n\nTruthful offline retrieval.\n", "utf8");
    const env = {
      ...process.env,
      EXOGRAPH_WORKSPACE_ROOT: workspaceRoot,
      EXOGRAPH_NOTE_ROOTS: workspaceRoot,
      EXOGRAPH_RUNTIME_ROOT: runtimeRoot,
    };

    try {
      const run = async (argv: string[]) => {
        let output = "";
        expect(await runCli(["node", "exograph", ...argv], {
          env,
          stdout: { write: (text) => { output += text; } },
          stderr: { write: () => {} },
        })).toBe(0);
        return JSON.parse(output);
      };

      const status = await run(["status"]);
      expect(status).toMatchObject({
        app: {
          available: false,
          diagnostic: {
            code: "server-json-missing",
            runtimeRoot,
            serverJsonPath: path.join(runtimeRoot, "server.json"),
          },
        },
        search: { backend: "filesystem", mode: "lexical" },
      });

      const search = await run(["search", "offline retrieval"]);
      expect(search).toMatchObject({
        schema_version: "exograph.search.v1",
        retrieval: { provider: "filesystem", mode: "lexical" },
        runtime: {
          code: "server-json-missing",
          runtimeRoot,
          serverJsonPath: path.join(runtimeRoot, "server.json"),
        },
        results: [{ path: notePath }],
      });
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("uses filesystem retrieval instead of a live app for a different Workspace", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "exograph-cli-runtime-mismatch-"));
    const notePath = path.join(workspaceRoot, "selected.md");
    await writeFile(notePath, "# Selected\n\nSelected workspace truth.\n", "utf8");
    const appSearch = vi.fn(client.search);
    const mismatchedClient = {
      ...client,
      getStatus: async () => statusResponse(),
      search: appSearch,
    };
    const env = {
      ...process.env,
      EXOGRAPH_WORKSPACE_ROOT: workspaceRoot,
      EXOGRAPH_NOTE_ROOTS: workspaceRoot,
    };
    let output = "";

    try {
      expect(await runCli(["node", "exograph", "search", "workspace truth"], {
        env,
        stdout: { write: (text) => { output += text; } },
        stderr: { write: () => {} },
        connectAppClient: async () => mismatchedClient,
      })).toBe(0);

      expect(JSON.parse(output)).toMatchObject({
        retrieval: { provider: "filesystem" },
        runtime: {
          code: "workspace-mismatch",
          selectedWorkspaceRoot: workspaceRoot,
          appWorkspaceRoot: "/workspace",
        },
        results: [{ path: notePath }],
      });
      expect(appSearch).not.toHaveBeenCalled();
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("lists saved Workspaces and searches a selected inactive Workspace without changing the active one", async () => {
    const userDataPath = await mkdtemp(path.join(os.tmpdir(), "exograph-cli-workspaces-"));
    const alpha = path.join(userDataPath, "alpha");
    const beta = path.join(userDataPath, "beta");
    await mkdir(alpha);
    await mkdir(beta);
    await writeFile(path.join(alpha, "alpha.md"), "# Alpha\n\nIndependent repository context.\n", "utf8");
    await writeFile(path.join(beta, "beta.md"), "# Beta\n\nActive personal context.\n", "utf8");
    const env = { ...process.env, EXOGRAPH_USER_DATA_PATH: userDataPath };
    await saveWorkspaceSettings(workspaceSettings(alpha), env);
    await saveWorkspaceSettings(workspaceSettings(beta), env);
    const run = async (argv: string[]) => {
      let output = "";
      await runCli(["node", "exograph", ...argv], {
        env,
        stdout: { write: (text) => { output += text; } },
        stderr: { write: () => {} },
        connectAppClient: async () => {
          throw new Error("An explicitly selected Workspace must not use the active app client.");
        },
      });
      return JSON.parse(output);
    };

    try {
      const listed = await run(["workspaces"]);
      expect(listed).toMatchObject({
        schema_version: "exograph.workspaces.v1",
        workspaces: [
          { label: "beta", active: true },
          { label: "alpha", active: false },
        ],
      });

      const status = await run(["status", "--workspace", "alpha"]);
      expect(status).toMatchObject({
        app: { available: false },
        workspace: { label: "alpha", root: alpha, active: false },
      });

      const search = await run(["search", "repository context", "--workspace", "alpha"]);
      expect(search).toMatchObject({
        schema_version: "exograph.search.v1",
        scope: { workspace_root: alpha, note_roots: [alpha] },
        retrieval: { provider: "filesystem" },
        results: [{ path: path.join(alpha, "alpha.md") }],
      });
    } finally {
      await rm(userDataPath, { recursive: true, force: true });
    }
  });
});

function terminalResponse() {
  return {
    id: "term-1",
    title: "Shell",
    cwd: "/workspace",
    kind: "shell",
    command: "/bin/zsh",
    status: "running",
  };
}

function statusResponse(workspaceRoot = "/workspace"): ExographCommandStatusWithControlPlane {
  return {
    workspace: {
      workspaceRoot,
      defaultTerminalCwd: workspaceRoot,
      noteRoots: [{ id: "notes", label: "notes", path: workspaceRoot }],
      indexedRoots: [],
      indexing: { enabled: true, mode: "hybrid", backend: "qmd" },
      searchEngine: "qmd",
    },
    terminals: [],
    controlPlane: {
      runtimeRoot: "/workspace/.exograph",
      serverJsonPath: "/workspace/.exograph/server.json",
      pid: 123,
      port: 456,
      baseUrl: "http://127.0.0.1:456",
    },
  };
}

function indexStatusResponse(): ExographCommandIndexStatusResponse {
  return {
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
}

function spawnResponse(): ExographSpawnAgentCommandResponse {
  return {
    ok: true,
    invocation: { id: "inv-1", status: "running", handle: "review", createdAt: "2026-07-24T00:00:00.000Z" },
    terminal: { id: "term-1", title: "Review", cwd: "/workspace", kind: "shell", status: "running" },
  };
}

function workspaceSettings(root: string): WorkspaceSettings {
  return {
    workspaceRoot: root,
    defaultTerminalCwd: root,
    noteRoots: [root],
    indexedRoots: [],
    indexing: { enabled: false, mode: "off", backend: "qmd" },
    appearanceMode: "system",
    colorThemeId: "exograph-neutral",
    editorFontSize: 15,
    terminalFontSize: 13,
    explorerScale: 1,
    graphInverseNavigation: true,
    graphShowOverflowLabels: true,
    exploreIndexSearchOnEnter: false,
    indexUpdateStrategy: "on-save",
  };
}
