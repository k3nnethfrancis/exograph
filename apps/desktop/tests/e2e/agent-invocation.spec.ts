import { expect, test, type Locator, type Page } from "@playwright/test";
import { access, mkdir, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  launchExographWorkspaceFixture,
  relaunchExographWorkspaceFixture,
} from "../helpers";

const fixtureScript = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../fixtures/invocation-fixture.mjs",
);

test.describe.configure({ timeout: 90_000 });

test("reviews and keeps one deterministic invocation changeset end to end", async () => {
  const fixture = await launchInvocationFixture("modify");
  try {
    const record = await invokeAndWaitForSettlement(fixture);
    expect(record).toMatchObject({
      status: "process-exited",
      exitCode: 0,
      command: { handle: "fixture" },
      changeset: {
        status: "pending-review",
        files: [expect.objectContaining({ operation: "modified", decision: { status: "pending" } })],
      },
    });
    await assertDurableArtifacts(fixture, record, {
      launchContains: '<exograph-invocation id="',
      settledContains: "Fixture modified content.",
    });

    const review = fixture.page.locator('section[aria-label="Review invocation changes"]');
    await expect(review).toBeVisible();
    const keep = review.getByRole("button", { name: "Keep", exact: true });
    await keep.click();
    await expect(keep).toBeDisabled();
    const kept = await waitForInvocation(
      fixture.workspaceRoot,
      (candidate) => candidate.id === record.id && candidate.changeset?.status === "kept",
    );
    expect(kept.changeset.status).toBe("kept");
    await expect(readFile(fixture.paths.tagged, "utf8")).resolves.toContain("Fixture modified content.");
    await expect.poll(() => listPendingReviews(fixture.page)).toEqual([]);

    await expect(fixture.page.getByTestId("open-invocation-history")).toBeVisible();
    await fixture.page.getByTestId("open-invocation-history").click();
    await expect(fixture.page.getByTestId("invocation-history-panel")).toBeVisible();
    await fixture.page.locator(".invocation-history__open").filter({ hasText: "@fixture" }).click();
    await expect(review).toContainText("Kept");
    await review.getByRole("button", { name: "Close review" }).click();
    await expect(review).toHaveCount(0);
  } finally {
    await fixture.cleanup();
  }
});

test("clears a pending review while switching Workspaces without settling its durable source record", async () => {
  const fixture = await launchInvocationFixture("modify");
  const destination = path.dirname(fixture.workspaceRoot);
  try {
    const record = await invokeAndWaitForSettlement(fixture);
    const review = fixture.page.locator('section[aria-label="Review invocation changes"]');
    await expect(review).toBeVisible();
    await applyWorkspaceRoot(fixture.page, destination);
    await expect(review).toHaveCount(0);
    expect((await invocationRecords(fixture.workspaceRoot)).find((candidate) => candidate.id === record.id))
      .toMatchObject({ changeset: { status: "pending-review" } });

    await applyWorkspaceRoot(fixture.page, fixture.workspaceRoot);
    await expect(review).toBeVisible();
    await expect(review).toContainText("invocation-fixture.md");
  } finally {
    await fixture.cleanup();
  }
});

test("rejects one deterministic invocation back to the exact clean base", async () => {
  const fixture = await launchInvocationFixture("modify");
  try {
    const record = await invokeAndWaitForSettlement(fixture);
    const cleanBase = await readCleanBase(fixture, record.id);
    const review = fixture.page.locator('section[aria-label="Review invocation changes"]');
    await expect(review).toBeVisible();
    await review.getByRole("button", { name: "Reject", exact: true }).click();
    const rejected = await waitForInvocation(
      fixture.workspaceRoot,
      (candidate) => candidate.id === record.id && candidate.changeset?.status === "rejected",
    );

    expect(rejected.changeset.status).toBe("rejected");
    await expect(readFile(fixture.paths.tagged, "utf8")).resolves.toBe(cleanBase);
    expect(await readFile(fixture.paths.tagged, "utf8")).not.toContain("exograph-invocation");
    await expect.poll(() => listPendingReviews(fixture.page)).toEqual([]);

    await expect(fixture.page.getByTestId("open-invocation-history")).toBeVisible();
    await fixture.page.getByTestId("open-invocation-history").click();
    await fixture.page.locator(".invocation-history__open").filter({ hasText: "@fixture" }).click();
    await expect(review).toContainText("Rejected");
    await expect(fixture.page.locator(".cm-content")).toContainText("Fixture modified content.");
  } finally {
    await fixture.cleanup();
  }
});

