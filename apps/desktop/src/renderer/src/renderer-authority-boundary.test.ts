import { builtinModules } from "node:module";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, test } from "vitest";

const rendererRoot = fileURLToPath(new URL(".", import.meta.url));
const desktopSourceRoot = path.resolve(rendererRoot, "../..");
const forbiddenSourceRoots = [
  path.join(desktopSourceRoot, "main"),
  path.join(desktopSourceRoot, "preload"),
];
const nodeModules = new Set(
  builtinModules.flatMap((name) => [name, name.replace(/^node:/, "")]),
);

async function productionSources(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const sources: string[] = [];

  for (const entry of entries) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      sources.push(...(await productionSources(entryPath)));
      continue;
    }
    if (!/\.(?:ts|tsx)$/.test(entry.name)) continue;
    if (/\.(?:test|spec)\.(?:ts|tsx)$/.test(entry.name)) continue;
    if (entry.name.endsWith(".d.ts")) continue;
    sources.push(entryPath);
  }

  return sources;
}

function importedSpecifiers(source: string, filePath: string): string[] {
  const syntax = filePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const file = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, syntax);
  const specifiers: string[] = [];

  function visit(node: ts.Node): void {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1 &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      specifiers.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  }

  visit(file);
  return specifiers;
}

function violation(filePath: string, specifier: string): string | null {
  const normalized = specifier.replace(/^node:/, "");
  if (specifier === "electron" || specifier.startsWith("electron/")) {
    return "imports Electron directly";
  }
  if (specifier.startsWith("node:") || nodeModules.has(normalized)) {
    return "imports a Node built-in";
  }
  if (!specifier.startsWith(".")) return null;

  const resolved = path.resolve(path.dirname(filePath), specifier);
  if (
    forbiddenSourceRoots.some(
      (root) => resolved === root || resolved.startsWith(`${root}${path.sep}`),
    )
  ) {
    return "imports a main-process or preload implementation";
  }
  return null;
}

describe("renderer authority boundary", () => {
  test("production renderer code cannot import Node, Electron, main, or preload authority", async () => {
    const failures: string[] = [];

    for (const filePath of await productionSources(rendererRoot)) {
      const source = await readFile(filePath, "utf8");
      for (const specifier of importedSpecifiers(source, filePath)) {
        const reason = violation(filePath, specifier);
        if (!reason) continue;
        failures.push(`${path.relative(rendererRoot, filePath)}: ${reason} (${specifier})`);
      }
    }

    expect(failures).toEqual([]);
  });
});
