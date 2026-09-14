import { chmod, mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createDefaultClaudeAgentCommand, createDefaultCodexAgentCommand } from "@exograph/core";

import { bindResolvedExecutable, executableToken, inspectAgentCommandLaunchFacts } from "./agent-command-launch-facts";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("agent command launch facts", () => {
  it("resolves an executable without running the configured command", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "exograph-command-facts-"));
    temporaryRoots.push(root);
    const bin = path.join(root, "bin");
    const executable = path.join(bin, "fake-agent");
    await mkdir(bin);
    await writeFile(executable, "#!/bin/sh\nexit 0\n");
    await chmod(executable, 0o755);

    const facts = await inspectAgentCommandLaunchFacts(
      { ...createDefaultClaudeAgentCommand(), id: "fake", handle: "fake", label: "Fake", command: "fake-agent --flag" },
      { kind: "cli", workspaceRoot: root },
      { PATH: bin },
    );

    expect(facts).toMatchObject({
      cwd: root,
      cwdReady: true,
      executable: "fake-agent",
      executablePath: await realpath(executable),
      executableReady: true,
      launchable: true,
    });
  });

  it("reports independent cwd and executable launch gates", async () => {
    const facts = await inspectAgentCommandLaunchFacts(
      { ...createDefaultClaudeAgentCommand(), command: "missing-agent" },
      { kind: "cli", workspaceRoot: "/definitely/missing/exograph-workspace" },
      { PATH: "" },
    );
    expect(facts).toMatchObject({ cwdReady: false, executableReady: false, launchable: false, block: "cwd-missing" });
  });

  it("explains when a customized Codex command cannot run outside Git", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "exograph-command-facts-"));
    temporaryRoots.push(root);
    const bin = path.join(root, "bin");
    await mkdir(bin);
    await writeFile(path.join(bin, "codex"), "#!/bin/sh\nexit 0\n");
    await chmod(path.join(bin, "codex"), 0o755);

    const facts = await inspectAgentCommandLaunchFacts(
      { ...createDefaultCodexAgentCommand(), command: "codex exec -", version: 3 },
      { kind: "cli", workspaceRoot: root },
      { PATH: bin },
    );

    expect(facts).toMatchObject({ launchable: false, block: "workspace-not-git" });
    expect(facts.detail).toContain("--skip-git-repo-check");
  });

  it("finds a user-installed command from a minimal packaged-app PATH", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "exograph-command-facts-"));
    temporaryRoots.push(root);
    const localBin = path.join(root, ".local", "bin");
    const executable = path.join(localBin, "claude");
    await mkdir(localBin, { recursive: true });
    await writeFile(executable, "#!/bin/sh\nexit 0\n");
    await chmod(executable, 0o755);

    const facts = await inspectAgentCommandLaunchFacts(
      createDefaultClaudeAgentCommand(),
      { kind: "cli", workspaceRoot: root },
      { HOME: root, PATH: "/usr/bin:/bin" },
    );

    expect(facts).toMatchObject({ executablePath: await realpath(executable), executableReady: true, launchable: true });
  });

  it("extracts quoted executable tokens without interpreting the shell command", () => {
    expect(executableToken("'/Applications/Fake Agent/bin/fake' --test")).toBe("/Applications/Fake Agent/bin/fake");
    expect(executableToken("fake\\ agent --test")).toBe("fake agent");
  });

  it("changes the launch fingerprint when a resolved executable is replaced in place", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "exograph-command-facts-"));
    temporaryRoots.push(root);
    const executable = path.join(root, "agent");
    await writeFile(executable, "#!/bin/sh\nprintf first\n");
    await chmod(executable, 0o755);
    const command = { ...createDefaultClaudeAgentCommand(), command: executable };

    const before = await inspectAgentCommandLaunchFacts(command, { kind: "cli", workspaceRoot: root }, { PATH: "" });
    await writeFile(executable, "#!/bin/sh\nprintf second\n");
    const after = await inspectAgentCommandLaunchFacts(command, { kind: "cli", workspaceRoot: root }, { PATH: "" });

    expect(before.launchable).toBe(true);
    expect(after.launchable).toBe(true);
    expect(after.fingerprint).not.toBe(before.fingerprint);
  });

  it("binds the resolved executable path so a later PATH shadow cannot change the process launched", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "exograph-command-facts-"));
    temporaryRoots.push(root);
    const first = path.join(root, "first-agent");
    const second = path.join(root, "second-agent");
    await writeFile(first, "#!/bin/sh\nexit 0\n");
    await writeFile(second, "#!/bin/sh\nexit 0\n");
    await Promise.all([chmod(first, 0o755), chmod(second, 0o755)]);

    expect(bindResolvedExecutable("agent --flag", await realpath(first))).toBe(`'${await realpath(first)}' --flag`);
    expect(bindResolvedExecutable("'agent' --flag", await realpath(second))).toBe(`'${await realpath(second)}' --flag`);
  });
});