test("reviews a create, modify, delete, and proven rename per file and in a batch", async () => {
  const fixture = await launchInvocationFixture("multi");
  try {
    let record = await invokeAndWaitForSettlement(fixture);
    const cleanBase = await readCleanBase(fixture, record.id);
    expect(operationNames(record)).toEqual(["created", "deleted", "modified", "modified", "renamed"]);
    const review = fixture.page.locator('section[aria-label="Review invocation changes"]');
    await expect(review).toBeVisible();
    await expect(review).toContainText("created.md");
    await review.getByRole("button", { name: "Reject", exact: true }).click();
    record = await waitForInvocation(
      fixture.workspaceRoot,
      (candidate) => candidate.id === record.id && candidate.changeset?.status === "partially-resolved",
    );
    expect(record.changeset.status).toBe("partially-resolved");
    await expect(access(fixture.paths.created)).rejects.toMatchObject({ code: "ENOENT" });

    await navigateReviewToFile(review, "second.md");
    await review.getByRole("button", { name: "Keep", exact: true }).click();
    record = await waitForInvocation(
      fixture.workspaceRoot,
      (candidate) => candidate.id === record.id &&
        candidate.changeset?.files.some((change: Record<string, any>) =>
          (change.before?.path === fixture.paths.second || change.after?.path === fixture.paths.second) &&
          change.decision.status === "kept"),
    );
    expect(record.changeset.status).toBe("partially-resolved");
    await expect(readFile(fixture.paths.second, "utf8")).resolves.toContain("Fixture updated second note.");

    await review.getByText(/^All \d+ files$/).click();
    await review.getByRole("button", { name: "Reject all" }).click();
    record = await waitForInvocation(
      fixture.workspaceRoot,
      (candidate) => candidate.id === record.id && candidate.changeset?.status === "resolved",
    );
    expect(record.changeset.status).toBe("resolved");
    await expect(readFile(fixture.paths.tagged, "utf8")).resolves.toBe(cleanBase);
    await expect(readFile(fixture.paths.deleted, "utf8")).resolves.toBe(fixture.initial.deleted);
    await expect(readFile(fixture.paths.renameBefore, "utf8")).resolves.toBe(fixture.initial.renameBefore);
    await expect(access(fixture.paths.renameAfter)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(fixture.paths.second, "utf8")).resolves.toContain("Fixture updated second note.");
  } finally {
    await fixture.cleanup();
  }
});

test("keeps a complete multi-file changeset in one batch", async () => {
  const fixture = await launchInvocationFixture("multi");
  try {
    const record = await invokeAndWaitForSettlement(fixture);
    const review = fixture.page.locator('section[aria-label="Review invocation changes"]');
    await expect(review).toBeVisible();
    await review.getByText(/^All \d+ files$/).click();
    await review.getByRole("button", { name: "Keep all" }).click();
    const kept = await waitForInvocation(
      fixture.workspaceRoot,
      (candidate) => candidate.id === record.id && candidate.changeset?.status === "kept",
    );

    expect(kept.changeset.status).toBe("kept");
    await expect(readFile(fixture.paths.tagged, "utf8")).resolves.toContain("Fixture multi-file content.");
    await expect(readFile(fixture.paths.second, "utf8")).resolves.toContain("Fixture updated second note.");
    await expect(readFile(fixture.paths.created, "utf8")).resolves.toBe("# Created by invocation fixture\n");
    await expect(access(fixture.paths.deleted)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(fixture.paths.renameBefore)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(fixture.paths.renameAfter, "utf8")).resolves.toBe(fixture.initial.renameBefore);
  } finally {
    await fixture.cleanup();
  }
});

