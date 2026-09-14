import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, readdir, readlink, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";

const sourceScript = fileURLToPath(new URL("./install-local", import.meta.url));
const sourceMacInstaller = fileURLToPath(new URL("./install-mac-app", import.meta.url));
const roots = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "exograph-install-local-"));
  roots.push(root);

  const repo = path.join(root, "repo");
  const scripts = path.join(repo, "scripts");
  const sourceBin = path.join(repo, "packages", "cli", "bin");
  const targetBin = path.join(root, "target-bin");
  const tools = path.join(root, "tools");
  await Promise.all([
    mkdir(scripts, { recursive: true }),
    mkdir(sourceBin, { recursive: true }),
    mkdir(targetBin, { recursive: true }),
    mkdir(tools, { recursive: true }),
  ]);

  const installer = path.join(scripts, "install-local");
  const macInstaller = path.join(scripts, "install-mac-app");
  const sourceLauncher = path.join(sourceBin, "exograph");
  const pnpm = path.join(tools, "pnpm");
  const uname = path.join(tools, "uname");
  await writeFile(installer, await readFile(sourceScript, "utf8"), "utf8");
  await writeFile(macInstaller, await readFile(sourceMacInstaller, "utf8"), "utf8");
  await writeFile(sourceLauncher, "#!/usr/bin/env bash\nexit 0\n", "utf8");
  await writeFile(pnpm, "#!/usr/bin/env bash\nexit 0\n", "utf8");
  await writeFile(
    uname,
    `#!/usr/bin/env bash
case "\${1:-}" in
  -s) printf 'Darwin\\n' ;;
  -m) printf 'arm64\\n' ;;
  *) printf 'Darwin\\n' ;;
esac
`,
    "utf8",
  );
  await Promise.all([
    chmod(installer, 0o755),
    chmod(macInstaller, 0o755),
    chmod(sourceLauncher, 0o755),
    chmod(pnpm, 0o755),
    chmod(uname, 0o755),
  ]);

  return {
    installer,
    macInstaller,
    pnpm,
    repo,
    sourceLauncher,
    targetBin,
    targetLauncher: path.join(targetBin, "exo"),
    tools,
  };
}

async function createPackagedApp(repo, architecture, marker) {
  const appContents = path.join(repo, "release", architecture, "Exograph.app", "Contents");
  await mkdir(appContents, { recursive: true });
  await writeFile(path.join(appContents, "marker"), marker, "utf8");
  return path.dirname(appContents);
}

function runInstaller(fixture, args, environment = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(fixture.installer, args, {
      env: {
        ...process.env,
        HOME: path.dirname(fixture.repo),
        PATH: `${fixture.tools}:${process.env.PATH}`,
        ...environment,
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      resolve({ code, signal, stderr, stdout });
    });
  });
}

test("skip-build refuses a missing CLI artifact before replacing an existing shim", async () => {
  const fixture = await createFixture();
  const priorLauncher = path.join(path.dirname(fixture.repo), "prior-exograph");
  await writeFile(priorLauncher, "packages/cli/dist/index.cjs\n", "utf8");
  await symlink(priorLauncher, fixture.targetLauncher);

  const result = await runInstaller(fixture, [
    "--skip-install",
    "--skip-build",
    "--bin-dir",
    fixture.targetBin,
  ]);

  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /packages\/cli\/dist\/index\.cjs/);
  assert.match(result.stderr, /build first|omit --skip-build/i);
  assert.equal(await readlink(fixture.targetLauncher), priorLauncher);
});

