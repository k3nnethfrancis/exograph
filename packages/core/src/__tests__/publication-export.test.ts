import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { exportPublication, verifyPublicationSnapshot, PublicationExportError } from "../publication-export";

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function fixture(files: Record<string, string>) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "exo-publication-"))); temporary.push(root);
  const notes = path.join(root, "notes");
  for (const [relative, content] of Object.entries(files)) { const file = path.join(notes, relative); await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, content); }
  return { root, notes, request: { model: { workspaceRoot: root, defaultTerminalCwd: root, noteRoots: [{ id: "notes", label: "Notes", path: notes }], indexedRoots: [], indexing: { enabled: false, mode: "off" as const, backend: "qmd" as const } }, publicationDirectory: path.join(notes, "public"), stagingParent: path.join(root, "stages"), generatedRoutes: ["index.xml", "sitemap.xml"] } };
}
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

describe("publication export", () => {
  it("keeps generated public folder URLs when their index Note is a draft, without exposing that Note", async () => {
    const f = await fixture({
      "public/index.md": '[Reports](/reports) [Draft index](reports/index.md) [Private folder](/private-folder)',
      "public/reports/index.md": "---\ndraft: true\n---\nPRIVATE PLACEHOLDER",
      "public/reports/report.md": "# Published report",
      "public/private-folder/index.md": "---\ndraft: true\n---\nPRIVATE FOLDER",
    });
    const snapshot = await exportPublication({ ...f.request, generatedRoutes: [...f.request.generatedRoutes, "private-folder"] });
    const output = await readFile(path.join(snapshot.directory, "index.md"), "utf8");
    expect(output).toContain("[Reports](<reports>)");
    expect(output).not.toContain("reports/index.md");
    expect(output).not.toContain("(<private-folder>)");
    expect(snapshot.manifest.files.map((file) => file.path)).toEqual(["index.md", "reports/report.md"]);
    expect(snapshot.manifest.diagnostics).toHaveLength(2);
  });


  it("recognizes BOM and YAML-labelled draft headers before eligibility and preserves shared-preview status", async () => {
    const f = await fixture({
      "public/index.md": "---\n---\n# Public",
      "public/bom.md": "\ufeff---\ndraft: true\n---\nBOM PRIVATE",
      "public/labelled.md": "---yaml\ndraft: true\n---\nLABELLED PRIVATE",
      "public/preview.md": "\ufeff---yaml\ndraft: true\npreview: true\n---\nShared preview",
    });
    const snapshot = await exportPublication(f.request);
    expect(snapshot.manifest.files.map((file) => file.path)).toEqual(["index.md", "preview.md"]);
    expect(snapshot.manifest.files.find((file) => file.path === "preview.md")?.visibility).toBe("unlisted");
    const preview = await readFile(path.join(snapshot.directory, "preview.md"), "utf8");
    expect(preview).toContain("unlisted: true");
    expect(preview).toContain("Shared preview");
  });

  it.each(["---\ndraft: true\nUNTERMINATED PRIVATE", "---toml\ndraft = true\n---\nPRIVATE"])("fails closed on unsupported metadata rather than exporting it as body: %s", async (body) => {
    const f = await fixture({ "public/index.md": body });
    await expect(exportPublication(f.request)).rejects.toThrow("publication frontmatter");
  });

  it("projects Markdown and wiki references inside HTML text while retaining literal code examples", async () => {
    const f = await fixture({
      "public/index.md": '<div>![[secret|embed label]] [[secret|link label]] [Private](../secret.md) [[page|Page]]<pre>![[secret]]</pre><code>[example](../secret.md)</code></div>',
      "secret.md": "SECRET BODY", "public/page.md": "# Page",
    });
    const snapshot = await exportPublication(f.request);
    const output = await readFile(path.join(snapshot.directory, "index.md"), "utf8");
    expect(output).toContain("<div>embed label link label Private [Page](&lt;page.md&gt;)");
    expect(output).toContain("<pre>![[secret]]</pre>");
    expect(output).toContain("<code>[example](../secret.md)</code>");
    expect(snapshot.manifest.diagnostics).toHaveLength(3);
  });

  it.each(['<set href="#pic" attributeName="href" to="../../private.png"/>', '<animate attributeName="href" values="#empty;../../private.png"/>'])("rejects SVG resource mutation %s", async (animation) => {
    const f = await fixture({ "public/index.md": "![diagram](diagram.svg)", "public/diagram.svg": `<svg xmlns="http://www.w3.org/2000/svg"><image id="pic" href="#empty"/>${animation}</svg>` });
    await expect(exportPublication(f.request)).rejects.toBeInstanceOf(PublicationExportError);
  });

  it("uses the first reference definition as CommonMark does before filtering private targets", async () => {
    const f = await fixture({ "public/index.md": "[label][id]\n\n[id]: ../secret.md\n[id]: page.md\n", "public/page.md": "# Public", "secret.md": "PRIVATE" });
    const snapshot = await exportPublication(f.request);
    const output = await readFile(path.join(snapshot.directory, "index.md"), "utf8");
    expect(output).not.toContain("page.md");
    expect(output).not.toContain("secret.md");
    expect(output).toContain("label");
    expect(snapshot.manifest.diagnostics.map((item) => item.code)).toEqual(["excluded-local-target"]);
  });

  it("stages only eligible Notes and reached assets, keeps preview visibility/tags, leaves all source bytes unchanged", async () => {
    const files = {
      "public/index.md": '---\ntags: [shared]\n---\n[[page|**Page**]] [[secret|authored label]] ![[secret]] ![public image](images/ok.png) ![private image](../private.png)\n`[[secret]]`\n```md\n![[secret]]\n```\n',
      "public/page.md": "# Page\n", "public/preview.md": '---\ndraft: "true"\npreview: "true"\ntags: [preview-only]\n---\nShared preview',
      "public/draft.md": "---\ndraft: true\n---\nPRIVATE DRAFT", "private/secret.md": "---\ntitle: PRIVATE TITLE\ntags: [private-only, shared]\n---\nPRIVATE CONTENT",
      "private.png": "PRIVATE BYTES", "public/images/ok.png": "PUBLIC BYTES", "public/images/unused.png": "UNREACHED BYTES",
    };
    const f = await fixture(files);
    const before = await Promise.all(Object.keys(files).map(async (file) => digest(await readFile(path.join(f.notes, file)))));
    const snapshot = await exportPublication(f.request);
    expect(snapshot.manifest.files.map((file) => file.path)).toEqual(["images/ok.png", "index.md", "page.md", "preview.md"]);
    const output = await readFile(path.join(snapshot.directory, "index.md"), "utf8");
    expect(output).toContain("authored label"); expect(output).not.toContain("PRIVATE TITLE"); expect(output).not.toContain("../private.png");
    expect(output).toContain("`[[secret]]`"); expect(output).toContain("```md\n![[secret]]\n```");
    expect(output).toMatch(/tags: \[\s*shared\s*\]/);
    expect(await readFile(path.join(snapshot.directory, "preview.md"), "utf8")).toContain("unlisted: true");
    expect(snapshot.manifest.files.find((file) => file.path === "preview.md")?.visibility).toBe("unlisted");
    expect(snapshot.manifest.generatedRoutes).toContain("tags/shared"); expect(snapshot.manifest.generatedRoutes).not.toContain("tags/private-only"); expect(snapshot.manifest.generatedRoutes).not.toContain("tags/preview-only");
    expect(await Promise.all(Object.keys(files).map(async (file) => digest(await readFile(path.join(f.notes, file)))))).toEqual(before);
    expect(snapshot.sources.hashes.some((source) => source.path.endsWith("secret.md"))).toBe(true);
    expect(snapshot.manifest.files.some((file) => file.path.includes("manifest"))).toBe(false);
    await verifyPublicationSnapshot(snapshot);
  });

  it("resolves against original private membership and never falls back from a bad explicit path", async () => {
    const f = await fixture({ "public/index.md": "[[same]] [no](missing/same.md) [[missing/same]] [[same.md]]", "public/same.md": "# Public", "private/same.md": "# Private" });
    const snapshot = await exportPublication(f.request);
    const result = await readFile(path.join(snapshot.directory, "index.md"), "utf8");
    expect(result).toContain("[same.md](<same.md>)");
    expect(result).not.toContain("missing/same.md)");
    expect(snapshot.manifest.diagnostics.map((item) => item.code)).toEqual(["ambiguous-local-target", "missing-local-target", "missing-local-target"]);
  });

  it("preserves public anchors, formatted labels, nested reference definitions, external URLs and literal wiki examples", async () => {
    const f = await fixture({ "public/index.md": "[**strong** `code`](page.md#section) [site](https://example.org/a?q=1#x)\n\n> [ref][target]\n>\n> [target]: ../secret.md\n\n\\[[secret]]\n[[page|*emphasis*]]\n![[page#section]]", "public/page.md": "# Page", "secret.md": "PRIVATE" });
    const snapshot = await exportPublication(f.request);
    const result = await readFile(path.join(snapshot.directory, "index.md"), "utf8");
    expect(result).toContain("[**strong** `code`](<page.md#section>)"); expect(result).toContain("[site](https://example.org/a?q=1#x)");
    expect(result).not.toContain("../secret.md"); expect(result).toContain("\\[[secret]]");
    expect(result).toContain("![[page.md#section|page#section]]");
  });

  it("projects parsed HTML and frontmatter resources, retains inline style/SVG fragments and known generated routes", async () => {
    const f = await fixture({
      "public/index.md": '---\nimage: /images/a.svg\n---\n<style>.paper {color:red}</style><a href="/index.xml">RSS</a><a href="/reports">Reports</a><a href="/unknown">Unknown</a><a href="../private.md">Private</a><img src="images/a.svg">',
      "public/reports/report.md": "# Report", "private.md": "PRIVATE", "public/images/a.svg": '<svg xmlns="http://www.w3.org/2000/svg"><defs><marker id="arrow"/></defs><path marker-end="url(#arrow)"/><image href="../../private.png"/></svg>', "private.png": "PRIVATE",
    });
    const snapshot = await exportPublication(f.request);
    const result = await readFile(path.join(snapshot.directory, "index.md"), "utf8");
    expect(result).toContain('<style>.paper {color:red}</style>'); expect(result).toContain('href="index.xml"'); expect(result).toContain('href="reports"'); expect(result).not.toContain('href="/unknown"'); expect(result).not.toContain('href="../private.md"');
    expect(result).toContain("image: images/a.svg"); expect(await readFile(path.join(snapshot.directory, "images/a.svg"), "utf8")).not.toContain("private.png");
  });

  it.each(['<img srcset="../private.png 1x">', '<style>@import "../private.css";</style>', '<script src="https://example.com/script.js"></script>', '---\nresources: ../private.css\n---\n# Note'])("fails closed with explicit diagnostics for unsupported resource constructs %s", async (content) => {
    const f = await fixture({ "public/index.md": content });
    await expect(exportPublication(f.request)).rejects.toBeInstanceOf(PublicationExportError);
  });

  it("does not follow source symlinks and rejects staging inside any authorized Note Root", async () => {
    const f = await fixture({ "public/index.md": "![escaped](images/secret.png)", "private/secret.png": "SECRET" });
    await symlink(path.join(f.notes, "private"), path.join(f.notes, "public/images"));
    const snapshot = await exportPublication(f.request);
    expect(snapshot.manifest.files.map((file) => file.path)).toEqual(["index.md"]);
    await expect(exportPublication({ ...f.request, stagingParent: path.join(f.notes, "stages") })).rejects.toThrow("outside every Note Root");
    await expect(exportPublication({ ...f.request, publicationDirectory: path.join(f.notes, "public/images") })).rejects.toThrow("symlink redirect");
  });

  it("checks source/stage membership and bytes, uses fresh output and carries source dates", async () => {
    const f = await fixture({ "public/index.md": "# Start", "public/old.md": "# Old" });
    const first = await exportPublication(f.request);
    expect(await readFile(path.join(first.directory, "index.md"), "utf8")).toMatch(/created: /);
    await writeFile(path.join(first.directory, "index.md"), "tampered");
    await expect(verifyPublicationSnapshot(first)).rejects.toThrow("staged bytes changed");
    await writeFile(path.join(f.notes, "public/old.md"), "---\ndraft: true\n---\nOld");
    const second = await exportPublication(f.request);
    expect(second.directory).not.toBe(first.directory); expect(second.manifest.files.map((file) => file.path)).toEqual(["index.md"]);
    await writeFile(path.join(f.notes, "public/index.md"), "# Changed");
    await expect(verifyPublicationSnapshot(second)).rejects.toThrow("source bytes changed");
  });

  it("ignores dependency caches and unrelated private binaries, handles invalid private YAML without blocking export", async () => {
    const f = await fixture({ "public/index.md": "# Public", "private/bad.md": "---\nbad: [\n---\nprivate", "node_modules/pkg/bad.md": "---\nbad: [\n---\ninvalid dependency", "public/node_modules/never.md": "do not publish" });
    const snapshot = await exportPublication(f.request);
    expect(snapshot.manifest.files.map((file) => file.path)).toEqual(["index.md"]);
    await writeFile(path.join(f.notes, "private/background.bin"), "irrelevant");
    await verifyPublicationSnapshot(snapshot);
  });
});
