import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { changeManagedDesign, vanillaPreview } from "./managed-design";
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const signal = () => new AbortController().signal;
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "design-recovery-")); roots.push(root);
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-q"); git("config", "user.name", "Test"); git("config", "user.email", "test@example.com");
  await writeFile(path.join(root, "style.css"), "vanilla"); await writeFile(path.join(root, ".gitignore"), "node_modules/\n");
  git("add", "."); git("commit", "-qm", "Vanilla"); const baseline = git("rev-parse", "HEAD");
  await writeFile(path.join(root, "exograph-site.json"), JSON.stringify({ schemaVersion: 1, contentDirectory: "garden", vanillaCommit: baseline }));
  await mkdir(path.join(root, ".github/workflows"), { recursive: true });
  await writeFile(path.join(root, ".github/workflows/publish.yml"), "my deployment");
  await mkdir(path.join(root, "garden")); await writeFile(path.join(root, "garden/index.md"), "exported notes");
  await writeFile(path.join(root, "CNAME"), "example.com"); await writeFile(path.join(root, "style.css"), "custom");
  await writeFile(path.join(root, "custom.js"), "component");
  git("add", "."); git("commit", "-qm", "Custom site");
  const install = async (dir: string) => { await mkdir(path.join(dir, "node_modules"), { recursive: true }); await writeFile(path.join(dir, "node_modules/installed"), "yes"); };
  return { root, git, install };
}
it("previews vanilla without touching the active design or its unsaved edits", async () => {
  const f = await fixture(); await writeFile(path.join(f.root, "style.css"), "unsaved");
  const before = f.git("status", "--porcelain");
  const preview = await vanillaPreview(f.root, path.dirname(f.root), signal(), f.install);
  try {
    expect(await readFile(path.join(preview.directory, "style.css"), "utf8")).toBe("vanilla");
    expect(await readFile(path.join(f.root, "style.css"), "utf8")).toBe("unsaved");
    expect(f.git("status", "--porcelain")).toBe(before);
  } finally { await preview.dispose(); }
});
it("saves unsaved customization, restores vanilla, and undoes it while preserving publication identity", async () => {
  const f = await fixture(); await writeFile(path.join(f.root, "style.css"), "unsaved custom");
  await writeFile(path.join(f.root, "new.js"), "new component");
  await changeManagedDesign(f.root, "restore", signal(), f.install);
  expect(await readFile(path.join(f.root, "style.css"), "utf8")).toBe("vanilla");
  await expect(readFile(path.join(f.root, "custom.js"))).rejects.toThrow();
  expect(await readFile(path.join(f.root, "garden/index.md"), "utf8")).toBe("exported notes");
  expect(await readFile(path.join(f.root, ".github/workflows/publish.yml"), "utf8")).toBe("my deployment");
  expect(await readFile(path.join(f.root, "CNAME"), "utf8")).toBe("example.com");
  expect(f.git("status", "--porcelain")).toBe("");
  await changeManagedDesign(f.root, "undo", signal(), f.install);
  expect(await readFile(path.join(f.root, "style.css"), "utf8")).toBe("unsaved custom");
  expect(await readFile(path.join(f.root, "new.js"), "utf8")).toBe("new component");
  expect(f.git("status", "--porcelain")).toBe("");
  await expect(changeManagedDesign(f.root, "undo", signal(), f.install)).rejects.toThrow("no saved design");
});
it("leaves the active design intact when dependency installation fails or edits arrive while installing", async () => {
  const f = await fixture();
  await expect(changeManagedDesign(f.root, "restore", signal(), async () => { throw new Error("offline"); })).rejects.toThrow("offline");
  expect(await readFile(path.join(f.root, "style.css"), "utf8")).toBe("custom");
  await expect(changeManagedDesign(f.root, "restore", signal(), async () => { await writeFile(path.join(f.root, "style.css"), "new edits"); })).rejects.toThrow("changed during");
  expect(await readFile(path.join(f.root, "style.css"), "utf8")).toBe("new edits");
});
it("rejects edits to exported notes and cancellation before replacing the active design", async () => {
  const f = await fixture(); await writeFile(path.join(f.root, "garden/index.md"), "edited export");
  await expect(changeManagedDesign(f.root, "restore", signal(), f.install)).rejects.toThrow("source notes");
  const controller = new AbortController(); controller.abort();
  await expect(vanillaPreview(f.root, path.dirname(f.root), controller.signal, f.install)).rejects.toThrow();
});
it("repeated vanilla restore retains the original customization checkpoint", async () => {
  const f = await fixture();
  await changeManagedDesign(f.root, "restore", signal(), f.install);
  const checkpoint = f.git("rev-parse", "refs/exograph/design-recovery");
  await changeManagedDesign(f.root, "restore", signal(), f.install);
  expect(f.git("rev-parse", "refs/exograph/design-recovery")).toBe(checkpoint);
  await changeManagedDesign(f.root, "undo", signal(), f.install);
  expect(await readFile(path.join(f.root, "style.css"), "utf8")).toBe("custom");
});
it("cancels after installing a candidate without replacing the active design", async () => {
  const f = await fixture(); const controller = new AbortController();
  await expect(changeManagedDesign(f.root, "restore", controller.signal, async () => { controller.abort(); })).rejects.toThrow();
  expect(await readFile(path.join(f.root, "style.css"), "utf8")).toBe("custom");
  expect(f.git("status", "--porcelain")).toBe("");
});

it("recovers a baseline not included by a shallow site's default clone", async () => {
  const f = await fixture();
  await writeFile(path.join(f.root, ".git/shallow"), f.git("rev-parse", "HEAD") + "\n");
  const preview = await vanillaPreview(f.root, path.dirname(f.root), signal(), f.install);
  try { expect(await readFile(path.join(preview.directory, "style.css"), "utf8")).toBe("vanilla"); }
  finally { await preview.dispose(); }
  await changeManagedDesign(f.root, "restore", signal(), f.install);
  await changeManagedDesign(f.root, "undo", signal(), f.install);
  expect(await readFile(path.join(f.root, "style.css"), "utf8")).toBe("custom");
});
it("rolls back design files if installing dependencies into the active checkout fails", async () => {
  const f = await fixture();
  const { symlink } = await import("node:fs/promises");
  await symlink(path.dirname(f.root), path.join(f.root, "node_modules"));
  await expect(changeManagedDesign(f.root, "restore", signal(), f.install)).rejects.toThrow("symbolic link");
  expect(await readFile(path.join(f.root, "style.css"), "utf8")).toBe("custom");
  expect(await readFile(path.join(f.root, "custom.js"), "utf8")).toBe("component");
  expect(f.git("status", "--porcelain")).toBe("");
});
