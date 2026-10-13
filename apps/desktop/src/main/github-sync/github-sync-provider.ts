import os from "node:os";
import type { GitHubSyncRepositoryInfo } from "../../shared/api";
import { resolveGitHubCli } from "../publishing/github-cli";
import { githubRepository, runSyncCommand } from "./git-sync-repository";

export interface SyncAccount { login: string; id: number; name?: string }
export interface SyncRepositoryProvider {
  account(): Promise<SyncAccount>;
  list(query: string, page: number): Promise<{ repositories: GitHubSyncRepositoryInfo[]; nextPage?: number }>;
  inspect(repository: string): Promise<GitHubSyncRepositoryInfo>;
  create(repository: string): Promise<GitHubSyncRepositoryInfo>;
  gitArgs(): Promise<string[]>;
}
export function repositoryName(input: string): string {
  const value = input.trim();
  if (/^[\w.-]+\/[\w.-]+$/.test(value) && !value.split("/").some(p => p === "." || p === "..")) return value;
  return githubRepository(value);
}
type Repository = { id: number; full_name: string; clone_url: string; private: boolean; permissions?: { push?: boolean }; default_branch: string; size: number; empty?: boolean };
const info = (r: Repository): GitHubSyncRepositoryInfo => ({ id: r.id, nameWithOwner: r.full_name, url: r.clone_url, isPrivate: r.private, writable: r.permissions?.push === true, defaultBranch: r.default_branch || "main", empty: r.empty === true });
export class GitHubSyncProvider implements SyncRepositoryProvider {
  constructor(private readonly toolsRoot: string, private readonly request?: (args: string[]) => Promise<string>, private readonly createRepository?: (repository: string) => Promise<void>) {}
  private async api(args: string[]) {
    if (this.request) return JSON.parse(await this.request(args));
    const gh = await resolveGitHubCli(this.toolsRoot, undefined, { download: false });
    return JSON.parse(await runSyncCommand(gh, ["api", ...args], os.homedir()));
  }
  async account(): Promise<SyncAccount> { return this.api(["user"]); }
  async list(query: string, page: number) {
    // A search cursor advances over source pages until it finds matches or
    // exhausts them; an empty first page never claims an older repo is absent.
    for (;;) {
      const rows: Repository[] = await this.api([`user/repos?visibility=private&affiliation=owner,collaborator,organization_member&per_page=100&page=${page}&sort=updated`]);
      const repositories = rows.filter(r => r.private && r.permissions?.push && r.full_name.toLowerCase().includes(query.toLowerCase())).map(info);
      if (repositories.length || rows.length < 100 || !query) return { repositories, nextPage: rows.length === 100 ? page + 1 : undefined };
      page += 1;
    }
  }
  async inspect(repository: string): Promise<GitHubSyncRepositoryInfo> {
    const name = repositoryName(repository);
    const row: Repository = await this.api([`repos/${name}`]);
    let empty = false;
    try { await this.api([`repos/${name}/git/matching-refs/heads`]).then((refs: unknown[]) => { empty = refs.length === 0; }); }
    catch (error) { if (/409|Git Repository is empty/i.test(String(error))) empty = true; else throw error; }
    return info({ ...row, empty });
  }
  async create(repository: string) {
    const name = repositoryName(repository);
    if (this.createRepository) await this.createRepository(name);
    else {
      const gh = await resolveGitHubCli(this.toolsRoot, undefined, { download: false });
      await runSyncCommand(gh, ["repo", "create", name, "--private"], os.homedir());
    }
    const created = await this.inspect(name);
    if (created.nameWithOwner.toLowerCase() !== name.toLowerCase()) throw new Error("GitHub returned a different repository than the approved destination. Your notes were not uploaded.");
    return created;
  }

  async gitArgs(): Promise<string[]> {
    const gh = await resolveGitHubCli(this.toolsRoot, undefined, { download: false });
    return ["-c", "credential.helper=", "-c", `credential.helper=!'${gh.replace(/'/g, "'\"'\"'")}' auth git-credential`];
  }
}
