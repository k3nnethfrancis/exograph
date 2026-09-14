import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";

import { saveWorkspaceSettings, type WorkspaceSettings } from "@exograph/core";

import { runExographMcpServer } from "./mcp-server";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

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

async function invokeMcp(
  requests: object[],
  options: Omit<Parameters<typeof runExographMcpServer>[0], "input" | "output" | "error">,
): Promise<Record<string, unknown>[]> {
  const input = new PassThrough();
  const output = new PassThrough();
  let text = "";
  output.on("data", (chunk) => {
    text += chunk.toString();
  });
  const server = runExographMcpServer({ ...options, input, output, error: new PassThrough() });
  input.end(requests.map((request) => JSON.stringify(request)).join("\n"));
  await server;
  return text
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function toolCall(id: number, name: string, arguments_: Record<string, unknown> = {}): object {
  return { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: arguments_ } };
}

describe("Exograph MCP server", () => {
  it("serves workspace discovery through status and search tools", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "exograph-mcp-"));
    temporaryRoots.push(root);
    const notePath = path.join(root, "research.md");
    await writeFile(notePath, "# Research\n\nExograph holds local context.\n", "utf8");
    const responses = await invokeMcp([
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
      toolCall(3, "search_notes", { query: "context" }),
      toolCall(4, "workspace_status"),
    ], {
      env: { EXOGRAPH_WORKSPACE_ROOT: root, EXOGRAPH_NOTE_ROOTS: root },
    });

    expect((responses[0].result as Record<string, unknown>)).toMatchObject({ protocolVersion: "2025-06-18", capabilities: { tools: { listChanged: false } } });
    const tools = (responses[1].result as { tools: Array<{ name: string }> }).tools;
    expect(tools.map((tool) => tool.name)).toEqual(["workspace_status", "search_notes"]);
    expect(toolText(responses[2]).results?.[0]).toMatchObject({ path: notePath, title: "Research", snippet: expect.any(String) });
    expect(toolText(responses[3])).toMatchObject({
      app: { available: false },
      workspace: {
        status: "resolved",
        resolution: "environment",
        root,
        noteRoots: [{ path: root }],
        indexing: { enabled: false },
      },
      search: expect.any(Object),
    });
  });

  it("selects the one workspace whose Note Root contains the caller cwd", async () => {
    const userDataPath = await mkdtemp(path.join(os.tmpdir(), "exograph-mcp-user-data-"));
    const alpha = await mkdtemp(path.join(os.tmpdir(), "exograph-mcp-alpha-"));
    const beta = await mkdtemp(path.join(os.tmpdir(), "exograph-mcp-beta-"));
    temporaryRoots.push(userDataPath, alpha, beta);
    const callerCwd = path.join(alpha, "project", "src");
    await mkdir(callerCwd, { recursive: true });
    await writeFile(path.join(alpha, "alpha.md"), "# Alpha\n\nScoped caller workspace.\n", "utf8");
    await writeFile(path.join(beta, "beta.md"), "# Beta\n\nOther workspace.\n", "utf8");
    const env = { EXOGRAPH_USER_DATA_PATH: userDataPath };
    await saveWorkspaceSettings(workspaceSettings(alpha), env);
    await saveWorkspaceSettings(workspaceSettings(beta), env);

    const responses = await invokeMcp([
      toolCall(1, "workspace_status"),
      toolCall(2, "search_notes", { query: "Scoped caller" }),
    ], { env, cwd: callerCwd });

    expect(toolText(responses[0])).toMatchObject({
      workspace: {
        status: "resolved",
        resolution: "caller-cwd",
        callerCwd,
        root: alpha,
      },
    });
    expect(toolText(responses[1]).results?.[0]).toMatchObject({ path: path.join(alpha, "alpha.md") });
  });

  it("uses a sole configured workspace when caller cwd is outside it", async () => {
    const userDataPath = await mkdtemp(path.join(os.tmpdir(), "exograph-mcp-user-data-"));
    const root = await mkdtemp(path.join(os.tmpdir(), "exograph-mcp-singleton-"));
    const externalCwd = await mkdtemp(path.join(os.tmpdir(), "exograph-mcp-external-"));
    temporaryRoots.push(userDataPath, root, externalCwd);
    await writeFile(path.join(root, "only.md"), "# Only\n\nSingleton scope.\n", "utf8");
    const env = { EXOGRAPH_USER_DATA_PATH: userDataPath };
    await saveWorkspaceSettings(workspaceSettings(root), env);

    const responses = await invokeMcp([
      toolCall(1, "workspace_status"),
      toolCall(2, "search_notes", { query: "Singleton" }),
    ], { env, cwd: externalCwd });

    expect(toolText(responses[0])).toMatchObject({
      workspace: { status: "resolved", resolution: "single-workspace-fallback", root },
    });
    expect(toolText(responses[1]).results?.[0]).toMatchObject({ path: path.join(root, "only.md") });
  });

  it("refuses search if caller cwd is covered by multiple workspaces", async () => {
    const userDataPath = await mkdtemp(path.join(os.tmpdir(), "exograph-mcp-user-data-"));
    const parent = await mkdtemp(path.join(os.tmpdir(), "exograph-mcp-parent-"));
    const child = path.join(parent, "nested");
    await mkdir(child);
    temporaryRoots.push(userDataPath, parent);
    const env = { EXOGRAPH_USER_DATA_PATH: userDataPath };
    await saveWorkspaceSettings(workspaceSettings(parent), env);
    await saveWorkspaceSettings(workspaceSettings(child), env);

    const responses = await invokeMcp([
      toolCall(1, "workspace_status"),
      toolCall(2, "search_notes", { query: "anything" }),
    ], { env, cwd: child });

    expect(toolText(responses[0])).toMatchObject({
      app: { available: false },
      workspace: { status: "ambiguous", callerCwd: child, candidateCount: 2 },
      search: null,
    });
    expect(responses[1].result).toMatchObject({ isError: true });
    expect(resultText(responses[1])).toContain("matches 2 Exograph Workspaces");
  });

  it("refuses search when caller cwd resolves no Workspace and no singleton exists", async () => {
    const userDataPath = await mkdtemp(path.join(os.tmpdir(), "exograph-mcp-user-data-"));
    const alpha = await mkdtemp(path.join(os.tmpdir(), "exograph-mcp-alpha-"));
    const beta = await mkdtemp(path.join(os.tmpdir(), "exograph-mcp-beta-"));
    const externalCwd = await mkdtemp(path.join(os.tmpdir(), "exograph-mcp-external-"));
    temporaryRoots.push(userDataPath, alpha, beta, externalCwd);
    const env = { EXOGRAPH_USER_DATA_PATH: userDataPath };
    await saveWorkspaceSettings(workspaceSettings(alpha), env);
    await saveWorkspaceSettings(workspaceSettings(beta), env);

    const responses = await invokeMcp([
      toolCall(1, "workspace_status"),
      toolCall(2, "search_notes", { query: "anything" }),
    ], { env, cwd: externalCwd });

    expect(toolText(responses[0])).toMatchObject({
      workspace: { status: "unresolved", callerCwd: externalCwd, candidateCount: 2 },
      search: null,
    });
    expect(responses[1].result).toMatchObject({ isError: true });
    expect(resultText(responses[1])).toContain("No Exograph Workspace matches caller cwd");
  });

  it("falls back to scoped filesystem search when the running app belongs to another workspace", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "exograph-mcp-fallback-"));
    const otherRoot = await mkdtemp(path.join(os.tmpdir(), "exograph-mcp-other-app-"));
    temporaryRoots.push(root, otherRoot);
    const notePath = path.join(root, "fallback.md");
    await writeFile(notePath, "# Fallback\n\nFilesystem result wins.\n", "utf8");

    const responses = await invokeMcp([
      toolCall(1, "workspace_status"),
      toolCall(2, "search_notes", { query: "Filesystem result" }),
    ], {
      env: { EXOGRAPH_WORKSPACE_ROOT: root, EXOGRAPH_NOTE_ROOTS: root },
      connectApp: async () => ({
        getStatus: async () => appStatus(otherRoot),
        getIndexStatus: async () => indexStatusResponse(),
        search: async () => ({ query: "Filesystem result", mode: "lexical", source: "filesystem", warnings: [], results: [{ filePath: path.join(otherRoot, "wrong.md"), title: "Wrong", snippet: "", score: 0, source: "filesystem" }] }),
      }),
    });

    expect(toolText(responses[0])).toMatchObject({ app: { available: false } });
    expect(toolText(responses[1]).results?.[0]).toMatchObject({ path: notePath });
  });

  it("uses app retrieval only when its Workspace exactly matches the resolved scope", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "exograph-mcp-app-match-"));
    temporaryRoots.push(root);

    const responses = await invokeMcp([
      toolCall(1, "workspace_status"),
      toolCall(2, "search_notes", { query: "from app" }),
    ], {
      env: { EXOGRAPH_WORKSPACE_ROOT: root, EXOGRAPH_NOTE_ROOTS: root },
      connectApp: async () => ({
        getStatus: async () => appStatus(root),
        getIndexStatus: async () => indexStatusResponse(),
        search: async () => ({ query: "from app", mode: "hybrid", source: "qmd", warnings: [], results: [{ filePath: path.join(root, "app.md"), title: "App", snippet: "", score: 1, source: "qmd" }] }),
      }),
    });

    expect(toolText(responses[0])).toMatchObject({ app: { available: true }, search: { backend: "qmd" } });
    expect(toolText(responses[1]).results?.[0]).toMatchObject({ path: path.join(root, "app.md"), source: "qmd" });
  });

  it("returns tool errors as MCP tool results rather than crashing the protocol", async () => {
    const [response] = await invokeMcp([toolCall(1, "read_note")], {
      env: { EXOGRAPH_WORKSPACE_ROOT: process.cwd(), EXOGRAPH_NOTE_ROOTS: process.cwd() },
    });
    expect(response.result).toMatchObject({ isError: true });
  });
});

interface ToolBody {
  results?: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

function appStatus(root: string) {
  return {
    workspace: {
      workspaceRoot: root,
      defaultTerminalCwd: root,
      noteRoots: [{ id: "notes", label: "notes", path: root }],
      indexedRoots: [],
      indexing: { enabled: true, mode: "hybrid" as const, backend: "qmd" as const },
      searchEngine: "qmd" as const,
    },
    terminals: [],
    controlPlane: {
      runtimeRoot: path.join(root, ".exograph"),
      serverJsonPath: path.join(root, ".exograph", "server.json"),
      pid: process.pid,
      port: 12345,
      baseUrl: "http://127.0.0.1:12345",
    },
  };
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

function toolText(response: Record<string, unknown>): ToolBody {
  return JSON.parse(resultText(response));
}

function resultText(response: Record<string, unknown>): string {
  const result = response.result as { content: Array<{ text: string }> };
  return result.content[0].text;
}
