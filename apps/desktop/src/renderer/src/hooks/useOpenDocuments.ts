import { useEffect, useRef, useState } from "react";
import { noteTitle } from "@exograph/core/note-title";
import type { NoteDocument, WorkspaceGraphContext, WorkspaceModel } from "@exograph/core";

import type { FileStatInfo } from "../../../shared/api";
import { DocumentSaveBarrier } from "./documentSaveBarrier";

export interface OpenEditorDocument extends NoteDocument {
  dirty: boolean;
  revision?: string;
  saveConflict?: "changed" | "missing";
  resolvingConflict?: boolean;
  diskVersion: FileStatInfo | null;
  /** Ephemeral review documents are exact snapshots and never save to disk. */
  readOnly?: boolean;
  /** The backing workspace path disappeared outside Exograph; the buffer remains recoverable. */
  filesystemState?: "deleted";
}

export type DocumentSaveStatus = "idle" | "saving" | "saved" | "error" | "conflict";

const AUTOSAVE_IDLE_DELAY_MS = 2_000;
const AUTOSAVE_MAX_DELAY_MS = 5_000;
const CONTEXT_COMMIT_IDLE_DELAY_MS = 500;

export function selectActiveDocument(
  documents: Record<string, OpenEditorDocument>,
  activeDocumentPath: string | null,
): OpenEditorDocument | null {
  return activeDocumentPath ? documents[activeDocumentPath] ?? null : null;
}

/**
 * Editor panes emit their own document path. Mutations must never infer that
 * target from ambient focus because another split may have gained focus before
 * React processes the event.
 */
export function applyDocumentBodyEdit(
  documents: Record<string, OpenEditorDocument>,
  filePath: string,
  body: string,
): Record<string, OpenEditorDocument> | null {
  const currentDocument = documents[filePath];
  if (!currentDocument || currentDocument.readOnly || currentDocument.resolvingConflict) return null;
  const title = currentDocument.kind === "markdown" && noteTitleSource(currentDocument.body) !== noteTitleSource(body)
    ? noteTitle(filePath, currentDocument.frontmatter, body)
    : currentDocument.title;
  return {
    ...documents,
    [filePath]: { ...currentDocument, body, title, dirty: true },
  };
}

export function applyDocumentFrontmatterEdit(
  documents: Record<string, OpenEditorDocument>,
  filePath: string,
  key: string,
  value: unknown,
): Record<string, OpenEditorDocument> | null {
  const currentDocument = documents[filePath];
  if (!currentDocument || currentDocument.readOnly || currentDocument.resolvingConflict) return null;
  const frontmatter = { ...currentDocument.frontmatter, [key]: value };
  return {
    ...documents,
    [filePath]: {
      ...currentDocument,
      frontmatter,
      title: currentDocument.kind === "markdown" ? noteTitle(filePath, frontmatter, currentDocument.body) : currentDocument.title,
      dirty: true,
    },
  };
}

export interface UseOpenDocumentsOptions {
  workspaceModel: WorkspaceModel | null;
  /** Derived from the focused editor leaf; this hook does not own selection. */
  activeDocumentPath: string | null;
  getOpenEditorPaths: () => Set<string>;
  getEditorScrollTopForPath: (filePath: string) => number | null;
}

