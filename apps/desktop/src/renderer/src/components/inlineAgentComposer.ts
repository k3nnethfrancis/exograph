import { normalizeAgentCommandAppearance, type AgentCommand, type AgentCommandAppearance } from "@exograph/core/agent-command-configuration";
import { Facet, Prec, StateEffect, StateField, type EditorState, type Extension, type Range, type Transaction } from "@codemirror/state";
import { Decoration, DecorationSet, EditorView, WidgetType, keymap } from "@codemirror/view";
import type { InvocationSkillContext } from "@exograph/core";
import {
  containsDocumentAgentProtocolSyntax,
  findDocumentAgentEnvelopes,
  formatDocumentAgentInvocation,
} from "@exograph/core/document-agent-protocol";

export interface InlineAgentDraft {
  protocolInvocationId: string;
  handle: string;
  message: string;
  documentBody: string;
  skill?: InvocationSkillContext;
  anchor: InlineAgentViewportAnchor;
  restoreComposer: () => string | null;
  focusComposer: () => void;
}

export interface InlineAgentViewportAnchor {
  left: number;
  top: number;
  origin: "top left" | "bottom left";
}

export function cancelInlineAgentDraft(draft: InlineAgentDraft, close: () => void): string | null {
  const restoredBody = draft.restoreComposer();
  close();
  draft.focusComposer();
  return restoredBody;
}

export interface ComposerState {
  id: number;
  handle: string;
  from: number;
  messageFrom: number;
  to: number;
  skill?: InvocationSkillContext;
}

const openComposer = StateEffect.define<ComposerState>();
const closeComposer = StateEffect.define<null>();

const composerState = StateField.define<ComposerState | null>({
  create: () => null,
  update(value, transaction) {
    let next = value
      ? {
          ...value,
          from: transaction.changes.mapPos(value.from, 1),
          messageFrom: transaction.changes.mapPos(value.messageFrom, 1),
          to: transaction.changes.mapPos(value.to, 1),
        }
      : null;

    if (next && transaction.docChanged) {
      const before = transaction.startState.selection.main;
      const after = transaction.state.selection.main;
      // The agent request is ordinary document text. Extend its live range only
      // while the user is typing at its active end; edits elsewhere do not turn
      // unrelated prose into the request.
      if (before.empty && before.head >= next.messageFrom && before.head <= next.to && after.empty) {
        next = { ...next, to: after.head };
      }
    }

    for (const effect of transaction.effects) {
      if (effect.is(openComposer)) next = effect.value;
      if (effect.is(closeComposer)) next = null;
    }
    return next;
  },
});

const composerDecorations = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, transaction) {
    let next = value.map(transaction.changes);
    if (transaction.reconfigured) {
      const composer = transaction.state.field(composerState);
      if (composer) next = decorationsForComposer(composer, transaction.state);
    }
    for (const effect of transaction.effects) {
      if (effect.is(openComposer)) next = decorationsForComposer(effect.value, transaction.state);
      if (effect.is(closeComposer)) next = Decoration.none;
    }
    return next;
  },
  provide: (field) => EditorView.decorations.from(field),
});

function decorationsForComposer(composer: ComposerState, state: EditorState): DecorationSet {
  const appearance = normalizeAgentCommandAppearance(state.facet(composerCallbackFacet).getCommand?.(composer.handle)?.appearance);
  return Decoration.set([
    Decoration.mark({
      class: `inline-agent-composer__mark inline-agent-composer__mark--${agentPresentation(composer.handle)}`,
      inclusiveEnd: true,
    }).range(composer.from, composer.to),
    Decoration.mark({
      class: `inline-agent-composer__mention inline-agent-composer__mention--${agentPresentation(composer.handle)}`,
    }).range(composer.from, composer.messageFrom),
    Decoration.widget({
      widget: new InlineAgentAffordanceWidget(composer, appearance),
      side: 1,
    }).range(composer.to),
  ]);
}

