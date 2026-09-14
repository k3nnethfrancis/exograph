import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DocumentPersistence } from "./document-persistence";

let directory: string;
let filePath: string;
beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "exograph-conflict-"));
  filePath = path.join(directory, "note.md");
  await writeFile(filePath, "---\nstatus: original\n---\nOriginal body\n");
});
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

describe("editor document persistence", () => {
  it("rejects a completed external edit with equal byte length and leaves its exact bytes intact", async () => {
    const owner = new DocumentPersistence();
    const document = await owner.read(filePath);
    const external = (await readFile(filePath, "utf8")).replace("original", "external");
    await writeFile(filePath, external);
    expect(await owner.save(filePath, document.frontmatter, "Local body", document.revision)).toMatchObject({ status: "conflict" });
    expect(await readFile(filePath, "utf8")).toBe(external);
  });

  it("advances the revision after saving and rejects another save from the old revision", async () => {
    const owner = new DocumentPersistence();
    const document = await owner.read(filePath);
    const saved = await owner.save(filePath, {}, "Short", document.revision);
    expect(saved.status).toBe("saved");
    expect((await owner.read(filePath)).body).toBe("Short");
    expect(await owner.save(filePath, {}, "Stale", document.revision)).toMatchObject({ status: "conflict" });
    if (saved.status !== "saved") throw new Error("Expected save");
    expect(await owner.save(filePath, {}, "Newest", saved.revision)).toMatchObject({ status: "saved" });
  });

  it("serializes saves through canonical aliases so only one stale writer wins", async () => {
    const owner = new DocumentPersistence();
    const document = await owner.read(filePath);
    const alias = path.join(directory, "alias.md");
    await symlink(filePath, alias);
    const results = await Promise.all([
      owner.save(filePath, {}, "First", document.revision),
      owner.save(alias, {}, "Second", document.revision),
    ]);
    expect(results.filter((result) => result.status === "saved")).toHaveLength(1);
    expect(results.filter((result) => result.status === "conflict")).toHaveLength(1);
    expect((await owner.read(filePath)).body).toBe(results[0].status === "saved" ? "First" : "Second");
  });

  it("does not recreate a missing original or overwrite an existing copy destination", async () => {
    const owner = new DocumentPersistence();
    const document = await owner.read(filePath);
    await rm(filePath);
    expect(await owner.save(filePath, {}, "Local", document.revision)).toEqual({ status: "missing" });
    await expect(readFile(filePath)).rejects.toMatchObject({ code: "ENOENT" });
    const destination = path.join(directory, "copy.md");
    const copy = await owner.saveCopy(destination, { status: "local" }, "Local");
    expect(await owner.read(destination)).toEqual(copy);
    await expect(owner.saveCopy(destination, {}, "Other")).rejects.toThrow("Destination already exists");
    expect((await owner.read(destination)).body).toBe("Local");
  });
});
