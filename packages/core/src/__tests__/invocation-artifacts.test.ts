import { chmod, mkdtemp, mkdir, readFile, readdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildInvocationChangeset } from "../invocation-changeset";
import { InvocationArtifactCompactionError, InvocationCaptureBudgetError } from "../invocation-artifacts";
import { InvocationStore } from "../invocation-store";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("invocation artifacts", () => {
  it("captures exact multi-root launch and settled manifests into streamed content-addressed objects", async () => {
    const workspaceRoot = await temporaryRoot();
    const rootA = path.join(workspaceRoot, "notes-a");
    const rootB = path.join(workspaceRoot, "notes-b");
    await Promise.all([mkdir(rootA), mkdir(rootB)]);
    const modified = path.join(rootA, "modified.md");
    const deleted = path.join(rootB, "deleted.md");
    const renamedFrom = path.join(rootA, "old-name.md");
    const largeBinary = path.join(rootB, "large.bin");
    const shared = Buffer.from("same content\n");
    const binary = Buffer.alloc(3 * 1024 * 1024, 7);
    binary[4096] = 0;
    await Promise.all([
      writeFile(modified, "before\n"),
      writeFile(deleted, "delete me\n"),
      writeFile(renamedFrom, shared),
      writeFile(largeBinary, binary),
      writeFile(path.join(rootB, "same-copy.bin"), binary),
      mkdir(path.join(rootA, ".exograph"), { recursive: true }).then(() => writeFile(path.join(rootA, ".exograph", "ignored.md"), "ignore")),
    ]);
    const outside = path.join(workspaceRoot, "outside.md");
    await writeFile(outside, "outside");
    await symlink(outside, path.join(rootA, "outside-link.md"));

    const store = new InvocationStore(workspaceRoot);
    const invocationId = "capture-all";
    const canonicalRootA = await realpath(rootA);
    const canonicalRootB = await realpath(rootB);
    const launch = await store.captureLaunchArtifacts(invocationId, {
      noteRoots: [rootB, rootA, rootA],
      cleanBase: { path: modified, content: "clean request removed\n", capturedAt: "2026-07-20T00:00:00.000Z" },
      capture: { capturedAt: "2026-07-20T00:00:01.000Z", maxConcurrency: 2 },
    });

    expect(Object.keys(launch.launchManifest.files)).toEqual([
      path.join(canonicalRootB, "large.bin"),
      path.join(canonicalRootB, "same-copy.bin"),
      path.join(canonicalRootB, "deleted.md"),
      path.join(canonicalRootA, "modified.md"),
      path.join(canonicalRootA, "old-name.md"),
    ].sort());
    const canonicalLargeBinary = path.join(canonicalRootB, "large.bin");
    expect(Object.keys(launch.launchManifest.files)).not.toContain(path.join(canonicalRootA, ".exograph", "ignored.md"));
    expect(Object.keys(launch.launchManifest.files)).not.toContain(path.join(canonicalRootA, "outside-link.md"));
    expect(launch.launchManifest.files[canonicalLargeBinary]?.mediaType).toBe("binary");
    expect(launch.launchManifest.files[canonicalLargeBinary]?.byteLength).toBe(binary.byteLength);
    expect(launch.launchManifest.files[canonicalLargeBinary]?.snapshotRef).toBe(
      launch.launchManifest.files[path.join(canonicalRootB, "same-copy.bin")]?.snapshotRef,
    );
    await expect(store.readSnapshot(invocationId, launch.cleanBase.file)).resolves.toEqual(Buffer.from("clean request removed\n"));

    const renamedTo = path.join(rootA, "new-name.md");
    const created = path.join(rootB, "created.md");
    await Promise.all([
      writeFile(modified, "after\n"),
      rm(deleted),
      rename(renamedFrom, renamedTo),
      writeFile(created, "new\n"),
    ]);
    const frozenLaunch = await store.captureManifest(invocationId, "launch", [rootA, rootB]);
    expect(frozenLaunch.files[path.join(canonicalRootA, "modified.md")]?.sha256).toBe(
      launch.launchManifest.files[path.join(canonicalRootA, "modified.md")]?.sha256,
    );
    const settled = await store.captureManifest(invocationId, "settled", [rootA, rootB], {
      capturedAt: "2026-07-20T00:00:02.000Z",
      maxConcurrency: 3,
    });
    const changeset = buildInvocationChangeset(launch.launchManifest, settled);

    expect(changeset.files.map((entry) => entry.operation).sort()).toEqual(["created", "deleted", "modified", "renamed"]);
    expect(changeset.files.find((entry) => entry.operation === "renamed")).toMatchObject({
      before: { path: path.join(canonicalRootA, "old-name.md") },
      after: { path: path.join(canonicalRootA, "new-name.md") },
    });
    const objectFiles = await readdir(path.join(workspaceRoot, ".exograph", "invocations", invocationId, "files", "objects"));
    expect(objectFiles.every((entry) => /^[a-f0-9]{64}$/.test(entry))).toBe(true);
    expect(objectFiles.filter((entry) => entry === launch.launchManifest.files[canonicalLargeBinary]?.sha256)).toHaveLength(1);

    const report = await store.compactArtifacts(invocationId, changeset);
    expect(report).toMatchObject({
      beforeObjectCount: 7,
      retainedObjectCount: 6,
      removedObjectCount: 1,
      removedBytes: binary.byteLength,
    });
    const compactLaunch = await store.readManifest(invocationId, "launch");
    const compactSettled = await store.readManifest(invocationId, "settled");
    expect(Object.keys(compactLaunch!.files).sort()).toEqual([
      path.join(canonicalRootA, "modified.md"),
      path.join(canonicalRootA, "old-name.md"),
      path.join(canonicalRootB, "deleted.md"),
    ].sort());
    expect(Object.keys(compactSettled!.files).sort()).toEqual([
      path.join(canonicalRootA, "modified.md"),
      path.join(canonicalRootA, "new-name.md"),
      path.join(canonicalRootB, "created.md"),
    ].sort());
    await expect(store.readSnapshot(invocationId, changeset.files.find((entry) => entry.operation === "deleted")!.before!))
      .resolves.toEqual(Buffer.from("delete me\n"));
    expect(await readdir(path.join(workspaceRoot, ".exograph", "invocations", invocationId, "files", "objects")))
      .not.toContain(launch.launchManifest.files[canonicalLargeBinary]?.sha256);
  });

  it("reuses unchanged launch snapshots while capturing the exact settled manifest", async () => {
    const workspaceRoot = await temporaryRoot();
    const noteRoot = path.join(workspaceRoot, "notes");
    const notePath = path.join(noteRoot, "note.md");
    const unchangedPath = path.join(noteRoot, "unchanged.bin");
    await mkdir(noteRoot);
    await Promise.all([
      writeFile(notePath, "before\n"),
      writeFile(unchangedPath, Buffer.alloc(2 * 1024 * 1024, 7)),
    ]);
    const store = new InvocationStore(workspaceRoot);
    const launch = await store.captureManifest("reuse-unchanged", "launch", [noteRoot]);
    await writeFile(notePath, "after\n");

    const settled = await store.captureSettledManifest(
      "reuse-unchanged",
      [noteRoot],
      launch,
      { maxTotalBytes: 3 * 1024 * 1024 },
    );
    const changeset = buildInvocationChangeset(launch, settled);

    expect(changeset.files).toHaveLength(1);
    expect(changeset.files[0]).toMatchObject({ operation: "modified", after: { path: await realpath(notePath) } });
    expect(settled.files[await realpath(unchangedPath)]).toEqual(launch.files[await realpath(unchangedPath)]);
  });

  it("counts each current file once against the settled total-byte budget", async () => {
    const workspaceRoot = await temporaryRoot();
    const noteRoot = path.join(workspaceRoot, "notes");
    const notePath = path.join(noteRoot, "note.md");
    await mkdir(noteRoot);
    await writeFile(notePath, "aaaa");
    const store = new InvocationStore(workspaceRoot);
    const launch = await store.captureManifest("settled-byte-budget", "launch", [noteRoot]);
    await writeFile(notePath, "bbbb");

    const settled = await store.captureSettledManifest(
      "settled-byte-budget",
      [noteRoot],
      launch,
      { maxTotalBytes: 4 },
    );

    expect(buildInvocationChangeset(launch, settled).files).toEqual([
      expect.objectContaining({
        operation: "modified",
        after: expect.objectContaining({ path: await realpath(notePath), byteLength: 4 }),
      }),
    ]);
  });

  it("does not rewrite unchanged launch objects during settlement", async () => {
    const workspaceRoot = await temporaryRoot();
    const noteRoot = path.join(workspaceRoot, "notes");
    const notePath = path.join(noteRoot, "note.md");
    await mkdir(noteRoot);
    await writeFile(notePath, "unchanged\n");
    const store = new InvocationStore(workspaceRoot);
    const invocationId = "read-only-reuse";
    const launch = await store.captureManifest(invocationId, "launch", [noteRoot]);
    const objectsDir = path.join(workspaceRoot, ".exograph", "invocations", invocationId, "files", "objects");
    await chmod(objectsDir, 0o555);
    try {
      await expect(store.captureSettledManifest(invocationId, [noteRoot], launch)).resolves.toMatchObject({
        files: launch.files,
      });
    } finally {
      await chmod(objectsDir, 0o755);
    }
  });

  it("leaves duplicate-content moves as create/delete and never follows nested symlinks", async () => {
    const workspaceRoot = await temporaryRoot();
    const noteRoot = path.join(workspaceRoot, "notes");
    await mkdir(noteRoot);
    const fromA = path.join(noteRoot, "a.md");
    const fromB = path.join(noteRoot, "b.md");
    await Promise.all([writeFile(fromA, "duplicate"), writeFile(fromB, "duplicate")]);
    const store = new InvocationStore(workspaceRoot);
    const launch = await store.captureManifest("ambiguous", "launch", [noteRoot]);
    await Promise.all([
      rename(fromA, path.join(noteRoot, "c.md")),
      rename(fromB, path.join(noteRoot, "d.md")),
    ]);
    const settled = await store.captureManifest("ambiguous", "settled", [noteRoot]);

    const changeset = buildInvocationChangeset(launch, settled);
    expect(changeset.files.filter((entry) => entry.operation === "renamed")).toHaveLength(0);
    expect(changeset.files.filter((entry) => entry.operation === "created")).toHaveLength(2);
    expect(changeset.files.filter((entry) => entry.operation === "deleted")).toHaveLength(2);
  });

  it("persists atomic recovery artifacts and an idempotent review journal across store instances", async () => {
    const workspaceRoot = await temporaryRoot();
    const noteRoot = path.join(workspaceRoot, "notes");
    const notePath = path.join(noteRoot, "note.md");
    await mkdir(noteRoot);
    await writeFile(notePath, "launch\n");
    const first = new InvocationStore(workspaceRoot);
    const canonicalNotePath = await realpath(notePath);
    await first.captureLaunchArtifacts("recover-me", {
      noteRoots: [noteRoot],
      cleanBase: { path: notePath, content: "clean\n" },
    });
    await first.beginReviewJournal("recover-me", [
      { changeId: "modified:note", action: "reject" },
      { changeId: "created:other", action: "keep" },
    ], "2026-07-20T01:00:00.000Z");
    await expect(first.beginReviewJournal("recover-me", [
      { changeId: "modified:note", action: "reject" },
      { changeId: "created:other", action: "keep" },
    ], "later-is-ignored")).resolves.toMatchObject({ createdAt: "2026-07-20T01:00:00.000Z" });
    const quarantinePath = path.join(noteRoot, ".note.md.exograph-review-test.quarantine");
    const planned = await first.updateReviewJournalMutation("recover-me", "modified:note", {
      phase: "planned",
      quarantinePath,
    });
    expect(planned.entries[0]).toMatchObject({
      changeId: "modified:note",
      mutation: { phase: "planned", quarantinePath },
    });
    await first.updateReviewJournalEntry("recover-me", "modified:note", {
      status: "applied",
      completedAt: "2026-07-20T01:00:01.000Z",
    });
    const idempotentUpdate = await first.updateReviewJournalEntry("recover-me", "modified:note", {
      status: "applied",
      completedAt: "later-is-ignored",
    });
    expect(idempotentUpdate.entries[0]).toMatchObject({
      changeId: "modified:note",
      completedAt: "2026-07-20T01:00:01.000Z",
    });
    expect(idempotentUpdate.entries[0]?.mutation).toBeUndefined();
    await first.updateReviewJournalEntry("recover-me", "created:other", {
      status: "applied",
      acceptedSha256: "a".repeat(64),
      completedAt: "2026-07-20T01:00:02.000Z",
    });
    await expect(first.updateReviewJournalEntry("recover-me", "created:other", {
      status: "applied",
      acceptedSha256: "not-a-hash",
    })).rejects.toThrow("lowercase SHA-256");
    const invocationDir = path.join(workspaceRoot, ".exograph", "invocations", "recover-me");
    await writeFile(path.join(invocationDir, ".launch-manifest.json-interrupted.tmp"), "not json");

    const restarted = new InvocationStore(workspaceRoot);
    const recovery = await restarted.readArtifactRecovery("recover-me");
    expect(recovery).toMatchObject({
      invocationId: "recover-me",
      cleanBase: { file: { path: canonicalNotePath } },
      launchManifest: { files: { [canonicalNotePath]: { path: canonicalNotePath } } },
      settledManifest: null,
      reviewJournal: {
        entries: [
          { changeId: "modified:note", status: "applied" },
          { changeId: "created:other", status: "applied", acceptedSha256: "a".repeat(64) },
        ],
      },
    });
    await expect(restarted.listArtifactRecoveries()).resolves.toEqual([recovery]);
    await writeFile(path.join(invocationDir, "review-journal.json"), JSON.stringify({
      version: 1,
      createdAt: "2026-07-20T01:00:00.000Z",
      updatedAt: "2026-07-20T01:00:02.000Z",
      entries: [{ changeId: "created:other", action: "keep", status: "applied", acceptedSha256: "not-a-hash" }],
    }));
    await expect(restarted.readReviewJournal("recover-me")).rejects.toThrow("accepted hash is invalid");
    await expect(restarted.readArtifactRecovery("missing")).resolves.toEqual({
      invocationId: "missing",
      cleanBase: null,
      launchManifest: null,
      settledManifest: null,
      reviewJournal: null,
    });
  });

  it("fails closed when a configured Note Root is missing", async () => {
    const workspaceRoot = await temporaryRoot();
    const store = new InvocationStore(workspaceRoot);
    await expect(store.captureManifest("missing-root", "launch", [path.join(workspaceRoot, "gone")]))
      .rejects.toThrow("Note Root is unavailable");
    await expect(readFile(path.join(workspaceRoot, ".exograph", "invocations", "missing-root", "launch-manifest.json")))
      .rejects.toMatchObject({ code: "ENOENT" });
    await expect(store.captureManifest("no-roots", "launch", [])).rejects.toThrow("at least one Note Root");

    const noteRoot = path.join(workspaceRoot, "notes");
    const outside = path.join(workspaceRoot, "outside.md");
    await mkdir(noteRoot);
    await writeFile(outside, "outside");
    await expect(store.captureLaunchArtifacts("outside", {
      noteRoots: [noteRoot],
      cleanBase: { path: outside, content: "outside" },
    })).rejects.toThrow("outside the authorized Note Roots");
  });

  it.each([
    { budget: "file-count" as const, files: ["a", "b"], options: { maxFiles: 1 } },
    { budget: "file-bytes" as const, files: ["four"], options: { maxFileBytes: 3 } },
    { budget: "total-bytes" as const, files: ["abc", "def"], options: { maxTotalBytes: 5 } },
  ])("fails visibly at the $budget capture budget and cleans new objects", async ({ budget, files, options }) => {
    const workspaceRoot = await temporaryRoot();
    const noteRoot = path.join(workspaceRoot, "notes");
    await mkdir(noteRoot);
    await Promise.all(files.map((content, index) => writeFile(path.join(noteRoot, `${index}.md`), content)));
    const store = new InvocationStore(workspaceRoot);

    try {
      await store.captureManifest(`budget-${budget}`, "launch", [noteRoot], options);
      throw new Error("Expected capture to exceed its budget.");
    } catch (error) {
      expect(error).toBeInstanceOf(InvocationCaptureBudgetError);
      expect(error).toMatchObject({ code: "invocation-capture-budget-exceeded", budget });
    }
    const objectsDir = path.join(workspaceRoot, ".exograph", "invocations", `budget-${budget}`, "files", "objects");
    await expect(readdir(objectsDir)).resolves.toEqual([]);
  });

  it("fails visibly at the elapsed-time budget without leaving objects", async () => {
    const workspaceRoot = await temporaryRoot();
    const noteRoot = path.join(workspaceRoot, "notes");
    await mkdir(noteRoot);
    await writeFile(path.join(noteRoot, "note.md"), "content");
    const now = vi.spyOn(Date, "now").mockReturnValueOnce(0).mockReturnValue(10);
    const store = new InvocationStore(workspaceRoot);
    try {
      await expect(store.captureManifest("budget-elapsed", "launch", [noteRoot], { maxElapsedMs: 5 }))
        .rejects.toMatchObject({
          code: "invocation-capture-budget-exceeded",
          budget: "elapsed-time",
        });
    } finally {
      now.mockRestore();
    }
    const objectsDir = path.join(workspaceRoot, ".exograph", "invocations", "budget-elapsed", "files", "objects");
    await expect(readdir(objectsDir)).resolves.toEqual([]);
  });

  it("surfaces stale-artifact cleanup failures without deleting referenced History snapshots", async () => {
    const workspaceRoot = await temporaryRoot();
    const noteRoot = path.join(workspaceRoot, "notes");
    const notePath = path.join(noteRoot, "note.md");
    const unrelatedPath = path.join(noteRoot, "unrelated.md");
    await mkdir(noteRoot);
    await writeFile(notePath, "before\n");
    await writeFile(unrelatedPath, "large unrelated snapshot\n");
    const store = new InvocationStore(workspaceRoot);
    const invocationId = "compaction-failure";
    await store.captureCleanBase(invocationId, { path: notePath, content: "before\n" });
    const launch = await store.captureManifest(invocationId, "launch", [noteRoot]);
    await writeFile(notePath, "after\n");
    const settled = await store.captureManifest(invocationId, "settled", [noteRoot]);
    const changeset = buildInvocationChangeset(launch, settled);
    const objectsDir = path.join(workspaceRoot, ".exograph", "invocations", invocationId, "files", "objects");
    const malformedStaleArtifact = path.join(objectsDir, "stale-directory");
    await mkdir(malformedStaleArtifact);

    let failure: unknown;
    try {
      await store.compactArtifacts(invocationId, changeset);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(InvocationArtifactCompactionError);
    expect(failure).toMatchObject({
      code: "invocation-artifact-compaction-failed",
      report: { removedObjectCount: 1, retainedObjectCount: 2 },
      failures: [expect.stringContaining("stale-directory")],
    });
    await expect(store.readSnapshot(invocationId, changeset.files[0]!.before!)).resolves.toEqual(Buffer.from("before\n"));
    await expect(store.readSnapshot(invocationId, changeset.files[0]!.after!)).resolves.toEqual(Buffer.from("after\n"));
    expect(Object.keys((await store.readManifest(invocationId, "launch"))!.files)).toEqual([await realpath(notePath)]);

    await rm(malformedStaleArtifact, { recursive: true });
    await expect(store.compactArtifacts(invocationId, changeset)).resolves.toMatchObject({
      retainedObjectCount: 2,
      removedObjectCount: 0,
    });
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "exograph-invocation-artifacts-"));
  temporaryRoots.push(root);
  return root;
}