const persistedInvocationDecorations = StateField.define<DecorationSet>({
  create(state) { return invocationDecorations(state); },
  update(value, transaction) {
    if (!transaction.docChanged) return value;
    // Most edits only move an existing envelope or change its payload. Mapping
    // the ranges is incremental; reparsing the full Markdown document is only
    // necessary when an envelope tag itself may have changed.
    return invocationProtocolSyntaxChanged(transaction)
      ? invocationDecorations(transaction.state)
      : value.map(transaction.changes);
  },
  provide: (field) => EditorView.decorations.from(field),
});

function invocationProtocolSyntaxChanged(transaction: Transaction): boolean {
  let changed = false;
  transaction.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    if (changed) return;
    const previousLine = transaction.startState.doc.lineAt(fromA).text;
    const removed = transaction.startState.doc.sliceString(fromA, toA);
    const added = inserted.toString();
    changed = containsDocumentAgentProtocolSyntax(previousLine)
      || containsDocumentAgentProtocolSyntax(removed)
      || containsDocumentAgentProtocolSyntax(added);
  });
  return changed;
}

let nextComposerId = 1;

export function inlineAgentComposerInsertion(input: {
  handle: string;
  initialMessage?: string;
  prefix?: string;
}): { inserted: string; mentionOffset: number; messageOffset: number } {
  const mention = `@${input.handle}`;
  const prefix = input.prefix ?? "";
  const inserted = `${prefix}${mention} ${input.initialMessage ?? ""}`;
  return {
    inserted,
    mentionOffset: prefix.length,
    messageOffset: prefix.length + mention.length,
  };
}

export function openInlineAgentComposer(view: EditorView, input: {
  from: number;
  to: number;
  handle: string;
  initialMessage?: string;
  skill?: InvocationSkillContext;
}): void {
  const prefix = input.from > 0 && view.state.sliceDoc(input.from - 1, input.from) !== "\n" ? "\n\n" : "";
  const insertion = inlineAgentComposerInsertion({ handle: input.handle, initialMessage: input.initialMessage, prefix });
  const composerFrom = input.from + insertion.mentionOffset;
  const id = nextComposerId++;
  const messageFrom = input.from + insertion.messageOffset;
  view.dispatch({
    changes: { from: input.from, to: input.to, insert: insertion.inserted },
    effects: openComposer.of({
      id,
      handle: input.handle,
      from: composerFrom,
      messageFrom,
      to: input.from + insertion.inserted.length,
      ...(input.skill ? { skill: input.skill } : {}),
    }),
    selection: { anchor: input.from + insertion.inserted.length },
    userEvent: "input.complete",
  });
  view.focus();
}

export function inlineAgentComposerExtension(options: {
  onSend: (draft: InlineAgentDraft) => void;
  onClose?: (documentBody: string) => void;
  onRestore?: (documentBody: string) => void;
  renderPersistedInvocations?: boolean;
  getCommand?: (handle: string) => AgentCommand | undefined;
}): Extension {
  return [
    composerState,
    composerDecorations,
    ...(options.renderPersistedInvocations === false ? [] : [persistedInvocationDecorations]),
    composerCallbackFacet.of({ onSend: options.onSend, onRestore: options.onRestore, getCommand: options.getCommand }),
    Prec.highest(keymap.of([
      { key: "Cmd-Enter", run: sendInlineAgentComposer },
      { key: "Ctrl-Enter", run: sendInlineAgentComposer },
      {
        key: "Escape",
        run: (view) => {
          const closed = closeInlineAgentComposer(view);
          if (closed) options.onClose?.(view.state.doc.toString());
          return closed;
        },
      },
    ])),
  ];
}

