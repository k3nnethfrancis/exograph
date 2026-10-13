import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { launchExographWorkspaceFixture } from "../helpers";

const git = async (cwd: string, ...args: string[]) => (await promisify(execFile)("/usr/bin/git", ["-C", cwd, ...args])).stdout.trim();

async function setupFixture(firstRun = false) {
  const env: Record<string, string> = {};
  let notes = "", remotes = "", downloads = "", metadata = "";
  const fixture = await launchExographWorkspaceFixture({ mutable: true, env, initialNoteLabel: firstRun ? null : "transport", configured: !firstRun, workspaceRootEnv: false, expectOnboarding: firstRun,
    selectFolderPath: root => path.join(root, "downloads"),
    prepareSettings: async ({ settingsPath, workspaceRoot }) => {
      notes = path.join(workspaceRoot, "notes/test-notes"); remotes = path.join(workspaceRoot, "remotes"); downloads = path.join(workspaceRoot, "downloads");
      const bin = path.join(workspaceRoot, "sync-tools"); metadata = path.join(workspaceRoot, "repositories.json");
      await Promise.all([mkdir(bin), mkdir(remotes), mkdir(downloads)]);
      const remote = path.join(remotes, "existing-notes.git");
      await git(workspaceRoot, "init", "--bare", "--initial-branch=main", remote);
      const seed = path.join(workspaceRoot, "seed"); await mkdir(seed); await git(seed, "init", "-b", "main");
      await git(seed, "config", "user.name", "Fixture"); await git(seed, "config", "user.email", "fixture@example.invalid");
      await writeFile(path.join(seed, "remote-note.md"), "# Notes from another Mac\n\nKeep this writing.\n");
      await git(seed, "add", "."); await git(seed, "commit", "-m", "Existing history"); await git(seed, "push", remote, "main");
      await writeFile(path.join(notes, "transport.md"), "# My local writing\n\nKeep my local notes.\n");
      await writeFile(metadata, JSON.stringify(["existing-notes"]));
      await writeFile(path.join(bin, "git"), `#!/usr/bin/env python3
import os,subprocess,sys
args=sys.argv[1:]
original_url=next((arg for arg in args if arg.startswith('https://github.com/fixture/')),None)
network=any(x in args for x in ['ls-remote','fetch','push','clone'])
if network:
 for i,arg in enumerate(args):
  if arg.startswith('https://github.com/fixture/'):
   args[i]=os.path.join(os.environ['EXO_SYNC_REMOTES'],arg.rsplit('/',1)[1])
  if 'github.com' in args[i]: raise SystemExit('Fixture refuses external Git '+repr(args[i]))
result=subprocess.call(['/usr/bin/git',*args])
if result==0 and 'clone' in args and original_url:
 subprocess.run(['/usr/bin/git','-C',args[-1],'remote','set-url','origin',original_url],check=True)
raise SystemExit(result)
`);
      await writeFile(path.join(bin, "gh"), `#!/usr/bin/env python3
import json,os,subprocess,sys
args=sys.argv[1:]
store=os.environ['EXO_SYNC_METADATA']; remotes=os.environ['EXO_SYNC_REMOTES']
names=json.load(open(store))
def repo(name):
 return dict(full_name='fixture/'+name,clone_url='https://github.com/fixture/'+name+'.git',private=True,permissions=dict(push=True),default_branch='main',size=1)
if args==['--version']: print('gh fixture')
elif args[:2]==['api','user']:
 if '--jq' in args: print('fixture')
 else: print(json.dumps(dict(login='fixture',id=42,name='Fixture')))
elif args==['api','--include','user']: print('x-oauth-scopes: repo')
elif args[:2]==['repo','create'] and args[-1]=='--private':
 if not args[2].startswith('fixture/'): raise SystemExit('Unexpected account')
 name=args[2].split('/')[1]
 if name in names: raise SystemExit('already exists')
 subprocess.run(['/usr/bin/git','init','--bare','--initial-branch=main',os.path.join(remotes,name+'.git')],check=True,stdout=subprocess.DEVNULL)
 names.append(name); json.dump(names,open(store,'w')); print(json.dumps(repo(name)))
elif len(args)>1 and args[0]=='api' and args[1].startswith('user/repos?'): print(json.dumps([repo(n) for n in names]))
elif len(args)>1 and args[0]=='api' and args[1].startswith('repos/fixture/'):
 name=args[1].split('/')[2]
 if name not in names: raise SystemExit('HTTP 404 Not Found')
 if '/git/matching-refs/heads' in args[1]:
  refs=subprocess.check_output(['/usr/bin/git','-C',os.path.join(remotes,name+'.git'),'for-each-ref','--format=%(refname)','refs/heads']).decode().splitlines()
  print(json.dumps([dict(ref=r) for r in refs]))
 else: print(json.dumps(repo(name)))
elif args[:2]==['repo','view']:
 name=args[2].split('/')[-1]
 if name not in names: raise SystemExit('HTTP 404 Not Found')
 print(json.dumps(dict(nameWithOwner='fixture/'+name,isPrivate=True)))
else: raise SystemExit('Unsupported fixture gh '+repr(args))
`);
      await chmod(path.join(bin, "git"), 0o755); await chmod(path.join(bin, "gh"), 0o755);
      env.PATH = `${bin}${path.delimiter}${process.env.PATH ?? ""}`; env.EXO_SYNC_REMOTES = remotes; env.EXO_SYNC_METADATA = metadata;
      if (!firstRun) await writeFile(settingsPath, JSON.stringify({ workspaceRoot, defaultTerminalCwd: workspaceRoot, noteRoots: [notes], indexedRoots: [], indexing: { enabled: false, mode: "off", backend: "qmd" }, searchEngine: "filesystem" }));
    },
  });
  return { fixture, notes, remotes, downloads, metadata };
}
async function openSync(page: Awaited<ReturnType<typeof setupFixture>>["fixture"]["page"]) {
  await page.getByTestId("workspace-menu-toggle").click(); await page.getByTestId("workspace-menu-settings").click(); await page.getByTestId("workspace-settings-tab-github-sync").click();
}