test("freezes every affected open editor while bulk review drains dirty autosaves", async () => {
  const fixture = await launchInvocationFixture("multi");
  try {
    await splitExplorerFileIntoEditor(fixture.page, "second, file");
    await expect(fixture.page.locator(".workspace-shell__canvas .pane-leaf--editor")).toHaveCount(2);

    await launchInvocation(fixture.page, fixture.paths.tagged);
    const record = await waitForInvocation(
      fixture.workspaceRoot,
      (candidate) => candidate.status !== "pending" && candidate.status !== "running",
    );
    const review = fixture.page.locator('section[aria-label="Review invocation changes"]');
    await expect(review).toBeVisible();

    await fixture.page.locator(".tab-strip__tab").filter({ hasText: "invocation-fixture" }).click();
    await appendEditorText(fixture.page, "\nHuman tagged edit.", fixture.paths.tagged);
    await fixture.page.locator(".tab-strip__tab").filter({ hasText: "second" }).click();
    await appendEditorText(fixture.page, "\nHuman second edit.", fixture.paths.second);
    await fixture.page.locator(".tab-strip__tab").filter({ hasText: "created" }).click();
    await expect(review).toBeVisible();
    await review.getByText(/^All \d+ files$/).click();
    await review.getByRole("button", { name: "Reject all" }).click();

    const conflicted = await waitForInvocation(
      fixture.workspaceRoot,
      (candidate) => candidate.id === record.id && candidate.changeset?.status === "conflict",
    );
    const modifiedDecisions = conflicted.changeset.files
      .filter((change: Record<string, any>) => change.operation === "modified")
      .map((change: Record<string, any>) => change.decision.status);
    expect(modifiedDecisions).toEqual(["conflict", "conflict"]);
    await expect.poll(() => readFile(fixture.paths.tagged, "utf8")).toContain("Human tagged edit.");
    await expect.poll(() => readFile(fixture.paths.second, "utf8")).toContain("Human second edit.");
    await fixture.page.waitForTimeout(2_200);
    await expect(readFile(fixture.paths.tagged, "utf8")).resolves.toContain("Human tagged edit.");
    await expect(readFile(fixture.paths.second, "utf8")).resolves.toContain("Human second edit.");
  } finally {
    await fixture.cleanup();
  }
});

test("preserves newer human work when rejecting a drifted proposal", async () => {
  const fixture = await launchInvocationFixture("modify");
  try {
    let record = await invokeAndWaitForSettlement(fixture);
    const change = changeFor(record, "modified");
    const drifted = `${await readFile(fixture.paths.tagged, "utf8")}\nNewer human work.\n`;
    await writeFile(fixture.paths.tagged, drifted, "utf8");

    const review = fixture.page.locator('section[aria-label="Review invocation changes"]');
    await expect(review).toBeVisible();
    await review.getByRole("button", { name: "Reject", exact: true }).click();
    record = await waitForInvocation(
      fixture.workspaceRoot,
      (candidate) => candidate.id === record.id && candidate.changeset?.status === "conflict",
    );
    expect(record.changeset.status).toBe("conflict");
    expect(changeFor(record, "modified").decision).toMatchObject({
      status: "conflict",
      reason: "The file changed after this proposal. Exograph did not overwrite newer work.",
    });
    await expect(readFile(fixture.paths.tagged, "utf8")).resolves.toBe(drifted);
    await expect.poll(() => listPendingReviews(fixture.page)).toEqual([
      expect.objectContaining({ invocationId: record.id, pendingFileCount: 1 }),
    ]);

    await expect(review).toContainText("File changed");
    await review.getByRole("button", { name: "Keep current" }).click();
    record = await waitForInvocation(
      fixture.workspaceRoot,
      (candidate) => candidate.id === record.id && candidate.changeset?.status === "kept",
    );
    expect(record.changeset.status).toBe("kept");
    await expect(readFile(fixture.paths.tagged, "utf8")).resolves.toBe(drifted);
    await expect.poll(() => listPendingReviews(fixture.page)).toEqual([]);
  } finally {
    await fixture.cleanup();
  }
});

test("Stop terminates the complete deterministic process tree", async () => {
  const fixture = await launchInvocationFixture("stop-tree");
  try {
    await launchInvocation(fixture.page, fixture.paths.tagged);
    const running = await waitForInvocation(fixture.workspaceRoot, (record) => record.status === "running");
    const parentPid = await waitForPid(path.join(fixture.controlRoot, "parent.pid"));
    const childPid = await waitForPid(path.join(fixture.controlRoot, "child.pid"));

    const activity = fixture.page.getByTestId("invocation-activity");
    const stop = activity.getByRole("button", { name: "Stop" });
    await expect(stop).toBeVisible();
    await expect(stop.locator(".lucide-circle-stop")).toBeVisible();
    await expect(stop.locator(".lucide-square")).toHaveCount(0);
    await expect(activity).toHaveCount(1);
    await expect(activity).toHaveAttribute("data-positioned", "true");
    const [activityBox, editorBox] = await Promise.all([
      activity.boundingBox(),
      fixture.page.locator(".editor-pane").first().boundingBox(),
    ]);
    expect(activityBox).not.toBeNull();
    expect(editorBox).not.toBeNull();
    expect(activityBox!.width).toBeLessThanOrEqual(280);
    expect(activityBox!.x).toBeGreaterThanOrEqual(editorBox!.x);
    expect(activityBox!.x + activityBox!.width).toBeLessThanOrEqual(editorBox!.x + editorBox!.width);
    expect(activityBox!.y).toBeGreaterThanOrEqual(editorBox!.y);
    expect(activityBox!.y + activityBox!.height).toBeLessThanOrEqual(editorBox!.y + editorBox!.height);
    await stop.click();
    const stopped = await waitForInvocation(
      fixture.workspaceRoot,
      (record) => record.id === running.id && record.status === "user-ended",
    );

    expect(stopped).toMatchObject({ status: "user-ended", changeset: { status: "no-change" } });
    await expect.poll(() => processExists(parentPid)).toBe(false);
    await expect.poll(() => processExists(childPid)).toBe(false);
    await expect(readFile(path.join(fixture.controlRoot, "signal.txt"), "utf8")).resolves.toBe("SIGTERM");
  } finally {
    await fixture.cleanup();
  }
});

