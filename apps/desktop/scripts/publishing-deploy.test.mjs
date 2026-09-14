import test, { after } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises"
import { execFileSync } from "node:child_process"
import os from "node:os"
import path from "node:path"
import { deploySnapshot } from "../resources/publishing/deploy.mjs"
import { snapshotFiles, snapshotHash } from "../resources/publishing/snapshot.mjs"

const roots = []
after(async () => { await Promise.all(roots.map(root => rm(root, {recursive:true,force:true}))) })
const git = (cwd, args) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } })
async function fixture(mode = "success", managed = false) {
  const root = await mkdtemp(path.join(os.tmpdir(), "deploy-adapter-test-"))
  roots.push(root)
  const engineDirectory = path.join(root, "engine"), input = path.join(root, "input")
  await mkdir(path.join(engineDirectory, "deployment"), { recursive: true })
  await mkdir(input)
  await writeFile(path.join(input, "index.md"), "# Reviewed snapshot\r\n")
  await writeFile(path.join(input, "image.png"), Buffer.from([0, 255, 0, 128, 10]))
  const workflow = "name: Reviewed workflow fixture\n"
  const buildScript = "// reviewed generic Quartz runner\n"
  await writeFile(path.join(engineDirectory, "deployment/quartz-build.mjs"), buildScript)
  await writeFile(path.join(engineDirectory, "deployment/github-pages.yml"), workflow)
  if (managed) {
    await mkdir(path.join(engineDirectory, ".github/workflows"), { recursive: true })
    await mkdir(path.join(engineDirectory, ".github/scripts"), { recursive: true })
    await mkdir(path.join(engineDirectory, "garden"))
    await writeFile(path.join(engineDirectory, ".github/workflows/exograph-publish.yml"), workflow)
    await writeFile(path.join(engineDirectory, ".github/scripts/exograph-quartz-build.mjs"), buildScript)
    await writeFile(path.join(engineDirectory, "exograph-site.json"), JSON.stringify({ schemaVersion: 1, repository: "owner/site", contentDirectory: "garden" }))
    await writeFile(path.join(engineDirectory, "theme.css"), "body { color: blue }")
    await writeFile(path.join(engineDirectory, ".gitattributes"), "* text=auto eol=lf\n")
    await writeFile(path.join(engineDirectory, "garden/removed.md"), "old public content")
  }
  git(engineDirectory, ["init", "--quiet"])
  git(engineDirectory, ["add", "."])
  git(engineDirectory, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "commit", "--quiet", "-m", "fixture"])
  let engineCommit = git(engineDirectory, ["rev-parse", "HEAD"]).trim()
  const remote = path.join(root, "remote.git")
  git(root, ["init", "--bare", "--quiet", remote])
  git(engineDirectory, ["push", remote, "HEAD:refs/heads/main"])
  if (managed) git(engineDirectory, ["update-ref", "refs/exograph/main", engineCommit])
  let privateCommit
  if (managed) {
    await writeFile(path.join(engineDirectory, "private-history.txt"), "DO-NOT-UPLOAD-HISTORY")
    git(engineDirectory, ["add", "."])
    git(engineDirectory, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "commit", "--quiet", "-m", "local history only"])
    privateCommit = git(engineDirectory, ["rev-parse", "HEAD"]).trim()
    await rm(path.join(engineDirectory, "private-history.txt"))
    await writeFile(path.join(engineDirectory, "theme.css"), "body { color: green }")
    git(engineDirectory, ["add", "--all"])
    git(engineDirectory, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "commit", "--quiet", "-m", "reviewed theme"])
    engineCommit = git(engineDirectory, ["rev-parse", "HEAD"]).trim()
  }
  const themeFiles = managed ? git(engineDirectory, ["ls-tree", "-r", "--name-only", "HEAD"]).trim().split("\n").filter(name => !name.startsWith("garden/")) : []
  const options = { repository: "owner/site", engineRepository: "owner/engine", workflowPath: path.join(engineDirectory,"deployment/github-pages.yml"), buildScriptPath: path.join(engineDirectory,"deployment/quartz-build.mjs"), input, engineDirectory, engineCommit, siteUrl: "https://example.com", snapshotHash: snapshotHash(await snapshotFiles(input)) }
  const calls = []
  let snapshotCommit, clock = 0, lists = 0, statuses = 0
  async function run(file, args, cwd) {
    calls.push({ file, args })
    if (file === "git") {
      if (args.includes("push")) {
        snapshotCommit = git(cwd, ["rev-parse", "HEAD"]).trim()
        assert.deepEqual(git(cwd, ["ls-tree", "-r", "--name-only", "HEAD"]).trim().split("\n"), [...themeFiles, ...(await snapshotFiles(input)).map(f=>`garden/${f.path}`)].sort())
        const blob = execFileSync("git", ["show", "HEAD:garden/image.png"], { cwd })
        assert.deepEqual(blob, await readFile(path.join(input, "image.png")))
        assert.deepEqual(execFileSync("git", ["show", "HEAD:garden/index.md"], {cwd}), await readFile(path.join(input, "index.md")))
        assert.equal(args.at(-1), "HEAD:refs/heads/publication")
        if (mode === "concurrent") {
          const concurrent = git(remote, ["-c", "user.name=Other", "-c", "user.email=other@example.com", "commit-tree", "main^{tree}", "-p", "main", "-m", "Concurrent publication"]).trim()
          git(remote, ["update-ref", "refs/heads/publication", concurrent])
        }
        git(cwd, ["push", remote, "HEAD:refs/heads/publication"])
        return ""
      }
      if (args.includes("ls-remote") || args.includes("fetch")) return git(cwd, args.map(value => value === "https://github.com/owner/site.git" ? remote : value))
      return git(cwd, args)
    }
    assert.equal(file, "gh")
    if (args[0] === "workflow") {
      assert.ok(args.includes(`snapshot_commit=${snapshotCommit}`))
      assert.ok(args.includes(`engine_commit=${engineCommit}`))
      if (managed) assert.equal(args.some(arg => arg.startsWith("engine_repository=")), false)
      return ""
    }
    if (args[0] === "run") {
      assert.equal(args[2], "42", "never download an unrelated latest run")
      const dir = args[args.indexOf("--dir") + 1]
      await writeFile(path.join(dir, "deployment.json"), JSON.stringify({ snapshotCommit, engineCommit, runId: "42", deploymentUrl: mode === "wrong-receipt" ? "https://other.example" : "https://example.com/" }))
      return ""
    }
    const endpoint = args[1]
    if (endpoint === "repos/owner/site/actions/workflows/exograph-publish.yml") {
      if (mode === "missing") throw Object.assign(new Error("Missing"), { notFound: true })
      return JSON.stringify({ id: 7, state: "active" })
    }
    if (endpoint.includes("/contents/.github/scripts/")) return JSON.stringify({ type:"file",encoding:"base64",content:Buffer.from(mode === "wrong-runner" ? "unreviewed" : buildScript).toString("base64") })
    if (endpoint.includes("/contents/")) return JSON.stringify({ type: "file", encoding: "base64", content: Buffer.from(mode === "wrong-workflow" ? "other" : workflow).toString("base64") })
    if (managed && endpoint.includes("/commits/")) throw new Error("Managed publishing must not require a remote engine commit")
    if (endpoint.includes("/commits/")) return JSON.stringify({ sha: engineCommit })
    if (endpoint.includes("/workflows/7/runs?")) {
      lists++
      const unrelated = { id: 999, display_title: "Another user's deployment", event: "workflow_dispatch", head_branch: "main" }
      return JSON.stringify({ workflow_runs: lists === 1 ? [unrelated] : [unrelated, { id: 42, display_title: `Publish ${snapshotCommit} with ${engineCommit}`, event: "workflow_dispatch", head_branch: "main" }] })
    }
    if (endpoint.endsWith("/runs/42")) {
      statuses++
      return JSON.stringify(statuses === 1 ? { status: "in_progress" } : { status: "completed", conclusion: mode === "failed-run" ? "failure" : "success" })
    }
    throw new Error(`Unexpected fake command: ${args.join(" ")}`)
  }
  return { options, calls, remote, root, privateCommit, dependencies: { run, now: () => clock, sleep: async ms => { clock += ms } } }
}

