import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, writeFile } from "node:fs/promises";
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
        const args=Object.fromEntries(Array.from({length:(process.argv.length-2)/2},(_,i)=>[process.argv[2+i*2],process.argv[3+i*2]]));
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

for (const outcome of ["setup-required", "deployed"] as const) {
  test(`Publish prepared site exercises the real local adapter and displays ${outcome}`, async () => {
    const fixture = await launchExographWorkspaceFixture({
      mutable: true,
      prepareSettings: async ({ settingsPath, workspaceRoot }) => {
        const notes = path.join(workspaceRoot, "notes/test-notes");
        const publication = path.join(notes, "publication");
        const engine = path.join(workspaceRoot, "publishing-engine");
        await mkdir(publication, { recursive: true });
        await mkdir(path.join(engine, "scripts"), { recursive: true });
        await writeFile(path.join(publication, "index.md"), "# Public site\n");
        const args = `const args=Object.fromEntries(Array.from({length:(process.argv.length-2)/2},(_,i)=>[process.argv[2+i*2],process.argv[3+i*2]]));`;
        await writeFile(path.join(engine, "scripts/exograph-publish.mjs"), `import {mkdir,writeFile} from 'node:fs/promises'; ${args}
          await mkdir(args['--output']);await writeFile(args['--output']+'/index.html','<title>Prepared site</title>');
          console.log(JSON.stringify({ok:true,outputPath:args['--output'],action:args['--action']}));`);
        // This fixture only reads files and prints a receipt; it has no network or deployment commands.
        await writeFile(path.join(engine, "scripts/exograph-deploy.mjs"), `import {readFile,readdir,appendFile} from 'node:fs/promises';
          import {createHash} from 'node:crypto';import path from 'node:path';${args}
          const files=[];async function visit(dir){for(const item of await readdir(dir,{withFileTypes:true})){
            const file=path.join(dir,item.name);if(item.isDirectory())await visit(file);else files.push({path:path.relative(args['--input'],file).split(path.sep).join('/'),sha256:createHash('sha256').update(await readFile(file)).digest('hex')});}}
          await visit(args['--input']);files.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
          if(createHash('sha256').update(JSON.stringify(files)).digest('hex')!==args['--snapshot-hash'])throw new Error('Snapshot digest mismatch');
          await appendFile(path.join(path.dirname(args['--input']),'deployment-invocations'),'called\\n');
          ${outcome === "setup-required"
            ? `console.log(JSON.stringify({ok:false,status:'setup-required',message:'Install the reviewed fixture workflow.'}));process.exitCode=2;`
            : `console.log(JSON.stringify({ok:true,status:'deployed',deploymentUrl:args['--site-url'],snapshotCommit:'${"b".repeat(40)}',engineCommit:args['--engine-commit'],runId:'123'}));`}
        `);
        const git = (...input: string[]) => promisify(execFile)("git", ["-C", engine, ...input]);
        await git("init"); await git("add", ".");
        await git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "-c", "commit.gpgsign=false", "commit", "-m", "Local publishing fixture");
        await writeFile(settingsPath, JSON.stringify({ workspaceRoot, defaultTerminalCwd: workspaceRoot, noteRoots: [notes],
          indexedRoots: [], indexing: { enabled: false, mode: "off", backend: "qmd" }, searchEngine: "filesystem",
          publishing: { publicationDirectory: publication, engineDirectory: engine, siteUrl: "https://example.com/" } }));
      },
    });
    try {
      const { page } = fixture;
      await page.getByTestId("workspace-menu-toggle").click();
      await page.getByTestId("workspace-menu-settings").click();
      await page.getByTestId("workspace-settings-tab-publishing").click();
      await expect(page.getByTestId("publishing-publish")).toBeDisabled();
      await page.getByTestId("publishing-prepare").click();
      await expect(page.getByTestId("publishing-status")).toContainText("It has not been deployed", { timeout: 30_000 });
      const prepared = await page.evaluate(() => window.exograph.publishing.getStatus());
      expect(prepared.preparedId).toBeTruthy();
      const invocations = path.join(path.dirname(prepared.outputPath!), "deployment-invocations");
      await expect(readFile(invocations)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(page.getByTestId("publishing-publish")).toBeEnabled();
      await page.getByTestId("publishing-publish").click();
      if (outcome === "deployed") {
        await expect(page.getByTestId("publishing-status")).toContainText("Site published", { timeout: 30_000 });
        await expect(page.getByTestId("publishing-open-site")).toBeVisible();
        await expect(page.getByTestId("publishing-publish")).toBeDisabled();
      } else {
        await expect(page.getByRole("alert")).toContainText("Install the reviewed fixture workflow", { timeout: 30_000 });
        await expect(page.getByTestId("publishing-status")).toContainText("It has not been deployed");
        await expect(page.getByTestId("publishing-open-site")).toHaveCount(0);
      }
      expect((await page.evaluate(() => window.exograph.publishing.getStatus())).deployment?.status).toBe(outcome);
      expect(await readFile(invocations, "utf8")).toBe("called\n");
    } catch (error) {
      console.error("Explicit publishing state", await fixture.page.evaluate(() => window.exograph.publishing.getStatus()).catch(String));
      console.error("Explicit publishing alerts", await fixture.page.getByRole("alert").allTextContents().catch(String));
      throw error;
    } finally { await fixture.cleanup(); }
  });
}
