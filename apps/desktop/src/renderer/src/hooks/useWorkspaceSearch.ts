import { startTransition, useEffect, useRef, useState } from "react";

import type { WorkspaceSearchResults } from "@exograph/core";

export type WorkspaceSearchResultMode = "idle" | "filename" | "index-loading" | "index" | "index-unavailable" | "error";

const emptySearchResults: WorkspaceSearchResults = {
  notes: [],
  tags: [],
};

export function useWorkspaceSearch(options: { indexedOnEnter: boolean; qmdSelected: boolean }) {
  const [query, setQuery] = useState("");
  const [submittedQuery, setSubmittedQuery] = useState("");
  const [results, setResults] = useState<WorkspaceSearchResults>(emptySearchResults);
  const [resultMode, setResultMode] = useState<WorkspaceSearchResultMode>("idle");
  const [resultQuery, setResultQuery] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const runRef = useRef(0);
  const filenameResultsByQueryRef = useRef(new Map<string, WorkspaceSearchResults>());

  useEffect(() => {
    const runId = ++runRef.current;
    if (!submittedQuery.trim()) {
      setResults(emptySearchResults);
      setResultMode("idle");
      setResultQuery("");
      setMessage(null);
      return;
    }

    const normalizedQuery = submittedQuery.trim();
    const cachedResults = filenameResultsByQueryRef.current.get(normalizedQuery);
    if (cachedResults) {
      startTransition(() => {
        setResults(cachedResults);
        setResultMode("filename");
        setResultQuery(normalizedQuery);
        setMessage(null);
      });
    }

    void window.exograph.workspace.searchWorkspace(normalizedQuery).then(
      (nextResults) => {
        if (runRef.current !== runId) return;
        filenameResultsByQueryRef.current.set(normalizedQuery, nextResults);
        startTransition(() => {
          setResults(nextResults);
          setResultMode("filename");
          setResultQuery(normalizedQuery);
          setMessage(null);
        });
      },
      (error) => {
        if (runRef.current !== runId) return;
        console.warn("[exograph] workspace search failed", error);
        startTransition(() => {
          setResults(emptySearchResults);
          setResultMode("error");
          setResultQuery(normalizedQuery);
          setMessage("Filename search failed.");
        });
      },
    );
  }, [submittedQuery]);

  async function runIndexedSearch() {
    const trimmedQuery = query.trim();
    if (!trimmedQuery) {
      return;
    }
    if (!options.qmdSelected) {
      setResultMode("index-unavailable");
      setResultQuery(trimmedQuery);
      setMessage("QMD is not selected. Showing Simple search results.");
      return;
    }
    if (!options.indexedOnEnter) {
      setResultMode("index-unavailable");
      setResultQuery(trimmedQuery);
      setMessage("QMD search on Enter is off. Showing Simple search results.");
      return;
    }

    const runId = ++runRef.current;
    setResultMode("index-loading");
    setResultQuery(trimmedQuery);
    setMessage(null);
    try {
      const response = await window.exograph.workspace.searchIndex(trimmedQuery, { limit: 30 });
      if (runRef.current !== runId) {
        return;
      }
      const nextResults: WorkspaceSearchResults = {
        notes: response.results.map((result) => ({
          filePath: result.filePath,
          title: result.title,
          snippet: result.snippet,
          kind: "note" as const,
        })),
        tags: [],
      };
      startTransition(() => {
        setResults(nextResults);
        setResultMode(response.source === "qmd" ? "index" : "index-unavailable");
        setResultQuery(response.query);
        setMessage(response.warnings[0] ?? null);
      });
    } catch (error) {
      if (runRef.current !== runId) {
        return;
      }
      console.warn("[exograph] QMD workspace search failed", error);
      startTransition(() => {
        setResultMode("error");
        setResultQuery(trimmedQuery);
        setMessage(error instanceof Error ? error.message : "QMD search failed. Try Simple search in Settings.");
      });
    }
  }

  return {
    query,
    setQuery,
    submittedQuery,
    setSubmittedQuery,
    results,
    resultMode,
    resultQuery,
    message,
    runIndexedSearch,
  };
}