test("missing or changed workflow blocks before snapshot upload", async () => {
  for (const mode of ["missing", "wrong-workflow", "wrong-runner"]) for (const managed of [false, true]) {
    const f = await fixture(mode, managed)
    const result = await deploySnapshot(f.options, f.dependencies)
    assert.equal(result.status, "setup-required")
    assert.equal(f.calls.some(call => call.args.includes("push") || call.args[0] === "workflow"), false)
  }
})

test("changed input and dirty engine fail before remote calls", async () => {
  const f = await fixture()
  await writeFile(path.join(f.options.input, "extra.md"), "not reviewed")
  await assert.rejects(deploySnapshot(f.options, f.dependencies), /snapshot changed/)
  assert.equal(f.calls.some(call => call.file === "gh"), false)
  const dirty = await fixture()
  await writeFile(path.join(dirty.options.engineDirectory, "unreviewed"), "change")
  await assert.rejects(deploySnapshot(dirty.options, dirty.dependencies), /uncommitted changes/)
  assert.equal(dirty.calls.some(call => call.file === "gh"), false)
})

test("only sanitized incremental snapshot is uploaded, exact run and deployment receipt establish success", async () => {
  const f = await fixture()
  const result = await deploySnapshot(f.options, f.dependencies)
  assert.equal(result.status, "deployed")
  assert.equal(result.runId, "42")
  assert.equal(result.deploymentUrl, "https://example.com/")
  assert.equal(result.engineCommit, f.options.engineCommit)
  assert.equal(f.calls.filter(call => call.args.includes("push")).length, 1)
  assert.ok(f.calls.find(call => call.args.includes("fetch")).args.includes("--depth=1"))
})

