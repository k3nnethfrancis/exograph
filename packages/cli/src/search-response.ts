import path from "node:path";

import type { IndexSearchResponse, WorkspaceModel } from "@exograph/core";

export const AGENT_SEARCH_SCHEMA_VERSION = "exograph.search.v1";
export const DEFAULT_AGENT_SEARCH_LIMIT = 10;
export const MAX_AGENT_SEARCH_LIMIT = 20;

export interface AgentSearchPage {
  limit: number;
  returned: number;
  next_cursor: string | null;
}

export interface AgentSearchResponse {
  schema_version: typeof AGENT_SEARCH_SCHEMA_VERSION;
  query: string;
  scope: { workspace_root: string; note_roots: string[] };
  retrieval: {
    provider: "qmd" | "filesystem";
    mode: IndexSearchResponse["mode"];
    warnings: string[];
    incomplete?: IndexSearchResponse["incomplete"];
  };
  page: AgentSearchPage;
  results: Array<{
    path: string;
    root_path: string;
    relative_path: string;
    title: string;
    snippet: string;
    score: number;
    source: "qmd" | "filesystem";
  }>;
  next: string;
}

export function parseSearchCursor(value: unknown, query: string): number {
  if (typeof value !== "string" || !value) return 0;
  try {
    const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as { query?: unknown; offset?: unknown };
    if (decoded.query !== query || !Number.isSafeInteger(decoded.offset) || Number(decoded.offset) < 0) {
      throw new Error("invalid");
    }
    return Number(decoded.offset);
  } catch {
    throw new Error("Invalid search cursor. Start a new search to obtain a fresh cursor.");
  }
}

export function searchCursor(query: string, offset: number): string {
  return Buffer.from(JSON.stringify({ query, offset }), "utf8").toString("base64url");
}

export function boundedSearchLimit(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, MAX_AGENT_SEARCH_LIMIT) : DEFAULT_AGENT_SEARCH_LIMIT;
}

export function agentSearchResponse(
  model: WorkspaceModel,
  response: IndexSearchResponse,
  page: { limit: number; offset: number },
): AgentSearchResponse {
  const noteRoots = model.noteRoots.map((root) => path.resolve(root.path));
  const returned = response.results.length;
  const nextOffset = page.offset + returned;
  return {
    schema_version: AGENT_SEARCH_SCHEMA_VERSION,
    query: response.query,
    scope: { workspace_root: model.workspaceRoot, note_roots: noteRoots },
    retrieval: {
      provider: response.source,
      mode: response.mode,
      warnings: response.warnings,
      incomplete: response.incomplete,
    },
    page: {
      limit: page.limit,
      returned,
      next_cursor: response.hasMore && returned > 0 ? searchCursor(response.query, nextOffset) : null,
    },
    results: response.results.map((result) => {
      const rootPath = rootForPath(result.filePath, noteRoots);
      return {
        path: result.filePath,
        root_path: rootPath,
        relative_path: path.relative(rootPath, result.filePath),
        title: result.title,
        snippet: result.snippet,
        score: result.score,
        source: result.source,
      };
    }),
    next: "Use a returned path with your native filesystem tools. Refine the query, or pass next_cursor to continue this result set.",
  };
}

function rootForPath(filePath: string, roots: string[]): string {
  const target = path.resolve(filePath);
  return roots.find((root) => isWithin(root, target)) ?? path.dirname(target);
}

function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}