export function useOpenDocuments(options: UseOpenDocumentsOptions) {
  const [openDocuments, setOpenDocuments] = useState<Record<string, OpenEditorDocument>>({});
  const [documentSaveStatuses, setDocumentSaveStatuses] = useState<Record<string, DocumentSaveStatus>>({});
  const [graphContextByPath, setGraphContextByPath] = useState<Record<string, WorkspaceGraphContext>>({});
  const [scrollRestoreRequest, setScrollRestoreRequest] = useState<{ filePath: string; scrollTop: number; nonce: number } | null>(null);
  const [conflictRevealRequest, setConflictRevealRequest] = useState<{ filePath: string; nonce: number } | null>(null);
  const conflictRevealNonceRef = useRef(0);
  const [transitionPending, setTransitionPending] = useState(false);
  const transitionPendingRef = useRef(false);
  const openDocumentsRef = useRef(openDocuments);
  const optionsRef = useRef(options);
  const pendingRefreshesRef = useRef<Map<string, { timeoutId: number; diskVersion: FileStatInfo | null }>>(new Map());
  const pendingContextRefreshesRef = useRef<Map<string, { timeoutId?: number; idleId?: number }>>(new Map());
  const pendingContextCommitsRef = useRef<Map<string, number>>(new Map());
  const pendingAutosavesRef = useRef<Map<string, number>>(new Map());
  const saveBarrierRef = useRef(new DocumentSaveBarrier());
  const dirtySinceRef = useRef<Map<string, number>>(new Map());
  const lastEditorInputAtRef = useRef(0);
  const scrollRestoreNonceRef = useRef(0);

  const activeDocument = selectActiveDocument(openDocuments, options.activeDocumentPath);
  const activeGraphContext = options.activeDocumentPath ? graphContextByPath[options.activeDocumentPath] ?? null : null;

  useEffect(() => {
    openDocumentsRef.current = openDocuments;
  }, [openDocuments]);

  useEffect(() => {
    optionsRef.current = options;
  }, [options]);

  useEffect(() => {
    const recordEditorInput = (event: InputEvent) => {
      if ((event.target as HTMLElement | null)?.closest?.(".cm-content")) {
        lastEditorInputAtRef.current = performance.now();
      }
    };
    document.addEventListener("beforeinput", recordEditorInput, { capture: true });
    return () => document.removeEventListener("beforeinput", recordEditorInput, { capture: true });
  }, []);

  useEffect(() => () => {
    for (const timeoutId of pendingAutosavesRef.current.values()) {
      window.clearTimeout(timeoutId);
    }
    pendingAutosavesRef.current.clear();
    for (const timeoutId of pendingContextCommitsRef.current.values()) {
      window.clearTimeout(timeoutId);
    }
    pendingContextCommitsRef.current.clear();
    for (const pending of pendingContextRefreshesRef.current.values()) {
      if (pending.timeoutId !== undefined) window.clearTimeout(pending.timeoutId);
      if (pending.idleId !== undefined) window.cancelIdleCallback(pending.idleId);
    }
    pendingContextRefreshesRef.current.clear();
  }, []);

  useEffect(() => {
    window.__exographFlushDirtyDocuments = flushDirtyDocuments;
    window.__exographPrepareDocumentTransition = prepareDocumentTransition;
    window.__exographFinishDocumentTransition = finishDocumentTransition;
    return () => {
      if (window.__exographFlushDirtyDocuments === flushDirtyDocuments) {
        delete window.__exographFlushDirtyDocuments;
        delete window.__exographPrepareDocumentTransition;
        delete window.__exographFinishDocumentTransition;
      }
    };
  });

  useEffect(() => {
    const guardReload = (event: BeforeUnloadEvent) => {
      if (!Object.values(openDocumentsRef.current).some((document) => document.dirty)) return;
      event.preventDefault();
      event.returnValue = "";
      if (transitionPendingRef.current) return;
      void prepareDocumentTransition().then(() => window.location.reload()).catch(() => {});
    };
    window.addEventListener("beforeunload", guardReload);
    return () => window.removeEventListener("beforeunload", guardReload);
  }, []);

  useEffect(() => window.exograph.workspace.onGraphChanged(() => {
    for (const [filePath, document] of Object.entries(openDocumentsRef.current)) {
      scheduleMarkdownContextRefresh(document, filePath);
    }
  }), []);

  function pruneToOpenPaths(openPaths: Set<string>) {
    setOpenDocuments((current) => {
      const next = Object.fromEntries(
        Object.entries(current).filter(([filePath, document]) => openPaths.has(filePath) || document.dirty),
      );
      return Object.keys(next).length === Object.keys(current).length ? current : next;
    });
    setGraphContextByPath((current) => pruneRecordToKeys(current, openPaths));
  }

  async function ensureDocumentLoaded(filePath: string) {
    // A closed dirty/conflicted buffer is still the editor authority. Reopening
    // it must work even if the external file has disappeared.
    if (openDocumentsRef.current[filePath]?.dirty) return;
    const [document, diskVersion] = await Promise.all([window.exograph.notes.read(filePath), window.exograph.notes.stat(filePath)]);

    setOpenDocuments((current) => ({
      ...current,
      [filePath]: {
        ...document,
        ...(current[filePath]?.dirty ? current[filePath] : {}),
        dirty: current[filePath]?.dirty ?? false,
        diskVersion: current[filePath]?.dirty ? current[filePath].diskVersion : diskVersion,
        frontmatter: current[filePath]?.dirty ? current[filePath].frontmatter : document.frontmatter,
        body: current[filePath]?.dirty ? current[filePath].body : document.body,
      },
    }));
    scheduleMarkdownContextRefresh(document, filePath);
  }

  function openVirtualDocument(document: NoteDocument) {
    const nextDocuments = {
      ...openDocumentsRef.current,
      [document.filePath]: {
        ...document,
        dirty: false,
        diskVersion: null,
        readOnly: true,
      },
    };
    openDocumentsRef.current = nextDocuments;
    setOpenDocuments(nextDocuments);
    setDocumentSaveStatuses((current) => ({ ...current, [document.filePath]: "idle" }));
  }

  function scheduleRefresh(filePath: string, diskVersion?: FileStatInfo | null) {
    const currentDocument = openDocumentsRef.current[filePath];
    if (!currentDocument || currentDocument.dirty || currentDocument.filesystemState === "deleted") {
      return;
    }

    const pending = pendingRefreshesRef.current.get(filePath);
    if (pending) {
      window.clearTimeout(pending.timeoutId);
    }

    const timeoutId = window.setTimeout(() => {
      pendingRefreshesRef.current.delete(filePath);
      void refreshFromDisk(filePath, diskVersion);
    }, 250);
    pendingRefreshesRef.current.set(filePath, { timeoutId, diskVersion: diskVersion ?? null });
  }

  async function refreshFromDisk(filePath: string, knownVersion?: FileStatInfo | null) {
    const currentDocument = openDocumentsRef.current[filePath];
    if (!currentDocument || currentDocument.dirty || currentDocument.filesystemState === "deleted") {
      return;
    }

    const scrollTop = filePath === optionsRef.current.activeDocumentPath ? optionsRef.current.getEditorScrollTopForPath(filePath) : null;
    const [document, diskVersion] = await Promise.all([
      window.exograph.notes.read(filePath),
      knownVersion === undefined ? window.exograph.notes.stat(filePath) : Promise.resolve(knownVersion),
    ]);
    setOpenDocuments((current) => {
      const currentDocument = current[filePath];
      if (!currentDocument || currentDocument.dirty) {
        return current;
      }

      if (
        currentDocument.body === document.body &&
        JSON.stringify(currentDocument.frontmatter) === JSON.stringify(document.frontmatter)
      ) {
        return {
          ...current,
          [filePath]: {
            ...currentDocument,
            revision: document.revision,
            diskVersion,
          },
        };
      }

      return {
        ...current,
        [filePath]: {
          ...document,
          dirty: false,
          diskVersion,
        },
      };
    });
    scheduleMarkdownContextRefresh(document, filePath);

    if (scrollTop !== null) {
      scrollRestoreNonceRef.current += 1;
      setScrollRestoreRequest({ filePath, scrollTop, nonce: scrollRestoreNonceRef.current });
    }
  }

  async function reloadFromDisk(filePath: string) {
    const currentDocument = openDocumentsRef.current[filePath];
    if (!currentDocument) {
      return;
    }

    const scrollTop = filePath === optionsRef.current.activeDocumentPath ? optionsRef.current.getEditorScrollTopForPath(filePath) : null;
    const [document, diskVersion] = await Promise.all([
      window.exograph.notes.read(filePath),
      window.exograph.notes.stat(filePath),
    ]);
    if (!openDocumentsRef.current[filePath]) return;
    const next = { ...openDocumentsRef.current, [filePath]: { ...document, dirty: false, diskVersion } };
    openDocumentsRef.current = next;
    setOpenDocuments(next);
    scheduleMarkdownContextRefresh(document, filePath);
    setDocumentSaveStatuses((current) => ({ ...current, [filePath]: "idle" }));
    dirtySinceRef.current.delete(filePath);

    if (scrollTop !== null) {
      scrollRestoreNonceRef.current += 1;
      setScrollRestoreRequest({ filePath, scrollTop, nonce: scrollRestoreNonceRef.current });
    }
  }

  function updateBody(filePath: string, body: string) {
    if (transitionPendingRef.current) return;
    const nextDocuments = applyDocumentBodyEdit(openDocumentsRef.current, filePath, body);
    if (!nextDocuments) return;
    openDocumentsRef.current = nextDocuments;
    setOpenDocuments(nextDocuments);
    setDocumentSaveStatuses((current) => ({ ...current, [filePath]: nextDocuments[filePath].saveConflict ? "conflict" : "idle" }));
    scheduleAutosave(filePath);
  }

  function updateFrontmatter(filePath: string, key: string, value: unknown) {
    if (transitionPendingRef.current) return;
    const nextDocuments = applyDocumentFrontmatterEdit(openDocumentsRef.current, filePath, key, value);
    if (!nextDocuments) return;
    openDocumentsRef.current = nextDocuments;
    setOpenDocuments(nextDocuments);
    setDocumentSaveStatuses((current) => ({ ...current, [filePath]: nextDocuments[filePath].saveConflict ? "conflict" : "idle" }));
    scheduleAutosave(filePath);
  }

  function saveDocument(filePath: string): Promise<void> {
    if (openDocumentsRef.current[filePath]?.filesystemState === "deleted") {
      return Promise.resolve();
    }
    cancelPendingAutosave(filePath);
    return saveBarrierRef.current.run(filePath, () => performSaveDocument(filePath));
  }

  async function performSaveDocument(filePath: string) {
    const document = openDocumentsRef.current[filePath];
    if (!document || document.readOnly || !document.dirty || document.filesystemState === "deleted") {
      return;
    }

    if (document.saveConflict) {
      setConflictRevealRequest({ filePath, nonce: ++conflictRevealNonceRef.current });
      throw new Error("Resolve the document conflict before continuing.");
    }
    if (document.resolvingConflict) throw new Error("Wait for document conflict resolution to finish.");
    setDocumentSaveStatuses((current) => ({ ...current, [filePath]: "saving" }));
    try {
      if (!document.revision) throw new Error("Reload the document before saving: its disk revision is unavailable.");
      const result = await window.exograph.notes.save(filePath, document.frontmatter, document.body, document.revision);
      if (result.status !== "saved") {
        const latest = openDocumentsRef.current[filePath];
        if (latest) {
          const next = { ...openDocumentsRef.current, [filePath]: { ...latest, dirty: true, saveConflict: result.status === "missing" ? "missing" as const : "changed" as const } };
          openDocumentsRef.current = next;
          setOpenDocuments(next);
        }
        cancelPendingAutosave(filePath);
        if (latest) setConflictRevealRequest({ filePath, nonce: ++conflictRevealNonceRef.current });
        setDocumentSaveStatuses((current) => ({ ...current, [filePath]: "conflict" }));
        throw new Error("The file changed outside Exograph. Save a copy or discard local edits to continue.");
      }
      const diskVersion = await window.exograph.notes.stat(filePath);
      const remainsOpen = optionsRef.current.getOpenEditorPaths().has(filePath);
      if (document.kind === "markdown" && remainsOpen && isAttachedNote(filePath, optionsRef.current.workspaceModel)) {
        scheduleMarkdownContextRefresh(document, filePath);
      }
      const current = openDocumentsRef.current;
      const latest = current[filePath];
      if (latest) {
        const stillDirty = latest.body !== document.body
          || JSON.stringify(latest.frontmatter) !== JSON.stringify(document.frontmatter);
        const next = { ...current };
        if (!remainsOpen && !stillDirty) delete next[filePath];
        else next[filePath] = { ...latest, dirty: stillDirty, diskVersion, revision: result.revision };
        openDocumentsRef.current = next;
        setOpenDocuments(next);
        if (stillDirty) {
          dirtySinceRef.current.set(filePath, performance.now());
          scheduleAutosave(filePath);
        } else {
          dirtySinceRef.current.delete(filePath);
        }
      }
      setDocumentSaveStatuses((current) => ({ ...current, [filePath]: "saved" }));
      window.setTimeout(() => {
        setDocumentSaveStatuses((current) => current[filePath] === "saved" ? { ...current, [filePath]: "idle" } : current);
      }, 1600);
    } catch (error) {
      console.error("[exograph] failed to save document", { filePath, error });
      setDocumentSaveStatuses((current) => ({ ...current, [filePath]: openDocumentsRef.current[filePath]?.saveConflict ? "conflict" : "error" }));
      throw error;
    }
  }

  /**
   * Make editor state observable to exact review before main probes the file.
   * The caller disables editing first, so draining then flushing produces one
   * stable on-disk version: a human edit becomes a visible review conflict.
   */
  async function prepareDocumentsForReview(filePaths: readonly string[]): Promise<void> {
    const uniquePaths = [...new Set(filePaths)];
    for (const filePath of uniquePaths) cancelPendingAutosave(filePath);
    await Promise.all(uniquePaths.map(async (filePath) => {
      await saveBarrierRef.current.idle(filePath);
      cancelPendingAutosave(filePath);
      if (openDocumentsRef.current[filePath]?.dirty) await saveDocument(filePath);
      await saveBarrierRef.current.idle(filePath);
    }));
  }

  /** Discard a settled review proposal only after all prior writes are done. */
  async function discardAndReloadDocument(filePath: string): Promise<void> {
    cancelPendingAutosave(filePath);
    await saveBarrierRef.current.idle(filePath);
    cancelPendingAutosave(filePath);
    await reloadFromDisk(filePath);
  }

  function deletePathsWithin(targetPath: string) {
    for (const filePath of pendingAutosavesRef.current.keys()) {
      if (isPathWithin(targetPath, filePath)) cancelPendingAutosave(filePath);
    }
    for (const filePath of dirtySinceRef.current.keys()) {
      if (isPathWithin(targetPath, filePath)) dirtySinceRef.current.delete(filePath);
    }
    setOpenDocuments((current) =>
      Object.fromEntries(Object.entries(current).filter(([filePath]) => !isPathWithin(targetPath, filePath))),
    );
    setGraphContextByPath((current) =>
      Object.fromEntries(Object.entries(current).filter(([filePath]) => !isPathWithin(targetPath, filePath))),
    );
  }

  function remapOpenPaths(sourcePath: string, nextPath: string) {
    const dirtyTimesToRemap = Array.from(dirtySinceRef.current.entries())
      .filter(([filePath]) => isPathWithin(sourcePath, filePath));
    const autosavesToRemap = Array.from(pendingAutosavesRef.current.keys())
      .filter((filePath) => isPathWithin(sourcePath, filePath))
      .map((filePath) => filePath.replace(sourcePath, nextPath));
    for (const filePath of pendingAutosavesRef.current.keys()) {
      if (isPathWithin(sourcePath, filePath)) cancelPendingAutosave(filePath);
    }
    for (const [filePath, dirtySince] of dirtyTimesToRemap) {
      dirtySinceRef.current.delete(filePath);
      dirtySinceRef.current.set(filePath.replace(sourcePath, nextPath), dirtySince);
    }
    const remapRecord = <T,>(record: Record<string, T>): Record<string, T> =>
      Object.fromEntries(
        Object.entries(record).map(([filePath, value]) => [
          isPathWithin(sourcePath, filePath) ? filePath.replace(sourcePath, nextPath) : filePath,
          value,
        ]),
      );

    setOpenDocuments((current) =>
      Object.fromEntries(
        Object.entries(current).map(([filePath, value]) => {
          const remappedPath = isPathWithin(sourcePath, filePath) ? filePath.replace(sourcePath, nextPath) : filePath;
          return [
            remappedPath,
            {
              ...value,
              filePath: remappedPath,
            },
          ];
        }),
      ),
    );
    setGraphContextByPath((current) => remapRecord(current));
    for (const filePath of autosavesToRemap) scheduleAutosave(filePath);
  }

  function scheduleAutosave(filePath: string) {
    if (openDocumentsRef.current[filePath]?.saveConflict) return;
    if (openDocumentsRef.current[filePath]?.filesystemState === "deleted") return;
    if (!dirtySinceRef.current.has(filePath)) dirtySinceRef.current.set(filePath, performance.now());
    cancelPendingAutosave(filePath);
    const dirtyForMs = performance.now() - (dirtySinceRef.current.get(filePath) ?? performance.now());
    const timeoutId = window.setTimeout(
      () => runAutosaveWhenIdle(filePath),
      Math.max(0, Math.min(AUTOSAVE_IDLE_DELAY_MS, AUTOSAVE_MAX_DELAY_MS - dirtyForMs)),
    );
    pendingAutosavesRef.current.set(filePath, timeoutId);
  }

  function runAutosaveWhenIdle(filePath: string) {
    if (openDocumentsRef.current[filePath]?.filesystemState === "deleted") {
      pendingAutosavesRef.current.delete(filePath);
      return;
    }
    const idleForMs = performance.now() - lastEditorInputAtRef.current;
    const dirtyForMs = performance.now() - (dirtySinceRef.current.get(filePath) ?? performance.now());
    if (idleForMs < AUTOSAVE_IDLE_DELAY_MS && dirtyForMs < AUTOSAVE_MAX_DELAY_MS) {
      const timeoutId = window.setTimeout(
        () => runAutosaveWhenIdle(filePath),
        Math.min(AUTOSAVE_IDLE_DELAY_MS - idleForMs, AUTOSAVE_MAX_DELAY_MS - dirtyForMs),
      );
      pendingAutosavesRef.current.set(filePath, timeoutId);
      return;
    }
    pendingAutosavesRef.current.delete(filePath);
    void saveDocument(filePath).catch(() => { /* Save state owns the visible error. */ });
  }

  async function flushDirtyDocuments(): Promise<void> {
    const dirtyPaths = Object.entries(openDocumentsRef.current)
      .filter(([, document]) => document.dirty && document.filesystemState !== "deleted")
      .map(([filePath]) => filePath);
    await Promise.all(dirtyPaths.map((filePath) => saveDocument(filePath)));
  }

  async function prepareDocumentTransition(): Promise<void> {
    if (transitionPendingRef.current) throw new Error("A document transition is already in progress.");
    transitionPendingRef.current = true;
    setTransitionPending(true);
    try { await flushDirtyDocuments(); }
    catch (error) { finishDocumentTransition(); throw error; }
  }

  function finishDocumentTransition() {
    transitionPendingRef.current = false;
    setTransitionPending(false);
  }

  function setResolvingConflict(filePath: string, resolvingConflict: boolean) {
    const document = openDocumentsRef.current[filePath];
    if (!document) return;
    const next = { ...openDocumentsRef.current, [filePath]: { ...document, resolvingConflict } };
    openDocumentsRef.current = next;
    setOpenDocuments(next);
  }

  async function saveConflictCopy(filePath: string, destination: string): Promise<void> {
    const document = openDocumentsRef.current[filePath];
    if (!document?.saveConflict || document.resolvingConflict) throw new Error("The conflict is no longer available.");
    if (document.kind === "markdown" && !/\.md(?:own)?$/i.test(destination)) {
      throw new Error("Use a Markdown filename (.md) to preserve this document’s properties.");
    }
    cancelPendingAutosave(filePath);
    setResolvingConflict(filePath, true);
    try {
      await saveBarrierRef.current.idle(filePath);
      const copy = await window.exograph.notes.saveCopy(destination, document.frontmatter, document.body);
      const next = { ...openDocumentsRef.current };
      delete next[filePath];
      next[destination] = { ...copy, dirty: false, diskVersion: null };
      openDocumentsRef.current = next;
      setOpenDocuments(next);
      dirtySinceRef.current.delete(filePath);
      setDocumentSaveStatuses((current) => ({ ...current, [filePath]: "idle", [destination]: "saved" }));
    } finally { setResolvingConflict(filePath, false); }
  }

  async function discardSaveConflict(filePath: string): Promise<"reloaded" | "closed"> {
    const document = openDocumentsRef.current[filePath];
    if (!document?.saveConflict || document.resolvingConflict) throw new Error("The conflict is no longer available.");
    cancelPendingAutosave(filePath);
    setResolvingConflict(filePath, true);
    try {
      await saveBarrierRef.current.idle(filePath);
      if (document.saveConflict === "missing") {
        const next = { ...openDocumentsRef.current };
        delete next[filePath];
        openDocumentsRef.current = next;
        setOpenDocuments(next);
        dirtySinceRef.current.delete(filePath);
        return "closed";
      }
      await reloadFromDisk(filePath);
      return "reloaded";
    } finally { setResolvingConflict(filePath, false); }
  }

  function cancelPendingAutosave(filePath: string) {
    const timeoutId = pendingAutosavesRef.current.get(filePath);
    if (timeoutId !== undefined) window.clearTimeout(timeoutId);
    pendingAutosavesRef.current.delete(filePath);
  }

  async function reconcileOpenDocumentFilesystemState(): Promise<void> {
    const candidates = Object.entries(openDocumentsRef.current)
      .filter(([, document]) => !document.readOnly)
      .map(([filePath]) => filePath);
    const results = await Promise.all(candidates.map(async (filePath) => {
      try {
        return [filePath, await window.exograph.notes.stat(filePath)] as const;
      } catch {
        return [filePath, null] as const;
      }
    }));
    const missingPaths = new Set(results.filter(([, stat]) => stat === null).map(([filePath]) => filePath));
    if (missingPaths.size === 0) return;
    for (const filePath of missingPaths) cancelPendingAutosave(filePath);
    setOpenDocuments((current) => {
      const next = { ...current };
      for (const filePath of missingPaths) {
        const document = next[filePath];
        if (document) next[filePath] = { ...document, filesystemState: "deleted" };
      }
      openDocumentsRef.current = next;
      return next;
    });
    setDocumentSaveStatuses((current) => Object.fromEntries(
      Object.entries(current).map(([filePath, status]) => [filePath, missingPaths.has(filePath) ? "idle" : status]),
    ));
  }

  async function recoverDeletedDocument(sourcePath: string, destinationPath: string): Promise<void> {
    const document = openDocumentsRef.current[sourcePath];
    if (!document || document.filesystemState !== "deleted") return;
    await window.exograph.notes.saveCopy(destinationPath, document.frontmatter, document.body);
    const diskVersion = await window.exograph.notes.stat(destinationPath);
    const next = { ...openDocumentsRef.current };
    delete next[sourcePath];
    next[destinationPath] = { ...document, filePath: destinationPath, dirty: false, diskVersion, filesystemState: undefined, saveConflict: undefined };
    openDocumentsRef.current = next;
    setOpenDocuments(next);
    setDocumentSaveStatuses((current) => {
      const updated = { ...current };
      delete updated[sourcePath];
      updated[destinationPath] = "saved";
      return updated;
    });
    dirtySinceRef.current.delete(sourcePath);
  }

  function updateMarkdownContext(filePath: string, graphContext: WorkspaceGraphContext | null) {
    setGraphContextByPath((current) => ({
      ...current,
      ...(graphContext ? { [filePath]: graphContext } : {}),
    }));
  }

  function scheduleMarkdownContextRefresh(document: NoteDocument, filePath: string) {
    const pendingCommit = pendingContextCommitsRef.current.get(filePath);
    if (pendingCommit !== undefined) window.clearTimeout(pendingCommit);
    pendingContextCommitsRef.current.delete(filePath);
    const existing = pendingContextRefreshesRef.current.get(filePath);
    if (existing?.timeoutId !== undefined) window.clearTimeout(existing.timeoutId);
    if (existing?.idleId !== undefined) window.cancelIdleCallback(existing.idleId);

    const pending: { timeoutId?: number; idleId?: number } = {};
    pending.timeoutId = window.setTimeout(() => {
      delete pending.timeoutId;
      const run = () => {
        pendingContextRefreshesRef.current.delete(filePath);
        void loadMarkdownContext(document, filePath, optionsRef.current.workspaceModel).then((graphContext) => {
          scheduleMarkdownContextCommit(filePath, graphContext);
        }).catch((error) => {
          console.warn("[exograph] failed to load graph context", { filePath, error });
        });
      };
      if (typeof window.requestIdleCallback === "function") {
        pending.idleId = window.requestIdleCallback(run, { timeout: 1_500 });
      } else {
        run();
      }
    }, 250);
    pendingContextRefreshesRef.current.set(filePath, pending);
  }

  function scheduleMarkdownContextCommit(filePath: string, graphContext: WorkspaceGraphContext | null) {
    const existing = pendingContextCommitsRef.current.get(filePath);
    if (existing !== undefined) window.clearTimeout(existing);
    const idleForMs = performance.now() - lastEditorInputAtRef.current;
    const delayMs = Math.max(0, CONTEXT_COMMIT_IDLE_DELAY_MS - idleForMs);
    const timeoutId = window.setTimeout(() => {
      const currentIdleForMs = performance.now() - lastEditorInputAtRef.current;
      if (currentIdleForMs < CONTEXT_COMMIT_IDLE_DELAY_MS) {
        scheduleMarkdownContextCommit(filePath, graphContext);
        return;
      }
      pendingContextCommitsRef.current.delete(filePath);
      updateMarkdownContext(filePath, graphContext);
    }, delayMs);
    pendingContextCommitsRef.current.set(filePath, timeoutId);
  }

  return {
    openDocuments,
    transitionPending,
    conflictRevealRequest,
    saveConflictCopy,
    discardSaveConflict,
    graphContextByPath,
    documentSaveStatuses,
    activeDocumentPath: options.activeDocumentPath,
    activeDocument,
    activeGraphContext,
    scrollRestoreRequest,
    pruneToOpenPaths,
    ensureDocumentLoaded,
    openVirtualDocument,
    scheduleRefresh,
    reloadFromDisk,
    updateBody,
    updateFrontmatter,
    saveDocument,
    prepareDocumentsForReview,
    discardAndReloadDocument,
    deletePathsWithin,
    remapOpenPaths,
    reconcileOpenDocumentFilesystemState,
    recoverDeletedDocument,
  };
}