test("mac app install with CLI inherits the missing-artifact refusal", async () => {
  const fixture = await createFixture();
  const appSource = path.join(fixture.repo, "release", "mac-arm64", "Exograph.app", "Contents");
  const priorLauncher = path.join(path.dirname(fixture.repo), "prior-exograph");
  const defaultTargetLauncher = path.join(path.dirname(fixture.repo), ".local", "bin", "exo");
  await mkdir(appSource, { recursive: true });
  await mkdir(path.dirname(defaultTargetLauncher), { recursive: true });
  await writeFile(path.join(appSource, "marker"), "fixture app\n", "utf8");
  await writeFile(priorLauncher, "packages/cli/dist/index.cjs\n", "utf8");
  await symlink(priorLauncher, defaultTargetLauncher);

  const result = await runInstaller(
    { ...fixture, installer: fixture.macInstaller },
    [
      "--skip-build",
      "--with-cli",
      "--app-dir",
      path.join(path.dirname(fixture.repo), "Applications"),
    ],
  );

  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /Build it first.*omit --skip-build/i);
  assert.equal(await readlink(defaultTargetLauncher), priorLauncher);
});

test("mac app dry run remains non-mutating while reporting the CLI install handoff", async () => {
  const fixture = await createFixture();
  const appSource = path.join(fixture.repo, "release", "mac-arm64", "Exograph.app", "Contents");
  const appTarget = path.join(path.dirname(fixture.repo), "Applications", "Exograph.app");
  const priorLauncher = path.join(path.dirname(fixture.repo), "prior-exograph");
  const defaultTargetLauncher = path.join(path.dirname(fixture.repo), ".local", "bin", "exo");
  await mkdir(appSource, { recursive: true });
  await mkdir(appTarget, { recursive: true });
  await mkdir(path.dirname(defaultTargetLauncher), { recursive: true });
  await writeFile(path.join(appSource, "marker"), "new fixture app\n", "utf8");
  await writeFile(path.join(appTarget, "marker"), "installed fixture app\n", "utf8");
  await writeFile(priorLauncher, "packages/cli/dist/index.cjs\n", "utf8");
  await symlink(priorLauncher, defaultTargetLauncher);

  const result = await runInstaller(
    { ...fixture, installer: fixture.macInstaller },
    [
      "--dry-run",
      "--skip-build",
      "--with-cli",
      "--app-dir",
      path.dirname(appTarget),
    ],
  );

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /\[dry-run\].*scripts\/install-local.*--skip-install.*--skip-build/);
  assert.equal(await readFile(path.join(appTarget, "marker"), "utf8"), "installed fixture app\n");
  assert.equal(await readlink(defaultTargetLauncher), priorLauncher);
});

test("mac app install uses the bundle for the current architecture when multiple builds exist", async () => {
  const fixture = await createFixture();
  const appDir = path.join(path.dirname(fixture.repo), "Applications");
  await createPackagedApp(fixture.repo, "mac-arm64", "arm build\n");
  await createPackagedApp(fixture.repo, "mac-x64", "intel build\n");

  const result = await runInstaller(
    { ...fixture, installer: fixture.macInstaller },
    ["--skip-build", "--app-dir", appDir],
  );

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /release\/mac-arm64\/Exograph\.app/);
  assert.equal(await readFile(path.join(appDir, "Exograph.app", "Contents", "marker"), "utf8"), "arm build\n");
});

test("mac app install leaves a working app intact when staging the replacement fails", async () => {
  const fixture = await createFixture();
  const appDir = path.join(path.dirname(fixture.repo), "Applications");
  const installedContents = path.join(appDir, "Exograph.app", "Contents");
  await createPackagedApp(fixture.repo, "mac-arm64", "new build\n");
  await mkdir(installedContents, { recursive: true });
  await writeFile(path.join(installedContents, "marker"), "existing build\n", "utf8");
  await writeFile(path.join(fixture.tools, "cp"), "#!/usr/bin/env bash\nexit 1\n", "utf8");
  await chmod(path.join(fixture.tools, "cp"), 0o755);

  const result = await runInstaller(
    { ...fixture, installer: fixture.macInstaller },
    ["--skip-build", "--app-dir", appDir],
  );

  assert.notEqual(result.code, 0);
  assert.equal(await readFile(path.join(installedContents, "marker"), "utf8"), "existing build\n");
});

