import { EditorialStore } from "@exograph/core/editorial-store";
import { captureEditorialTarget, createEditorialNote } from "@exograph/core/editorial-notes";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { launchExographWorkspaceFixture } from "../helpers";

const git = async (cwd: string, ...args: string[]) => (await promisify(execFile)("/usr/bin/git", ["-C", cwd, ...args])).stdout.trim();

test("GitHub sync settings save explicitly and sync real local and remote note changes", async () => {
  const env: Record<string, string> = {};
  let notes = "", remote = "", other = "";
  const fixture = await launchExographWorkspaceFixture({ mutable: true, env, initialNoteLabel: "transport",
    prepareSettings: async ({ settingsPath, workspaceRoot }) => {
      notes = path.join(workspaceRoot, "notes/test-notes");
      remote = path.join(workspaceRoot, "remote.git"); other = path.join(workspaceRoot, "other-computer");
      const bin = path.join(workspaceRoot, "sync-tools"); await mkdir(bin);
      await git(workspaceRoot, "init", "--bare", "--initial-branch=main", remote);
      await git(notes, "init", "-b", "main");
      await git(notes, "config", "user.name", "Sync fixture"); await git(notes, "config", "user.email", "sync@example.invalid");
      await writeFile(path.join(notes, "transport.md"), "# Transport\n\nStarting words.\n");
      await git(notes, "add", "transport.md"); await git(notes, "commit", "-m", "Initial writing");
      await git(notes, "push", remote, "main");
      await git(notes, "remote", "add", "origin", "https://github.com/fixture/private-notes.git");
      await git(workspaceRoot, "clone", remote, other);
      await git(other, "config", "user.name", "Other Mac"); await git(other, "config", "user.email", "other@example.invalid");
      // Only transport calls are redirected; repository operations use actual Git.
      // No test operation can reach GitHub, even though private identity is tested.
      await writeFile(path.join(bin, "git"), `#!/usr/bin/env python3
import os,subprocess,sys
args=sys.argv[1:]
if any(x in args for x in ['ls-remote','fetch','push']):
 args=[os.environ['EXO_SYNC_FIXTURE_REMOTE'] if x=='https://github.com/fixture/private-notes.git' else x for x in args]
 if any('github.com' in x for x in args): raise SystemExit('Fixture refuses external Git')
raise SystemExit(subprocess.call(['/usr/bin/git',*args]))
`);
      await writeFile(path.join(bin, "gh"), `#!/bin/sh
case "$*" in
 '--version') echo 'gh fixture';;
 'repo view fixture/private-notes --json nameWithOwner,isPrivate') echo '{"nameWithOwner":"fixture/private-notes","isPrivate":true}';;
 'api user --jq .login') echo 'fixture';;
 'api --include user') echo 'x-oauth-scopes: repo, workflow, read:org';;
 *) exit 1;;
esac
`);
      await chmod(path.join(bin, "git"), 0o755); await chmod(path.join(bin, "gh"), 0o755);
      env.PATH = `${bin}${path.delimiter}${process.env.PATH ?? ""}`; env.EXO_SYNC_FIXTURE_REMOTE = remote;
      await writeFile(settingsPath, JSON.stringify({ workspaceRoot, defaultTerminalCwd: workspaceRoot, noteRoots: [notes], indexedRoots: [], indexing: { enabled: false, mode: "off", backend: "qmd" }, searchEngine: "filesystem" }));
    },
  });
  try {
    const page = fixture.page;
    await page.getByTestId("workspace-menu-toggle").click(); await page.getByTestId("workspace-menu-settings").click();
    await page.getByTestId("workspace-settings-tab-github-sync").click();
    await expect(page.getByTestId("github-sync-now")).toBeDisabled();
    await page.getByTestId("github-sync-enabled").check();
    await page.getByTestId("github-sync-cadence").selectOption("hourly");
    await expect(page.getByTestId("github-sync-now")).toBeDisabled();
    await page.getByTestId("github-sync-save").click();
    await expect(page.getByText("fixture/private-notes · Private", { exact: true })).toBeVisible();
    await expect(page.getByTestId("github-sync-now")).toBeEnabled();
    // A wake event performs an overdue scheduled sync through the production scheduler.
    await writeFile(path.join(notes, "scheduled.md"), "# Saved while this Mac slept\n");
    await fixture.electronApp.evaluate(({ powerMonitor }) => { powerMonitor.emit("resume"); });
    await expect.poll(async () => git(remote, "show", "main:scheduled.md").catch(() => "")).toContain("Saved while this Mac slept");
    await expect(page.getByTestId("github-sync-now")).toBeEnabled();
    // The first annotation-only pull must update the already-open note without a reload.
    await git(other, "pull", "--ff-only");
    const incomingStore = new EditorialStore(other);
    const incomingPath = path.join(other, "transport.md");
    const initialAnnotations = await incomingStore.read(incomingPath);
    const originalBody = await readFile(incomingPath, "utf8");
    const passageFrom = originalBody.indexOf("Starting words.");
    const incoming = await incomingStore.save(incomingPath, [createEditorialNote({ id: "remote-note", commentary: "Comment from the other Mac", targets: [captureEditorialTarget(originalBody, passageFrom, passageFrom + "Starting words.".length, "passage")] })], initialAnnotations.revision);
    if (incoming.status !== "saved") throw new Error("Could not create fixture annotation");
    await git(other, "add", ".exograph"); await git(other, "commit", "-m", "Editorial comment only"); await git(other, "push", "origin", "main");
    await page.getByTestId("github-sync-now").click();
    await expect.poll(() => readFile(path.join(notes, ".exograph/editorial/v1/documents", incoming.snapshot.documentId + ".json"), "utf8").catch(() => "")).toContain("Comment from the other Mac");
    await expect(page.getByTestId("github-sync-now")).toBeEnabled();
    await page.getByTestId("workspace-settings-close").click();
    await expect(page.getByTestId("editorial-marker").first()).toBeVisible();
    await page.getByTestId("editorial-marker").first().click();
    await expect(page.getByTestId("editorial-selected-note")).toContainText("Comment from the other Mac");
    await page.getByTestId("workspace-menu-toggle").click(); await page.getByTestId("workspace-menu-settings").click();
    await page.getByTestId("workspace-settings-tab-github-sync").click();
    // Local saved writing + portable suggestion state both travel through the real pipeline.
    await writeFile(path.join(notes, "transport.md"), "# Transport\n\nWriting from this Mac.\n");
    await page.getByTestId("github-sync-now").click();
    await expect(page.getByTestId("github-sync-status")).toContainText("Saved snapshot uploaded.", { timeout: 30_000 });
    await expect.poll(() => git(remote, "show", "main:transport.md")).toContain("Writing from this Mac.");
    expect(await git(remote, "show", `main:.exograph/editorial/v1/documents/${incoming.snapshot.documentId}.json`)).toContain("Comment from the other Mac");
    await git(other, "pull", "--ff-only");
    await writeFile(path.join(other, "remote-writing.md"), "# Arrived from the other Mac\n");
    await git(other, "add", "remote-writing.md"); await git(other, "commit", "-m", "Other Mac writing"); await git(other, "push", "origin", "main");
    await page.getByTestId("github-sync-now").click();
    await expect.poll(async () => readFile(path.join(notes, "remote-writing.md"), "utf8").catch(() => "")).toContain("Arrived from the other Mac");
    await expect(page.getByTestId("github-sync-status")).toContainText("Saved snapshot uploaded.");
    await expect(page.getByTestId("github-sync-status")).not.toContainText("Not yet synced");
    await expect(page.getByTestId("github-sync-now")).toBeEnabled();
    await page.screenshot({ path: "/tmp/exograph-github-sync-settings.png" });
    await page.getByTestId("workspace-settings-close").click();
    await page.getByTestId("workspace-menu-toggle").click(); await page.getByTestId("workspace-menu-settings").click();
    await page.getByTestId("workspace-settings-tab-github-sync").click();
    await expect(page.getByTestId("github-sync-enabled")).toBeChecked();
    await expect(page.getByTestId("github-sync-cadence")).toHaveValue("hourly");
    await page.getByTestId("workspace-settings-close").click();
    // A newer remote passage must not overwrite an unsaved editor buffer.
    await git(other, "pull", "--ff-only");
    await writeFile(path.join(other, "transport.md"), "# Transport\n\nRemote overlapping wording.\n");
    await git(other, "add", "transport.md"); await git(other, "commit", "-m", "Remote passage change"); await git(other, "push", "origin", "main");
    const conflict = await page.evaluate(async () => {
      const view = (document.querySelector(".cm-content") as any).cmView.rootView.view;
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "# Transport\n\nUnsaved human wording.\n" } });
      const api = (window as any).exograph;
      return api.githubSync.syncNow({ root: (await api.githubSync.getStatus()).root });
    });
    expect(conflict.phase).toBe("conflict");
    expect(await readFile(path.join(notes, "transport.md"), "utf8")).toContain("Unsaved human wording.");
    expect(await git(remote, "show", "main:transport.md")).toContain("Remote overlapping wording.");
    await expect(page.locator(".cm-content")).toContainText("Unsaved human wording.");
  } finally { await fixture.cleanup(); }
});