function invocationDecorations(state: EditorState): DecorationSet {
  const text = state.doc.toString();
  const decorations: Array<Range<Decoration>> = [];
  const envelopes = findDocumentAgentEnvelopes(text);
  const envelopeLineStarts = new Set<number>();
  for (const envelope of envelopes) {
    envelopeLineStarts.add(state.doc.lineAt(envelope.from).from);
    envelopeLineStarts.add(state.doc.lineAt(envelope.to - 1).from);
  }
  for (const lineFrom of envelopeLineStarts) {
    decorations.push(Decoration.line({ class: "inline-agent-invocation__envelope-line" }).range(lineFrom));
  }
  // Invalid historical nesting is rendered as the one user-authored request,
  // not as overlapping CodeMirror marks. Every metadata tag is concealed, but
  // only the innermost payload receives the invocation treatment.
  for (const invocation of envelopes.filter((candidate) => !envelopes.some(
    (other) => other.from > candidate.from && other.to < candidate.to,
  ))) {
    const markClass = invocation.kind === "response"
      ? `inline-agent-response__mark inline-agent-response__mark--${agentPresentation(invocation.agent)}`
      : `inline-agent-composer__mark inline-agent-composer__mark--${agentPresentation(invocation.agent)}`;
    decorations.push(Decoration.mark({
      class: markClass,
    }).range(invocation.contentFrom, invocation.contentTo));
    const mention = `@${invocation.agent}`;
    if (invocation.kind === "invocation" && text.startsWith(mention, invocation.contentFrom)) {
      decorations.push(Decoration.mark({
        class: `inline-agent-composer__mention inline-agent-composer__mention--${agentPresentation(invocation.agent)}`,
      }).range(invocation.contentFrom, invocation.contentFrom + mention.length));
    }
    if (invocation.kind === "response") {
      decorations.push(Decoration.widget({
        widget: new PersistedInvocationResumeWidget(invocation.invocationId),
        side: 1,
      }).range(invocation.contentTo));
    }
  }
  return Decoration.set(decorations, true);
}

class PersistedInvocationResumeWidget extends WidgetType {
  constructor(private readonly protocolInvocationId: string) { super(); }

  eq(other: PersistedInvocationResumeWidget): boolean {
    return other.protocolInvocationId === this.protocolInvocationId;
  }

  toDOM(): HTMLElement {
    const button = document.createElement("button");
    button.className = "inline-agent-response__resume";
    button.type = "button";
    button.title = "Open agent session";
    button.setAttribute("aria-label", "Open agent session");
    button.dataset.protocolInvocationId = this.protocolInvocationId;
    button.innerHTML = '<svg aria-hidden="true" viewBox="0 0 16 16"><path d="M6 3h7v7M13 3 4 12"/></svg>';
    button.addEventListener("mousedown", (event) => event.preventDefault());
    button.addEventListener("click", () => {
      button.dispatchEvent(new CustomEvent("exograph:resume-invocation", {
        bubbles: true,
        detail: { protocolInvocationId: this.protocolInvocationId },
      }));
    });
    return button;
  }

  ignoreEvent(): boolean { return false; }
}

export function isPersistedInvocationPosition(state: EditorState, position: number): boolean {
  return findDocumentAgentEnvelopes(state.doc.toString())
    .filter((envelope) => envelope.kind === "invocation")
    .some((invocation) => position >= invocation.from && position <= invocation.to);
}

interface ComposerCallbacks {
  getCommand?: (handle: string) => AgentCommand | undefined;
  onSend: (draft: InlineAgentDraft) => void;
  onRestore?: (documentBody: string) => void;
}

const composerCallbackFacet = Facet.define<ComposerCallbacks, ComposerCallbacks>({
  combine: (callbacks) => callbacks[0] ?? { onSend: () => {} },
});

function sendInlineAgentComposer(view: EditorView): boolean {
  const composer = view.state.field(composerState, false);
  if (!composer) return false;
  const message = view.state.sliceDoc(composer.messageFrom, composer.to).trim();
  if (!message) return true;
  const protocolInvocationId = globalThis.crypto.randomUUID();
  const source = view.state.sliceDoc(composer.from, composer.to);
  const anchor = captureInlineInvocationAnchor(
    view.coordsAtPos(composer.to),
    { width: globalThis.innerWidth, height: globalThis.innerHeight },
  );
  const envelope = formatDocumentAgentInvocation({ id: protocolInvocationId, agent: composer.handle, message: source });
  view.dispatch({
    changes: { from: composer.from, to: composer.to, insert: envelope },
    effects: closeComposer.of(null),
    userEvent: "input.complete",
  });
  const callbacks = view.state.facet(composerCallbackFacet);
  callbacks.onSend({
    protocolInvocationId,
    handle: composer.handle,
    message,
    documentBody: view.state.doc.toString(),
    ...(composer.skill ? { skill: composer.skill } : {}),
    anchor,
    restoreComposer: () => restoreSentInlineAgentComposer(view, {
      protocolInvocationId,
      handle: composer.handle,
      source,
      onRestore: callbacks.onRestore,
    }),
    focusComposer: () => view.focus(),
  });
  return true;
}