test("mac app install restores the previous app when interrupted after backup", async () => {
  const fixture = await createFixture();
  const appDir = path.join(path.dirname(fixture.repo), "Applications");
  const installedContents = path.join(appDir, "Exograph.app", "Contents");
  await createPackagedApp(fixture.repo, "mac-arm64", "new build\n");
  await mkdir(installedContents, { recursive: true });
  await writeFile(path.join(installedContents, "marker"), "existing build\n", "utf8");

  const result = await runInstaller(
    { ...fixture, installer: fixture.macInstaller },
    ["--skip-build", "--app-dir", appDir],
    { EXOGRAPH_TEST_INTERRUPT_AFTER_BACKUP: "1" },
  );

  assert.notEqual(result.code, 0);
  assert.equal(await readFile(path.join(installedContents, "marker"), "utf8"), "existing build\n");
  assert.deepEqual((await readdir(appDir)).filter((name) => name.startsWith(".Exograph.app.")), []);
});

test("mac app install rejects a stale bundle for another architecture", async () => {
  const fixture = await createFixture();
  await createPackagedApp(fixture.repo, "mac-x64", "intel build\n");

  const result = await runInstaller(
    { ...fixture, installer: fixture.macInstaller },
    ["--skip-build", "--app-dir", path.join(path.dirname(fixture.repo), "Applications")],
  );

  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /No packaged Exograph\.app found for mac-arm64/);
});

test("skip-build installs the repo-backed shim when the CLI artifact exists", async () => {
  const fixture = await createFixture();
  await mkdir(path.join(fixture.repo, "packages", "cli", "dist"), { recursive: true });
  await writeFile(
    path.join(fixture.repo, "packages", "cli", "dist", "index.cjs"),
    "#!/usr/bin/env node\n",
    "utf8",
  );

  const result = await runInstaller(fixture, [
    "--skip-install",
    "--skip-build",
    "--bin-dir",
    fixture.targetBin,
  ]);

  assert.equal(result.code, 0, result.stderr);
  assert.equal(await readlink(fixture.targetLauncher), fixture.sourceLauncher);
});

test("skip-build refuses an empty CLI artifact", async () => {
  const fixture = await createFixture();
  await mkdir(path.join(fixture.repo, "packages", "cli", "dist"), { recursive: true });
  await writeFile(path.join(fixture.repo, "packages", "cli", "dist", "index.cjs"), "", "utf8");

  const result = await runInstaller(fixture, [
    "--skip-install",
    "--skip-build",
    "--bin-dir",
    fixture.targetBin,
  ]);

  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /missing or empty/);
});

test("the normal build path creates the artifact before installing the shim", async () => {
  const fixture = await createFixture();
  await writeFile(
    fixture.pnpm,
    `#!/usr/bin/env bash
set -euo pipefail
if [[ " $* " == *" build "* ]]; then
  repo="$(cd "$(dirname "$0")/../repo" && pwd)"
  mkdir -p "$repo/packages/cli/dist"
  printf '#!/usr/bin/env node\\n' > "$repo/packages/cli/dist/index.cjs"
fi
`,
    "utf8",
  );

  const result = await runInstaller(fixture, [
    "--skip-install",
    "--bin-dir",
    fixture.targetBin,
  ]);

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /building Exograph/);
  assert.equal(await readlink(fixture.targetLauncher), fixture.sourceLauncher);
});

test("dry run reports the normal build and install without mutating files", async () => {
  const fixture = await createFixture();

  const result = await runInstaller(fixture, [
    "--skip-install",
    "--dry-run",
    "--bin-dir",
    fixture.targetBin,
  ]);

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /\[dry-run\].*pnpm.*build/);
  assert.match(result.stdout, /\[dry-run\].*ln.*-sfn/);
  await assert.rejects(readlink(fixture.targetLauncher), { code: "ENOENT" });
});