test("failed run or mismatched receipt cannot report deployment success", async () => {
  for (const mode of ["failed-run", "wrong-receipt"]) {
    const f = await fixture(mode)
    await assert.rejects(deploySnapshot(f.options, f.dependencies), /without success|receipt does not match/)
  }
})

test("snapshot digest uses globally sorted paths rather than directory traversal order", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "snapshot-order-"))
  await mkdir(path.join(root, "a"))
  await writeFile(path.join(root, "a/b.md"), "nested")
  await writeFile(path.join(root, "a.md"), "sibling")
  assert.deepEqual((await snapshotFiles(root)).map(file => file.path), ["a.md", "a/b.md"])
})


test("successive publications advance one branch, preserve parent history, and remove stale content", async () => {
  const f = await fixture()
  await writeFile(path.join(f.options.input, "old.md"), "removed next time")
  f.options.snapshotHash = snapshotHash(await snapshotFiles(f.options.input))
  const first = await deploySnapshot(f.options, f.dependencies)
  assert.equal(git(f.remote, ["rev-parse", `${first.snapshotCommit}^`]).trim(), f.options.engineCommit)
  await rm(path.join(f.options.input, "old.md"))
  await writeFile(path.join(f.options.input, "index.md"), "# Updated")
  f.options.snapshotHash = snapshotHash(await snapshotFiles(f.options.input))
  const second = await deploySnapshot(f.options, f.dependencies)
  assert.equal(git(f.remote, ["rev-parse", `${second.snapshotCommit}^`]).trim(), first.snapshotCommit)
  assert.equal(git(f.remote, ["show-ref", "--heads"]).trim().split("\n").length, 2)
  assert.deepEqual(git(f.remote, ["ls-tree", "-r", "--name-only", "publication"]).trim().split("\n"), ["garden/image.png", "garden/index.md"])
  assert.equal(git(f.remote, ["show", "publication:garden/index.md"]), "# Updated")
})


test("a concurrent publication rejects the ordinary push without dispatch or force", async () => {
  for (const managed of [false, true]) {
  const f = await fixture("concurrent", managed)
  await assert.rejects(deploySnapshot(f.options, f.dependencies), /rejected|failed to push/)
  assert.equal(f.calls.some(call => call.file === "gh" && call.args[0] === "workflow"), false)
  assert.equal(git(f.remote, ["log", "-1", "--format=%s", "publication"]).trim(), "Concurrent publication")
  assert.equal(f.calls.some(call => call.args.includes("--force") && call.args.includes("push")), false)
  }
})