async function finishDownloadedWorkspace(page: Awaited<ReturnType<typeof setupFixture>>["fixture"]["page"]) {
  await page.getByTestId("onboarding-continue").click();
  const tools = page.getByRole("button", { name: "Continue to tools", exact: true });
  const agents = page.getByRole("button", { name: "Set up CLI agents", exact: true });
  await expect(tools.or(agents)).toBeVisible();
  if (await tools.isVisible()) await tools.click();
  await agents.click();
  await page.getByRole("button", { name: "Open Exograph", exact: true }).click();
  await expect(page.getByTestId("sidebar")).toBeVisible({ timeout: 30_000 });
  await page.screenshot({ path: "/tmp/exograph-github-sync-opened-clone.png" });
  await page.getByTestId("sidebar").getByText("remote-note", { exact: true }).click();
  await expect(page.locator(".cm-content")).toContainText("Keep this writing.");
  await openSync(page);
  await page.getByTestId("github-sync-enable").click();
  await expect(page.getByTestId("github-sync-now")).toBeEnabled({ timeout: 30_000 });
  await expect(page.getByText("fixture/existing-notes ↗", { exact: true })).toBeVisible();
  await expect(page.getByTestId("github-sync-cadence")).toHaveValue("hourly");
}

test("new notes create a private repository with a reviewed name and simplified connected controls", async () => {
  const { fixture, notes, remotes, metadata } = await setupFixture();
  try {
    const page = fixture.page; await openSync(page);
    await page.getByTestId("github-sync-create").click();
    await expect(page.getByTestId("github-sync-name")).toHaveValue("test-notes");
    await page.getByTestId("github-sync-name").fill("my-writing");
    await expect(page.getByText("fixture/my-writing · Private")).toBeVisible();
    expect(JSON.parse(await readFile(metadata, "utf8"))).toEqual(["existing-notes"]);
    await page.screenshot({ path: "/tmp/exograph-github-sync-create.png" });
    await page.getByTestId("github-sync-create-submit").click();
    await expect.poll(async () => page.getByTestId("github-sync-now").isVisible().then(visible => visible ? "connected" : page.getByTestId("workspace-settings-github-sync").innerText()), { timeout: 30_000 }).toBe("connected");
    await expect(page.getByTestId("github-sync-now")).toBeEnabled({ timeout: 30_000 });
    expect(await git(path.join(remotes, "my-writing.git"), "show", "main:transport.md")).toContain("Keep my local notes.");
    expect(await git(notes, "config", "--local", "user.email")).toBe("42+fixture@users.noreply.github.com");
    await expect(page.getByTestId("github-sync-branch")).not.toBeVisible();
    await page.getByTestId("github-sync-cadence").selectOption("daily");
    await expect(page.getByTestId("github-sync-cadence")).toHaveValue("daily");
    await page.getByTestId("github-sync-pause").click(); await expect(page.getByTestId("github-sync-pause")).toHaveText("Resume sync");
    await page.getByTestId("github-sync-pause").click(); await expect(page.getByTestId("github-sync-pause")).toHaveText("Pause sync");
    await page.screenshot({ path: "/tmp/exograph-github-sync-connected.png" });
  } finally { await fixture.cleanup(); }
});

