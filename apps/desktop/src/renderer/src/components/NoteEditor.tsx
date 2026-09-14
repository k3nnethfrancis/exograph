import { SaveConflictNotice } from "./SaveConflictNotice";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { flushSync } from "react-dom";

import CodeMirror, { ExternalChange, type ReactCodeMirrorRef } from "@uiw/react-codemirror";
import { indentWithTab } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { bracketMatching, foldGutter } from "@codemirror/language";
import { lintGutter, lintKeymap } from "@codemirror/lint";
import { EditorSelection, Prec } from "@codemirror/state";
import { keymap, lineNumbers, EditorView, type ViewUpdate } from "@codemirror/view";
import { Clock3, Code2, Plus, Save, SlidersHorizontal } from "lucide-react";
import type { AgentCommand, NoteDocument, WorkspaceGraphContext } from "@exograph/core";
import { findDocumentAgentEnvelopes } from "@exograph/core/document-agent-protocol";
import type { InvocationFileReviewPayload } from "../../../shared/api";
import { exographEditorTheme, exographSyntaxHighlighting } from "../theme/codemirror";
import type { ExographThemeVariant } from "../theme/types";
import { codeLanguageForPath } from "./codeLanguages";
import { AgentCommandIcon } from "./AgentCommandIcon";
import { ExographMark } from "./ExographMark";
import { coerceFrontmatterValue, getDocumentDisplayTitle, stringifyFrontmatterValue } from "./documentDisplay";
import { markdownInlineFormattingEdit } from "./markdownInlineFormatting";
import {
  markdownLivePreview,
  refreshMarkdownPreviewEffect,
  type MarkdownGraphReferences,
} from "./markdownLivePreview";
import { inlineAgentComposerExtension, isPersistedInvocationPosition, openInlineAgentComposer, type InlineAgentDraft } from "./inlineAgentComposer";
import { invocationInlineReviewExtension, invocationReviewOriginal } from "../invocationInlineReview";
import type { EditorFaultContext } from "./editorFaultDiagnostics";
import type { AgentComposeRequest } from "./EditorPane";
import { InvocationReviewControls, type InvocationReviewPosition, type InvocationReviewQueueProjection } from "./invocation";
import {
  buildNoteGraphContext,
  graphReferencesForMarkdownMode,
  getWikilinkCompletionContext,
  wikilinkSuggestionEdit,
  WIKILINK_COMPLETION_LIMIT,
  type WikilinkSuggestion,
} from "../graphAffordances";

interface WikilinkSuggestionState {
  from: number;
  to: number;
  query: string;
  left: number;
  top: number;
  items: WikilinkSuggestion[];
  selectedIndex: number;
}

interface WikilinkPreviewState {
  target: string;
  left: number;
  top: number;
  title: string;
  excerpt: string;
  loading: boolean;
}

const EDITOR_BASIC_SETUP = {
  autocompletion: false,
  lineNumbers: false,
  foldGutter: false,
  highlightSelectionMatches: false,
} as const;

interface AgentSuggestionState {
  from: number;
  to: number;
  left: number;
  top: number;
  items: AgentCommand[];
  selectedIndex: number;
}

interface EditorDocument extends NoteDocument {
  dirty: boolean;
  saveConflict?: "changed" | "missing";
  resolvingConflict?: boolean;
  readOnly?: boolean;
}

interface NoteEditorProps {
  document: EditorDocument | null;
  graphContext: WorkspaceGraphContext | null;
  saveStatus: "idle" | "saving" | "saved" | "error" | "conflict";
  propertiesCollapsed: boolean;
  onToggleProperties: () => void;
  onOpenGraph: () => void;
  onUpdateFrontmatter: (key: string, value: unknown) => void;
  onBodyChange: (body: string) => void;
  onSave: () => void | Promise<void>;
  onSaveConflictCopy?: () => void;
  onDiscardSaveConflict?: () => Promise<void>;
  onOpenTag: (tag: string) => void;
  onOpenTarget: (target: string) => void;
  onSuggestTargets: (query: string) => Promise<Array<{ label: string; target: string; detail?: string }>>;
  onPreviewTarget: (target: string) => Promise<{ title: string; excerpt: string } | null>;
  agentCommands: AgentCommand[];
  onInvokeAgent: (draft: InlineAgentDraft) => void;
  invocationReview: NoteInvocationReview | null;
  editingFrozen: boolean;
  historyAvailable: boolean;
  onOpenHistory: () => void;
  onFocus: () => void;
  theme: ExographThemeVariant;
  fontSize: number;
  onAppZoom: (direction: -1 | 0 | 1) => void;
  compact: boolean;
  isNoteDocument: boolean;
  revealLineRequest?: { filePath: string; line: number; nonce: number } | null;
  scrollRestoreRequest?: { filePath: string; scrollTop: number; nonce: number } | null;
  initialSelectionRequest?: EditorInitialSelectionRequest | null;
  onInitialSelectionRequestHandled?: (nonce: number) => void;
  agentComposeRequest?: AgentComposeRequest | null;
  onAgentComposeRequestHandled?: (nonce: number) => void;
  onDiagnosticContext: (context: EditorFaultContext) => void;
  invocationActivity?: {
    protocolInvocationId?: string;
    render: (position?: InvocationReviewPosition) => ReactNode;
  };
  onResumeProtocolInvocation?: (protocolInvocationId: string) => void;
}

export interface EditorInitialSelectionRequest {
  filePath: string;
  kind: "generated-title";
  nonce: number;
}

const STANDARD_NOTE_PROPERTY_KEYS = ["title", "date", "tags"] as const;