test("offers review and session handoff as soon as the proposal settles while the harness keeps running", async () => {
  const fixture = await launchInvocationFixture("proposal-running", { adapter: "claude-code" });
  try {
    await launchInvocation(fixture.page);
    const running = await waitForInvocation(
      fixture.workspaceRoot,
      (record) => record.status === "running" && record.changeset?.status === "pending-review",
    );
    expect(running.providerSessionId).toBe("ce4b9e26-2574-4433-a054-1110cd403792");
    await expect(readFile(path.join(fixture.controlRoot, "proposal-ready.txt"), "utf8")).resolves.toBe("ready");

    const activity = fixture.page.getByTestId("invocation-activity");
    await expect(activity).toHaveCount(0);
    const review = fixture.page.locator('section[aria-label="Review invocation changes"]');
    await expect(review).toBeVisible();
    await expect(review.getByRole("button", { name: "Keep", exact: true })).toBeVisible();
    await expect(review.getByRole("button", { name: "Reject", exact: true })).toBeVisible();
    await review.getByRole("button", { name: "Open agent session" }).click();
    await expect.poll(() => fixture.page.evaluate(() => window.exograph.terminals.list()))
      .toContainEqual(expect.objectContaining({
        command: expect.stringContaining(`--resume '${running.providerSessionId}'`),
      }));
    await expect(fixture.page.getByTestId("utility-pane-terminal")).toHaveAttribute("aria-pressed", "true");

    await review.getByRole("button", { name: "Keep", exact: true }).click();
    await waitForInvocation(
      fixture.workspaceRoot,
      (record) => record.id === running.id && record.changeset?.status === "kept",
    );
    await expect(activity).toHaveCount(0, { timeout: 5_000 });
    const persistentResume = fixture.page.locator(".inline-agent-response__resume");
    await persistentResume.hover();
    await expect(persistentResume).toHaveCSS("opacity", "1");
    const terminalCount = (await fixture.page.evaluate(() => window.exograph.terminals.list())).length;
    await persistentResume.click();
    await expect.poll(async () => (await fixture.page.evaluate(() => window.exograph.terminals.list())).length)
      .toBe(terminalCount + 1);

    await fixture.page.evaluate((invocationId) => window.exograph.workspace.endAgentInvocation(invocationId), running.id);
    await waitForInvocation(
      fixture.workspaceRoot,
      (record) => record.id === running.id && record.status === "user-ended",
    );
  } finally {
    await fixture.cleanup();
  }
});