test("managed publication preserves reviewed theme, replaces garden, and never uploads local source history", async () => {
  const f = await fixture("success", true)
  const first = await deploySnapshot(f.options, f.dependencies)
  assert.equal(first.engineCommit, f.options.engineCommit)
  const checkedOut = path.join(f.root, "workflow-checkout")
  git(f.root, ["clone", "--quiet", "--branch", "publication", f.remote, checkedOut])
  await writeFile(path.join(checkedOut, "garden/index.md"), "simulated checkout filter mutation")
  const workflow = await readFile(new URL("../resources/publishing/managed-github-pages.yml", import.meta.url), "utf8")
  const materializer = workflow.split("node <<'NODE'\n")[1].split("          NODE")[0].split("\n").map(line => line.replace(/^          /, "")).join("\n")
  execFileSync(process.execPath, ["-e", materializer], {cwd: checkedOut})
  assert.deepEqual(await readFile(path.join(checkedOut, "garden/index.md")), await readFile(path.join(f.options.input, "index.md")))

  assert.equal(git(f.remote, ["show", "publication:theme.css"]), "body { color: green }")
  assert.equal(git(f.remote, ["show", "publication:.github/scripts/exograph-quartz-build.mjs"]), "// reviewed generic Quartz runner\n")
  assert.throws(() => git(f.remote, ["cat-file", "-e", `${first.snapshotCommit}:garden/removed.md`]))
  assert.throws(() => git(f.remote, ["cat-file", "-e", f.privateCommit]))
  assert.throws(() => git(f.remote, ["cat-file", "-e", f.options.engineCommit]))
  await rm(path.join(f.options.input, "image.png"))
  f.options.snapshotHash = snapshotHash(await snapshotFiles(f.options.input))
  // The shared fixture checks binary identity when present.
  const run = f.dependencies.run
  f.dependencies.run = async (file, args, cwd) => {
    if (file === "git" && args.includes("push")) {
      git(cwd, ["push", f.remote, "HEAD:refs/heads/publication"])
      return ""
    }
    return run(file, args, cwd)
  }
  // Stop at push to inspect the second exact tree, without reusing first-run fake receipts.
  f.dependencies.run = ((original) => async (file, args, cwd) => {
    if (file === "gh" && args[0] === "workflow") throw new Error("inspection complete")
    return original(file, args, cwd)
  })(f.dependencies.run)
  await assert.rejects(deploySnapshot(f.options, f.dependencies), /inspection complete/)
  assert.equal(git(f.remote, ["rev-parse", "publication^"]).trim(), first.snapshotCommit)
  assert.equal(git(f.remote, ["show", "publication:theme.css"]), "body { color: green }")
  assert.throws(() => git(f.remote, ["cat-file", "-e", "publication:garden/image.png"]))
})


test("managed publishers reject remote advancement before fetch instead of reverting its theme", async () => {
  const f = await fixture("success", true)
  const first = await deploySnapshot(f.options, f.dependencies)
  const advanced = git(f.remote, ["-c", "user.name=Other", "-c", "user.email=other@example.com", "commit-tree", "publication^{tree}", "-p", "publication", "-m", "Remote theme update"]).trim()
  git(f.remote, ["update-ref", "refs/heads/publication", advanced])
  git(f.options.engineDirectory, ["fetch", f.remote, "refs/heads/publication:refs/remotes/origin/publication"])
  f.calls.length = 0
  await assert.rejects(deploySnapshot(f.options, f.dependencies), /changed elsewhere/)
  assert.equal(f.calls.some(call => call.args.includes("push") || call.args[0] === "workflow"), false)
  assert.equal(git(f.options.engineDirectory, ["rev-parse", "refs/exograph/publication"]).trim(), first.snapshotCommit)
})


test("managed publishers reject advancement between remote inspection and fetch", async () => {
  const f = await fixture("success", true)
  const original = f.dependencies.run
  f.dependencies.run = async (file, args, cwd) => {
    if (file === "git" && args.includes("fetch") && args.includes("https://github.com/owner/site.git")) {
      const advanced = git(f.remote, ["-c", "user.name=Other", "-c", "user.email=other@example.com", "commit-tree", "main^{tree}", "-p", "main", "-m", "Concurrent theme"]).trim()
      git(f.remote, ["update-ref", "refs/heads/main", advanced])
    }
    return original(file, args, cwd)
  }
  await assert.rejects(deploySnapshot(f.options, f.dependencies), /changed while preparing/)
  assert.equal(f.calls.some(call => call.args.includes("push") || call.args[0] === "workflow"), false)
})
