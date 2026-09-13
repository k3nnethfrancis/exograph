#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const within = (root, target) => target === root || target.startsWith(root + path.sep);
const truth = value => value === true || value === "true";
async function files(root) {
  const result = [];
  async function visit(directory) {
    for (const name of (await readdir(directory)).sort()) {
      const target = path.join(directory, name), info = await lstat(target);
      if (info.isSymbolicLink()) throw new Error("Publication content must not contain symlinks.");
      if (info.isDirectory()) await visit(target);
      else if (info.isFile()) result.push({ path: path.relative(root, target).split(path.sep).join("/"), hash: createHash("sha256").update(await readFile(target)).digest("hex") });
      else throw new Error("Publication content must contain ordinary files.");
    }
  }
  await visit(root);
  return result;
}
// Stock Quartz can emit folder/tag anchors for unlisted-only groups with no listing.
// Correct generated navigation against the actual emitted inventory, preserving labels.
async function repairGeneratedLinks(root, site, require) {
  const { parse, serialize } = await import(pathToFileURL(require.resolve("parse5")).href);
  const inventory = new Set((await files(root)).map(file => file.path));
  for (const relative of [...inventory].filter(file => file.endsWith(".html"))) {
    const target = path.join(root, relative), tree = parse(await readFile(target, "utf8"));
    const attr = (node, key) => node.attrs?.find(item => item.name === key)?.value;
    const hasClass = (node, name) => (attr(node, "class") ?? "").split(/\s+/).includes(name);
    let changed = false;
    function walk(node) {
      for (let i = 0; i < (node.childNodes?.length ?? 0); i++) {
        const child = node.childNodes[i];
        walk(child);
        if (child.missingTitle) {
          if (child.tagName === "li" && hasClass(child, "section-li")) { node.childNodes.splice(i--, 1); changed = true; continue; }
          node.missingTitle = true;
        }
        if (child.tagName !== "a") continue;
        const href = attr(child, "href");
        if (!href || href.startsWith("#") || /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(href)) continue;
        let resolved;
        try { resolved = new URL(href, new URL(relative, site.href.replace(/\/?$/, "/"))); } catch { continue; }
        const base = site.pathname.replace(/\/$/, "");
        if (resolved.origin !== site.origin || (base && !resolved.pathname.startsWith(base + "/"))) continue;
        let route;
        try { route = decodeURIComponent(resolved.pathname.slice(base.length)).replace(/^\//, "").replace(/\/$/, ""); } catch { continue; }
        if (inventory.has(route) || inventory.has(route + ".html") || inventory.has((route ? route + "/" : "") + "index.html")) continue;
        if (hasClass(child, "tag-link")) { child.tagName = "span"; child.nodeName = "span"; child.attrs = child.attrs.filter(item => item.name !== "href"); }
        else { const children = child.childNodes ?? []; children.forEach(item => { item.parentNode = node; }); node.childNodes.splice(i, 1, ...children); i += children.length - 1; }
        if (node.tagName === "h3") node.missingTitle = true;
        changed = true;
      }
      if (hasClass(node, "page-listing")) {
        let count = 0;
        const countRows = item => { if (item.tagName === "li" && hasClass(item, "section-li")) count++; item.childNodes?.forEach(countRows); };
        countRows(node);
        const summary = node.childNodes.find(item => item.tagName === "p" && item.childNodes?.some(text => text.nodeName === "#text" && /items under this folder/.test(text.value)));
        if (summary) summary.childNodes = [{ nodeName: "#text", value: `${count} items under this folder.`, parentNode: summary }];
      }
    }
    walk(tree);
    if (changed) await writeFile(target, serialize(tree));
  }
}

async function run(script, args, cwd) {
  // Stock yargs detects Electron as an application. Supply ordinary Node argv explicitly.
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "--eval", "process.defaultApp=true;process.argv=JSON.parse(process.env.EXOGRAPH_QUARTZ_ARGV);await import(process.env.EXOGRAPH_QUARTZ_ENTRY)"], {
      cwd, env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", TZ: "UTC", EXOGRAPH_QUARTZ_ENTRY: pathToFileURL(script).href,
        EXOGRAPH_QUARTZ_ARGV: JSON.stringify([process.execPath, script, ...args]) }, stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.pipe(process.stderr); child.stderr.pipe(process.stderr);
    child.once("error", reject);
    child.once("close", code => code === 0 ? resolve() : reject(new Error(`Quartz exited with code ${code}.`)));
  });
}