test("keeps failed-process changes reviewable and rejects them exactly", async () => {
  const fixture = await launchInvocationFixture("partial-failure");
  try {
    const record = await invokeAndWaitForSettlement(fixture);
    const cleanBase = await readCleanBase(fixture, record.id);
    expect(record).toMatchObject({
      status: "failed",
      exitCode: 17,
      failureReason: "Command exited with code 17.",
      changeset: { status: "pending-review" },
    });
    expect(operationNames(record)).toEqual(["created", "modified"]);

    const rejected = await reviewAll(fixture.page, record.id, "reject");
    expect(rejected.changeset.status).toBe("rejected");
    await expect(readFile(fixture.paths.tagged, "utf8")).resolves.toBe(cleanBase);
    await expect(access(fixture.paths.partial)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await fixture.cleanup();
  }
});

test("treats a no-response note invocation as a protocol failure without a proposal", async () => {
  const fixture = await launchInvocationFixture("no-response");
  try {
    const record = await invokeAndWaitForSettlement(fixture);
    expect(record).toMatchObject({
      status: "failed",
      failureReason: "@fixture finished without writing its linked response into the note.",
      changeset: { status: "no-change", files: [] },
    });
    await expect(readFile(fixture.paths.tagged, "utf8")).resolves.toContain("<exograph-invocation");
    await expect.poll(() => listPendingReviews(fixture.page)).toEqual([]);
  } finally {
    await fixture.cleanup();
  }
});

test("resumes a failed provider session from the compact activity surface", async () => {
  const fixture = await launchInvocationFixture("resume-failure", { adapter: "claude-code" });
  try {
    const record = await invokeAndWaitForSettlement(fixture);
    expect(record).toMatchObject({
      status: "failed",
      providerSessionId: "ce4b9e26-2574-4433-a054-1110cd403792",
      failureReason: "Claude could not edit the document because its write permission was denied.",
    });

    const activity = fixture.page.getByTestId("invocation-activity");
    await expect(activity).toContainText("Failed");
    await activity.getByRole("button", { name: "Resume in Terminal" }).click();
    await expect.poll(() => readFile(path.join(fixture.controlRoot, "resumed-session.txt"), "utf8").catch(() => ""))
      .toBe(record.providerSessionId);
    await expect(fixture.page.getByTestId("utility-pane-terminal")).toHaveAttribute("aria-pressed", "true");
  } finally {
    await fixture.cleanup();
  }
});

test("recovers a pending exact review after an ordinary relaunch", async () => {
  const fixture = await launchInvocationFixture("modify");
  let relaunched: Awaited<ReturnType<typeof relaunchExographWorkspaceFixture>> | null = null;
  try {
    const record = await invokeAndWaitForSettlement(fixture);
    const cleanBase = await readCleanBase(fixture, record.id);
    await fixture.electronApp.close();
    relaunched = await relaunchExographWorkspaceFixture(fixture);

    await expect.poll(() => listPendingReviews(relaunched!.page)).toEqual([
      expect.objectContaining({ invocationId: record.id, pendingFileCount: 1 }),
    ]);
    const rejected = await reviewAll(relaunched.page, record.id, "reject");
    expect(rejected.changeset.status).toBe("rejected");
    await expect(readFile(fixture.paths.tagged, "utf8")).resolves.toBe(cleanBase);
  } finally {
    await relaunched?.electronApp.close().catch(() => {});
    await fixture.cleanup();
  }
});

test("recovers exact changes from an invocation orphaned by a host crash", async () => {
  test.setTimeout(120_000);
  const fixture = await launchInvocationFixture("crash-recovery");
  let relaunched: Awaited<ReturnType<typeof relaunchExographWorkspaceFixture>> | null = null;
  let invocationPid: number | null = null;
  try {
    await launchInvocation(fixture.page);
    const running = await waitForInvocation(fixture.workspaceRoot, (record) => record.status === "running");
    invocationPid = await waitForPid(path.join(fixture.controlRoot, "parent.pid"));
    await expect.poll(() => readFile(fixture.paths.tagged, "utf8")).toContain("Fixture crash-recovery content.");

    const electronProcess = fixture.electronApp.process();
    const electronExited = new Promise<void>((resolve) => electronProcess.once("exit", () => resolve()));
    electronProcess.kill("SIGKILL");
    await electronExited;
    try {
      relaunched = await relaunchExographWorkspaceFixture(fixture);
    } catch (error) {
      const mainLog = await readFile(path.join(path.dirname(fixture.runtimeRoot), "exograph-main.log"), "utf8").catch(() => "");
      throw new Error(`Crash-recovery relaunch failed.\n${mainLog}`, { cause: error });
    }
    const recovered = await waitForInvocation(
      fixture.workspaceRoot,
      (record) => record.id === running.id && record.status === "orphaned",
    );

    expect(recovered).toMatchObject({
      status: "orphaned",
      changeset: { status: "pending-review", files: [expect.objectContaining({ operation: "modified" })] },
    });
    await expect.poll(() => listPendingReviews(relaunched!.page)).toEqual([
      expect.objectContaining({ invocationId: recovered.id, pendingFileCount: 1 }),
    ]);
    const cleanBase = await readCleanBase(fixture, recovered.id);
    const rejected = await reviewAll(relaunched.page, recovered.id, "reject");
    expect(rejected.changeset.status).toBe("rejected");
    await expect(readFile(fixture.paths.tagged, "utf8")).resolves.toBe(cleanBase);
  } finally {
    if (invocationPid && processExists(invocationPid)) {
      try { process.kill(invocationPid, "SIGKILL"); } catch { /* Process already exited. */ }
    }
    await relaunched?.electronApp.close().catch(() => {});
    await fixture.cleanup();
  }
});

interface InvocationFixture {
  electronApp: Awaited<ReturnType<typeof launchExographWorkspaceFixture>>["electronApp"];
  page: Page;
  workspaceRoot: string;
  settingsPath: string;
  runtimeRoot: string;
  homeRoot: string;
  cleanup: () => Promise<void>;
  noteRoot: string;
  controlRoot: string;
  paths: {
    tagged: string;
    second: string;
    created: string;
    deleted: string;
    partial: string;
    renameBefore: string;
    renameAfter: string;
  };
  initial: {
    tagged: string;
    second: string;
    deleted: string;
    renameBefore: string;
  };
}

async function launchInvocationFixture(
  scenario: string,
  options: { adapter?: "generic" | "claude-code" } = {},
): Promise<InvocationFixture> {
  let noteRoot = "";
  let command = "";
  const initial = {
    tagged: "# Invocation fixture\n\nHuman-authored baseline.\n\n\n",
    second: "# Second note\n\nUnchanged baseline.\n",
    deleted: "# Deleted note\n\nRestore this exact content.\n",
    renameBefore: "# Rename identity\n\nUnique content used to prove a rename.\n",
  };
  const paths = {
    tagged: "",
    second: "",
    created: "",
    deleted: "",
    partial: "",
    renameBefore: "",
    renameAfter: "",
  };
  const fixture = await launchExographWorkspaceFixture({
    mutable: true,
    initialNoteLabel: null,
    prepareWorkspace: async (workspaceRoot) => {
      noteRoot = path.join(workspaceRoot, "notes/test-notes");
      Object.assign(paths, {
        tagged: path.join(noteRoot, "invocation-fixture.md"),
        second: path.join(noteRoot, "second.md"),
        created: path.join(noteRoot, "created.md"),
        deleted: path.join(noteRoot, "deleted.md"),
        partial: path.join(noteRoot, "partial.md"),
        renameBefore: path.join(noteRoot, "rename-before.md"),
        renameAfter: path.join(noteRoot, "rename-after.md"),
      });
      await mkdir(noteRoot, { recursive: true });
      await Promise.all([
        writeFile(paths.tagged, initial.tagged, "utf8"),
        writeFile(paths.second, initial.second, "utf8"),
        writeFile(paths.deleted, initial.deleted, "utf8"),
        writeFile(paths.renameBefore, initial.renameBefore, "utf8"),
      ]);
      command = [
        shellQuote(process.execPath),
        shellQuote(fixtureScript),
        shellQuote(scenario),
        shellQuote(noteRoot),
        shellQuote(paths.tagged),
      ].join(" ");
    },
    prepareSettings: async ({ settingsPath, workspaceRoot }) => {
      await writeFile(settingsPath, JSON.stringify({
        workspaceRoot,
        defaultTerminalCwd: workspaceRoot,
        noteRoots: [path.join(workspaceRoot, "notes/test-notes")],
        agentCommands: [{
          id: "fixture",
          label: "Fixture",
          handle: "fixture",
          command,
          adapter: options.adapter ?? "generic",
          continuityPolicy: options.adapter === "claude-code" ? "continuous" : "fresh",
          cwdPolicy: "workspace_root",
          promptDelivery: "stdin",
          version: 1,
          enabled: true,
        }],
        indexedRoots: [],
        indexing: { enabled: false, mode: "off", backend: "qmd" },
        appearanceMode: "system",
        colorThemeId: "exograph-neutral",
        editorFontSize: 15,
        terminalFontSize: 13,
        explorerScale: 1,
        exploreIndexSearchOnEnter: false,
        indexUpdateStrategy: "on-save",
      }, null, 2), "utf8");
    },
  });
  noteRoot = await realpath(noteRoot);
  Object.assign(paths, {
    tagged: path.join(noteRoot, "invocation-fixture.md"),
    second: path.join(noteRoot, "second.md"),
    created: path.join(noteRoot, "created.md"),
    deleted: path.join(noteRoot, "deleted.md"),
    partial: path.join(noteRoot, "partial.md"),
    renameBefore: path.join(noteRoot, "rename-before.md"),
    renameAfter: path.join(noteRoot, "rename-after.md"),
  });
  await fixture.page.getByRole("button", { name: "invocation-fixture, file" }).first().click();
  await expect(fixture.page.getByTestId("editor-title")).toHaveText("invocation-fixture");
  return {
    ...fixture,
    noteRoot,
    controlRoot: path.join(path.dirname(noteRoot), ".invocation-fixture"),
    paths,
    initial,
  };
}

async function invokeAndWaitForSettlement(fixture: InvocationFixture): Promise<Record<string, any>> {
  await launchInvocation(fixture.page);
  return waitForInvocation(
    fixture.workspaceRoot,
    (record) => record.status !== "pending" && record.status !== "running",
  );
}

async function launchInvocation(page: Page, documentPath?: string): Promise<void> {
  // The fixture ends on an empty line. Compose in that existing space so the
  // protocol envelope can be removed byte-for-byte back to the original note.
  await appendEditorText(page, "@fixture", documentPath);
  await expect(page.getByTestId("agent-suggestion-fixture")).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("inline-agent-composer")).toHaveCount(1);
  await page.keyboard.type("Exercise the deterministic invocation contract.");
  await page.keyboard.press(process.platform === "darwin" ? "Meta+Enter" : "Control+Enter");
  const authorization = page.getByRole("dialog", { name: "Run Fixture?" });
  await expect(authorization).toBeVisible();
  await authorization.getByRole("button", { name: "Run once" }).click();
  await expect(authorization).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => document.activeElement?.closest(".cm-editor") !== null)).toBe(true);
}

