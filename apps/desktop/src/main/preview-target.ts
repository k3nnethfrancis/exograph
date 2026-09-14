import path from "node:path";
import { readFile, realpath, stat } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

import { WorkspaceFiles, type WorkspaceSettings } from "@exograph/core";
import type { PreviewTarget } from "../shared/api/workspace-filesystem";

export type PreviewTargetResponse = PreviewTarget & { ok: true };

export async function resolvePreviewTarget(target: string, settings: WorkspaceSettings): Promise<PreviewTargetResponse> {
  const trimmed = target.trim();
  if (!trimmed) {
    throw new Error("Preview target cannot be empty.");
  }

  const localhostUrl = parseBareLocalhostUrl(trimmed);
  if (localhostUrl) {
    return { ok: true, url: localhostUrl.toString(), source: "url", kind: "web" };
  }

  const parsedUrl = parsePreviewUrl(trimmed);
  if (parsedUrl) {
    if (parsedUrl.protocol === "http:" || parsedUrl.protocol === "https:") {
      if (!isTrustedLocalhost(parsedUrl.hostname)) {
        throw new Error("Preview URLs are limited to localhost or local files in V1.");
      }
      return { ok: true, url: parsedUrl.toString(), source: "url", kind: "web" };
    }
    if (parsedUrl.protocol === "file:") {
      return resolveLocalPreviewPath(fileURLToPath(parsedUrl), settings);
    }
    throw new Error("Preview URL must use http, https, or file.");
  }

  const candidatePath = path.isAbsolute(trimmed)
    ? trimmed
    : path.resolve(settings.workspaceRoot, trimmed);
  return resolveLocalPreviewPath(candidatePath, settings);
}

function isTrustedLocalhost(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1" || normalized === "[::1]";
}

async function resolveLocalPreviewPath(filePath: string, settings: WorkspaceSettings): Promise<PreviewTargetResponse> {
  const resolvedPath = path.resolve(filePath);
  const trustedPath = await new WorkspaceFiles(settings.noteRoots).existing(resolvedPath)
    .catch(() => {
      throw new Error("Local preview files must be inside a configured Note Root.");
    });

  const canonicalPath = await realpath(trustedPath);
  const extension = path.extname(canonicalPath).toLowerCase();
  if (![".html", ".htm", ".pdf"].includes(extension)) {
    throw new Error("Local preview files must be .html, .htm, or .pdf files.");
  }

  const fileStat = await stat(canonicalPath);
  if (!fileStat.isFile()) {
    throw new Error("Local preview target must be an existing file.");
  }

  if (extension === ".pdf") {
    return { ok: true, url: pathToFileURL(canonicalPath).toString(), source: "file", kind: "pdf", filePath: trustedPath };
  }
  return { ok: true, url: pathToFileURL(canonicalPath).toString(), source: "file", kind: "html" };
}

/**
 * The renderer gets bytes only through this narrow read path. Rechecking the
 * canonical target here prevents a caller from turning a Preview path into a
 * general filesystem read capability.
 */
export async function readPdfFile(filePath: string, settings: WorkspaceSettings): Promise<ArrayBuffer> {
  const canonicalPath = await new WorkspaceFiles(settings.noteRoots).existingIdentity(filePath)
    .catch(() => {
      throw new Error("Local PDF files must be inside a configured Note Root.");
    });
  if (path.extname(canonicalPath).toLowerCase() !== ".pdf") {
    throw new Error("Local PDF files must use the .pdf extension.");
  }
  const fileStat = await stat(canonicalPath);
  if (!fileStat.isFile()) {
    throw new Error("Local PDF target must be an existing file.");
  }
  const bytes = await readFile(canonicalPath);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

function parsePreviewUrl(target: string): URL | null {
  if (!/^[a-z][a-z0-9+.-]*:/i.test(target)) {
    return null;
  }
  try {
    return new URL(target);
  } catch {
    throw new Error("Preview target is not a valid URL.");
  }
}

function parseBareLocalhostUrl(target: string): URL | null {
  const candidate = `http://${target}`;
  try {
    const parsed = new URL(candidate);
    if ((target.startsWith("localhost") || target.startsWith("127.0.0.1") || target.startsWith("[::1]")) && isTrustedLocalhost(parsed.hostname)) {
      return parsed;
    }
  } catch {
    return null;
  }
  return null;
}
