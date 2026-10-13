import { describe, expect, it } from "vitest";
import { GitHubSyncProvider, repositoryName } from "./github-sync-provider";
const repo = (name: string) => ({ id: 1, full_name: `writer/${name}`, clone_url: `https://github.com/writer/${name}.git`, private: true, permissions: { push: true }, default_branch: "writing", size: 1 });
describe("GitHub repository discovery", () => {
  it("searches later pages before reporting no matches", async () => {
    const calls: string[][] = [];
    const provider = new GitHubSyncProvider("/unused", async args => { calls.push(args); return JSON.stringify(calls.length === 1 ? Array.from({ length: 100 }, (_, i) => repo(`other-${i}`)) : [repo("older-notes")]); });
    expect((await provider.list("older-notes", 1)).repositories.map(r => r.nameWithOwner)).toEqual(["writer/older-notes"]);
    expect(calls[1]![0]).toContain("page=2");
  });
  it("reports public and read-only destinations without changing their visibility", async () => {
    const calls: string[][] = [];
    const provider = new GitHubSyncProvider("/unused", async args => { calls.push(args); return JSON.stringify(calls.length === 1 ? { ...repo("notes"), private: false, permissions: { push: false } } : []); });
    expect(await provider.inspect("https://github.com/writer/notes.git")).toMatchObject({ isPrivate: false, writable: false, empty: true });
    expect(calls.every(args => !args.includes("POST") && !args.includes("PATCH"))).toBe(true);
  });
  it("creates only a private repository at the explicitly approved owner/name", async () => {
    const created: string[] = [];
    const provider = new GitHubSyncProvider("/unused", async args => JSON.stringify(args[0]!.endsWith("matching-refs/heads") ? [] : repo("notes")), async name => { created.push(name); });
    await provider.create("writer/notes"); expect(created).toEqual(["writer/notes"]);
  });
  it("rejects credential-bearing and non-GitHub URLs", () => {
    expect(() => repositoryName("https://token@github.com/writer/notes")).toThrow();
    expect(() => repositoryName("https://elsewhere.invalid/writer/notes")).toThrow();
  });
});
