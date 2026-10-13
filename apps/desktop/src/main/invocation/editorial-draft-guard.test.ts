import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildInvocationChangeset, createDefaultClaudeAgentCommand, agentCommandSnapshot, InvocationStore, type InvocationRecord } from "@exograph/core";
import { guardEditorialDraftSettlement } from "./editorial-draft-guard";
import { InvocationReviewService } from "./invocation-review";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "exograph-editorial-guard-")); roots.push(root);
  const notePath = path.join(root, "essay.md"), otherPath = path.join(root, "other.md");
  const source = "Author prose.\n";
  await writeFile(notePath,source); await writeFile(otherPath,"Unrelated file.\n");
  const store = new InvocationStore(root);
  const artifacts = await store.captureLaunchArtifacts("draft", { noteRoots: [root], cleanBase: {path: notePath, content: source} });
  const record: InvocationRecord = {id: "draft", workspaceRoot: root, noteRoots: [root], context: "note", status: "process-exited", taggedDocumentPath: notePath, originalMentionText: "@claude", purpose:"editorial-draft",editorialDraft:{noteId:"selected",annotationRevision:"a".repeat(64),sourceRevision:"b".repeat(64),reviewStatus:"waiting"},mentionProvenance: "human-authored", message: "Draft only.", promptDelivery: "stdin", command: agentCommandSnapshot(createDefaultClaudeAgentCommand()), cwd: root, createdAt: new Date().toISOString(), continuity: {policy: "fresh", outcome: "fresh"}};
  const capture = async () => {
    const settled = await store.captureSettledManifest(record.id, [root], artifacts.launchManifest);
    return {...record, changeset: buildInvocationChangeset(artifacts.launchManifest, settled)};
  };
  return {root,notePath,otherPath,source,store,record,capture};
}
describe("staged editorial source-write guard", () => {
  it("does not alter an unchanged author document", async () => {
    const f = await fixture(), captured = await f.capture();
    const result = await guardEditorialDraftSettlement(f.store,captured);
    expect(result).toEqual(captured); expect(await readFile(f.notePath,"utf8")).toBe(f.source);
  });
  it("journal-rejects all observed author and unrelated file changes", async () => {
    const f = await fixture(); await writeFile(f.notePath,"Illegal author rewrite.\n"); await writeFile(f.otherPath,"Illegal unrelated rewrite.\n");
    const result = await guardEditorialDraftSettlement(f.store,await f.capture());
    expect(result.status).toBe("failed"); expect(result.editorialGuardFailure).toContain("rejected");
    expect(result.changeset?.files.every(change => change.decision.status === "rejected")).toBe(true);
    expect(await readFile(f.notePath,"utf8")).toBe(f.source); expect(await readFile(f.otherPath,"utf8")).toBe("Unrelated file.\n");
    expect((await f.store.readRecord("draft"))?.editorialGuardFailure).toBe(result.editorialGuardFailure);
  });
  it("preserves newer bytes on rollback conflict and disallows Keep-current", async () => {
    const f = await fixture(); await writeFile(f.notePath,"Illegal rewrite.\n");
    const captured = await f.capture(), current = "Latest external author edit.\n";
    await writeFile(f.notePath,current);
    const result = await guardEditorialDraftSettlement(f.store,captured);
    expect(result.status).toBe("failed"); expect(result.changeset?.status).toBe("conflict"); expect(await readFile(f.notePath,"utf8")).toBe(current);
    const review = new InvocationReviewService(f.root), changeId = result.changeset!.files[0].id;
    expect((await review.getFilePayload(result,changeId)).canKeep).toBe(false);
    await expect(review.resolve(result,[{changeId,action:"keep"}])).rejects.toThrow("Editorial drafting was rejected");
    expect(await readFile(f.notePath,"utf8")).toBe(current);
  });
});
