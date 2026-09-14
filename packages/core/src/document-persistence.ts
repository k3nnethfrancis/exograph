import { createHash } from "node:crypto";
import { readFile, realpath, open } from "node:fs/promises";

import { parseWorkspaceDocument, serializeWorkspaceDocument } from "./notes";
import { createWorkspaceFile } from "./workspace";
import type { NoteDocument } from "./types";

export interface VersionedNoteDocument extends NoteDocument {
  revision: string;
}

export type DocumentSaveResult =
  | { status: "saved"; revision: string }
  | { status: "conflict"; currentRevision: string }
  | { status: "missing" };

function revisionOf(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Owns editor reads and revision-checked saves. Outside writers do not share
 * this queue: the comparison detects observed changes, not filesystem CAS. */
export class DocumentPersistence {
  private readonly pending = new Map<string, Promise<unknown>>();

  async read(filePath: string): Promise<VersionedNoteDocument> {
    const bytes = await readFile(filePath);
    return { ...parseWorkspaceDocument(filePath, bytes.toString("utf8")), revision: revisionOf(bytes) };
  }

  async save(filePath: string, frontmatter: Record<string, unknown>, body: string, expectedRevision: string): Promise<DocumentSaveResult> {
    if (typeof expectedRevision !== "string" || !/^[a-f0-9]{64}$/.test(expectedRevision)) {
      throw new Error("A document revision is required to save safely. Reload the document first.");
    }
    let identity: string;
    try { identity = await realpath(filePath); }
    catch (error) { if (isMissing(error)) return { status: "missing" }; throw error; }
    const previous = this.pending.get(identity) ?? Promise.resolve();
    const saving = previous.catch(() => {}).then(async (): Promise<DocumentSaveResult> => {
      // r+ never recreates a removed file. Read and write through the same
      // handle so an atomic replacement cannot redirect this save onto it.
      let file;
      try { file = await open(identity, "r+"); }
      catch (error) { if (isMissing(error)) return { status: "missing" }; throw error; }
      try {
        const currentRevision = revisionOf(await file.readFile());
        if (currentRevision !== expectedRevision) return { status: "conflict", currentRevision };
        const serialized = serializeWorkspaceDocument(filePath, frontmatter, body);
        const bytes = Buffer.from(serialized, "utf8");
        // Explicit position: readFile advanced the handle's cursor.
        let offset = 0;
        while (offset < bytes.length) {
          const { bytesWritten } = await file.write(bytes, offset, bytes.length - offset, offset);
          if (!bytesWritten) throw new Error("The document write made no progress.");
          offset += bytesWritten;
        }
        await file.truncate(bytes.length);
        const revision = revisionOf(bytes);
        // A path may have been atomically replaced while its old handle was
        // open. Never clear the buffer if the named file is already different.
        let observedRevision: string;
        try { observedRevision = revisionOf(await readFile(filePath)); }
        catch (error) { if (isMissing(error)) return { status: "missing" }; throw error; }
        return observedRevision === revision
          ? { status: "saved", revision }
          : { status: "conflict", currentRevision: observedRevision };
      } finally { await file.close(); }
    });
    this.pending.set(identity, saving);
    try { return await saving; }
    finally { if (this.pending.get(identity) === saving) this.pending.delete(identity); }
  }

  async saveCopy(filePath: string, frontmatter: Record<string, unknown>, body: string): Promise<VersionedNoteDocument> {
    const serialized = serializeWorkspaceDocument(filePath, frontmatter, body);
    await createWorkspaceFile(filePath, serialized);
    return { ...parseWorkspaceDocument(filePath, serialized), revision: revisionOf(serialized) };
  }
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}