interface RestorableInvocation {
  protocolInvocationId: string;
  handle: string;
  source: string;
}

export function restoreInlineInvocationText(
  documentBody: string,
  invocation: RestorableInvocation,
): { documentBody: string; composer: ComposerState } | null {
  const envelope = findDocumentAgentEnvelopes(documentBody).find((candidate) =>
    candidate.kind === "invocation" &&
    candidate.id === invocation.protocolInvocationId &&
    candidate.agent === invocation.handle,
  );
  if (!envelope) return null;

  const from = envelope.from;
  const mentionLength = `@${invocation.handle}`.length;
  return {
    documentBody: `${documentBody.slice(0, envelope.from)}${invocation.source}${documentBody.slice(envelope.to)}`,
    composer: {
      id: nextComposerId++,
      handle: invocation.handle,
      from,
      messageFrom: from + mentionLength,
      to: from + invocation.source.length,
    },
  };
}

function restoreSentInlineAgentComposer(
  view: EditorView,
  invocation: RestorableInvocation & { onRestore?: (documentBody: string) => void },
): string | null {
  const restored = restoreInlineInvocationText(view.state.doc.toString(), invocation);
  if (!restored) {
    view.focus();
    return null;
  }
  const envelope = findDocumentAgentEnvelopes(view.state.doc.toString()).find((candidate) =>
    candidate.kind === "invocation" &&
    candidate.id === invocation.protocolInvocationId &&
    candidate.agent === invocation.handle,
  );
  if (!envelope) return null;
  view.dispatch({
    changes: { from: envelope.from, to: envelope.to, insert: invocation.source },
    effects: openComposer.of(restored.composer),
    selection: { anchor: restored.composer.to },
    userEvent: "input.complete",
  });
  const documentBody = view.state.doc.toString();
  invocation.onRestore?.(documentBody);
  view.focus();
  return documentBody;
}

export function captureInlineInvocationAnchor(
  coords: { left: number; top: number; bottom: number } | null,
  viewport: { width: number; height: number },
): InlineAgentViewportAnchor {
  const margin = 12;
  const gap = 6;
  const popoverWidth = 390;
  const estimatedPopoverHeight = 220;
  if (!coords) return { left: 24, top: 48, origin: "top left" };

  const maxLeft = Math.max(margin, viewport.width - popoverWidth - margin);
  const left = Math.min(Math.max(coords.left, margin), maxLeft);
  const below = coords.bottom + gap;
  if (below + estimatedPopoverHeight <= viewport.height - margin) {
    return { left, top: below, origin: "top left" };
  }
  return {
    left,
    top: Math.max(margin, coords.top - estimatedPopoverHeight - gap),
    origin: "bottom left",
  };
}

function closeInlineAgentComposer(view: EditorView): boolean {
  if (!view.state.field(composerState, false)) return false;
  view.dispatch({ effects: closeComposer.of(null), userEvent: "input.complete" });
  return true;
}

export class InlineAgentAffordanceWidget extends WidgetType {
  constructor(private readonly composer: ComposerState, private readonly appearance?: AgentCommandAppearance) {
    super();
  }

  eq(other: InlineAgentAffordanceWidget): boolean {
    return this.composer.id === other.composer.id && this.composer.handle === other.composer.handle
      && this.appearance?.color === other.appearance?.color && this.appearance?.iconDataUrl === other.appearance?.iconDataUrl;
  }

