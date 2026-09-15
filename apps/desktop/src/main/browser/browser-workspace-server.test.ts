import { request } from "node:http";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { DocumentPersistence } from "@exograph/core";
import type { BrowserApi } from "../../shared/browser-api";
import { BrowserWorkspaceServer } from "./browser-workspace-server";
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "exo-browser-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const notes = path.join(root, "notes");
  await mkdir(notes);
  await mkdir(path.join(root, "assets"));
  const file = path.join(notes, "a.md");
  await writeFile(file, "# A\nOriginal");
  await writeFile(path.join(root, "browser.html"), "browser entry");
  const persistence = new DocumentPersistence();
  let scope = "a";
  const api = {
    bootstrap: async () => ({
      workspaceRoot: root,
      noteRoots: [{ id: "notes", label: "Notes", path: notes }],
      defaultTerminalCwd: root,
    }),
    read: vi.fn((file) => persistence.read(file)),
    save: vi.fn((...args: Parameters<BrowserApi["save"]>) =>
      persistence.save(...args),
    ),
    saveCopy: (...args: Parameters<BrowserApi["saveCopy"]>) =>
      persistence.saveCopy(...args),
  } as unknown as BrowserApi;
  const server = new BrowserWorkspaceServer({
    api,
    assets: root,
    scope: () => scope,
  });
  cleanup.push(() => server.stop());
  const { url } = await server.open();
  const parsed = new URL(url);
  const origin = parsed.origin;
  const ticket = parsed.hash.slice(7);
  const response = await fetch(origin + "/session", {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({ token: ticket }),
  });
  expect(response.status).toBe(200);
  const cookie = response.headers.get("set-cookie")!.split(";")[0];
  const call = (
    method: string,
    args: unknown[] = [],
    headers: Record<string, string> = {},
  ) =>
    fetch(origin + "/api/" + method, {
      method: "POST",
      headers: {
        Origin: origin,
        Cookie: cookie,
        "Content-Type": "application/json",
        ...headers,
      },
      body: JSON.stringify({ args }),
    });
  return {
    server,
    api,
    root,
    notes,
    file,
    origin,
    ticket,
    cookie,
    call,
    changeScope: () => {
      scope = "b";
      server.changed();
    },
  };
}
it("requires same-origin authentication, rejects ticket replay, and exposes only the browser API", async () => {
  const f = await fixture();
  expect(await (await fetch(f.origin)).text()).toBe("browser entry");
  expect((await f.call("read", [f.file], { Cookie: "" })).status).toBe(401);
  expect(
    (await f.call("read", [f.file], { Origin: "https://example.com" })).status,
  ).toBe(403);
  expect(
    await new Promise((resolve) => {
      const req = request(
        f.origin,
        { headers: { Host: "evil.test" } },
        (res) => {
          res.resume();
          resolve(res.statusCode);
        },
      );
      req.end();
    }),
  ).toBe(403);
  expect(
    (
      await fetch(f.origin + "/session", {
        method: "POST",
        headers: { Origin: f.origin, "Content-Type": "application/json" },
        body: JSON.stringify({ token: f.ticket }),
      })
    ).status,
  ).toBe(401);
  expect((await f.call("spawnAgentCommand", ["evil"])).status).toBe(400);
  expect((await fetch(f.origin + "/index.html")).status).toBe(404);
  expect((await f.call("read", [f.file])).status).toBe(200);
});
it("enforces Note Root containment for reads and writes, including symlink escapes", async () => {
  const f = await fixture();
  const outside = path.join(f.root, "private.md");
  await writeFile(outside, "private");
  await symlink(outside, path.join(f.notes, "escape.md"));
  for (const target of [
    outside,
    path.join(f.notes, "escape.md"),
    "relative.md",
  ]) {
    expect((await f.call("read", [target])).status).toBe(400);
    expect(
      (await f.call("save", [target, {}, "overwrite", "revision"])).status,
    ).toBe(400);
    expect((await f.call("saveCopy", [target, {}, "overwrite"])).status).toBe(
      400,
    );
  }
  expect(await readFile(outside, "utf8")).toBe("private");
  expect(f.api.read).not.toHaveBeenCalled();
  expect(f.api.save).not.toHaveBeenCalled();
});
it("uses production revision checks so an external edit cannot be silently overwritten", async () => {
  const f = await fixture();
  const original = (await (await f.call("read", [f.file])).json()).result;
  await writeFile(f.file, "# A\nChanged by desktop");
  const result = (
    await (
      await f.call("save", [f.file, {}, "Browser edits", original.revision])
    ).json()
  ).result;
  expect(result.status).toBe("conflict");
  expect(await readFile(f.file, "utf8")).toContain("Changed by desktop");
});
it("expires existing sessions when workspace authority changes and suppresses stale responses", async () => {
  const f = await fixture();
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.mocked(f.api.read).mockImplementation(async () => {
    await waiting;
    return {
      filePath: f.file,
      title: "secret",
      body: "old workspace",
      frontmatter: {},
      kind: "markdown",
      revision: "r",
    };
  });
  const response = f.call("read", [f.file]);
  await vi.waitFor(() => expect(f.api.read).toHaveBeenCalled());
  f.changeScope();
  release();
  expect((await response).status).toBe(401);
  expect((await f.call("bootstrap")).status).toBe(401);
});
