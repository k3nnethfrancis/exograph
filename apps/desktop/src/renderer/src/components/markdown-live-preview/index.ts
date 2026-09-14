import { type ChangeSet, type Extension, StateEffect, StateField, type Text, Transaction } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import {
  listContinuationOutdentKeymap,
  listPrefixAtomicRanges,
  listPrefixNavigationKeymap,
  listPrefixSelectionFilter,
  selectAllMarkdownKeymap,
  toggleTaskCheckboxAt,
  wikilinkExitKeymap,
} from "./commands";
import {
  listPrefixPattern,
  markdownPreviewMetadata,
  type MarkdownPreviewMetadata,
  updateMarkdownPreviewMetadataForChanges,
} from "./metadata";
import { buildDecorations } from "./decorations";
import { GraphReferencesWidget, type MarkdownGraphReferences } from "./widgets";
import { referenceVisibilityExtension } from "../../referenceVisibility";
export type { MarkdownGraphReferenceItem, MarkdownGraphReferences } from "./widgets";

const toggleFoldEffect = StateEffect.define<number>();
export const refreshMarkdownPreviewEffect = StateEffect.define<null>();

const foldedListParentAnchorsField = StateField.define<Set<number>>({
  create() {
    return new Set();
  },
  update(folded, tr) {
    let next = folded;
    for (const effect of tr.effects) {
      if (effect.is(toggleFoldEffect)) {
        next = new Set(next);
        if (next.has(effect.value)) {
          next.delete(effect.value);
        } else {
          next.add(effect.value);
        }
      }
    }
    if (tr.docChanged) {
      // A fold follows its parent line-start anchor, never a raw line number.
      const remapped = new Set<number>();
      for (const anchor of next) {
        const mappedAnchor = remapFoldParentAnchor(anchor, tr);
        if (mappedAnchor !== null) {
          remapped.add(mappedAnchor);
        }
      }
      return remapped;
    }
    return next;
  },
});

function remapFoldParentAnchor(anchor: number, tr: Transaction): number | null {
  let parentDeleted = false;
  let insertedLineBeforeParent = false;
  const parentLineEnd = tr.startState.doc.lineAt(anchor).to;
  tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    if (fromA <= anchor && toA >= parentLineEnd) {
      parentDeleted = true;
    }
    if (fromA === anchor && toA === anchor && inserted.toString().includes("\n")) {
      insertedLineBeforeParent = true;
    }
  }, true);
  if (parentDeleted) {
    return null;
  }

  const mappedAnchor = tr.changes.mapPos(anchor, insertedLineBeforeParent ? 1 : -1);
  return isListParentAnchor(tr.state.doc, mappedAnchor) ? mappedAnchor : null;
}

