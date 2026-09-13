import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { launchExographWorkspaceFixture, relaunchExographWorkspaceFixture } from "../helpers";

// Real renderer → preload → main → Core export → child process → HTTP journey.
// The tiny site adapter isolates Exograph's contract; Quartz parity has its own gate.
test("Publishing persists its folder, exports a private-safe snapshot, previews, and cancels on settings changes", async () => {
  let publication = "";
  let engine = "";
  const source = "# Garden\n\n[Public](public.md) and [Private](../secret.md).\n";
  const fixture = await launchExographWorkspaceFixture({
    mutable: true,
    prepareSettings: async ({ settingsPath, workspaceRoot }) => {
      const notes = path.join(workspaceRoot, "notes/test-notes");
      publication = path.join(notes, "garden");
      engine = path.join(workspaceRoot, "site-engine");
      await mkdir(publication, { recursive: true });
      await mkdir(path.join(engine, "scripts"), { recursive: true });
      await writeFile(path.join(publication, "index.md"), source);
      await writeFile(path.join(publication, "public.md"), "# Public\n");
      await writeFile(path.join(notes, "secret.md"), "# PRIVATE_SECRET_SENTINEL\n");
      await writeFile(path.join(engine, "scripts/exograph-publish.mjs"), `
        import { readFile, mkdir, writeFile, readdir } from 'node:fs/promises';
        import {parseArgs} from 'node:util';
        const {values}=parseArgs({options:Object.fromEntries(['input','output','site-url','action'].map(name=>[name,{type:'string'}]))});
        const args=Object.fromEntries(Object.entries(values).map(([key,value])=>['--'+key,value]));
        const body=await readFile(args['--input']+'/index.md','utf8');
        const files=await readdir(args['--input']);
        if(files.includes('secret.md') || body.includes('secret.md')) throw new Error('Private reference reached adapter');
        await mkdir(args['--output']);
        await writeFile(args['--output']+'/index.html','<!doctype html><title>Publication fixture</title><pre>'+body+'</pre>');
        console.log(JSON.stringify({ok:true,outputPath:args['--output'],action:args['--action']}));
      `);
      await writeFile(settingsPath, JSON.stringify({ workspaceRoot, defaultTerminalCwd: workspaceRoot,
        noteRoots: [notes], indexedRoots: [], indexing: { enabled: false, mode: "off", backend: "qmd" }, searchEngine: "filesystem" }));
    },
  });
  let relaunched: Awaited<ReturnType<typeof relaunchExographWorkspaceFixture>> | undefined;
  try {
    let page = fixture.page;
    await page.getByTestId("workspace-menu-toggle").click();
    await page.getByTestId("workspace-menu-settings").click();
    await page.getByTestId("workspace-settings-tab-publishing").click();
    await page.getByTestId("publishing-folder").fill(publication);
    await page.getByTestId("publishing-engine").fill(engine);
    await page.getByTestId("publishing-site-url").fill("https://example.com/");
    await page.getByTestId("publishing-repository").fill("author/site");
    await expect.poll(async () => JSON.parse(await readFile(fixture.settingsPath, "utf8"))).toMatchObject({ publishing: {
      publicationDirectory: publication, engineDirectory: engine, siteUrl: "https://example.com/",
    } });
    await expect(page.getByTestId("publishing-preview")).toBeEnabled();
    // A background settings save must not invalidate unchanged publication configuration.
    expect(await page.evaluate(async () => {
      const snapshot = await window.exograph.workspace.getSettings();
      const saved = await window.exograph.workspace.saveSettings({ expectedRevision: snapshot.revision,
        settings: { ...snapshot.settings, editorFontSize: snapshot.settings.editorFontSize === 16 ? 17 : 16 } });
      return saved.revision !== snapshot.revision;
    })).toBe(true);
    await page.getByTestId("publishing-preview").click();
    await expect(page.getByTestId("publishing-status")).toContainText("Preview ready", { timeout: 30_000 });
    const status = await page.evaluate(() => window.exograph.publishing.getStatus());
    expect(status.phase).toBe("ready");
    expect(status.previewUrl).toMatch(/^http:\/\/127\.0\.0\.1:/);
    const output = await (await fetch(status.previewUrl!)).text();
    expect(output).toContain("Public");
    expect(output).toContain("Private");
    expect(output).not.toContain("secret.md");
    expect(output).not.toContain("PRIVATE_SECRET_SENTINEL");
    expect(await readFile(path.join(publication, "index.md"), "utf8")).toBe(source);
    // Refresh the settings editor after the deliberate external write; its save CAS remains strict.
    await page.getByTestId("workspace-settings-close").click();
    await page.getByTestId("workspace-menu-toggle").click();
    await page.getByTestId("workspace-menu-settings").click();
    await page.getByTestId("workspace-settings-tab-publishing").click();
    await page.getByTestId("publishing-site-url").fill("https://updated.example/");
    await expect.poll(() => page.evaluate(() => window.exograph.publishing.getStatus())).toMatchObject({ phase: "idle" });
    await expect(fetch(status.previewUrl!)).rejects.toThrow();
    await expect(page.getByTestId("publishing-prepare")).toBeEnabled();
    await page.getByTestId("publishing-prepare").click();
    await expect(page.getByTestId("publishing-status")).toContainText("It has not been deployed", { timeout: 30_000 });
    expect((await page.evaluate(() => window.exograph.publishing.getStatus())).previewUrl).toBeUndefined();
    await expect(page.getByRole("alert")).toContainText("Publishing setup required");
    await expect(page.getByTestId("publishing-publish")).toBeDisabled();
    await fixture.electronApp.close();
    relaunched = await relaunchExographWorkspaceFixture(fixture);
    page = relaunched.page;
    await page.getByTestId("workspace-menu-toggle").click();
    await page.getByTestId("workspace-menu-settings").click();
    await page.getByTestId("workspace-settings-tab-publishing").click();
    await expect(page.getByTestId("publishing-folder")).toHaveValue(publication);
    await expect(page.getByTestId("publishing-site-url")).toHaveValue("https://updated.example/");
    await expect(page.getByTestId("publishing-repository")).toHaveValue("author/site");
  } catch (error) {
    const activePage = relaunched?.page ?? fixture.page;
    console.error("Publishing failure state", await activePage.evaluate(() => window.exograph.publishing.getStatus()).catch(String));
    console.error("Publishing failure alerts", await activePage.getByRole("alert").allTextContents().catch(String));
    throw error;
  } finally {
    await relaunched?.cleanup();
    await fixture.cleanup();
  }
});

