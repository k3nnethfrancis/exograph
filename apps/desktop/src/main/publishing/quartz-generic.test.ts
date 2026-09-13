import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { buildQuartzSite } from "./quartz-build";
import { publishingResource } from "./publishing-resources";

const cleanup: string[] = [];
afterEach(async () => { await Promise.all(cleanup.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture(custom: boolean, unlisted = true) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "exo-vanilla-runner-"))); cleanup.push(root);
  const engine = path.join(root, "quartz ; project"), input = path.join(root, "snapshot"), output = path.join(root, "site");
  await mkdir(path.join(engine, "quartz"), { recursive: true });
  await mkdir(path.join(engine, "custom")); await writeFile(path.join(engine, "custom/theme.txt"), "theme kept");
  const require = createRequire(import.meta.url);
  const coreRequire = createRequire(require.resolve("@exograph/core"));
  await mkdir(path.join(engine, "node_modules/@quartz-community/utils"), { recursive: true });
  for (const dependency of ["yaml", "parse5"]) {
    const dependencyRoot = path.resolve(path.dirname(coreRequire.resolve(dependency)), "..");
    await symlink(dependencyRoot, path.join(engine, "node_modules", dependency), "dir");
  }
  await writeFile(path.join(engine, "node_modules/@quartz-community/utils/package.json"), '{"type":"module","exports":{".":{"import":"./index.js"}}}');
  await writeFile(path.join(engine, "node_modules/@quartz-community/utils/index.js"), 'export const slugifyFilePath = value => value.toLowerCase().replace(/\\s/g,"-").replace(/\\.md$/,"");');
  await writeFile(path.join(engine, "package.json"), '{"name":"quartz","version":"5.0.0","type":"module"}');
  const config = JSON.stringify({ configuration: { pageTitle: custom ? "My custom theme" : "Quartz 5", baseUrl: "quartz.jzhao.xyz", analytics: { provider: "plausible" }, theme: { colors: { custom: "red" } } }, plugins: [{ source: "@quartz-community/crawl-links", options: { markdownLinkResolution: "shortest", externalLinkIcon: false } }, ...(unlisted ? [{ source: "@quartz-community/unlisted-pages" }] : []), { source: "./custom", options: { retained: true } }] });
  const configPath = path.join(engine, custom ? "quartz.plugins.json" : "quartz.config.default.yaml");
  await writeFile(configPath, config);
  await mkdir(input); await writeFile(path.join(input, "index.md"), "# Public");
  const preview = "---\ndraft: true\npreview: true\nunlisted: true\n---\n# Shared preview\n";
  await writeFile(path.join(input, "preview.md"), preview);
  // A real CLI child asserts the generated config/content and custom relative files.
  // Actual upstream Quartz rendering is covered by the separate real-engine gate.
  await writeFile(path.join(engine, "quartz/bootstrap-cli.mjs"), `import {readFile,mkdir,writeFile} from 'node:fs/promises';import YAML from 'yaml';
    const args=Object.fromEntries(Array.from({length:(process.argv.length-3)/2},(_,i)=>[process.argv[3+i*2],process.argv[4+i*2]]));
    const config=YAML.parse(await readFile('quartz.config.yaml','utf8'));
    if(config.configuration.baseUrl!=='site.example/base'||config.configuration.analytics!==null||config.plugins[0].options.markdownLinkResolution!=='relative'||config.plugins[0].options.externalLinkIcon!==false||config.configuration.theme.colors.custom!=='red')throw new Error('Configuration lost');
    if(await readFile('custom/theme.txt','utf8')!=='theme kept')throw new Error('Custom relative path lost');
    if(!(await readFile(args['--directory']+'/preview.md','utf8')).includes('draft: false'))throw new Error('Shared preview not projected');
    await mkdir(args['--output']);
    await writeFile(args['--output']+'/index.html','<title>'+config.configuration.pageTitle+'</title><div class="page-listing"><p>1 items under this folder.</p><ul><li class="section-li"><h3><a href="missing/">preview-only folder</a></h3></li></ul></div><a class="tag-link" href="tags/missing">readable tag</a><a href="preview">preview</a><a href="https://site.example/base/remote">external</a>');
    await writeFile(args['--output']+'/preview.html','Shared preview');`);
  return { root, engine, input, output, configPath, config, preview, build: () => buildQuartzSite({ engineDirectory: engine, inputDirectory: input, outputDirectory: output, siteUrl: "https://site.example/base/", action: "preview", signal: new AbortController().signal }) };
}
it.each([false, true])("builds default/custom Quartz configuration without an adapter or source edits (custom=%s)", async custom => {
  const f = await fixture(custom); await f.build();
  const html = await readFile(path.join(f.output, "index.html"), "utf8");
  expect(html).toContain(custom ? "My custom theme" : "Quartz 5");
  expect(html).toContain("0 items under this folder");
  expect(html).not.toContain("preview-only folder");
  expect(html).toContain('<span class="tag-link">readable tag</span>');
  expect(html).toContain('href="preview"'); expect(html).toContain('href="https://site.example/base/remote"');
  expect(await readFile(f.configPath, "utf8")).toBe(f.config);
  expect(await readFile(path.join(f.input, "preview.md"), "utf8")).toBe(f.preview);
  expect((await readdir(f.root)).some(name => name.startsWith(".quartz-work-"))).toBe(false);
  await expect(f.build()).rejects.toThrow("fresh");
});
it("fails before rendering shared previews when the engine disables unlisted filtering", async () => {
  const f = await fixture(false, false);
  await expect(f.build()).rejects.toThrow("unlisted-pages");
  await expect(readFile(path.join(f.output, "index.html"))).rejects.toMatchObject({ code: "ENOENT" });
});

it.each([
  ["a b.md", "a-b.md", "# First"],
  ["one.md", "two.md", "---\naliases: [two]\n---\n# First"],
])("rejects conflicting engine URL mappings before rendering (%s)", async (first, second, content) => {
  const f = await fixture(false);
  await writeFile(path.join(f.input, first), content); await writeFile(path.join(f.input, second), "# Second");
  await expect(f.build()).rejects.toThrow("Publication URL collision");
  await expect(readFile(path.join(f.output, "index.html"))).rejects.toMatchObject({ code: "ENOENT" });
});

it.each(["node", "electron"])("runs optional hooks with normal util.parseArgs semantics under %s", async runtime => {
  const f = await fixture(false);
  await mkdir(path.join(f.engine, "scripts"));
  await writeFile(path.join(f.engine, "scripts/exograph-publish.mjs"), `import {parseArgs} from 'node:util';import {mkdir,writeFile} from 'node:fs/promises';
    const {values}=parseArgs({options:Object.fromEntries(['input','output','site-url','action'].map(name=>[name,{type:'string'}]))});
    if(!values.input||values.action!=='preview')throw new Error('Wrong hook arguments');
    await mkdir(values.output);await writeFile(values.output+'/index.html',values['site-url']);`);
  const executable = runtime === "electron" ? createRequire(import.meta.url)("electron") as string : process.execPath;
  await promisify(execFile)(executable, [await publishingResource("quartz-build.mjs"), "--engine", f.engine, "--input", f.input, "--output", f.output, "--site-url", "https://site.example/base/", "--action", "preview"], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, timeout: 20_000 });
  expect(await readFile(path.join(f.output, "index.html"), "utf8")).toBe("https://site.example/base/");
});
