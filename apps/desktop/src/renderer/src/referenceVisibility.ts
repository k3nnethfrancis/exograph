import { ViewPlugin, type EditorView, type ViewUpdate } from "@codemirror/view";

export const REFERENCES_REVEAL_PROGRESS = 0.72;
export const REFERENCES_HIDE_PROGRESS = 0.6;

/** Stable scroll-owned visibility for the editor's terminal References block. */
export function referencesVisibleAtScroll(
  currentlyVisible: boolean,
  scrollTop: number,
  scrollHeight: number,
  clientHeight: number,
): boolean {
  const scrollable = Math.max(0, scrollHeight - clientHeight);
  if (scrollable <= 1) return true;
  const progress = Math.min(1, Math.max(0, scrollTop / scrollable));
  return currentlyVisible
    ? progress >= REFERENCES_HIDE_PROGRESS
    : progress >= REFERENCES_REVEAL_PROGRESS;
}

class ReferenceVisibilityController {
  private visible = false;
  private frame: number | null = null;

  constructor(private readonly view: EditorView) {
    this.view.scrollDOM.addEventListener("scroll", this.sync, { passive: true });
    this.scheduleSync();
  }

  update(update: ViewUpdate) {
    if (update.docChanged || update.geometryChanged) this.scheduleSync();
  }

  destroy() {
    this.view.scrollDOM.removeEventListener("scroll", this.sync);
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.surface()?.classList.remove("editor-surface--references-visible");
  }

  private readonly sync = () => {
    const scroller = this.view.scrollDOM;
    this.visible = referencesVisibleAtScroll(
      this.visible,
      scroller.scrollTop,
      scroller.scrollHeight,
      scroller.clientHeight,
    );
    this.surface()?.classList.toggle("editor-surface--references-visible", this.visible);
  };

  private scheduleSync() {
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.frame = requestAnimationFrame(() => {
      this.frame = null;
      this.sync();
    });
  }

  private surface() {
    return this.view.dom.closest<HTMLElement>(".editor-surface");
  }
}

export const referenceVisibilityExtension = ViewPlugin.fromClass(ReferenceVisibilityController);
