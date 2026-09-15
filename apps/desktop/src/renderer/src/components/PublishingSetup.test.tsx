import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PublishingSetup } from "./PublishingSetup";
const setup = vi.fn(); const configured = vi.fn(); let mounted: ReactTestRenderer | undefined;
const scope = { workspaceRoot: "/notes", noteRoots: ["/notes"], publishing: { publicationDirectory: "/notes/garden", engineDirectory: "/old-theme", siteUrl: "https://example.com/", destinationRepository: "user/site" } };
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", { exograph: { publishing: { getSetupStatus: async () => ({ authenticated: true, managed: false, login: "user" }), setup } } });
  setup.mockReset(); configured.mockReset();
});
afterEach(async () => { if (mounted) await act(async () => mounted!.unmount()); mounted = undefined; vi.unstubAllGlobals(); });
it("imports the existing theme and configures the returned managed path only after explicit setup", async () => {
  setup.mockResolvedValue({ status: "ready", repository: "user/site", engineDirectory: "/managed/site", siteUrl: "https://example.com/" });
  await act(async () => { mounted = create(<PublishingSetup scope={scope} onConfigured={configured} onClose={() => {}} />); });
  expect(setup).not.toHaveBeenCalled();
  await act(async () => mounted!.root.findByProps({ "data-testid": "publishing-setup-submit" }).props.onClick());
  expect(setup).toHaveBeenCalledWith({ scope, publicationDirectory: "/notes/garden", repository: "user/site", createRepository: false, visibility: "public", siteUrl: "https://example.com/", themeDirectory: "/old-theme" });
  expect(configured).toHaveBeenCalledWith({ ...scope.publishing, engineDirectory: "/managed/site" });
});
it("keeps current configuration when setup fails and surfaces the actionable error", async () => {
  setup.mockResolvedValue({ status: "setup-required", message: "Repository contains uncommitted edits" });
  await act(async () => { mounted = create(<PublishingSetup scope={scope} onConfigured={configured} onClose={() => {}} />); });
  await act(async () => mounted!.root.findByProps({ "data-testid": "publishing-setup-submit" }).props.onClick());
  expect(configured).not.toHaveBeenCalled(); expect(JSON.stringify(mounted!.toJSON())).toContain("uncommitted edits");
});

it("defaults to the authorized personal account and vanilla without requesting an owner or theme path", async () => {
  const fresh = { workspaceRoot: "/notes", noteRoots: ["/notes"] };
  setup.mockResolvedValue({ status: "ready", repository: "user/my-garden", engineDirectory: "/sites/user/my-garden", siteUrl: "https://user.github.io/my-garden/" });
  await act(async () => { mounted = create(<PublishingSetup scope={fresh} onConfigured={configured} onClose={() => {}} />); });
  await act(async () => mounted!.root.findByProps({ "data-testid": "publishing-setup-folder" }).props.onChange({ target: { value: "/notes/garden" } }));
  await act(async () => mounted!.root.findByProps({ "data-testid": "publishing-setup-repository" }).props.onChange({ target: { value: "my-garden" } }));
  expect(mounted!.root.findAllByProps({ "data-testid": "publishing-setup-theme" })).toHaveLength(0);
  await act(async () => mounted!.root.findByProps({ "data-testid": "publishing-setup-submit" }).props.onClick());
  expect(setup).toHaveBeenCalledWith({ scope: fresh, publicationDirectory: "/notes/garden", repository: "user/my-garden", createRepository: true, visibility: "public" });
});
it("offers organizations and disables repository creation where it is not allowed", async () => {
  window.exograph.publishing.getSetupStatus = async () => ({ authenticated: true, managed: false, login: "user", accounts: [
    { login: "user", kind: "user", canCreate: true }, { login: "team", kind: "organization", canCreate: true }, { login: "restricted", kind: "organization", canCreate: false },
  ] });
  await act(async () => { mounted = create(<PublishingSetup scope={{ workspaceRoot: "/notes", noteRoots: ["/notes"] }} onConfigured={configured} onClose={() => {}} />); });
  expect(mounted!.root.findByProps({ value: "restricted" }).props.disabled).toBe(true);
  await act(async () => mounted!.root.findByProps({ "aria-label": "GitHub account" }).props.onChange({ target: { value: "team" } }));
  expect(mounted!.root.findByProps({ "aria-label": "GitHub account" }).props.value).toBe("team");
});