async function appendEditorText(page: Page, text: string, documentPath?: string): Promise<void> {
  const titles = page.locator(".editor-panel__title[title]");
  const titleIndex = documentPath
    ? await titles.evaluateAll((elements, targetPath) => {
        const identity = (value: string) => value.replace(/^\/private\/(?=(?:var|tmp)\/)/u, "/");
        return elements.findIndex((element) => identity((element as HTMLElement).title) === identity(targetPath));
      }, documentPath)
    : -1;
  if (documentPath && titleIndex < 0) throw new Error(`Unable to find open editor for ${documentPath}`);
  const content = documentPath
    ? titles.nth(titleIndex).locator("xpath=ancestor::*[@data-testid='editor-panel']").locator(".cm-content")
    : page.locator(".cm-content").first();
  await content.click();
  await page.evaluate(({ insert, documentPath }) => {
    const identity = (value: string) => value.replace(/^\/private\/(?=(?:var|tmp)\/)/u, "/");
    const title = documentPath
      ? [...document.querySelectorAll<HTMLElement>(".editor-panel__title[title]")].find((candidate) => identity(candidate.title) === identity(documentPath))
      : null;
    const content = (title?.closest("[data-testid='editor-panel']") ?? document).querySelector(".cm-content") as (HTMLElement & { cmView?: { view?: any } }) | null;
    const view = content?.cmView?.view;
    if (!view) throw new Error("Unable to resolve CodeMirror view");
    const position = view.state.doc.length + insert.length;
    view.dispatch({ changes: { from: view.state.doc.length, insert }, selection: { anchor: position } });
    view.focus();
  }, { insert: text, documentPath });
}

