import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { GitHubDownload, GitHubRepositoryPicker } from "./GitHubRepositoryPicker";
import type { GitHubSyncRepositoryInfo } from "../../../shared/api";

const repository: GitHubSyncRepositoryInfo = { nameWithOwner: "author/notes", url: "https://github.com/author/notes", defaultBranch: "main", isPrivate: true, writable: true, empty: false };
let rendered: ReactTestRenderer | undefined;
const downloadRepository = vi.fn(), onDownloaded = vi.fn(), getAccountStatus = vi.fn(), listRepositories = vi.fn(), inspectRepository = vi.fn();
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  downloadRepository.mockReset().mockResolvedValue({ directory: "/downloads/notes", repository });
  onDownloaded.mockReset(); getAccountStatus.mockReset().mockResolvedValue({ authenticated: false }); listRepositories.mockReset(); inspectRepository.mockReset();
  vi.stubGlobal("window", { setTimeout, clearTimeout, exograph: { githubSync: { getAccountStatus, downloadRepository, listRepositories, inspectRepository, onSetupProgress: () => () => {} } } });
});
afterEach(async () => { if (rendered) await act(async () => rendered!.unmount()); rendered = undefined; vi.unstubAllGlobals(); });

it("retries opening the completed download without cloning again after workspace setup fails", async () => {
  onDownloaded.mockRejectedValueOnce(new Error("Workspace has unsaved conflicts.")).mockResolvedValue(undefined);
  await act(async () => { rendered = create(<GitHubDownload onClose={() => {}} onDownloaded={onDownloaded} />); });
  await act(async () => rendered!.root.findByType(GitHubRepositoryPicker).props.onSelect(repository));
  const submit = () => rendered!.root.findByProps({ "data-testid": "github-download-submit" });
  await act(async () => submit().props.onClick());
  expect(JSON.stringify(rendered!.toJSON())).toContain("Workspace has unsaved conflicts.");
  expect(submit().children).toEqual(["Open downloaded notes"]);
  await act(async () => submit().props.onClick());
  expect(downloadRepository).toHaveBeenCalledTimes(1);
  expect(onDownloaded).toHaveBeenNthCalledWith(2, "/downloads/notes");
});

it("stays in the download choice when the native folder picker is cancelled", async () => {
  downloadRepository.mockResolvedValue(null);
  await act(async () => { rendered = create(<GitHubDownload onClose={() => {}} onDownloaded={onDownloaded} />); });
  await act(async () => rendered!.root.findByType(GitHubRepositoryPicker).props.onSelect(repository));
  await act(async () => rendered!.root.findByProps({ "data-testid": "github-download-submit" }).props.onClick());
  expect(onDownloaded).not.toHaveBeenCalled();
  expect(rendered!.root.findByProps({ "data-testid": "github-download-submit" }).children).toEqual(["Download notes"]);
});

it("keeps public and read-only repository rows unavailable", async () => {
  getAccountStatus.mockResolvedValue({ authenticated: true, login: "author" });
  listRepositories.mockResolvedValue({ repositories: [repository, { ...repository, nameWithOwner: "author/public", isPrivate: false }, { ...repository, nameWithOwner: "other/read-only", writable: false }] });
  await act(async () => { rendered = create(<GitHubRepositoryPicker onSelect={() => {}} />); });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); });
  const rows = rendered!.root.findAllByProps({ className: "github-repository-option" });
  expect(rows.map(row => row.props.disabled)).toEqual([false, true, true]);
});
