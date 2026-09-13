import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { readFile, mkdir, mkdtemp, copyFile, rm } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import path from "node:path"
import os from "node:os"
import { snapshotFiles, snapshotHash, sha256 } from "./snapshot.mjs"

const exec = promisify(execFile)
async function command(file, args, cwd) {
  try {
    const result = await exec(file, args, { cwd, maxBuffer: 8 * 1024 * 1024, timeout: 60000, env: { ...process.env, GH_PROMPT_DISABLED: "1", GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } })
    return result.stdout
  } catch (error) {
    const failure = new Error(`${file} command failed. ${String(error.stderr ?? "").trim().slice(-2000)}`)
    failure.notFound = /HTTP 404|\(404\)/.test(error.stderr ?? "")
    throw failure
  }
}
const setup = message => ({ ok: false, status: "setup-required", message })
const sameUrl = (a, b) => new URL(a).href.replace(/\/$/, "") === new URL(b).href.replace(/\/$/, "")

export async function deploySnapshot(options, dependencies = {}) {
  const run = dependencies.run ?? command
  const sleep = dependencies.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)))
  const now = dependencies.now ?? Date.now
  const engine = options.engineDirectory
  const git = (args, cwd = engine) => run("git", args, cwd)
  const gh = args => run("gh", args, engine)
  const api = async endpoint => JSON.parse(await gh(["api", endpoint]))
  const profile = { repository: options.repository, engineRepository: options.engineRepository, workflow: "exograph-publish.yml", workflowRef: "main", siteUrl: options.siteUrl }
  const repositoryName = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
  if (!repositoryName.test(profile.repository ?? "") || !repositoryName.test(profile.engineRepository ?? "")) throw new Error("Choose GitHub repositories in owner/repository format")
  if (!/^[0-9a-f]{40}$/.test(options.engineCommit) || !/^[0-9a-f]{64}$/.test(options.snapshotHash)) throw new Error("Expected immutable engine commit and snapshot SHA-256")
  const url = new URL(options.siteUrl)
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error("Use an HTTPS site URL without credentials, query, or fragment")
  const revision = (await git(["rev-parse", "HEAD"])).trim()
  if (revision !== options.engineCommit) throw new Error("Engine revision changed; prepare and review a new preview")
  if ((await git(["status", "--porcelain", "--untracked-files=all"])).trim()) throw new Error("Engine has uncommitted changes; commit and review it before publishing")
  const files = await snapshotFiles(options.input)
  if (!files.length || snapshotHash(files) !== options.snapshotHash) throw new Error("Publication snapshot changed; prepare a new preview")
  const expectedWorkflow = await readFile(options.workflowPath)
  const expectedBuildScript = await readFile(options.buildScriptPath)
  let workflow
  async function installedWorkflow() {
    const content = await api(`repos/${profile.repository}/contents/.github/workflows/${profile.workflow}?ref=${encodeURIComponent(profile.workflowRef)}`)
    if (content.type !== "file" || content.encoding !== "base64" || sha256(Buffer.from(content.content, "base64")) !== sha256(expectedWorkflow)) return false
    const buildScript = await api(`repos/${profile.repository}/contents/.github/scripts/exograph-quartz-build.mjs?ref=${encodeURIComponent(profile.workflowRef)}`)
    return buildScript.type === "file" && buildScript.encoding === "base64" && sha256(Buffer.from(buildScript.content, "base64")) === sha256(expectedBuildScript)
  }
  try {
    workflow = await api(`repos/${profile.repository}/actions/workflows/${profile.workflow}`)
    if (workflow.state !== "active" || !(await installedWorkflow())) return setup("Install the reviewed Exograph publishing workflow before publishing. No snapshot has been uploaded.")
    const remoteEngine = await api(`repos/${profile.engineRepository}/commits/${options.engineCommit}`)
    if (remoteEngine.sha !== options.engineCommit) return setup("Push the reviewed engine commit to its configured repository before publishing. No snapshot has been uploaded.")
  } catch (error) {
    if (error.notFound) return setup("The publishing workflow or reviewed engine commit is not installed. No snapshot has been uploaded.")
    throw error
  }
  const temporary = await mkdtemp(path.join(os.tmpdir(), "exograph-deploy-"))
  let snapshotCommit, runId
  try {
    // Fetch only destination history. The user's vault repository is never opened.
    const branch = "publication"
    const remote = `https://github.com/${profile.repository}.git`
    const credentials = ["-c", "credential.helper=", "-c", "credential.helper=!gh auth git-credential"]
    await git(["init", "--quiet"], temporary)
    const remoteBranch = (await git([...credentials, "ls-remote", "--heads", remote, `refs/heads/${branch}`], temporary)).trim()
    const baseBranch = remoteBranch ? branch : profile.workflowRef
    await git([...credentials, "fetch", "--quiet", "--depth=1", "--no-tags", remote, `refs/heads/${baseBranch}`], temporary)
    await git(["symbolic-ref", "HEAD", `refs/heads/${branch}`], temporary)
    await git(["update-ref", `refs/heads/${branch}`, "FETCH_HEAD"], temporary)
    // Replace the tree, not its history; removed publication files cannot survive.
    await git(["read-tree", "--empty"], temporary)
    const publication = path.join(temporary, "garden")
    for (const file of files) {
      const target = path.join(publication, file.path)
      await mkdir(path.dirname(target), { recursive: true })
      await copyFile(path.join(options.input, file.path), target)
    }
    if (snapshotHash(await snapshotFiles(publication)) !== options.snapshotHash || snapshotHash(await snapshotFiles(options.input)) !== options.snapshotHash) throw new Error("Snapshot changed while preparing deployment; nothing was uploaded")
    await git(["-c", "core.autocrlf=false", "add", "--force", "--all", "--", "garden"], temporary)
    await git(["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-c", "user.name=Exograph Publishing", "-c", "user.email=publishing@exograph.local", "commit", "--quiet", "--allow-empty", "-m", `Publish reviewed snapshot ${options.snapshotHash}\n\nRequest: ${randomUUID()}`], temporary)
    snapshotCommit = (await git(["rev-parse", "HEAD"], temporary)).trim()
    const tree = (await git(["ls-tree", "-r", "--name-only", "-z", "HEAD"], temporary)).split("\0").filter(Boolean).sort()
    if (JSON.stringify(tree) !== JSON.stringify(files.map(file => `garden/${file.path}`).sort())) throw new Error("Deployment commit does not match the reviewed file inventory")
    // Recheck authority before a normal fast-forward push. Concurrent publishers
    // cause a rejected push, never a force update or an automatic retry.
    if ((await git(["rev-parse", "HEAD"])).trim() !== options.engineCommit || (await git(["status", "--porcelain", "--untracked-files=all"])).trim()) throw new Error("Engine changed while preparing deployment")
    if (!(await installedWorkflow())) return setup("The deployment workflow changed. Review setup again before publishing; nothing was uploaded.")
    await git(["-c", "credential.helper=", "-c", "credential.helper=!gh auth git-credential", "push", `https://github.com/${profile.repository}.git`, `HEAD:refs/heads/${branch}`], temporary)
    await gh(["workflow", "run", profile.workflow, "--repo", profile.repository, "--ref", profile.workflowRef, "-f", `snapshot_commit=${snapshotCommit}`, "-f", `engine_commit=${options.engineCommit}`, "-f", `engine_repository=${profile.engineRepository}`, "-f", `site_url=${url.href}`])
    const title = `Publish ${snapshotCommit} with ${options.engineCommit}`
    const deadline = now() + 20 * 60 * 1000
    while (now() < deadline) {
      if (!runId) {
        const response = await api(`repos/${profile.repository}/actions/workflows/${workflow.id}/runs?event=workflow_dispatch&branch=${encodeURIComponent(profile.workflowRef)}&per_page=100`)
        const matches = response.workflow_runs.filter(candidate => candidate.display_title === title && candidate.event === "workflow_dispatch" && candidate.head_branch === profile.workflowRef)
        if (matches.length > 1) throw new Error("Multiple matching deployment runs found; inspect GitHub before retrying")
        if (matches[0]) runId = String(matches[0].id)
      }
      if (runId) {
        const status = await api(`repos/${profile.repository}/actions/runs/${runId}`)
        if (status.status === "completed") {
          if (status.conclusion !== "success") throw new Error(`Deployment run ${runId} finished without success`)
          const receiptDirectory = path.join(temporary, "result")
          await mkdir(receiptDirectory)
          await gh(["run", "download", runId, "--repo", profile.repository, "--name", "exograph-deployment", "--dir", receiptDirectory])
          const receipt = JSON.parse(await readFile(path.join(receiptDirectory, "deployment.json"), "utf8"))
          if (receipt.snapshotCommit !== snapshotCommit || receipt.engineCommit !== options.engineCommit || String(receipt.runId) !== runId || !sameUrl(receipt.deploymentUrl, profile.siteUrl)) throw new Error("Deployment receipt does not match the reviewed snapshot, engine, and destination")
          return { ok: true, status: "deployed", deploymentUrl: receipt.deploymentUrl, snapshotCommit, engineCommit: options.engineCommit, runId }
        }
      }
      await sleep(2000)
    }
    throw new Error("Stopped waiting for deployment; the dispatched workflow may still finish. Check GitHub before retrying")
  } catch (error) {
    if (snapshotCommit) { error.snapshotCommit = snapshotCommit; error.runId = runId }
    throw error
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}