async function splitExplorerFileIntoEditor(page: Page, accessibleName: string): Promise<void> {
  const source = await page.getByRole("button", { name: accessibleName }).first().boundingBox();
  const editor = await page.locator(".workspace-shell__canvas .pane-leaf--editor").first().boundingBox();
  expect(source).not.toBeNull();
  expect(editor).not.toBeNull();
  await page.mouse.move(source!.x + source!.width / 2, source!.y + source!.height / 2);
  await page.mouse.down();
  await page.mouse.move(editor!.x + editor!.width * 0.88, editor!.y + editor!.height / 2, { steps: 8 });
  await page.mouse.up();
}

async function waitForInvocation(
  workspaceRoot: string,
  predicate: (record: Record<string, any>) => boolean,
): Promise<Record<string, any>> {
  let match: Record<string, any> | undefined;
  await expect.poll(async () => {
    match = (await invocationRecords(workspaceRoot)).find(predicate);
    return Boolean(match);
  }, { timeout: 20_000 }).toBe(true);
  return match!;
}

async function invocationRecords(workspaceRoot: string): Promise<Array<Record<string, any>>> {
  const root = path.join(workspaceRoot, ".exograph/invocations");
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const records = await Promise.all(entries.filter((entry) => entry.isDirectory()).map(async (entry) => {
    try {
      return JSON.parse(await readFile(path.join(root, entry.name, "record.json"), "utf8")) as Record<string, any>;
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return null;
      throw error;
    }
  }));
  return records.filter((record): record is Record<string, any> => record !== null);
}

