import { afterEach, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { prepareAppProfile } from "./app-profile";
const roots: string[] = [];
function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "exo-profile-")); roots.push(root);
  const legacy = path.join(root, "@exograph", "desktop"); mkdirSync(legacy, { recursive: true });
  return { root, legacy, destination: path.join(root, "Exograph") };
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
it("preserves profile data, relocates managed sites and saved references, and leaves the original intact", () => {
  const { root, legacy, destination } = fixture();
  mkdirSync(path.join(legacy, "publishing-sites", "site", ".git"), { recursive: true });
  writeFileSync(path.join(legacy, "publishing-sites", "site", ".git", "config"), "git data");
  writeFileSync(path.join(legacy, "Cookies"), Buffer.from([0, 1, 255]));
  const settings = { publishing: { engineDirectory: path.join(legacy, "publishing-sites", "site") }, noteRoots: ["/notes"], unrelated: legacy + "-other" };
  writeFileSync(path.join(legacy, "workspace-settings.json"), JSON.stringify(settings));
  writeFileSync(path.join(legacy, "workspace-registry.json"), JSON.stringify({ entries: [{ settings }] }));
  expect(prepareAppProfile(root)).toBe(destination);
  expect(JSON.parse(readFileSync(path.join(destination, "workspace-settings.json"), "utf8"))).toEqual({ ...settings, publishing: { engineDirectory: path.join(destination, "exo-quartz-sites", "site") } });
  expect(readFileSync(path.join(destination, "Cookies"))).toEqual(Buffer.from([0, 1, 255]));
  expect(readFileSync(path.join(destination, "exo-quartz-sites", "site", ".git", "config"), "utf8")).toBe("git data");
  expect(JSON.parse(readFileSync(path.join(legacy, "workspace-settings.json"), "utf8"))).toEqual(settings);
  expect(prepareAppProfile(root)).toBe(destination);
});
it("honors custom profiles and never overwrites an existing conventional profile", () => {
  const { root, legacy, destination } = fixture();
  expect(prepareAppProfile(root, "/custom-profile")).toBe("/custom-profile");
  expect(existsSync(destination)).toBe(false);
  mkdirSync(destination); writeFileSync(path.join(destination, "keep"), "current");
  writeFileSync(path.join(legacy, "legacy"), "old");
  expect(prepareAppProfile(root)).toBe(destination);
  expect(existsSync(path.join(destination, "legacy"))).toBe(false);
});
it("refuses to copy a running old app profile", () => {
  const { root, legacy, destination } = fixture();
  symlinkSync(`${os.hostname()}-${process.pid}`, path.join(legacy, "SingletonLock"));
  expect(() => prepareAppProfile(root)).toThrow("Close the older Exograph");
  expect(existsSync(destination)).toBe(false);
});
it("does not promote corrupt settings or disturb the source on failure", () => {
  const { root, legacy, destination } = fixture();
  writeFileSync(path.join(legacy, "workspace-settings.json"), "invalid JSON");
  expect(() => prepareAppProfile(root)).toThrow();
  expect(existsSync(destination)).toBe(false);
  expect(readFileSync(path.join(legacy, "workspace-settings.json"), "utf8")).toBe("invalid JSON");
});
