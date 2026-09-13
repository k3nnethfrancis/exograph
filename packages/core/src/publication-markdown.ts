import { fromMarkdown } from "mdast-util-from-markdown";
import { parseFragment } from "parse5";
import type { RootContent, Root, Definition } from "mdast";

export type PublicationResolution = { url: string; kind?: "note" | "asset" | "generated" } | { reason: string };
export type PublicationResolver = (url: string, wiki?: boolean) => PublicationResolution;
type Edit = { from: number; to: number; value: string };
const escapeText = (text: string) => text.replace(/[\\`*_[\]<>!]/g, "\\$&");
const escapeAttribute = (text: string) => text.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
function apply(source: string, edits: Edit[]): string {
  let result = source;
  for (const edit of edits.sort((a, b) => b.from - a.from)) result = result.slice(0, edit.from) + edit.value + result.slice(edit.to);
  return result;
}

/** Source-offset edits keep code and unrelated Markdown byte-for-byte intact. */
export function projectPublicationMarkdown(source: string, resolve: PublicationResolver, diagnose: (reason: string) => void): string {
  const tree = fromMarkdown(source);
  const definitions = new Map<string, Definition>();
  const edits: Edit[] = [];
  const protectedRanges: Array<[number, number]> = [];
  function collect(node: Root | RootContent): void {
    if (node.type === "definition" && !definitions.has(node.identifier.toLowerCase())) definitions.set(node.identifier.toLowerCase(), node);
    if (["code", "inlineCode", "html", "definition", "link", "image", "linkReference", "imageReference"].includes(node.type)) protectedRanges.push([node.position!.start.offset!, node.position!.end.offset!]);
    if ("children" in node) for (const child of node.children) collect(child);
  }
  collect(tree);
  const wikiEdits: Edit[] = [];
  for (const match of source.matchAll(/(!?)\[\[([^\]\n]+)\]\]/g)) {
    const from = match.index!;
    const to = from + match[0].length;
    if (protectedRanges.some(([a, b]) => from < b && to > a) || (source.slice(0, from).match(/\\+$/)?.[0].length ?? 0) % 2) continue;
    const [target, ...aliases] = match[2].split("|");
    const label = aliases.length ? aliases.join("|") : target;
    const resolved = resolve(target.trim(), true);
    let value = escapeText(label);
    if ("url" in resolved) value = match[1] && resolved.kind === "note" ? `![[${resolved.url}|${label}]]` : `${match[1]}[${projectPublicationMarkdown(label, resolve, diagnose)}](<${resolved.url}>)`;
    else diagnose(resolved.reason);
    wikiEdits.push({ from, to, value });
  }
  edits.push(...wikiEdits);
  const raw = (node: RootContent) => source.slice(node.position!.start.offset!, node.position!.end.offset!);
  const visible = (node: RootContent): string => "value" in node ? String(node.value) : "alt" in node ? node.alt ?? "" : "children" in node ? node.children.map((child) => visible(child)).join("") : "";
  const replace = (node: RootContent, value: string) => edits.push({ from: node.position!.start.offset!, to: node.position!.end.offset!, value });
  function visit(node: Root | RootContent): void {
    if (node.type === "code" || node.type === "inlineCode") return;
    if (node.type !== "root" && wikiEdits.some((edit) => node.position!.start.offset! >= edit.from && node.position!.end.offset! <= edit.to)) return;
    if (node.type === "html") { replace(node, projectPublicationHtml(raw(node), resolve, diagnose)); return; }
    if (node.type === "definition") { replace(node, ""); return; }
    if (node.type === "link" || node.type === "image" || node.type === "linkReference" || node.type === "imageReference") {
      const url = "url" in node ? node.url : definitions.get(node.identifier.toLowerCase())?.url;
      if (url === undefined) { diagnose("missing-reference-definition"); replace(node, escapeText(visible(node))); return; }
      const originalLabel = "children" in node && node.children.length ? source.slice(node.children[0].position!.start.offset!, node.children.at(-1)!.position!.end.offset!) : escapeText(visible(node));
      const label = projectPublicationMarkdown(originalLabel, resolve, diagnose);
      const resolved = resolve(url);
      if (!("url" in resolved)) { diagnose(resolved.reason); replace(node, label); return; }
      // External inline links retain authored syntax. References must be expanded because definitions are removed.
      if ((node.type === "link" || node.type === "image") && label === originalLabel && resolved.url === url && /^(?:https?:|mailto:|tel:|\/\/)/i.test(url)) return;
      const image = node.type === "image" || node.type === "imageReference";
      const title = "title" in node ? node.title : ("identifier" in node ? definitions.get(node.identifier.toLowerCase())?.title : null);
      replace(node, `${image ? "!" : ""}[${label}](<${resolved.url}>${title ? ` ${JSON.stringify(title)}` : ""})`);
      return;
    }
    if ("children" in node) for (const child of node.children) visit(child);
  }
  visit(tree);
  return apply(source, edits);
}

/** HTML attribute positions come from an HTML parser, including entity decoding. */
export function projectPublicationHtml(source: string, resolve: PublicationResolver, diagnose: (reason: string) => void): string {
  const fragment = parseFragment(source, { sourceCodeLocationInfo: true });
  const edits: Edit[] = [];
  function visit(node: typeof fragment.childNodes[number], literal = false): void {
    if (node.nodeName === "#text" && "value" in node && !literal && node.sourceCodeLocation) {
      const projected = projectPublicationMarkdown(node.value, resolve, diagnose);
      if (projected !== node.value) edits.push({
        from: node.sourceCodeLocation.startOffset, to: node.sourceCodeLocation.endOffset,
        value: projected.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"),
      });
    }
    if ("tagName" in node) {
      if (["script", "object", "embed", "base", "link", "meta", "animate", "set", "animatemotion", "animatetransform", "discard"].includes(node.tagName.toLowerCase())) throw new Error(`Unsupported active HTML element: ${node.tagName}`);
      for (const attribute of node.attrs) {
        if (attribute.name.startsWith("on") || ["srcdoc", "srcset", "ping", "action", "formaction"].includes(attribute.name)) throw new Error(`Unsupported HTML resource attribute: ${attribute.name}`);
        if (attribute.name === "style" || /url\s*\(|@import|image-set\s*\(/i.test(attribute.value)) checkCss(attribute.value);
        if (!["href", "src", "poster", "background"].includes(attribute.name)) continue;
        const resolved = resolve(attribute.value);
        const location = node.sourceCodeLocation?.attrs?.[attribute.prefix ? `${attribute.prefix}:${attribute.name}` : attribute.name];
        if (!location) throw new Error("HTML resource has no source location.");
        if ("url" in resolved) edits.push({ from: location.startOffset, to: location.endOffset, value: `${attribute.prefix ? `${attribute.prefix}:` : ""}${attribute.name}="${escapeAttribute(resolved.url)}"` });
        else { diagnose(resolved.reason); edits.push({ from: location.startOffset, to: location.endOffset, value: "" }); }
      }
      if (node.tagName === "style") for (const child of node.childNodes) if ("value" in child) checkCss(child.value);
      literal ||= ["pre", "code", "style", "textarea", "title"].includes(node.tagName);
      if ("content" in node) for (const child of node.content.childNodes) visit(child, literal);
    }
    if ("childNodes" in node) for (const child of node.childNodes) visit(child, literal);
  }
  for (const node of fragment.childNodes) visit(node);
  return apply(source, edits);
}

function checkCss(value: string): void {
  // CSS escapes and resource functions require a CSS resource owner; reject instead of guessing URLs.
  if (/\\|@import|image-set\s*\(/i.test(value) || /url\s*\(/i.test(value.replace(/url\(\s*[\'"]?#[\w:.-]+[\'"]?\s*\)/gi, ""))) throw new Error("Unsupported CSS resource reference; use a contained Markdown/HTML image instead.");
}