let working;
try {
  const { values } = parseArgs({ options: Object.fromEntries(["engine", "input", "output", "site-url", "action"].map(key => [key, { type: "string" }])) });
  if (!values.engine || !values.input || !values.output || !values["site-url"] || !["preview", "prepare"].includes(values.action)) throw new Error("Choose a Quartz project, publication folder, and site URL.");
  const engine = await realpath(values.engine), input = await realpath(values.input);
  const site = new URL(values["site-url"]);
  if (!["http:", "https:"].includes(site.protocol) || site.username || site.password || site.search || site.hash) throw new Error("Use an HTTP(S) site URL without credentials, query, or fragment.");
  await mkdir(path.dirname(path.resolve(values.output)), { recursive: true });
  const output = path.join(await realpath(path.dirname(path.resolve(values.output))), path.basename(values.output));
  if (within(input, output) || within(output, input) || within(engine, output) || within(output, engine)) throw new Error("Build output must be separate from content and the Quartz project.");
  try { const info = await lstat(output); if (!info.isDirectory() || (await readdir(output)).length) throw new Error("Build output must be fresh."); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  const before = await files(input);
  let hook;
  try { hook = await realpath(path.join(engine, "scripts/exograph-publish.mjs")); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  if (hook) {
    if (!within(engine, hook)) throw new Error("The optional build adapter must belong to the Quartz project.");
    await run(hook, ["--input", input, "--output", output, "--site-url", site.href, "--action", values.action], engine);
  } else {
    const pkg = JSON.parse(await readFile(path.join(engine, "package.json"), "utf8"));
    if (!/^5\./.test(pkg.version ?? "") || !String(pkg.name).toLowerCase().includes("quartz")) throw new Error("Select an installed Quartz 5 project, or provide its optional build adapter.");
    const require = createRequire(path.join(engine, "package.json"));
    let YAML;
    try { YAML = require("yaml"); } catch { throw new Error("Install the Quartz project's dependencies before building (npm ci in that project)."); }
    const { slugifyFilePath } = await import(pathToFileURL(require.resolve("@quartz-community/utils")).href);
    const routes = new Map();
    const register = (route, source) => {
      const normalized = route.replace(/\/index(?:\.html)?$/, "").replace(/\.html$/, "");
      const owner = routes.get(normalized);
      if (owner && owner !== source) throw new Error(`Publication URL collision: ${owner} and ${source}`);
      routes.set(normalized, source);
    };
    for (const file of before) {
      if (["index.xml", "sitemap.xml", "static/contentIndex.json"].includes(file.path)) throw new Error(`Asset conflicts with a generated publication file: ${file.path}`);
      register(slugifyFilePath(file.path), file.path);
      if (!/\.md$/i.test(file.path)) continue;
      const body = await readFile(path.join(input, file.path), "utf8");
      const header = body.match(/^\ufeff?---(?:yaml|yml)?[ \t]*\r?\n((?:[\s\S]*?\r?\n)?)---[ \t]*(?:\r?\n|$)/);
      const metadata = header ? YAML.parse(header[1]) ?? {} : {};
      const aliases = metadata.aliases ?? metadata.alias ?? [];
      for (const alias of Array.isArray(aliases) ? aliases : [aliases]) {
        if (typeof alias !== "string") throw new Error(`Invalid publication alias: ${file.path}`);
        const relative = path.posix.join(path.posix.dirname(file.path), alias);
        if (relative.startsWith("../") || relative.startsWith("/")) throw new Error(`Publication alias escapes its site: ${file.path}`);
        register(slugifyFilePath(relative), file.path);
      }
    }
    let config;
    for (const name of ["quartz.config.yaml", "quartz.plugins.json", "quartz.config.default.yaml", "quartz.plugins.default.json"]) {
      try { const source = await readFile(path.join(engine, name), "utf8"); config = name.endsWith(".json") ? JSON.parse(source) : YAML.parse(source); break; }
      catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    if (!config?.configuration || !Array.isArray(config.plugins)) throw new Error("The Quartz project needs a Quartz 5 YAML or JSON configuration.");
    config.configuration.baseUrl = site.host + site.pathname.replace(/\/$/, "");
    if (values.action === "preview") config.configuration.analytics = null;
    const sourceName = entry => typeof entry.source === "string" ? entry.source : entry.source?.repo ?? "";
    const plugin = name => config.plugins.find(entry => new RegExp(`(?:@quartz-community/|github:quartz-community/)${name}(?:#.*)?$`).test(sourceName(entry)) && entry.enabled !== false);
    const links = plugin("crawl-links");
    if (links) links.options = { ...links.options, markdownLinkResolution: "relative" };
    working = await mkdtemp(path.join(path.dirname(output), ".quartz-work-"));
    for (const entry of await readdir(engine, { withFileTypes: true })) {
      if ([".git", "content", "public", "quartz.config.yaml", "quartz.config.default.yaml", "quartz.plugins.json", "quartz.plugins.default.json"].includes(entry.name)) continue;
      const source = path.join(engine, entry.name), target = path.join(working, entry.name);
      if (entry.name === "quartz") await cp(source, target, { recursive: true, filter: file => !file.split(path.sep).includes(".quartz-cache") });
      else await symlink(source, target, entry.isDirectory() ? "dir" : "file");
    }
    await writeFile(path.join(working, "quartz.config.yaml"), YAML.stringify(config));
    const content = path.join(working, "content");
    await cp(input, content, { recursive: true, preserveTimestamps: true });
    for (const file of before.filter(file => /\.md$/i.test(file.path))) {
      const target = path.join(content, file.path), source = await readFile(target, "utf8");
      const header = source.match(/^\ufeff?---(?:yaml|yml)?[ \t]*\r?\n((?:[\s\S]*?\r?\n)?)---[ \t]*(?:\r?\n|$)/);
      if (!header) continue;
      const document = YAML.parseDocument(header[1]), metadata = document.toJS() ?? {};
      if (truth(metadata.unlisted) && !plugin("unlisted-pages")) throw new Error("Enable the Quartz unlisted-pages plugin before publishing shared previews or unlisted notes.");
      if (truth(metadata.draft) && truth(metadata.preview) && truth(metadata.unlisted)) {
        document.set("draft", false);
        await writeFile(target, `---\n${document.toString()}---\n${source.slice(header[0].length)}`);
      }
    }
    await run(path.join(working, "quartz/bootstrap-cli.mjs"), ["build", "--directory", content, "--output", output], working);
    await repairGeneratedLinks(output, site, require);
  }
  if (JSON.stringify(before) !== JSON.stringify(await files(input))) throw new Error("The publication snapshot changed during the build.");
  if (!(await lstat(path.join(output, "index.html"))).isFile()) throw new Error("Quartz produced no index.html.");
  await files(output);
  process.stdout.write(JSON.stringify({ ok: true, outputPath: output, action: values.action }) + "\n");
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
} finally { if (working) await rm(working, { recursive: true, force: true }); }