test("existing unrelated notes get a separate download and preserve the current writing", async () => {
  const { fixture, notes, downloads } = await setupFixture();
  try {
    const page = fixture.page; await openSync(page);
    await page.getByTestId("github-sync-existing").click();
    await expect(page.getByRole("button", { name: "fixture/existing-notes Private", exact: true })).toBeVisible();
    await page.screenshot({ path: "/tmp/exograph-github-sync-picker.png" });
    await page.getByRole("button", { name: "fixture/existing-notes Private", exact: true }).click();
    await page.getByTestId("github-sync-connect-submit").click();
    await expect(page.getByTestId("github-sync-combination-review")).toContainText("kept separate");
    expect(await readFile(path.join(notes, "transport.md"), "utf8")).toContain("Keep my local notes.");
    await page.screenshot({ path: "/tmp/exograph-github-sync-existing-review.png" });
    await page.getByRole("button", { name: "Download as another workspace" }).click();
    await page.getByRole("button", { name: "fixture/existing-notes Private", exact: true }).click();
    await page.screenshot({ path: "/tmp/exograph-github-sync-download.png" });
    // A human edit remains safe while a second workspace downloads and opens.
    await page.evaluate(() => {
      const view = (document.querySelector(".cm-content") as any).cmView.rootView.view;
      view.dispatch({ changes: { from: view.state.doc.length, insert: "\nUnsaved before switching.\n" } });
    });
    await page.getByTestId("github-download-submit").click();
    await expect.poll(async () => page.getByTestId("onboarding-notes-folder").isVisible().then(visible => visible ? "downloaded" : page.getByTestId("github-download").innerText())).toBe("downloaded");
    await expect(page.getByTestId("onboarding-notes-folder")).toContainText(path.join(downloads, "existing-notes"));
    expect(await readFile(path.join(downloads, "existing-notes/remote-note.md"), "utf8")).toContain("Keep this writing.");
    await finishDownloadedWorkspace(page);
    expect(await readFile(path.join(notes, "transport.md"), "utf8")).toContain("Unsaved before switching.");
    expect(await readFile(path.join(notes, "transport.md"), "utf8")).toContain("Keep my local notes.");
  } finally { await fixture.cleanup(); }
});

test("first launch downloads notes from GitHub before choosing a workspace", async () => {
  const { fixture, downloads } = await setupFixture(true);
  try {
    const page = fixture.page;
    const button = page.getByTestId("workspace-picker-github").or(page.getByTestId("onboarding-open-github"));
    await button.click();
    await page.getByRole("button", { name: "fixture/existing-notes Private", exact: true }).click();
    await page.screenshot({ path: "/tmp/exograph-github-sync-download.png" });
    await page.getByTestId("github-download-submit").click();
    await expect.poll(async () => page.getByTestId("onboarding-notes-folder").isVisible().then(visible => visible ? "downloaded" : page.getByTestId("github-download").innerText())).toBe("downloaded");
    await expect(page.getByTestId("onboarding-notes-folder")).toContainText(path.join(downloads, "existing-notes"));
    await expect(page.getByTestId("onboarding-continue")).toBeEnabled();
    expect(await git(path.join(downloads, "existing-notes"), "log", "-1", "--format=%s")).toBe("Existing history");
    await finishDownloadedWorkspace(page);
    await page.screenshot({ path: "/tmp/exograph-github-sync-first-launch.png" });
  } finally { await fixture.cleanup(); }
});