export function NoteEditor(props: NoteEditorProps) {
  const {
    document,
    graphContext: loadedGraphContext,
    saveStatus,
    propertiesCollapsed,
    onToggleProperties,
    onOpenGraph,
    onUpdateFrontmatter,
    onBodyChange,
    onSave,
    onSaveConflictCopy,
    onDiscardSaveConflict,
    onOpenTag,
    onOpenTarget,
    onSuggestTargets,
    onPreviewTarget,
    agentCommands,
    onInvokeAgent,
    invocationReview,
    editingFrozen,
    historyAvailable,
    onOpenHistory,
    onFocus,
    theme,
    fontSize,
    onAppZoom,
    compact,
    isNoteDocument,
    revealLineRequest,
    scrollRestoreRequest,
    initialSelectionRequest,
    onInitialSelectionRequestHandled,
    agentComposeRequest,
    onAgentComposeRequestHandled,
    onDiagnosticContext,
    invocationActivity,
    onResumeProtocolInvocation,
  } = props;
  const [rawMarkdownMode, setRawMarkdownMode] = useState(false);
  const [chromeVisible, setChromeVisible] = useState(false);
  const codeMirrorRef = useRef<ReactCodeMirrorRef>(null);
  const renderedDocumentPathRef = useRef<string | null>(null);
  const pendingDocumentSyncRef = useRef<{ filePath: string; body: string } | null>(null);
  const scrollTopByPathRef = useRef<Map<string, number>>(new Map());
  const selectionByPathRef = useRef<Map<string, { anchor: number; head: number }>>(new Map());
  const restoringScrollRef = useRef(false);
  const processedRevealLineNonceRef = useRef<number | null>(null);
  const processedScrollRestoreNonceRef = useRef<number | null>(null);
  const processedAgentComposeNonceRef = useRef<number | null>(null);
  const wikilinkSuggestionRequestRef = useRef(0);
  const wikilinkPreviewRequestRef = useRef(0);
  const suppressedWikilinkCompletionRef = useRef<{ pos: number; text: string } | null>(null);
  const [wikilinkSuggestions, setWikilinkSuggestions] = useState<WikilinkSuggestionState | null>(null);
  const [agentSuggestions, setAgentSuggestions] = useState<AgentSuggestionState | null>(null);
  const [wikilinkPreview, setWikilinkPreview] = useState<WikilinkPreviewState | null>(null);
  const [inlineComposerActive, setInlineComposerActive] = useState(false);
  const [inlineComposerHandle, setInlineComposerHandle] = useState<string | null>(null);
  const [newPropertyKey, setNewPropertyKey] = useState("");
  const [newPropertyValue, setNewPropertyValue] = useState("");
  const [reviewPosition, setReviewPosition] = useState<InvocationReviewPosition | undefined>(undefined);
  const [activityPosition, setActivityPosition] = useState<InvocationReviewPosition | undefined>(undefined);

  useEffect(() => {
    const root = codeMirrorRef.current?.view?.dom;
    if (!root || !onResumeProtocolInvocation) return;
    const onResume = (event: Event) => {
      const protocolInvocationId = (event as CustomEvent<{ protocolInvocationId?: string }>).detail?.protocolInvocationId;
      if (protocolInvocationId) onResumeProtocolInvocation(protocolInvocationId);
    };
    root.addEventListener("exograph:resume-invocation", onResume);
    return () => root.removeEventListener("exograph:resume-invocation", onResume);
  }, [document?.filePath, onResumeProtocolInvocation]);

  useEffect(() => {
    setRawMarkdownMode(false);
    setChromeVisible(false);
    setWikilinkSuggestions(null);
    setAgentSuggestions(null);
    setWikilinkPreview(null);
    suppressedWikilinkCompletionRef.current = null;
  }, [document?.filePath]);

  useEffect(() => {
    if (!agentComposeRequest || !document || document.kind !== "markdown" || document.readOnly) return;
    if (agentComposeRequest.filePath !== document.filePath) return;
    if (processedAgentComposeNonceRef.current === agentComposeRequest.nonce) return;
    const view = codeMirrorRef.current?.view;
    if (!view || view.state.doc.toString() !== document.body) return;
    processedAgentComposeNonceRef.current = agentComposeRequest.nonce;
    const end = view.state.doc.length;
    openInlineAgentComposer(view, {
      from: end,
      to: end,
      handle: agentComposeRequest.handle,
      initialMessage: agentComposeRequest.message,
      skill: agentComposeRequest.skill,
    });
    setInlineComposerActive(true);
    setInlineComposerHandle(agentComposeRequest.handle);
    onAgentComposeRequestHandled?.(agentComposeRequest.nonce);
  }, [agentComposeRequest, document, onAgentComposeRequestHandled]);

  const documentPath = document?.filePath ?? "";
  if (renderedDocumentPathRef.current !== documentPath) {
    renderedDocumentPathRef.current = documentPath;
    pendingDocumentSyncRef.current = document ? { filePath: document.filePath, body: document.body } : null;
  }
  const useMarkdownEditing = shouldUseMarkdownRenderer(document);
  const showNoteMetadata = useMarkdownEditing && isNoteDocument;

  useEffect(() => {
    onDiagnosticContext({
      notePath: document?.filePath ?? null,
      mode: !document ? "empty" : !useMarkdownEditing ? "code" : rawMarkdownMode ? "markdown-raw" : "markdown-live",
      selection: selectionByPathRef.current.get(document?.filePath ?? "") ?? null,
      agentHandle: inlineComposerHandle,
    });
  }, [document?.filePath, inlineComposerHandle, onDiagnosticContext, rawMarkdownMode, useMarkdownEditing]);
  const displayTitle = document ? getDocumentDisplayTitle(document.filePath, document.kind) : "";
  const suppressedGeneratedTitle = useMemo(
    () => (document && showNoteMetadata ? generatedDailyTitleForPath(document.filePath) : null),
    [document, showNoteMetadata],
  );
  const codeLanguage = useMemo(() => {
    if (!document || useMarkdownEditing) {
      return null;
    }
    if (document.kind === "markdown") {
      return { id: "markdown", label: "Markdown", extensions: [markdown()] };
    }
    return codeLanguageForPath(document.filePath);
  }, [document, useMarkdownEditing]);
  const graphContext = useMemo(() => buildNoteGraphContext(loadedGraphContext), [loadedGraphContext]);
  const graphPropertyEntries = notePropertyEntries(document);
  const cmTheme = useMemo(() => exographEditorTheme(theme, fontSize), [fontSize, theme]);
  const syntaxTheme = useMemo(() => exographSyntaxHighlighting(theme), [theme]);
  const graphReferences = useMemo((): MarkdownGraphReferences | null => {
    return graphReferencesForMarkdownMode(showNoteMetadata, rawMarkdownMode, graphContext);
  }, [graphContext, rawMarkdownMode, showNoteMetadata]);
  const graphReferencesRef = useRef(graphReferences);
  graphReferencesRef.current = graphReferences;
  const agentCommandsRef = useRef(agentCommands);
  agentCommandsRef.current = agentCommands;
  const invocationCommands = useMemo(() => agentCommands.filter((command) => command.enabled), [agentCommands]);
  const invokeAgentRef = useRef(onInvokeAgent);
  const bodyChangeRef = useRef(onBodyChange);
  const openTargetRef = useRef(onOpenTarget);
  const openTagRef = useRef(onOpenTag);
  const suggestTargetsRef = useRef(onSuggestTargets);
  const previewTargetRef = useRef(onPreviewTarget);
  const resolveMarkdownImageRef = useRef(window.exograph.notes.resolveMarkdownImage);
  const saveRef = useRef(onSave);
  const appZoomRef = useRef(onAppZoom);
  // Event callbacks must stay stable for CodeMirror configuration without
  // becoming stale for the first input after switching Notes.
  invokeAgentRef.current = onInvokeAgent;
  bodyChangeRef.current = onBodyChange;
  openTargetRef.current = onOpenTarget;
  openTagRef.current = onOpenTag;
  suggestTargetsRef.current = onSuggestTargets;
  previewTargetRef.current = onPreviewTarget;
  saveRef.current = onSave;
  appZoomRef.current = onAppZoom;

  useLayoutEffect(() => {
    const pending = pendingDocumentSyncRef.current;
    const view = codeMirrorRef.current?.view;
    if (!pending || pending.filePath !== documentPath || !view) {
      return;
    }
    pendingDocumentSyncRef.current = null;
    const currentBody = view.state.doc.toString();
    if (currentBody === pending.body) {
      return;
    }
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: pending.body },
      annotations: ExternalChange.of(true),
    });
  });
  const agentComposer = useMemo(
    () => inlineAgentComposerExtension({
      getCommand: (handle) => agentCommandsRef.current.find((command) => command.handle === handle),
      onSend: (draft) => {
        setInlineComposerActive(false);
        setInlineComposerHandle(null);
        invokeAgentRef.current(draft);
      },
      onClose: (documentBody) => {
        setInlineComposerActive(false);
        setInlineComposerHandle(null);
        bodyChangeRef.current(documentBody);
      },
      onRestore: (documentBody) => {
        setInlineComposerActive(true);
        bodyChangeRef.current(documentBody);
      },
      renderPersistedInvocations: !rawMarkdownMode,
    }),
    [rawMarkdownMode, agentCommands],
  );
  const normalizedNewPropertyKey = normalizeFrontmatterPropertyKey(newPropertyKey);
  const newPropertyKeyFeedback = frontmatterPropertyKeyFeedback(newPropertyKey, document?.frontmatter ?? {});
  const canAddProperty =
    Boolean(normalizedNewPropertyKey) &&
    !newPropertyKeyFeedback;
  const handleAddProperty = useMemo(
    () =>
      () => {
        if (!normalizedNewPropertyKey || !canAddProperty) {
          return;
        }
        onUpdateFrontmatter(normalizedNewPropertyKey, newPropertyValue);
        setNewPropertyKey("");
        setNewPropertyValue("");
      },
    [canAddProperty, newPropertyValue, normalizedNewPropertyKey, onUpdateFrontmatter],
  );
  const selectionTracker = useMemo(
    () =>
      EditorView.updateListener.of((update) => {
        if (!documentPath || !update.selectionSet) {
          return;
        }
        const range = update.state.selection.main;
        selectionByPathRef.current.set(documentPath, { anchor: range.anchor, head: range.head });
        onDiagnosticContext({
          notePath: documentPath,
          mode: !useMarkdownEditing ? "code" : rawMarkdownMode ? "markdown-raw" : "markdown-live",
          selection: { anchor: range.anchor, head: range.head },
          agentHandle: inlineComposerHandle,
        });
      }),
    [documentPath, inlineComposerHandle, onDiagnosticContext, rawMarkdownMode, useMarkdownEditing],
  );
  const maybeUpdateWikilinkSuggestions = useMemo(
    () =>
      (update: ViewUpdate) => {
        if (!useMarkdownEditing || rawMarkdownMode) {
          setWikilinkSuggestions(null);
          return;
        }
        const range = update.state.selection.main;
        if (!range.empty) {
          setWikilinkSuggestions(null);
          return;
        }
        const linkContext = getWikilinkCompletionContext(update.state, range.head);
        if (!linkContext) {
          suppressedWikilinkCompletionRef.current = null;
          setWikilinkSuggestions(null);
          return;
        }
        const suppressed = suppressedWikilinkCompletionRef.current;
        const linkText = update.state.doc.sliceString(linkContext.from, linkContext.to);
        if (suppressed && suppressed.pos === range.head && suppressed.text === linkText) {
          setWikilinkSuggestions(null);
          return;
        }
        suppressedWikilinkCompletionRef.current = null;

        const requestId = ++wikilinkSuggestionRequestRef.current;
        const cursorCoords = update.view.coordsAtPos(range.head);
        const surface = update.view.dom.closest<HTMLElement>(".editor-surface");
        const surfaceRect = surface?.getBoundingClientRect();
        const left = cursorCoords && surfaceRect ? cursorCoords.left - surfaceRect.left : 24;
        const top = cursorCoords && surfaceRect ? cursorCoords.bottom - surfaceRect.top + 4 : 48;
        void suggestTargetsRef.current(linkContext.query).then((suggestions) => {
          if (requestId !== wikilinkSuggestionRequestRef.current) {
            return;
          }
          const currentRange = update.view.state.selection.main;
          const currentContext = currentRange.empty ? getWikilinkCompletionContext(update.view.state, currentRange.head) : null;
          if (!currentContext || currentContext.query !== linkContext.query) {
            setWikilinkSuggestions(null);
            return;
          }
          const items = suggestions.slice(0, WIKILINK_COMPLETION_LIMIT);
          setWikilinkSuggestions(items.length > 0 ? { ...currentContext, left, top, items, selectedIndex: 0 } : null);
        }).catch(() => {
          if (requestId === wikilinkSuggestionRequestRef.current) {
            setWikilinkSuggestions(null);
          }
        });
      },
    [rawMarkdownMode, useMarkdownEditing],
  );
  const maybeUpdateAgentSuggestions = useMemo(
    () =>
      (update: ViewUpdate) => {
        if (!useMarkdownEditing || rawMarkdownMode || (!update.selectionSet && !update.docChanged)) {
          setAgentSuggestions(null);
          return;
        }
        const range = update.state.selection.main;
        if (!range.empty) {
          setAgentSuggestions(null);
          return;
        }
        const context = getAgentCompletionContext(update.state.doc, range.head);
        if (!context) {
          setAgentSuggestions(null);
          return;
        }
        // Parsing durable invocation envelopes requires inspecting the full
        // document. Ordinary typing cannot open agent completion, so keep that
        // work out of the keystroke path until an @ query actually exists.
        if (isPersistedInvocationPosition(update.state, range.head)) {
          setAgentSuggestions(null);
          return;
        }
        const items = invocationCommands.filter((command) => command.handle.startsWith(context.query));
        if (items.length === 0) {
          setAgentSuggestions(null);
          return;
        }
        const coords = update.view.coordsAtPos(range.head);
        const surfaceRect = update.view.dom.closest<HTMLElement>(".editor-surface")?.getBoundingClientRect();
        setAgentSuggestions({
          ...context,
          left: coords && surfaceRect ? coords.left - surfaceRect.left : 24,
          top: coords && surfaceRect ? coords.bottom - surfaceRect.top + 4 : 48,
          items,
          selectedIndex: 0,
        });
      },
    [invocationCommands, rawMarkdownMode, useMarkdownEditing],
  );
  const handleEditorChange = useMemo(
    () =>
      (value: string, update: ViewUpdate) => {
        // The open-document model is canonical save input. Commit every body
        // revision in input order; deferring independent snapshots can let an
        // older transition render after a newer autosave has completed.
        bodyChangeRef.current(value);
        maybeUpdateWikilinkSuggestions(update);
        maybeUpdateAgentSuggestions(update);
      },
    [maybeUpdateAgentSuggestions, maybeUpdateWikilinkSuggestions],
  );
  const acceptAgentSuggestion = useMemo(
    () =>
      (command: AgentCommand) => {
        const view = codeMirrorRef.current?.view;
        const active = agentSuggestions;
        if (!view || !active) return;
        openInlineAgentComposer(view, { from: active.from, to: active.to, handle: command.handle });
        setInlineComposerActive(true);
        setInlineComposerHandle(command.handle);
        setAgentSuggestions(null);
      },
    [agentSuggestions],
  );
  const acceptWikilinkSuggestion = useMemo(
    () =>
      (suggestion: WikilinkSuggestion) => {
        const view = codeMirrorRef.current?.view;
        const active = wikilinkSuggestions;
        if (!view || !active) {
          return;
        }
        const edit = wikilinkSuggestionEdit(active, suggestion);
        view.dispatch({
          changes: { from: active.from, to: active.to, insert: edit.insert },
          selection: { anchor: edit.selection },
          userEvent: "input.complete",
        });
        suppressedWikilinkCompletionRef.current = { pos: edit.selection, text: edit.insert };
        setWikilinkSuggestions(null);
        view.focus();
      },
    [wikilinkSuggestions],
  );
  const handleEditorSurfaceKeyDown = useMemo(
    () =>
      (event: KeyboardEvent<HTMLDivElement>) => {
        if (event.key === "Escape" && agentSuggestions) {
          event.preventDefault();
          event.stopPropagation();
          setAgentSuggestions(null);
          return;
        }
        if ((event.key === "ArrowDown" || event.key === "ArrowUp") && agentSuggestions?.items.length) {
          event.preventDefault();
          event.stopPropagation();
          const delta = event.key === "ArrowDown" ? 1 : -1;
          setAgentSuggestions((current) => current
            ? { ...current, selectedIndex: nextSuggestionIndex(current.selectedIndex, current.items.length, delta) }
            : current);
          return;
        }
        if ((event.key === "ArrowDown" || event.key === "ArrowUp") && wikilinkSuggestions?.items.length) {
          event.preventDefault();
          event.stopPropagation();
          const delta = event.key === "ArrowDown" ? 1 : -1;
          setWikilinkSuggestions((current) => current
            ? { ...current, selectedIndex: nextSuggestionIndex(current.selectedIndex, current.items.length, delta) }
            : current);
          return;
        }
        if (event.key === "Enter" && agentSuggestions?.items.length) {
          event.preventDefault();
          event.stopPropagation();
          acceptAgentSuggestion(agentSuggestions.items[agentSuggestions.selectedIndex]);
          return;
        }
        if (event.key === "Escape" && wikilinkSuggestions) {
          event.preventDefault();
          event.stopPropagation();
          setWikilinkSuggestions(null);
          return;
        }
        if (event.key !== "Enter" || !wikilinkSuggestions || wikilinkSuggestions.items.length === 0) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        acceptWikilinkSuggestion(wikilinkSuggestions.items[wikilinkSuggestions.selectedIndex]);
      },
    [acceptAgentSuggestion, acceptWikilinkSuggestion, agentSuggestions, wikilinkSuggestions],
  );
  const handleEditorSurfaceMouseMove = useMemo(
    () =>
      (event: MouseEvent<HTMLDivElement>) => {
        if (!useMarkdownEditing || rawMarkdownMode) {
          return;
        }
        const target = (event.target as HTMLElement | null)?.closest<HTMLElement>("[data-exograph-link-kind='wikilink'][data-exograph-link-target]");
        if (!target) {
          wikilinkPreviewRequestRef.current += 1;
          setWikilinkPreview(null);
          return;
        }

        const linkTarget = target.dataset.exographLinkTarget;
        if (!linkTarget || wikilinkPreview?.target === linkTarget) {
          return;
        }

        const surface = target.closest<HTMLElement>(".editor-surface");
        const surfaceRect = surface?.getBoundingClientRect();
        const targetRect = target.getBoundingClientRect();
        const left = surfaceRect ? targetRect.left - surfaceRect.left : 24;
        const top = surfaceRect ? targetRect.bottom - surfaceRect.top + 8 : 48;
        const requestId = ++wikilinkPreviewRequestRef.current;
        setWikilinkPreview({ target: linkTarget, left, top, title: linkTarget, excerpt: "", loading: true });

        void previewTargetRef.current(linkTarget).then((preview) => {
          if (requestId !== wikilinkPreviewRequestRef.current) {
            return;
          }
          if (!preview) {
            setWikilinkPreview(null);
            return;
          }
          setWikilinkPreview({ target: linkTarget, left, top, title: preview.title, excerpt: preview.excerpt, loading: false });
        }).catch(() => {
          if (requestId === wikilinkPreviewRequestRef.current) {
            setWikilinkPreview(null);
          }
        });
      },
    [rawMarkdownMode, useMarkdownEditing, wikilinkPreview?.target],
  );
  const handleEditorSurfaceMouseLeave = useMemo(
    () =>
      () => {
        wikilinkPreviewRequestRef.current += 1;
        setWikilinkPreview(null);
      },
    [],
  );
  const saveKeymap = useMemo(
    () =>
      keymap.of([
        {
          key: "Mod-s",
          run: (view) => {
            if (inlineComposerActive) flushSync(() => bodyChangeRef.current(view.state.doc.toString()));
            saveRef.current();
            return true;
          },
        },
        {
          key: "Mod-=",
          run: () => {
            appZoomRef.current(1);
            return true;
          },
        },
        {
          key: "Mod-Shift-=",
          run: () => {
            appZoomRef.current(1);
            return true;
          },
        },
        {
          key: "Mod--",
          run: () => {
            appZoomRef.current(-1);
            return true;
          },
        },
        {
          key: "Mod-0",
          run: () => {
            appZoomRef.current(0);
            return true;
          },
        },
        indentWithTab,
        ...lintKeymap,
      ]),
    [inlineComposerActive],
  );

  const markdownPreviewExtensions = useMemo(
    () => markdownLivePreview({
      onOpenTarget: (target) => openTargetRef.current(target),
      onOpenTag: (tag) => openTagRef.current(tag),
      onResolveImage: (target, options) => resolveMarkdownImageRef.current(documentPath, target, options?.lookupByFilename),
      suppressedGeneratedTitle,
      getGraphReferences: () => graphReferencesRef.current,
    }),
    [documentPath, suppressedGeneratedTitle],
  );
  const markdownSpellcheck = useMemo(
    () => EditorView.contentAttributes.of({ spellcheck: "true" }),
    [],
  );
  const markdownFormattingKeymap = useMemo(
    () => Prec.high(keymap.of([
      {
        key: "Mod-b",
        run: (view) => {
          view.dispatch({ ...markdownInlineFormattingEdit(view.state, "bold"), userEvent: "input" });
          return true;
        },
      },
      {
        key: "Mod-i",
        run: (view) => {
          view.dispatch({ ...markdownInlineFormattingEdit(view.state, "italic"), userEvent: "input" });
          return true;
        },
      },
    ])),
    [],
  );
  const invocationReviewExtensions = useMemo(
    () => invocationInlineReviewExtension({
      payload: invocationReview?.payload ?? null,
      documentKind: document?.kind ?? "text",
      rawMarkdownMode,
    }),
    [document?.kind, invocationReview?.payload, rawMarkdownMode],
  );
  const editorExtensions = useMemo(
    () => useMarkdownEditing
      ? [
          markdown(),
          EditorView.lineWrapping,
          markdownSpellcheck,
          markdownFormattingKeymap,
          saveKeymap,
          selectionTracker,
          agentComposer,
          ...(!rawMarkdownMode ? markdownPreviewExtensions : []),
          ...invocationReviewExtensions,
          cmTheme,
          syntaxTheme,
        ]
      : [
          lineNumbers(),
          foldGutter(),
          bracketMatching(),
          lintGutter(),
          saveKeymap,
          selectionTracker,
          agentComposer,
          ...(codeLanguage?.extensions ?? []),
          ...invocationReviewExtensions,
          cmTheme,
          syntaxTheme,
        ],
    [agentComposer, cmTheme, codeLanguage?.extensions, invocationReviewExtensions, markdownFormattingKeymap, markdownPreviewExtensions, markdownSpellcheck, rawMarkdownMode, saveKeymap, selectionTracker, syntaxTheme, useMarkdownEditing],
  );

  useLayoutEffect(() => {
    const view = codeMirrorRef.current?.view;
    if (view && useMarkdownEditing && !rawMarkdownMode) {
      view.dispatch({ effects: refreshMarkdownPreviewEffect.of(null) });
    }
  }, [graphReferences, rawMarkdownMode, useMarkdownEditing]);

  useEffect(() => {
    if (!document) {
      return;
    }

    const scroller = codeMirrorRef.current?.view?.scrollDOM;
    if (!scroller) {
      return;
    }

    const recordScroll = () => {
      if (!restoringScrollRef.current) {
        scrollTopByPathRef.current.set(document.filePath, scroller.scrollTop);
      }
    };
    const handleScroll = () => {
      recordScroll();
    };
    const interval = window.setInterval(recordScroll, 250);

    scroller.addEventListener("scroll", handleScroll, { passive: true });
    return () => {
      window.clearInterval(interval);
      scroller.removeEventListener("scroll", handleScroll);
    };
  }, [documentPath, rawMarkdownMode, theme.id, fontSize]);

  useLayoutEffect(() => {
    if (!document) {
      return;
    }

    const scroller = codeMirrorRef.current?.view?.scrollDOM;
    const scrollTop = scrollTopByPathRef.current.get(document.filePath);
    if (!scroller || scrollTop === undefined) {
      restoringScrollRef.current = false;
      return;
    }

    const restore = () => {
      scroller.scrollTop = scrollTop;
      const view = codeMirrorRef.current?.view;
      const selection = selectionByPathRef.current.get(document.filePath);
      if (view && selection) {
        const anchor = clampPosition(selection.anchor, view.state.doc.length);
        const head = clampPosition(selection.head, view.state.doc.length);
        const current = view.state.selection.main;
        if (current.anchor !== anchor || current.head !== head) {
          view.dispatch({ selection: EditorSelection.range(anchor, head) });
        }
      }
    };
    const frame = window.requestAnimationFrame(restore);
    const interval = window.setInterval(restore, 50);
    const timeout = window.setTimeout(() => {
      restore();
      window.clearInterval(interval);
      restoringScrollRef.current = false;
    }, 650);

    return () => {
      window.cancelAnimationFrame(frame);
      window.clearInterval(interval);
      window.clearTimeout(timeout);
    };
  }, [documentPath, rawMarkdownMode, theme.id, fontSize]);

  const handleEditorCreated = useMemo(
    () =>
      (view: EditorView) => {
        const pendingSync = pendingDocumentSyncRef.current;
        if (pendingSync?.filePath === documentPath && view.state.doc.toString() === pendingSync.body) {
          pendingDocumentSyncRef.current = null;
        }
        if (
          !document
          || !useMarkdownEditing
          || rawMarkdownMode
          || initialSelectionRequest?.filePath !== document.filePath
          || initialSelectionRequest.kind !== "generated-title"
        ) {
          return;
        }
        const initialPosition = initialMarkdownAuthoringPosition(document.body);
        if (view.state.doc.toString() !== document.body) {
          return;
        }
        if (initialPosition !== null) {
          const position = clampPosition(initialPosition, view.state.doc.length);
          view.dispatch({ selection: EditorSelection.cursor(position) });
          selectionByPathRef.current.set(document.filePath, { anchor: position, head: position });
          view.focus();
        }
        onInitialSelectionRequestHandled?.(initialSelectionRequest.nonce);
      },
    [document, documentPath, initialSelectionRequest, onInitialSelectionRequestHandled, rawMarkdownMode, useMarkdownEditing],
  );

  useLayoutEffect(() => {
    const view = codeMirrorRef.current?.view;
    if (!view || !invocationReview?.payload) {
      setReviewPosition(undefined);
      return;
    }
    const payload = invocationReview.payload;
    const original = invocationReviewOriginal(payload, document?.kind ?? "text");
    // This effect reruns when the reviewed document or payload changes. Cache
    // its offset between those changes; never rescan the full note on scroll.
    const changedOffset = firstChangedOffset(original, view.state.doc.toString());
    const place = () => {
      const coords = view.coordsAtPos(clampPosition(changedOffset, view.state.doc.length));
      const surface = view.dom.closest<HTMLElement>(".editor-surface");
      const bounds = surface?.getBoundingClientRect();
      if (!coords || !bounds) return;
      const maxWidth = Math.max(180, Math.min(390, bounds.width - 24));
      const left = Math.max(bounds.left + 12, Math.min(coords.left + 20, bounds.right - maxWidth - 12));
      const preferredTop = coords.bottom + 8;
      const top = preferredTop + 190 <= bounds.bottom
        ? preferredTop
        : Math.max(bounds.top + 12, coords.top - 174);
      setReviewPosition({ left, top, maxWidth, origin: `${Math.round(coords.left)}px ${Math.round(coords.top)}px` });
    };
    let frame: number | null = null;
    const schedulePlacement = () => {
      if (frame !== null) return;
      frame = window.requestAnimationFrame(() => {
        frame = null;
        place();
      });
    };
    place();
    const scroller = view.scrollDOM;
    scroller.addEventListener("scroll", schedulePlacement, { passive: true });
    window.addEventListener("resize", schedulePlacement);
    return () => {
      if (frame !== null) window.cancelAnimationFrame(frame);
      scroller.removeEventListener("scroll", schedulePlacement);
      window.removeEventListener("resize", schedulePlacement);
    };
  }, [document?.body, document?.filePath, document?.kind, invocationReview?.payload]);

  useLayoutEffect(() => {
    const view = codeMirrorRef.current?.view;
    const protocolInvocationId = invocationActivity?.protocolInvocationId;
    if (!view || !protocolInvocationId) {
      setActivityPosition(undefined);
      return;
    }
    const place = () => {
      const envelopes = findDocumentAgentEnvelopes(view.state.doc.toString());
      const envelope = envelopes.find((candidate) =>
        candidate.kind === "response" && candidate.invocationId === protocolInvocationId,
      ) ?? envelopes.find((candidate) =>
        candidate.kind === "invocation" && candidate.id === protocolInvocationId,
      );
      const surface = view.dom.closest<HTMLElement>(".editor-surface");
      const bounds = surface?.getBoundingClientRect();
      const coords = envelope ? view.coordsAtPos(envelope.contentTo) : null;
      if (!coords || !bounds) {
        setActivityPosition(undefined);
        return;
      }
      const maxWidth = Math.max(180, Math.min(280, bounds.width - 24));
      const left = Math.max(bounds.left + 12, Math.min(coords.left + 12, bounds.right - maxWidth - 12));
      const preferredTop = coords.bottom + 7;
      const top = preferredTop + 58 <= bounds.bottom
        ? preferredTop
        : Math.max(bounds.top + 12, coords.top - 56);
      setActivityPosition({ left, top, maxWidth, origin: `${Math.round(coords.left)}px ${Math.round(coords.top)}px` });
    };
    let frame: number | null = null;
    const schedulePlacement = () => {
      if (frame !== null) return;
      frame = window.requestAnimationFrame(() => {
        frame = null;
        place();
      });
    };
    place();
    view.scrollDOM.addEventListener("scroll", schedulePlacement, { passive: true });
    window.addEventListener("resize", schedulePlacement);
    return () => {
      if (frame !== null) window.cancelAnimationFrame(frame);
      view.scrollDOM.removeEventListener("scroll", schedulePlacement);
      window.removeEventListener("resize", schedulePlacement);
    };
  }, [document?.body, document?.filePath, invocationActivity?.protocolInvocationId]);

  useEffect(() => {
    if (!document || !revealLineRequest || revealLineRequest.filePath !== document.filePath) {
      return;
    }
    if (processedRevealLineNonceRef.current === revealLineRequest.nonce) {
      return;
    }

    processedRevealLineNonceRef.current = revealLineRequest.nonce;
    const reveal = () => {
      const view = codeMirrorRef.current?.view;
      if (!view) {
        return;
      }
      const lineNumber = Math.max(1, Math.min(revealLineRequest.line, view.state.doc.lines));
      const line = view.state.doc.line(lineNumber);
      view.dispatch({
        selection: { anchor: line.from },
        effects: EditorView.scrollIntoView(line.from, { y: "center" }),
      });
      view.focus();
    };

    const frame = window.requestAnimationFrame(reveal);
    const interval = window.setInterval(reveal, 50);
    const timeout = window.setTimeout(() => {
      reveal();
      window.clearInterval(interval);
    }, 350);

    return () => {
      window.cancelAnimationFrame(frame);
      window.clearInterval(interval);
      window.clearTimeout(timeout);
    };
  }, [document, documentPath, revealLineRequest]);

  useLayoutEffect(() => {
    if (!document || !scrollRestoreRequest || scrollRestoreRequest.filePath !== document.filePath) {
      return;
    }
    if (processedScrollRestoreNonceRef.current === scrollRestoreRequest.nonce) {
      return;
    }

    const scroller = codeMirrorRef.current?.view?.scrollDOM;
    if (!scroller) {
      return;
    }

    processedScrollRestoreNonceRef.current = scrollRestoreRequest.nonce;
    restoringScrollRef.current = true;
    const restore = () => {
      scroller.scrollTop = scrollRestoreRequest.scrollTop;
      const view = codeMirrorRef.current?.view;
      const selection = selectionByPathRef.current.get(document.filePath);
      if (view && selection) {
        const anchor = clampPosition(selection.anchor, view.state.doc.length);
        const head = clampPosition(selection.head, view.state.doc.length);
        const current = view.state.selection.main;
        if (current.anchor !== anchor || current.head !== head) {
          view.dispatch({ selection: EditorSelection.range(anchor, head) });
        }
      }
    };
    restore();
    const frame = window.requestAnimationFrame(restore);
    const interval = window.setInterval(restore, 50);
    const timeout = window.setTimeout(() => {
      restore();
      window.clearInterval(interval);
      restoringScrollRef.current = false;
    }, 650);
    return () => {
      window.cancelAnimationFrame(frame);
      window.clearInterval(interval);
      window.clearTimeout(timeout);
    };
  }, [document, documentPath, scrollRestoreRequest]);

  if (!document) {
    return (
      <section className="editor-panel editor-panel--empty" data-testid="editor-empty">
        <h1>Exograph</h1>
        <p>Open a note from the left sidebar to begin.</p>
      </section>
    );
  }

  return (
    <section
      className={`editor-panel ${compact ? "editor-panel--compact" : ""}`}
      data-testid="editor-panel"
      onMouseDown={onFocus}
      onMouseEnter={() => setChromeVisible(true)}
      onMouseLeave={() => setChromeVisible(false)}
    >
      <div
        className={`editor-panel__header ${chromeVisible || !propertiesCollapsed ? "editor-panel__header--visible" : ""}`}
      >
        <div className="editor-panel__summary">
          <div className="editor-panel__title-row">
            {showNoteMetadata ? (
              <button
                aria-label={propertiesCollapsed ? "Show properties" : "Hide properties"}
                className={`toolbar-button toolbar-button--icon ${compact ? "toolbar-button--compact" : ""}`}
                data-testid="toggle-properties"
                onClick={onToggleProperties}
                title={propertiesCollapsed ? "Show properties" : "Hide properties"}
                type="button"
              >
                <SlidersHorizontal size={14} />
              </button>
            ) : null}
            {historyAvailable ? (
              <button
                aria-label="Open invocation history"
                className={`toolbar-button toolbar-button--icon ${compact ? "toolbar-button--compact" : ""}`}
                data-testid="open-invocation-history"
                onClick={onOpenHistory}
                title="History"
                type="button"
              >
                <Clock3 size={14} />
              </button>
            ) : null}
            {showNoteMetadata ? (
              <button
                aria-label="Open graph for note"
                className={`toolbar-button toolbar-button--icon ${compact ? "toolbar-button--compact" : ""}`}
                data-testid="open-note-graph"
                onClick={onOpenGraph}
                title="Open graph for note"
                type="button"
              >
                <ExographMark size={14} />
              </button>
            ) : null}
            <div className="editor-panel__title" data-testid="editor-title" title={document.filePath}>
              {displayTitle}
            </div>
          </div>
        </div>

        <div className="editor-panel__actions">
          <span className="sr-only" data-testid="editor-save-status" aria-live="polite">
            {saveStatus === "saving" ? "Saving" : saveStatus === "saved" ? "Saved" : saveStatus === "conflict" ? "Save conflict" : saveStatus === "error" ? "Save failed" : document.dirty ? "Unsaved" : "Saved"}
          </span>
          <button
            aria-label="Save document"
            className={`toolbar-button toolbar-button--icon ${compact ? "toolbar-button--compact" : ""}`}
            data-testid="editor-save"
            disabled={!document.dirty || saveStatus === "saving" || Boolean(document.saveConflict) || editingFrozen}
            onClick={() => {
              const view = codeMirrorRef.current?.view;
              if (inlineComposerActive && view) flushSync(() => bodyChangeRef.current(view.state.doc.toString()));
              void saveRef.current();
            }}
            title={document.dirty ? "Save" : "No unsaved changes"}
            type="button"
          >
            <Save size={14} />
          </button>
          {useMarkdownEditing ? (
            <button
              aria-label={rawMarkdownMode ? "Switch to live preview" : "Switch to raw markdown"}
              className={`toolbar-button toolbar-button--icon ${compact ? "toolbar-button--compact" : ""}`}
              data-testid="toggle-markdown-mode"
              onClick={() => setRawMarkdownMode((current) => !current)}
              title={rawMarkdownMode ? "Live preview" : "Raw markdown"}
              type="button"
            >
              <Code2 size={14} />
            </button>
          ) : null}
        </div>
      </div>

      {document.saveConflict ? <SaveConflictNotice kind={document.saveConflict} pending={Boolean(document.resolvingConflict) || editingFrozen} onSaveCopy={onSaveConflictCopy} onDiscard={onDiscardSaveConflict} /> : null}

      {showNoteMetadata && !propertiesCollapsed ? (
        <div className="properties-card" data-testid="properties-panel">
          <div className="properties-card__content">
            {graphPropertyEntries.map(([key, value]) => (
              <div key={key} className="properties-card__row">
                <label className="properties-card__key" htmlFor={`property-${key}`}>
                  {key}
                </label>
                <div className="properties-card__field">
                  <input
                    id={`property-${key}`}
                    className="properties-card__input"
                    type="text"
                    value={stringifyFrontmatterValue(value)}
                    onChange={(event) => onUpdateFrontmatter(key, coerceFrontmatterValue(event.target.value, value))}
                  />
                  {key === "tags" ? (
                    <div className="tag-list">
                      {(Array.isArray(document.frontmatter.tags)
                        ? document.frontmatter.tags.filter((entry): entry is string => typeof entry === "string")
                        : typeof document.frontmatter.tags === "string"
                          ? document.frontmatter.tags.split(/[,\s]+/)
                          : []
                      ).map((tag) => (
                        <button key={tag} className="tag-pill" onClick={() => onOpenTag(tag.replace(/^#/, ""))} type="button">
                          #{tag.replace(/^#/, "")}
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
              </div>
            ))}
            <div className="properties-card__row properties-card__row--add">
              <label className="properties-card__key" htmlFor="property-new-key">
                New
              </label>
              <div className="properties-card__add">
                <input
                  aria-describedby={newPropertyKeyFeedback ? "property-key-feedback" : undefined}
                  id="property-new-key"
                  className="properties-card__input"
                  type="text"
                  value={newPropertyKey}
                  onChange={(event) => setNewPropertyKey(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      handleAddProperty();
                    }
                  }}
                  placeholder="key"
                />
                <input
                  aria-label="New property value"
                  className="properties-card__input"
                  type="text"
                  value={newPropertyValue}
                  onChange={(event) => setNewPropertyValue(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      handleAddProperty();
                    }
                  }}
                  placeholder="value"
                />
                <button
                  aria-label="Add property"
                  className={`toolbar-button toolbar-button--icon ${compact ? "toolbar-button--compact" : ""}`}
                  data-testid="add-frontmatter-property"
                  disabled={!canAddProperty}
                  onClick={handleAddProperty}
                  title={canAddProperty ? "Add property" : newPropertyKeyFeedback || "Enter a new property key"}
                  type="button"
                >
                  <Plus size={14} />
                </button>
                {newPropertyKeyFeedback ? (
                  <span
                    aria-live="polite"
                    className="properties-card__feedback"
                    data-testid="property-key-feedback"
                    id="property-key-feedback"
                  >
                    {newPropertyKeyFeedback}
                  </span>
                ) : null}
              </div>
            </div>
          </div>
        </div>
      ) : !useMarkdownEditing ? (
        <div className="properties-card properties-card--file" data-testid="properties-panel">
          <div className="properties-card__file-label">Project file</div>
          <div className="properties-card__file-meta">
            <span>{codeLanguage?.label ?? "Plain text"}</span>
            <span>{document.filePath}</span>
          </div>
        </div>
      ) : null}

      <div
        className={`editor-surface ${useMarkdownEditing && !rawMarkdownMode ? "editor-surface--live-preview" : ""} ${!useMarkdownEditing ? "editor-surface--code" : ""} ${invocationReview && !rawMarkdownMode ? "editor-surface--invocation-review" : ""}`}
        onKeyDownCapture={handleEditorSurfaceKeyDown}
        onMouseLeave={handleEditorSurfaceMouseLeave}
        onMouseMove={handleEditorSurfaceMouseMove}
      >
        <CodeMirror
          ref={codeMirrorRef}
          key={`${document.filePath}:${useMarkdownEditing && !rawMarkdownMode ? "live" : "code"}:${theme.id}:${fontSize}`}
          value={document.body}
          extensions={editorExtensions}
          basicSetup={EDITOR_BASIC_SETUP}
          editable={!document.readOnly && !editingFrozen && !invocationReview?.decisionPending}
          onBlur={() => {
            const view = codeMirrorRef.current?.view;
            if (inlineComposerActive && view) bodyChangeRef.current(view.state.doc.toString());
          }}
          onChange={inlineComposerActive ? undefined : handleEditorChange}
          onCreateEditor={handleEditorCreated}
          height="100%"
        />
        {agentSuggestions ? (
          <div
            className="agent-suggestions"
            data-testid="agent-suggestions"
            style={{ left: agentSuggestions.left, top: agentSuggestions.top }}
          >
            <div className="agent-suggestions__title">Agents</div>
            {agentSuggestions.items.map((command, index) => (
              <button
                key={command.id}
                aria-selected={index === agentSuggestions.selectedIndex}
                className={`agent-suggestions__item ${index === agentSuggestions.selectedIndex ? "agent-suggestions__item--active" : ""}`}
                data-testid={`agent-suggestion-${command.handle}`}
                type="button"
                onMouseDown={(event) => {
                  event.preventDefault();
                  acceptAgentSuggestion(command);
                }}
              >
                <AgentCommandIcon command={command} size={16} />
                <span className="agent-suggestions__copy">
                  <span className="agent-suggestions__label">{command.label}</span>
                  <span className="agent-suggestions__command">{command.command}</span>
                </span>
              </button>
            ))}
          </div>
        ) : null}
        {wikilinkPreview ? (
          <div
            className="wikilink-preview"
            data-testid="wikilink-preview"
            style={{ left: wikilinkPreview.left, top: wikilinkPreview.top }}
          >
            <div className="wikilink-preview__title">{wikilinkPreview.title}</div>
            <div className="wikilink-preview__excerpt">
              {wikilinkPreview.loading ? "Loading..." : wikilinkPreview.excerpt}
            </div>
          </div>
        ) : null}
        {wikilinkSuggestions ? (
          <div
            className="wikilink-suggestions"
            data-testid="wikilink-suggestions"
            style={{ left: wikilinkSuggestions.left, top: wikilinkSuggestions.top }}
          >
            <div className="wikilink-suggestions__title">Links</div>
            {wikilinkSuggestions.items.map((suggestion, index) => (
              <button
                key={suggestion.target}
                aria-selected={index === wikilinkSuggestions.selectedIndex}
                className={`wikilink-suggestions__item ${index === wikilinkSuggestions.selectedIndex ? "wikilink-suggestions__item--active" : ""}`}
                type="button"
                onMouseDown={(event) => {
                  event.preventDefault();
                  acceptWikilinkSuggestion(suggestion);
                }}
              >
                <span className="wikilink-suggestions__label">{suggestion.label}</span>
                {suggestion.detail ? <span className="wikilink-suggestions__detail">{suggestion.detail}</span> : null}
              </button>
            ))}
          </div>
        ) : null}
        {invocationReview ? (
          <InvocationReviewControls
            queue={invocationReview.queue}
            decisionPending={invocationReview.decisionPending}
            position={reviewPosition}
            onNavigate={invocationReview.onNavigate}
            onKeepCurrent={() => invocationReview.onKeepCurrent()}
            onRejectCurrent={() => invocationReview.onRejectCurrent()}
            onKeepAll={invocationReview.readOnly ? undefined : invocationReview.onKeepAll}
            onRejectAll={invocationReview.readOnly ? undefined : invocationReview.onRejectAll}
            onKeepConflict={invocationReview.readOnly ? undefined : () => invocationReview.onKeepCurrent()}
            onRefreshConflict={invocationReview.onRefreshConflict}
            onOpenConflict={invocationReview.onOpenConflict}
            onDismiss={invocationReview.onDismiss}
            onResume={invocationReview.onResume}
          />
        ) : null}
        {invocationActivity ? invocationActivity.render(activityPosition) : null}
      </div>

    </section>
  );
}

interface NoteInvocationReview {
  payload: InvocationFileReviewPayload;
  queue: InvocationReviewQueueProjection;
  readOnly: boolean;
  decisionPending: boolean;
  onNavigate: (index: number) => void;
  onKeepCurrent: () => void;
  onRejectCurrent: () => void;
  onKeepAll?: () => void;
  onRejectAll?: () => void;
  onRefreshConflict: () => void;
  onOpenConflict: () => void;
  onDismiss?: () => void;
  onResume?: () => void;
}

function clampPosition(position: number, docLength: number): number {
  return Math.max(0, Math.min(position, docLength));
}

export function firstChangedOffset(before: string, after: string): number {
  const shared = Math.min(before.length, after.length);
  let index = 0;
  while (index < shared && before.charCodeAt(index) === after.charCodeAt(index)) index += 1;
  return index;
}

export function initialMarkdownAuthoringPosition(body: string): number | null {
  // Creation provenance is carried by EditorInitialSelectionRequest. This
  // content check only verifies that the expected generated-H1 template is
  // still untouched before placing the caret on its trailing blank line.
  if (!/^\n?# [^\n]+\n$/.test(body)) {
    return null;
  }
  return body.length;
}

function getAgentCompletionContext(doc: { lineAt: (position: number) => { from: number; text: string }; sliceString: (from: number, to: number) => string }, position: number): {
  from: number;
  to: number;
  query: string;
} | null {
  const line = doc.lineAt(position);
  const beforeCursor = doc.sliceString(line.from, position);
  const match = beforeCursor.match(/(?:^|\s)@([a-z0-9_-]*)$/i);
  if (!match) return null;
  return {
    from: position - match[0].length + (match[0].startsWith(" ") ? 1 : 0),
    to: position,
    query: match[1].toLowerCase(),
  };
}

export function nextSuggestionIndex(current: number, count: number, delta: -1 | 1): number {
  if (count <= 0) {
    return 0;
  }
  return (current + delta + count) % count;
}

export function shouldUseMarkdownRenderer(document: Pick<NoteDocument, "kind"> | null): boolean {
  return document?.kind === "markdown";
}

export function normalizeFrontmatterPropertyKey(value: string): string {
  const trimmed = value.trim();
  return /^[A-Za-z_][A-Za-z0-9_-]*$/.test(trimmed) ? trimmed : "";
}

export function frontmatterPropertyKeyFeedback(value: string, frontmatter: Record<string, unknown>): string {
  if (!value.trim()) {
    return "";
  }
  const normalized = normalizeFrontmatterPropertyKey(value);
  if (!normalized) {
    return "Use letters, numbers, _ or -; begin with a letter or _.";
  }
  if (
    STANDARD_NOTE_PROPERTY_KEYS.includes(normalized as (typeof STANDARD_NOTE_PROPERTY_KEYS)[number]) ||
    Object.prototype.hasOwnProperty.call(frontmatter, normalized)
  ) {
    return `${normalized} already exists.`;
  }
  return "";
}

function notePropertyEntries(document: EditorDocument | null): Array<[string, unknown]> {
  if (!document) {
    return [];
  }

  const frontmatter = document.frontmatter;
  return [
    ["title", frontmatter.title ?? document.title],
    ["date", frontmatter.date ?? ""],
    ["tags", frontmatter.tags ?? []],
    ...Object.entries(frontmatter).filter(([key]) => !STANDARD_NOTE_PROPERTY_KEYS.includes(key as (typeof STANDARD_NOTE_PROPERTY_KEYS)[number]) && !key.startsWith("branch_")),
  ];
}

function generatedDailyTitleForPath(filePath: string): string | null {
  const displayTitle = getDocumentDisplayTitle(filePath, "markdown");
  return /^\d{4}-\d{2}-\d{2}$/.test(displayTitle) ? displayTitle : null;
}
