import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import matter from "gray-matter";

import { noteTitle } from "./note-title";
export { noteTitle } from "./note-title";

import type {
  MarkdownLinkReference,
  NoteDocument,
  TagReference,
  WikilinkReference,
} from "./types";

const WIKILINK_PATTERN = /\[\[([^\]]+)\]\]/g;
const MARKDOWN_LINK_PATTERN = /\[([^\]]+)\]\(([^)]+)\)/g;
const TAG_PATTERN = /(^|\s)#([a-zA-Z0-9/_-]+)/g;

export async function readNoteDocument(filePath: string): Promise<NoteDocument> {
  return readWorkspaceDocument(filePath);
}

export async function readWorkspaceDocument(filePath: string): Promise<NoteDocument> {
  const raw = await readFile(filePath, "utf8");
  return parseWorkspaceDocument(filePath, raw);
}

export function parseWorkspaceDocument(filePath: string, raw: string): NoteDocument {
  if (!isMarkdownPath(filePath)) {
    return {
      filePath,
      title: path.basename(filePath),
      frontmatter: {},
      body: raw,
      kind: "text",
    };
  }

  const parsed = matter(raw);
  const title = noteTitle(filePath, parsed.data, parsed.content);

  return {
    filePath,
    title,
    frontmatter: parsed.data,
    body: parsed.content,
    kind: "markdown",
  };
}

export async function saveNoteDocument(filePath: string, frontmatter: Record<string, unknown>, body: string): Promise<void> {
  return saveWorkspaceDocument(filePath, frontmatter, body);
}

export async function saveWorkspaceDocument(
  filePath: string,
  frontmatter: Record<string, unknown>,
  body: string,
): Promise<void> {
  await writeFile(filePath, serializeWorkspaceDocument(filePath, frontmatter, body), "utf8");
}

export function serializeWorkspaceDocument(filePath: string, frontmatter: Record<string, unknown>, body: string): string {
  if (!isMarkdownPath(filePath)) return body;

  const serializedFrontmatter =
    frontmatter.date instanceof Date && !Number.isNaN(frontmatter.date.getTime())
      ? { ...frontmatter, date: frontmatter.date.toISOString().slice(0, 10) }
      : frontmatter;
  const serialized = preserveTrailingNewline(body, matter.stringify(body, serializedFrontmatter));
  return serialized;
}

/**
 * gray-matter helpfully adds a final newline during serialization. That is a
 * formatting change, not an editor edit: preserving the source body avoids a
 * later file-watch refresh inserting a newline that the person never typed.
 */
function preserveTrailingNewline(body: string, serialized: string): string {
  if (body.endsWith("\n") || !serialized.endsWith("\n")) return serialized;
  return serialized.slice(0, -1);
}

export function extractWikilinks(body: string): WikilinkReference[] {
  return Array.from(body.matchAll(WIKILINK_PATTERN)).map((match) => {
    const content = match[1];
    const aliasSeparator = content.indexOf("|");
    const target = (aliasSeparator < 0 ? content : content.slice(0, aliasSeparator)).trim();
    const label = aliasSeparator < 0 ? target : content.slice(aliasSeparator + 1).trim();
    const from = match.index ?? 0;
    return { label, target, sourceRange: { from, to: from + match[0].length } };
  });
}

export function extractMarkdownLinks(body: string): MarkdownLinkReference[] {
  return Array.from(body.matchAll(MARKDOWN_LINK_PATTERN)).map((match) => {
    const from = match.index ?? 0;
    return {
      label: match[1].trim(),
      target: match[2].trim(),
      sourceRange: { from, to: from + match[0].length },
    };
  });
}

export function extractTags(body: string, frontmatter: Record<string, unknown>): TagReference[] {
  const bodyTags = Array.from(body.matchAll(TAG_PATTERN)).map((match) => {
    const hashOffset = match[0].lastIndexOf("#");
    const from = (match.index ?? 0) + hashOffset;
    const sourceRange = { from, to: from + match[2].length + 1 };
    return { tag: match[2], source: "body" as const, sourceRange, occurrences: [{ source: "body" as const, sourceRange }] };
  });
  const frontmatterTags = Array.isArray(frontmatter.tags)
    ? frontmatter.tags.filter((tag): tag is string => typeof tag === "string")
    : typeof frontmatter.tags === "string"
      ? frontmatter.tags
          .split(/[,\s]+/)
          .map((tag) => tag.replace(/^#/, ""))
          .filter(Boolean)
      : [];

  const tags = new Map<string, TagReference>();
  for (const tag of frontmatterTags) {
    const existing = tags.get(tag);
    const occurrence = { source: "frontmatter" as const };
    if (existing) tags.set(tag, { ...existing, occurrences: [...existing.occurrences, occurrence] });
    else tags.set(tag, { tag, source: "frontmatter", occurrences: [occurrence] });
  }
  for (const item of bodyTags) {
    const existing = tags.get(item.tag);
    if (existing) tags.set(item.tag, { ...existing, occurrences: [...existing.occurrences, ...item.occurrences] });
    else tags.set(item.tag, item);
  }
  return [...tags.values()].sort((left, right) => left.tag.localeCompare(right.tag));
}

function isMarkdownPath(filePath: string): boolean {
  return /\.md(?:own)?$/i.test(filePath);
}
