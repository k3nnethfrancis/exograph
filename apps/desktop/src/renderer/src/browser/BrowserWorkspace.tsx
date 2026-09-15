import { useEffect, useRef, useState } from "react";
import { BookOpen, Network, PanelLeft, Search } from "lucide-react";
import type {
  IndexSearchResponse,
  TreeNode,
  VersionedNoteDocument,
  WorkspaceGraphContext,
  WorkspaceModel,
} from "@exograph/core";
import { NoteEditor } from "../components/NoteEditor";
import { SpatialGraphView } from "../components/SpatialGraphView";
import { useInspectedConcept } from "../hooks/useInspectedConcept";
import { resolveTheme } from "../theme/registry";
import { applyTheme } from "../theme/applyTheme";
import {
  browserApi as api,
  connectBrowser,
  graphApi,
  onBrowserChanged,
} from "./client";

type Draft = VersionedNoteDocument & {
  dirty: boolean;
  saveConflict?: "changed" | "missing";
};
const theme = resolveTheme(
  "exograph-neutral",
  matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light",
);

export function BrowserWorkspace() {
  const [workspace, setWorkspace] = useState<WorkspaceModel | null>(null);
  const [connection, setConnection] = useState("Connecting");
  const [error, setError] = useState<string | null>(null);
  const [sidebar, setSidebar] = useState(true);
  const [view, setView] = useState<"note" | "graph">("note");
  const [draft, setDraft] = useState<Draft | null>(null);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const [context, setContext] = useState<WorkspaceGraphContext | null>(null);
  const [saveStatus, setSaveStatus] = useState<
    "idle" | "saving" | "saved" | "error" | "conflict"
  >("idle");
  const saving = useRef(false);
  const navigation = useRef(0);
  const refreshSequence = useRef(0);
  const [pendingPath, setPendingPath] = useState<string | null>(null);
  const [propertiesCollapsed, setPropertiesCollapsed] = useState(true);
  const [fontSize, setFontSize] = useState(15);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<IndexSearchResponse | null>(null);
  const [searching, setSearching] = useState(false);
  const [treeVersion, setTreeVersion] = useState(0);
  const inspected = useInspectedConcept();
  const fail = (reason: unknown) =>
    setError(reason instanceof Error ? reason.message : String(reason));
  function update(next: Draft | null) {
    draftRef.current = next;
    setDraft(next);
  }

  useEffect(() => {
    applyTheme(document.documentElement, theme);
    let disposed = false,
      disconnect: (() => void) | undefined;
    void connectBrowser((status) => {
      if (!disposed)
        setConnection(
          status === "connected"
            ? "Connected"
            : status === "expired"
              ? "Workspace changed · run exo serve to reconnect"
              : "Reconnecting…",
        );
    })
      .then(async (close) => {
        if (disposed) {
          close();
          return;
        }
        disconnect = close;
        const model = await api.bootstrap();
        if (!disposed) setWorkspace(model);
      })
      .catch((reason) => {
        if (!disposed) {
          setConnection("Disconnected");
          fail(reason);
        }
      });
    return () => {
      disposed = true;
      disconnect?.();
    };
  }, []);

  useEffect(
    () =>
      onBrowserChanged(() => {
        setTreeVersion((value) => value + 1);
        const current = draftRef.current;
        if (!current || saving.current) return;
        const generation = navigation.current;
        const refresh = ++refreshSequence.current;
        void Promise.all([
          api.read(current.filePath),
          api.getGraphContext(current.filePath),
        ])
          .then(([next, graph]) => {
            if (
              refreshSequence.current !== refresh ||
              navigation.current !== generation ||
              draftRef.current?.filePath !== current.filePath ||
              saving.current
            )
              return;
            const latest = draftRef.current;
            setContext(graph);
            if (next.revision === latest.revision) return;
            if (latest.dirty) {
              update({ ...latest, saveConflict: "changed" });
              setSaveStatus("conflict");
            } else {
              update({ ...next, dirty: false });
              setSaveStatus("idle");
            }
          })
          .catch(fail);
      }),
    [],
  );

  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (draftRef.current?.dirty) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (!query.trim()) {
      setResults(null);
      setSearching(false);
      return;
    }
    setResults(null);
    setSearching(true);
    const timer = setTimeout(() => {
      void api
        .search(query)
        .then((response) => {
          if (!cancelled) setResults(response);
        })
        .catch((reason) => {
          if (!cancelled) fail(reason);
        })
        .finally(() => {
          if (!cancelled) setSearching(false);
        });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, treeVersion]);

  async function open(filePath: string, discard = false) {
    if (draftRef.current?.dirty && !discard) {
      setPendingPath(filePath);
      return;
    }
    const generation = ++navigation.current;
    setError(null);
    try {
      const [document, graph] = await Promise.all([
        api.read(filePath),
        api.getGraphContext(filePath),
      ]);
      if (generation !== navigation.current) return;
      if (!discard && draftRef.current?.dirty) {
        setPendingPath(filePath);
        return;
      }
      update({ ...document, dirty: false });
      setContext(graph);
      setSaveStatus("idle");
      setView("note");
      setPendingPath(null);
      if (window.innerWidth < 760) setSidebar(false);
      inspected.inspect({ filePath });
    } catch (reason) {
      if (generation === navigation.current) fail(reason);
    }
  }
  async function save(): Promise<boolean> {
    const current = draftRef.current;
    if (!current || !current.dirty) return true;
    if (saving.current) return false;
    saving.current = true;
    const generation = navigation.current;
    setSaveStatus("saving");
    try {
      const result = await api.save(
        current.filePath,
        current.frontmatter,
        current.body,
        current.revision,
      );
      if (navigation.current !== generation || draftRef.current?.filePath !== current.filePath) return false;
      if (result.status === "saved") {
        const latest = draftRef.current;
        update({
          ...latest,
          revision: result.revision,
          dirty:
            latest.body !== current.body ||
            latest.frontmatter !== current.frontmatter,
          saveConflict: undefined,
        });
        setSaveStatus("saved");
        void api.getGraphContext(current.filePath).then(graph => {
          if (navigation.current === generation && draftRef.current?.filePath === current.filePath) setContext(graph);
        }).catch(fail);
        return !draftRef.current?.dirty;
      }
      update({
        ...draftRef.current,
        saveConflict: result.status === "missing" ? "missing" : "changed",
      });
      setSaveStatus("conflict");
      return false;
    } catch (reason) {
      fail(reason);
      setSaveStatus("error");
      return false;
    } finally {
      saving.current = false;
    }
  }
  async function saveCopy() {
    const current = draftRef.current;
    if (!current || saving.current) return;
    saving.current = true;
    try {
      const copy = await api.saveCopy(
        current.filePath,
        current.frontmatter,
        current.body,
      );
      if (draftRef.current === current) {
        update({ ...copy, dirty: false });
        setSaveStatus("saved");
        const graph = await api.getGraphContext(copy.filePath);
        if (draftRef.current?.filePath === copy.filePath) setContext(graph);
      } else
        setError(
          `Saved your earlier edits as ${copy.filePath}. Current edits remain in this editor.`,
        );
    } catch (reason) {
      fail(reason);
    } finally {
      saving.current = false;
    }
  }
  async function openTarget(target: string) {
    const current = draftRef.current;
    if (!current) return;
    try {
      const resolved = await api.resolveTarget(current.filePath, target);
      if (resolved) await open(resolved);
      else setError(`No note found for ${target}.`);
    } catch (reason) {
      fail(reason);
    }
  }
  function edit(body: string, frontmatter = draftRef.current?.frontmatter) {
    const current = draftRef.current;
    if (!current || !frontmatter) return;
    update({ ...current, body, frontmatter, dirty: true });
    if (!current.saveConflict) setSaveStatus("idle");
  }
  const unsupported = () =>
    setError("This action is available in the Exo desktop app.");
  return (
    <div
      className="browser-workspace"
      onKeyDown={(event) => {
        if (
          (event.metaKey || event.ctrlKey) &&
          event.key.toLowerCase() === "s"
        ) {
          event.preventDefault();
          void save();
        }
      }}
    >
      <header className="browser-header">
        <button
          aria-label="Toggle notes"
          aria-expanded={sidebar}
          onClick={() => setSidebar(!sidebar)}
        >
          <PanelLeft size={18} />
        </button>
        <strong>Exo</strong>
        <span className="browser-workspace-name">
          {workspace?.workspaceRoot.split("/").pop()}
        </span>
        {draft?.dirty && (
          <button
            className="browser-save"
            disabled={saveStatus === "saving"}
            onClick={() => {
              void save();
            }}
          >
            {saveStatus === "saving" ? "Saving…" : "Save"}
          </button>
        )}
        <div className="browser-view-switch">
          <button
            aria-label="Notes"
            aria-pressed={view === "note"}
            onClick={() => setView("note")}
          >
            <BookOpen size={17} />
          </button>
          <button
            aria-label="Graph"
            aria-pressed={view === "graph"}
            onClick={() => {
              setView("graph");
              if (draft) inspected.focus({ filePath: draft.filePath });
              if (window.innerWidth < 760) setSidebar(false);
            }}
          >
            <Network size={17} />
          </button>
        </div>
        <span className="browser-connection" role="status">
          {connection}
        </span>
      </header>
      {error && (
        <div className="browser-message" role="alert">
          <span>{error}</span>
          <button aria-label="Dismiss message" onClick={() => setError(null)}>
            ×
          </button>
        </div>
      )}
      {pendingPath && (
        <div className="browser-message">
          <span>Save your changes before opening another note?</span>
          <button
            onClick={() => {
              void save().then((saved) => {
                if (saved) void open(pendingPath, true);
              });
            }}
          >
            Save and open
          </button>
          <button
            onClick={() => {
              void open(pendingPath, true);
            }}
          >
            Discard and open
          </button>
          <button onClick={() => setPendingPath(null)}>Cancel</button>
        </div>
      )}
      <div className="browser-body">
        {sidebar && (
          <aside className="browser-sidebar" aria-label="Notes navigation">
            <label className="browser-search">
              <Search size={16} />
              <input
                aria-label="Search notes"
                placeholder="Search notes"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
            {searching && <p role="status">Searching…</p>}
            {query.trim() ? (
              <div className="browser-results">
                {results?.warnings.map((warning) => (
                  <p key={warning}>{warning}</p>
                ))}
                {results?.results.map((result) => (
                  <button
                    key={result.filePath}
                    onClick={() => {
                      void open(result.filePath);
                    }}
                  >
                    <strong>{result.title}</strong>
                    <small>{result.snippet}</small>
                  </button>
                ))}
                {results && !results.results.length && !searching && (
                  <p>No matching notes.</p>
                )}
              </div>
            ) : (
              workspace?.noteRoots.map((root) => (
                <Folder
                  key={root.path}
                  name={root.label}
                  path={root.path}
                  version={treeVersion}
                  onOpen={(file) => {
                    void open(file);
                  }}
                  onError={fail}
                  initialOpen
                />
              ))
            )}
          </aside>
        )}
        <main className="browser-content">
          {view === "graph" && workspace ? (
            <SpatialGraphView
              api={graphApi}
              showOntologyControls={false}
              inverseNavigation={false}
              showOverflowLabels={false}
              inspectedConcept={inspected.state.concept}
              focusRequest={inspected.state.focusRequest}
              graphReturnPath={draft?.filePath}
              isTargetOpen={(path) => draft?.filePath === path}
              onRestoreEditorConcept={(path) => {
                void open(path);
              }}
              onActivateOpenTarget={(path) => {
                setView("note");
                if (draft?.filePath !== path) void open(path);
              }}
              onOpenTarget={(path) => {
                void open(path);
              }}
              onFocus={() => {}}
            />
          ) : draft ? (
            <>
              <NoteEditor
                document={draft}
                graphContext={context}
                saveStatus={saveStatus}
                propertiesCollapsed={propertiesCollapsed}
                onToggleProperties={() =>
                  setPropertiesCollapsed(!propertiesCollapsed)
                }
                onOpenGraph={() => {
                  inspected.focus({ filePath: draft.filePath });
                  setView("graph");
                }}
                onUpdateFrontmatter={(key, value) =>
                  edit(draftRef.current!.body, {
                    ...draftRef.current!.frontmatter,
                    [key]: value,
                  })
                }
                onBodyChange={(body) => edit(body)}
                onSave={async () => {
                  await save();
                }}
                onSaveConflictCopy={() => {
                  void saveCopy();
                }}
                onDiscardSaveConflict={async () => {
                  await open(draft.filePath, true);
                }}
                onRecoverDeleted={() => {
                  void saveCopy();
                }}
                onSaveDeletedAs={() => {
                  void saveCopy();
                }}
                onOpenTag={(tag) => {
                  setQuery(tag);
                  setSidebar(true);
                }}
                onOpenTarget={(target) => {
                  void openTarget(target);
                }}
                onSuggestTargets={async (query) =>
                  (await api.suggestTargets(draft.filePath, query)).map(
                    (item) => ({
                      label: item.title,
                      target: item.target,
                      detail: item.snippet,
                    }),
                  )
                }
                onPreviewTarget={async (target) => {
                  const path = await api.resolveTarget(draft.filePath, target);
                  if (!path) return null;
                  const note = await api.read(path);
                  return {
                    title: note.title,
                    excerpt: note.body.slice(0, 350),
                  };
                }}
                resolveMarkdownImage={api.resolveMarkdownImage}
                agentCommands={[]}
                onInvokeAgent={unsupported}
                invocationReview={null}
                editingFrozen={false}
                historyAvailable={false}
                onOpenHistory={unsupported}
                onFocus={() => {}}
                theme={theme}
                fontSize={fontSize}
                onAppZoom={(direction) =>
                  setFontSize((size) =>
                    direction === 0
                      ? 15
                      : Math.max(11, Math.min(24, size + direction)),
                  )
                }
                compact
                isNoteDocument
                onDiagnosticContext={() => {}}
              />
            </>
          ) : (
            <div className="browser-empty">
              <BookOpen size={28} />
              <p>Open a note or explore the graph.</p>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
function Folder({
  name,
  path,
  version,
  onOpen,
  onError,
  initialOpen = false,
}: {
  name: string;
  path: string;
  version: number;
  onOpen: (path: string) => void;
  onError: (error: unknown) => void;
  initialOpen?: boolean;
}) {
  const [expanded, setExpanded] = useState(initialOpen);
  const [nodes, setNodes] = useState<TreeNode[] | null>(null);
  useEffect(() => {
    if (!expanded) return;
    let cancelled = false;
    void api
      .listTree(path)
      .then((nodes) => {
        if (!cancelled) setNodes(nodes);
      })
      .catch((reason) => {
        if (!cancelled) onError(reason);
      });
    return () => {
      cancelled = true;
    };
  }, [path, expanded, version]);
  return (
    <div className="browser-folder">
      <button aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
        {expanded ? "▾" : "▸"} {name}
      </button>
      {expanded && (
        <div className="browser-folder-children">
          {nodes ? (
            nodes.map((node) =>
              node.kind === "directory" ? (
                <Folder
                  key={node.path}
                  name={node.name}
                  path={node.path}
                  version={version}
                  onOpen={onOpen}
                  onError={onError}
                />
              ) : (
                <button
                  key={node.path}
                  className="browser-note"
                  onClick={() => onOpen(node.path)}
                >
                  {node.name.replace(/\.md$/i, "")}
                </button>
              ),
            )
          ) : (
            <small>Loading…</small>
          )}
        </div>
      )}
    </div>
  );
}
