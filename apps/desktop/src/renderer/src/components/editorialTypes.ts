import type { EditorialSnapshot } from "../../../shared/api";
import type { EditorialNote, EditorialSpan } from "@exograph/core/editorial-notes";
export type EditorialDisplayMode = "original" | "diff" | "preview";
export type EditorialAction =
  | { kind: "status"; noteId: string; status: EditorialNote["status"] }
  | { kind: "remove-target" | "remove-replacement"; noteId: string; targetId: string }
  | { kind: "field"; noteId: string; field: "title" | "commentary"; value: string }
  | { kind: "replacement"; noteId: string; targetId: string; value: string }
  | { kind: "apply" | "agent" | "add-target"; noteId: string }
  | { kind: "retarget" | "rebase"; noteId: string; targetId: string };
/** Local renderer bridge; NoteEditor remains the sole view/command owner. */
export interface EditorialPaneController {
  paneId: string;
  filePath: string;
  source: string;
  spans: readonly EditorialSpan[];
  selectedNoteId: string | null;
  mutationDisabled?: string;
  captureDisabled?: string;
  agentDisabled?: string;
  error: string | null;
  selectNote: (id: string) => void;
  createNote: () => void;
  action: (action: EditorialAction) => void;
  clearError: () => void;
  retrySave?: () => void;
  orphans?: EditorialSnapshot["orphans"];
  relink?: (documentId:string) => void;
  inlineNoteIds?: readonly string[];
  migrate?: () => void;
}