async function reviewAll(page: Page, invocationId: string, action: "keep" | "reject"): Promise<Record<string, any>> {
  return page.evaluate(({ invocationId, action }) =>
    window.exograph.workspace.reviewInvocationAll({ invocationId, action }), { invocationId, action });
}

async function reviewFile(
  page: Page,
  invocationId: string,
  changeId: string,
  action: "keep" | "reject",
): Promise<Record<string, any>> {
  return page.evaluate(({ invocationId, changeId, action }) =>
    window.exograph.workspace.reviewInvocationFile({ invocationId, changeId, action }), { invocationId, changeId, action });
}

async function listPendingReviews(page: Page): Promise<Array<Record<string, any>>> {
  return page.evaluate(() => window.exograph.workspace.listPendingInvocationReviews());
}

async function navigateReviewToFile(review: Locator, fileName: string): Promise<void> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    if ((await review.textContent())?.includes(fileName)) return;
    const next = review.getByRole("button", { name: "Next file" });
    if (await next.isDisabled()) break;
    await next.click();
  }
  await expect(review).toContainText(fileName);
}

function operationNames(record: Record<string, any>): string[] {
  return record.changeset.files.map((change: Record<string, any>) => change.operation).sort();
}

function changeFor(record: Record<string, any>, operation: string): Record<string, any> {
  const change = record.changeset.files.find((candidate: Record<string, any>) => candidate.operation === operation);
  if (!change) throw new Error(`Missing ${operation} invocation change.`);
  return change;
}

function changeForPath(record: Record<string, any>, filePath: string): Record<string, any> {
  const change = record.changeset.files.find((candidate: Record<string, any>) =>
    candidate.before?.path === filePath || candidate.after?.path === filePath);
  if (!change) throw new Error(`Missing invocation change for ${filePath}.`);
  return change;
}

async function assertDurableArtifacts(
  fixture: InvocationFixture,
  record: Record<string, any>,
  expected: { launchContains: string; settledContains: string },
): Promise<void> {
  const invocationDir = path.join(fixture.workspaceRoot, ".exograph/invocations", record.id);
  const cleanBase = JSON.parse(await readFile(path.join(invocationDir, "clean-base.json"), "utf8"));
  const launch = JSON.parse(await readFile(path.join(invocationDir, "launch-manifest.json"), "utf8"));
  const settled = JSON.parse(await readFile(path.join(invocationDir, "settled-manifest.json"), "utf8"));
  const storedRecord = JSON.parse(await readFile(path.join(invocationDir, "record.json"), "utf8"));

  expect(storedRecord.id).toBe(record.id);
  expect(cleanBase.file.path).toBe(fixture.paths.tagged);
  expect(await readFile(path.join(invocationDir, cleanBase.file.snapshotRef), "utf8")).not.toContain("exograph-invocation");
  expect(await readFile(path.join(invocationDir, launch.files[fixture.paths.tagged].snapshotRef), "utf8"))
    .toContain(expected.launchContains);
  expect(await readFile(path.join(invocationDir, settled.files[fixture.paths.tagged].snapshotRef), "utf8"))
    .toContain(expected.settledContains);
}

async function readCleanBase(fixture: InvocationFixture, invocationId: string): Promise<string> {
  const invocationDir = path.join(fixture.workspaceRoot, ".exograph/invocations", invocationId);
  const cleanBase = JSON.parse(await readFile(path.join(invocationDir, "clean-base.json"), "utf8"));
  return readFile(path.join(invocationDir, cleanBase.file.snapshotRef), "utf8");
}

async function applyWorkspaceRoot(page: Page, workspaceRoot: string): Promise<void> {
  await page.getByTestId("workspace-menu-toggle").click();
  await page.getByTestId("workspace-menu-settings").click();
  const root = page.getByTestId("workspace-settings-workspace-root");
  await root.fill(workspaceRoot);
  await page.getByTestId("workspace-settings-apply").click();
  await expect(page.getByTestId("workspace-settings-apply-status")).toHaveText("Changes applied.");
}

async function waitForPid(pidPath: string): Promise<number> {
  let pid = 0;
  await expect.poll(async () => {
    pid = Number(await readFile(pidPath, "utf8").catch(() => "0"));
    return Number.isSafeInteger(pid) && pid > 0;
  }).toBe(true);
  return pid;
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return Boolean(error && typeof error === "object" && "code" in error && error.code !== "ESRCH");
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