declare global {
  interface Window {
    __exographFlushDirtyDocuments?: () => Promise<void>;
    __exographPrepareDocumentTransition?: () => Promise<void>;
    __exographFinishDocumentTransition?: () => void;
  }
}

function noteTitleSource(body: string): string {
  let start = 0;
  while (start < body.length && /\s/.test(body[start])) start += 1;
  const newline = body.indexOf("\n", start);
  const end = newline === -1 ? body.length : newline;
  return body.slice(start, end).replace(/\r$/, "");
}

async function loadMarkdownContext(
  document: NoteDocument,
  filePath: string,
  model: WorkspaceModel | null,
): Promise<WorkspaceGraphContext | null> {
  if (document.kind !== "markdown" || !isAttachedNote(filePath, model)) {
    return null;
  }
  return window.exograph.notes.getGraphContext(filePath);
}

function isAttachedNote(filePath: string, model: WorkspaceModel | null): boolean {
  return model ? model.noteRoots.some((root) => isPathWithin(root.path, filePath)) : true;
}

function isPathWithin(parentPath: string, targetPath: string): boolean {
  return targetPath === parentPath || targetPath.startsWith(`${parentPath}/`);
}

function pruneRecordToKeys<T>(record: Record<string, T>, keys: Set<string>): Record<string, T> {
  return Object.fromEntries(Object.entries(record).filter(([key]) => keys.has(key)));
}