test("Publish uses Exograph's adapter and reports a missing destination workflow without uploading", async () => {
  const env: Record<string, string> = {};
  let invocations = "";
  const fixture = await launchExographWorkspaceFixture({
    mutable: true, env,
    prepareSettings: async ({ settingsPath, workspaceRoot }) => {
      const notes = path.join(workspaceRoot, "notes/test-notes"), publication = path.join(notes, "publication");
      const engine = path.join(workspaceRoot, "publishing-engine"), bin = path.join(workspaceRoot, "fixture-bin");
      await mkdir(publication, { recursive: true }); await mkdir(path.join(engine, "scripts"), { recursive: true }); await mkdir(bin);
      await writeFile(path.join(publication, "index.md"), "# Public site\n");
      const args = `const args=Object.fromEntries(Array.from({length:(process.argv.length-2)/2},(_,i)=>[process.argv[2+i*2],process.argv[3+i*2]]));`;
      await writeFile(path.join(engine, "scripts/exograph-publish.mjs"), `import {mkdir,writeFile} from 'node:fs/promises'; ${args}
        await mkdir(args['--output']);await writeFile(args['--output']+'/index.html','<title>Prepared site</title>');`);
      // No engine deployment adapter. The actual app-owned adapter reaches this
      // isolated fake GitHub executable; it cannot invoke a real network command.
      invocations = path.join(workspaceRoot, "gh-invocations");
      await writeFile(path.join(bin, "gh"), '#!/bin/sh\nprintf "%s\n" "$*" >> "$EXO_FIXTURE_GH_LOG"\nprintf "HTTP 404 Not Found\n" >&2\nexit 1\n');
      await chmod(path.join(bin, "gh"), 0o755);
      env.PATH = `${bin}${path.delimiter}${process.env.PATH ?? ""}`;
      env.EXO_FIXTURE_GH_LOG = invocations;
      const git = (...input: string[]) => promisify(execFile)("git", ["-C", engine, ...input]);
      await git("init"); await git("remote", "add", "origin", "https://github.com/author/theme.git"); await git("add", ".");
      await git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "-c", "commit.gpgsign=false", "commit", "-m", "Local publishing fixture");
      await writeFile(settingsPath, JSON.stringify({ workspaceRoot, defaultTerminalCwd: workspaceRoot, noteRoots: [notes],
        indexedRoots: [], indexing: { enabled: false, mode: "off", backend: "qmd" }, searchEngine: "filesystem",
        publishing: { publicationDirectory: publication, engineDirectory: engine, siteUrl: "https://example.com/", destinationRepository: "author/site" } }));
    },
  });
  try {
    const { page } = fixture;
    await page.getByTestId("workspace-menu-toggle").click(); await page.getByTestId("workspace-menu-settings").click();
    await page.getByTestId("workspace-settings-tab-publishing").click();
    await expect(page.getByTestId("publishing-publish")).toBeDisabled(); await page.getByTestId("publishing-prepare").click();
    await expect(page.getByTestId("publishing-status")).toContainText("It has not been deployed", { timeout: 30_000 });
    expect((await page.evaluate(() => window.exograph.publishing.getStatus())).preparedId).toBeTruthy();
    await expect(readFile(invocations)).rejects.toMatchObject({ code: "ENOENT" });
    await page.getByTestId("publishing-publish").click();
    await expect(page.getByRole("alert")).toContainText("No snapshot has been uploaded", { timeout: 30_000 });
    await expect(page.getByTestId("publishing-open-site")).toHaveCount(0);
    expect((await page.evaluate(() => window.exograph.publishing.getStatus())).deployment?.status).toBe("setup-required");
    expect(await readFile(invocations, "utf8")).toBe("api repos/author/site/actions/workflows/exograph-publish.yml\n");
  } catch (error) {
    console.error("Publishing state", await fixture.page.evaluate(() => window.exograph.publishing.getStatus()).catch(String));
    throw error;
  } finally { await fixture.cleanup(); }
});
