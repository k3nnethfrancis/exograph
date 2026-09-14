import { afterEach, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { saveManagedTheme } from "./managed-theme";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "managed-theme-")); roots.push(root);
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
  git("init", "-q"); git("config", "user.name", "Test"); git("config", "user.email", "test@example.com");
  await writeFile(path.join(root, "exograph-site.json"), JSON.stringify({ schemaVersion: 1 }));
  await writeFile(path.join(root, "theme.css"), "old");
  await writeFile(path.join(root, ".gitignore"), "node_modules/\n");
  await mkdir(path.join(root, "garden")); await writeFile(path.join(root, "garden", "index.md"), "export");
  git("add", "."); git("commit", "-qm", "initial"); return { root, git };
}
it("saves modified and new theme files locally while respecting ignored dependencies", async () => {
  const { root, git } = await fixture(); const before = git("rev-parse", "HEAD");
  await writeFile(path.join(root, "theme.css"), "new"); await writeFile(path.join(root, "component.js"), "new component");
  await mkdir(path.join(root, "node_modules")); await writeFile(path.join(root, "node_modules", "ignored"), "dependency");
  await saveManagedTheme(root, new AbortController().signal);
  expect(git("rev-parse", "HEAD")).not.toBe(before); expect(git("status", "--porcelain")).toBe("");
  expect(git("ls-tree", "-r", "--name-only", "HEAD")).not.toContain("node_modules");
  expect(await readFile(path.join(root, "garden", "index.md"), "utf8")).toBe("export");
});
it("refuses to absorb edits to the derivative garden copy", async () => {
  const { root, git } = await fixture(); const before = git("rev-parse", "HEAD");
  await writeFile(path.join(root, "garden", "index.md"), "user edit");
  await expect(saveManagedTheme(root, new AbortController().signal)).rejects.toThrow("source notes");
  expect(git("rev-parse", "HEAD")).toBe(before);
});
it("leaves legacy engine edits uncommitted", async () => {
  const { root, git } = await fixture(); await rm(path.join(root, "exograph-site.json"));
  const before = git("rev-parse", "HEAD"); await saveManagedTheme(root, new AbortController().signal);
  expect(git("rev-parse", "HEAD")).toBe(before);
});