function isListParentAnchor(doc: Text, anchor: number): boolean {
  if (anchor < 0 || anchor > doc.length) return false;
  const line = doc.lineAt(anchor);
  return line.from === anchor && (
    listPrefixPattern.test(line.text)
    || /^(#{1,6})\s+/.test(line.text)
    || /^(\s*)#([A-Za-z][\w/-]*)\b/.test(line.text)
  );
}

interface MarkdownLivePreviewOptions {
  onOpenTarget: (target: string) => void;
  onOpenTag: (tag: string) => void;
  onResolveImage: (target: string, options?: { lookupByFilename?: boolean }) => Promise<{ url: string }>;
  suppressedGeneratedTitle?: string | null;
  graphReferences?: MarkdownGraphReferences | null;
  getGraphReferences?: () => MarkdownGraphReferences | null;
}

interface MarkdownPreviewProjectionUpdate {
  previousDoc: Text;
  nextDoc: Text;
  changes: ChangeSet;
  docChanged: boolean;
  rebuild: boolean;
}

/** Internal composition seam: projection compilation must observe metadata
 * repaired for the same document generation. */
export function advanceMarkdownPreviewProjection<Result>(
  update: MarkdownPreviewProjectionUpdate,
  metadata: MarkdownPreviewMetadata,
  compile: (currentMetadata: MarkdownPreviewMetadata) => Result,
): { metadata: MarkdownPreviewMetadata; projection: Result | null } {
  const currentMetadata = update.docChanged
    ? updateMarkdownPreviewMetadataForChanges(update.previousDoc, update.nextDoc, update.changes, metadata)
    : metadata;
  return {
    metadata: currentMetadata,
    projection: update.rebuild ? compile(currentMetadata) : null,
  };
}

export function markdownLivePreview(options: MarkdownLivePreviewOptions): Extension[] {
  const graphReferences = () => options.getGraphReferences?.() ?? options.graphReferences;
  const decorationOptions = {
    ...options,
    onToggleFold: (view: EditorView, anchor: number) => {
      view.dispatch({ effects: toggleFoldEffect.of(anchor) });
    },
  };
  const graphReferencesField = StateField.define<DecorationSet>({
    create(state) {
      return graphReferenceDecorations(state.doc.length, graphReferences());
    },
    update(value, transaction) {
      const refresh = transaction.effects.some((effect) => effect.is(refreshMarkdownPreviewEffect));
      return transaction.docChanged || refresh
        ? graphReferenceDecorations(transaction.state.doc.length, graphReferences())
        : value;
    },
    provide: (field) => EditorView.decorations.from(field),
  });
  const plugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      metadata: MarkdownPreviewMetadata;

      constructor(view: EditorView) {
        this.metadata = markdownPreviewMetadata(view.state.doc);
        this.decorations = buildDecorations(view, decorationOptions, this.metadata, view.state.field(foldedListParentAnchorsField));
      }

      update(update: ViewUpdate) {
        const next = advanceMarkdownPreviewProjection({
          previousDoc: update.startState.doc,
          nextDoc: update.state.doc,
          changes: update.changes,
          docChanged: update.docChanged,
          rebuild: update.docChanged
            || update.viewportChanged
            || update.selectionSet
            || update.transactions.some(tr => tr.effects.some(e => (
              e.is(toggleFoldEffect) || e.is(refreshMarkdownPreviewEffect)
            ))),
        }, this.metadata, (metadata) =>
          buildDecorations(update.view, decorationOptions, metadata, update.view.state.field(foldedListParentAnchorsField)));
        this.metadata = next.metadata;
        if (next.projection) {
          this.decorations = next.projection;
        }
      }
    },
    { decorations: (instance) => instance.decorations },
  );

  return [
    foldedListParentAnchorsField,
    graphReferencesField,
    listPrefixAtomicRanges,
    listPrefixSelectionFilter,
    selectAllMarkdownKeymap,
    referenceVisibilityExtension,
    plugin,
    wikilinkExitKeymap,
    listContinuationOutdentKeymap,
    listPrefixNavigationKeymap,
    EditorView.domEventHandlers({
      mousedown(event, view) {
        if (!(event.target instanceof HTMLElement)) return false;

        const checkbox = event.target.closest<HTMLElement>("[data-exograph-checkbox-pos]");
        if (checkbox) {
          const toggled = toggleTaskCheckboxAt(view, checkbox.dataset.exographCheckboxPos);
          if (toggled) {
            event.preventDefault();
            event.stopPropagation();
            return true;
          }
        }

        const interactivePreviewControl = event.target.closest<HTMLElement>(
          "[data-exograph-fold-anchor], [data-exograph-checkbox-pos], [data-exograph-link-target], [data-exograph-tag]",
        );
        if (!interactivePreviewControl) {
          return false;
        }

        event.preventDefault();
        return true;
      },
      click(event, view) {
        if (!(event.target instanceof HTMLElement)) return false;

        // Checkbox toggle
        const checkbox = event.target.closest<HTMLElement>("[data-exograph-checkbox-pos]");
        if (checkbox) {
          event.preventDefault();
          return true;
        }

        // List fold toggle
        const foldToggle = event.target.closest<HTMLElement>("[data-exograph-fold-anchor]");
        if (foldToggle) {
          const anchor = Number(foldToggle.dataset.exographFoldAnchor);
          if (Number.isInteger(anchor) && anchor >= 0 && anchor <= view.state.doc.length) {
            view.dispatch({ effects: toggleFoldEffect.of(anchor) });
            event.preventDefault();
            return true;
          }
        }

        // Link / tag clicks
        const target = event.target.closest<HTMLElement>("[data-exograph-link-target], [data-exograph-tag]");
        if (!target) {
          return false;
        }

        const noteTarget = target.dataset.exographLinkTarget;
        if (noteTarget) {
          event.preventDefault();
          options.onOpenTarget(noteTarget);
          return true;
        }

        const tag = target.dataset.exographTag;
        if (tag) {
          event.preventDefault();
          options.onOpenTag(tag);
          return true;
        }

        return false;
      },
    }),
  ];
}

function graphReferenceDecorations(
  documentEnd: number,
  references: MarkdownGraphReferences | null | undefined,
): DecorationSet {
  if (!references || (references.backlinks.length === 0 && references.references.length === 0)) {
    return Decoration.none;
  }
  return Decoration.set([
    Decoration.widget({
      widget: new GraphReferencesWidget(references),
      side: 1,
      block: true,
    }).range(documentEnd),
  ]);
}

// ---------------------------------------------------------------------------
