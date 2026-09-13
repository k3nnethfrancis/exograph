import { createHash } from "node:crypto"
import { lstat, readdir, readFile } from "node:fs/promises"
import path from "node:path"

export const sha256 = bytes => createHash("sha256").update(bytes).digest("hex")
export async function snapshotFiles(root) {
  if (!(await lstat(root)).isDirectory() || (await lstat(root)).isSymbolicLink()) throw new Error("Snapshot must be an ordinary directory")
  const files = []
  async function visit(directory) {
    for (const name of await readdir(directory)) {
      if ([".git", ".gitattributes"].includes(name.toLowerCase())) throw new Error("Snapshot cannot contain Git metadata")
      const absolute = path.join(directory, name)
      const stat = await lstat(absolute)
      if (stat.isSymbolicLink()) throw new Error("Snapshot cannot contain symlinks")
      if (stat.isDirectory()) await visit(absolute)
      else if (stat.isFile()) files.push({ path: path.relative(root, absolute).split(path.sep).join("/"), sha256: sha256(await readFile(absolute)) })
      else throw new Error("Snapshot can contain only ordinary files")
    }
  }
  await visit(root)
  return files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
}
export const snapshotHash = files => sha256(JSON.stringify(files))