  toDOM(view: EditorView): HTMLElement {
    const anchor = document.createElement("span");
    anchor.className = `inline-agent-composer__affordance inline-agent-composer__affordance--${agentPresentation(this.composer.handle)}`;
    anchor.dataset.testid = "inline-agent-composer";

    const hint = document.createElement("span");
    hint.className = "inline-agent-composer__hint";
    hint.textContent = "⌘ ↵";
    hint.setAttribute("aria-label", "Command Return to send");
    hint.title = "Command + Return to send";

    const button = document.createElement("button");
    button.className = "inline-agent-composer__send";
    button.type = "button";
    button.setAttribute("aria-label", `Send message to @${this.composer.handle}`);
    const appearance = this.appearance;
    const mark = document.createElement("span");
    mark.className = "agent-command-icon";
    mark.setAttribute("aria-hidden", "true");
    if (appearance?.color) { mark.style.color = appearance.color; mark.style.borderColor = appearance.color; }
    if (appearance?.iconDataUrl) {
      const image = document.createElement("img");
      image.src = appearance.iconDataUrl;
      image.alt = "";
      image.width = image.height = 16;
      image.addEventListener("error", () => mark.replaceChildren(createAgentIcon(agentPresentation(this.composer.handle))), { once: true });
      mark.append(image);
    } else mark.append(createAgentIcon(agentPresentation(this.composer.handle)));
    button.append(mark);
    button.addEventListener("mousedown", (event) => event.preventDefault());
    button.addEventListener("click", (event) => {
      event.preventDefault();
      sendInlineAgentComposer(view);
      view.focus();
    });

    anchor.append(hint, button);
    return anchor;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

function agentPresentation(handle: string): "claude" | "codex" | "default" {
  return handle === "claude" || handle === "codex" ? handle : "default";
}

function createAgentIcon(kind: ReturnType<typeof agentPresentation>): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("fill", "currentColor");
  path.setAttribute("d", kind === "claude"
    ? "M4.709 15.955l4.72-2.647.08-.23-.08-.128H9.2l-.79-.048-2.698-.073-2.339-.097-2.266-.122-.571-.121L0 11.784l.055-.352.48-.321.686.06 1.52.103 2.278.158 1.652.097 2.449.255h.389l.055-.157-.134-.098-.103-.097-2.358-1.596-2.552-1.688-1.336-.972-.724-.491-.364-.462-.158-1.008.656-.722.881.06.225.061.893.686 1.908 1.476 2.491 1.833.365.304.145-.103.019-.073-.164-.274-1.355-2.446-1.446-2.49-.644-1.032-.17-.619a2.97 2.97 0 01-.104-.729L6.283.134 6.696 0l.996.134.42.364.62 1.414 1.002 2.229 1.555 3.03.456.898.243.832.091.255h.158V9.01l.128-1.706.237-2.095.23-2.695.08-.76.376-.91.747-.492.584.28.48.685-.067.444-.286 1.851-.559 2.903-.364 1.942h.212l.243-.242.985-1.306 1.652-2.064.73-.82.85-.904.547-.431h1.033l.76 1.129-.34 1.166-1.064 1.347-.881 1.142-1.264 1.7-.79 1.36.073.11.188-.02 2.856-.606 1.543-.28 1.841-.315.833.388.091.395-.328.807-1.969.486-2.309.462-3.439.813-.042.03.049.061 1.549.146.662.036h1.622l3.02.225.79.522.474.638-.079.485-1.215.62-1.64-.389-3.829-.91-1.312-.329h-.182v.11l1.093 1.068 2.006 1.81 2.509 2.33.127.578-.322.455-.34-.049-2.205-1.657-.851-.747-1.926-1.62h-.128v.17l.444.649 2.345 3.521.122 1.08-.17.353-.608.213-.668-.122-1.374-1.925-1.415-2.167-1.143-1.943-.14.08-.674 7.254-.316.37-.729.28-.607-.461-.322-.747.322-1.476.389-1.924.315-1.53.286-1.9.17-.632-.012-.042-.14.018-1.434 1.967-2.18 2.945-1.726 1.845-.414.164-.717-.37.067-.662.401-.589 2.388-3.036 1.44-1.882.93-1.086-.006-.158h-.055L4.132 18.56l-1.13.146-.487-.456.061-.746.231-.243 1.908-1.312-.006.006z"
    : "M4.25 4.75h15.5v14.5H4.25zM8 9.5h8M8 13h5");
  svg.append(path);
  return svg;
}
