import { afterEach, describe, expect, it, vi } from "vitest";

import type { IndexStatus, WorkspaceModel, WorkspaceSettings } from "@exograph/core";
import type { DerivedIndexClient } from "./derived-index-process";
import type { AutoEmbeddingPolicy } from "./indexing-auto-scheduler";
import { IndexingService, type IndexingServiceOptions } from "./indexing-service";

vi.mock("electron", () => ({
  app: {
    getPath: (name: string) => {
      if (name === "home") return "/Users/tester";
      if (name === "desktop") return "/Users/tester/Desktop";
      if (name === "documents") return "/Users/tester/Documents";
      return "/tmp/exograph-test";
    },
  },
}));

describe("IndexingService", () => {
  afterEach(() => vi.useRealTimers());

  it("detects settings changes that require root reconciliation", () => {
    const settings = workspaceSettings();
    const service = indexingService(settings);

    expect(service.shouldReconcileAfterSettingsApply(settings, settings)).toBe(false);
    expect(service.shouldReconcileAfterSettingsApply(settings, {
      ...settings,
      indexing: { enabled: true, mode: "hybrid", backend: "qmd" },
    })).toBe(true);
    expect(service.shouldReconcileAfterSettingsApply(settings, {
      ...settings,
      indexedRoots: [{ ...settings.indexedRoots[0], path: "/workspace/notes/other" }],
    })).toBe(true);
    expect(service.shouldReconcileAfterSettingsApply(settings, {
      ...settings,
      indexing: { enabled: false, mode: "off", backend: "qmd" },
      indexedRoots: [],
    })).toBe(false);
    expect(service.shouldReconcileAfterSettingsApply(settings, { ...settings, searchEngine: "filesystem" })).toBe(false);
    expect(service.shouldReconcileAfterSettingsApply({ ...settings, searchEngine: "filesystem" }, settings)).toBe(true);
    expect(service.shouldReconcileAfterSettingsApply({ ...settings, indexUpdateStrategy: "manual" }, settings)).toBe(true);
  });

  it("updates maintenance policy without replacing active derived-index clients", async () => {
    vi.useFakeTimers();
    const settings = workspaceSettings();
    const maintenance = derivedIndexClient();
    const foreground = derivedIndexClient();
    const service = indexingService(settings, undefined, maintenance, foreground);

    service.applySettings({
      model: workspaceModel(settings),
      settings: { ...settings, indexUpdateStrategy: "manual" },
      runtimeRoot: "/workspace/.exograph",
    });
    service.applyCurrentAutomaticPolicy();
    service.scheduleForFile("/workspace/notes/daily.md", "note-save");
    await vi.advanceTimersByTimeAsync(60_000);

    expect(maintenance.update).not.toHaveBeenCalled();
    expect(maintenance.dispose).not.toHaveBeenCalled();
    expect(foreground.dispose).not.toHaveBeenCalled();
    service.dispose();
  });

  it("saves specific indexed roots and refuses broad system roots by default", async () => {
    const settings = workspaceSettings();
    let savedSettings: WorkspaceSettings | null = null;
    const service = indexingService(settings, (nextSettings) => {
      savedSettings = nextSettings;
      return Promise.resolve(nextSettings);
    });

    await expect(service.addRoot({ path: "/Users/tester" })).rejects.toThrow("Refusing to index");
    await expect(service.addRoot({ path: "/workspace/notes/research", name: "research", kind: "notes" })).resolves.toMatchObject({
      indexing: { enabled: true, mode: "lexical", backend: "qmd" },
    });

    const savedSnapshot = savedSettings as WorkspaceSettings | null;
    expect(savedSnapshot?.indexedRoots).toHaveLength(2);
    expect(savedSnapshot?.indexedRoots.at(-1)).toMatchObject({
      id: "index-research",
      label: "research",
      path: "/workspace/notes/research",
      kind: "notes",
    });
  });

  it("refreshes changed roots without rebuilding embeddings for hybrid on-save indexing", async () => {
    vi.useFakeTimers();
    const settings = workspaceSettings();
    settings.indexing = { enabled: true, mode: "hybrid", backend: "qmd" };
    const maintenance = derivedIndexClient();
    const service = indexingService(settings, undefined, maintenance);

    service.scheduleForFile("/workspace/notes/daily.md", "note-save");
    await vi.advanceTimersByTimeAsync(15_000);

    expect(maintenance.update).toHaveBeenCalledWith(
      expect.objectContaining({ indexing: expect.objectContaining({ mode: "hybrid" }) }),
      "/workspace/.exograph",
      ["index-notes"],
      expect.anything(),
    );
    expect(maintenance.sync).not.toHaveBeenCalled();
    service.dispose();
  });

  it("waits for save quiet and system idle before running one bounded automatic slice", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const settings = workspaceSettings();
    settings.indexing = { enabled: true, mode: "hybrid", backend: "qmd" };
    const maintenance = derivedIndexClient();
    vi.mocked(maintenance.update).mockResolvedValue(indexStatus(1));
    vi.mocked(maintenance.embed).mockResolvedValue(indexStatus(0));
    let systemIdleTimeMs = 0;
    const service = indexingService(settings, undefined, maintenance, derivedIndexClient(), {
      getSystemIdleTimeMs: () => systemIdleTimeMs,
    });

    service.scheduleForFile("/workspace/notes/daily.md", "note-save");
    await vi.advanceTimersByTimeAsync(15_000);
    expect(maintenance.embed).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(29_999);
    expect(maintenance.embed).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(maintenance.embed).not.toHaveBeenCalled();

    systemIdleTimeMs = 10_000;
    await vi.advanceTimersByTimeAsync(9_999);
    expect(maintenance.embed).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(maintenance.embed).toHaveBeenCalledWith(
      expect.objectContaining({ indexing: expect.objectContaining({ mode: "hybrid" }) }),
      "/workspace/.exograph",
      { maxDocuments: 4, maxDocsPerBatch: 1, maxDurationMs: 15_000 },
      expect.anything(),
    );
    service.dispose();
  });

  it("coalesces rapid saves into one root refresh", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const settings = workspaceSettings();
    const maintenance = derivedIndexClient();
    vi.mocked(maintenance.update).mockResolvedValue(indexStatus(0, "lexical"));
    const service = indexingService(settings, undefined, maintenance);

    service.scheduleForFile("/workspace/notes/first.md", "first-save");
    await vi.advanceTimersByTimeAsync(5_000);
    service.scheduleForFile("/workspace/notes/second.md", "second-save");
    await vi.advanceTimersByTimeAsync(5_000);
    service.scheduleForFile("/workspace/notes/third.md", "third-save");
    await vi.advanceTimersByTimeAsync(14_999);
    expect(maintenance.update).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(maintenance.update).toHaveBeenCalledTimes(1);
    service.dispose();
  });

  it("runs exactly one follow-up refresh when another save becomes due in flight", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const settings = workspaceSettings();
    const first = deferred<IndexStatus>();
    const maintenance = derivedIndexClient();
    vi.mocked(maintenance.update)
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValue(indexStatus(0, "lexical"));
    const service = indexingService(settings, undefined, maintenance);

    service.scheduleForFile("/workspace/notes/first.md", "first-save");
    await vi.advanceTimersByTimeAsync(15_000);
    expect(maintenance.update).toHaveBeenCalledTimes(1);

    service.scheduleForFile("/workspace/notes/second.md", "second-save");
    service.scheduleForFile("/workspace/notes/third.md", "third-save");
    await vi.advanceTimersByTimeAsync(15_000);
    expect(maintenance.update).toHaveBeenCalledTimes(1);

    first.resolve(indexStatus(0, "lexical"));
    await vi.advanceTimersByTimeAsync(0);
    expect(maintenance.update).toHaveBeenCalledTimes(2);
    expect(maintenance.update).toHaveBeenLastCalledWith(
      expect.anything(),
      "/workspace/.exograph",
      ["index-notes"],
      expect.anything(),
    );
    service.dispose();
  });

  it("does not publish an old maintenance completion after A → B → A activation", async () => {
    vi.useFakeTimers();
    const firstA = deferred<IndexStatus>();
    const settingsA = workspaceSettings();
    const settingsB = { ...workspaceSettings(), workspaceRoot: "/workspace-b", defaultTerminalCwd: "/workspace-b", noteRoots: ["/workspace-b/notes"] };
    const maintenance = derivedIndexClient();
    const events: Parameters<IndexingServiceOptions["sendState"]>[0][] = [];
    let firstSignal: AbortSignal | undefined;
    vi.mocked(maintenance.update).mockImplementationOnce((_model, _runtimeRoot, _rootIds, signal) => {
      firstSignal = signal;
      return firstA.promise;
    });
    const service = indexingService(settingsA, undefined, maintenance, derivedIndexClient(), { sendState: (event) => events.push(event) });

    service.scheduleReconciliation("a-first", 0);
    await vi.advanceTimersByTimeAsync(0);
    expect(maintenance.update).toHaveBeenCalledTimes(1);

    service.activateWorkspace({
      model: workspaceModel(settingsB),
      settings: settingsB,
      runtimeRoot: "/workspace-b/.exograph",
    });
    service.activateWorkspace({
      model: workspaceModel(settingsA),
      settings: settingsA,
      runtimeRoot: "/workspace/.exograph",
    });
    expect(firstSignal?.aborted).toBe(true);

    firstA.resolve(indexStatus(0, "lexical"));
    await vi.advanceTimersByTimeAsync(0);

    expect(events.filter((event) => (event.state === "idle" || event.state === "error") && event.reason !== "workspace-activated")).toEqual([]);
    service.dispose();
  });

  it("does not let a held foreground read from A block B maintenance or return A data", async () => {
    vi.useFakeTimers();
    const settingsA = workspaceSettings();
    const settingsB = { ...workspaceSettings(), workspaceRoot: "/workspace-b", defaultTerminalCwd: "/workspace-b", noteRoots: ["/workspace-b/notes"] };
    const foreground = derivedIndexClient();
    const heldSearch = deferred<Awaited<ReturnType<DerivedIndexClient["search"]>>>();
    let searchSignal: AbortSignal | undefined;
    vi.mocked(foreground.search).mockImplementationOnce((_model, _root, _query, _options, signal) => {
      searchSignal = signal;
      return heldSearch.promise;
    });
    const maintenance = derivedIndexClient();
    const service = indexingService(settingsA, undefined, maintenance, foreground);

    const oldSearch = service.search("old");
    await Promise.resolve();
    service.activateWorkspace({ model: workspaceModel(settingsB), settings: settingsB, runtimeRoot: "/workspace-b/.exograph" });
    expect(searchSignal?.aborted).toBe(true);
    service.scheduleReconciliation("b", 0);
    await vi.advanceTimersByTimeAsync(0);
    expect(maintenance.update).toHaveBeenCalledWith(expect.objectContaining({ workspaceRoot: "/workspace-b" }), "/workspace-b/.exograph", ["index-notes"], expect.anything());

    heldSearch.resolve({ results: [], query: "old", mode: "hybrid", source: "qmd", provider: "qmd", warnings: [] });
    await expect(oldSearch).rejects.toMatchObject({ name: "AbortError" });
    service.dispose();
  });

  it("replaces the serialized maintenance worker so B never queues behind held A native work", async () => {
    vi.useFakeTimers();
    const settingsA = workspaceSettings();
    const settingsB = { ...workspaceSettings(), workspaceRoot: "/workspace-b", defaultTerminalCwd: "/workspace-b", noteRoots: ["/workspace-b/notes"] };
    const heldA = deferred<IndexStatus>();
    const workerA = derivedIndexClient();
    const workerB = derivedIndexClient();
    vi.mocked(workerA.update).mockImplementationOnce(() => heldA.promise);
    const workers = [workerA, workerB];
    const service = indexingService(settingsA, undefined, workerA, derivedIndexClient(), {
      maintenanceDerivedIndexFactory: () => workers.shift() ?? workerB,
    });

    service.scheduleReconciliation("a", 0);
    await vi.advanceTimersByTimeAsync(0);
    expect(workerA.update).toHaveBeenCalledOnce();
    service.activateWorkspace({ model: workspaceModel(settingsB), settings: settingsB, runtimeRoot: "/workspace-b/.exograph" });
    expect(workerA.dispose).toHaveBeenCalledOnce();
    service.scheduleReconciliation("b", 0);
    await vi.advanceTimersByTimeAsync(0);
    expect(workerB.update).toHaveBeenCalledWith(expect.objectContaining({ workspaceRoot: "/workspace-b" }), "/workspace-b/.exograph", ["index-notes"], expect.anything());

    heldA.resolve(indexStatus(0, "lexical"));
    await vi.advanceTimersByTimeAsync(0);
    service.dispose();
  });

  it.each([
    { name: "lexical mode", mode: "lexical" as const, strategy: "on-save" as const, pending: 1, updates: 1 },
    { name: "Manual only", mode: "hybrid" as const, strategy: "manual" as const, pending: 1, updates: 0 },
    { name: "zero pending", mode: "hybrid" as const, strategy: "on-save" as const, pending: 0, updates: 1 },
    { name: "over-cap backlog", mode: "hybrid" as const, strategy: "on-save" as const, pending: 5, updates: 1 },
  ])("does not automatically embed for $name", async ({ mode, strategy, pending, updates }) => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const settings = workspaceSettings();
    settings.indexing = { enabled: true, mode, backend: "qmd" };
    settings.indexUpdateStrategy = strategy;
    const maintenance = derivedIndexClient();
    vi.mocked(maintenance.update).mockResolvedValue(indexStatus(pending, mode));
    const service = indexingService(settings, undefined, maintenance, derivedIndexClient(), {
      getSystemIdleTimeMs: () => 120_000,
    });

    service.scheduleForFile("/workspace/notes/daily.md", "note-save");
    await vi.advanceTimersByTimeAsync(120_000);

    expect(maintenance.update).toHaveBeenCalledTimes(updates);
    expect(maintenance.embed).not.toHaveBeenCalled();
    service.dispose();
  });

  it("keeps explicit embed and sync unbounded", async () => {
    const settings = workspaceSettings();
    settings.indexing = { enabled: true, mode: "hybrid", backend: "qmd" };
    settings.indexUpdateStrategy = "manual";
    const maintenance = derivedIndexClient();
    vi.mocked(maintenance.embed).mockResolvedValue(indexStatus(0));
    const service = indexingService(settings, undefined, maintenance);

    await service.embed("settings");
    await service.runSync("settings");

    expect(maintenance.embed).toHaveBeenCalledWith(expect.anything(), "/workspace/.exograph", undefined, expect.anything());
    expect(maintenance.sync).toHaveBeenCalledWith(expect.anything(), "/workspace/.exograph", expect.anything());
    service.dispose();
  });

  it("uses foreground filesystem search and cached status while maintenance is active", async () => {
    const settings = workspaceSettings();
    settings.indexing = { enabled: true, mode: "hybrid", backend: "qmd" };
    settings.indexUpdateStrategy = "manual";
    const held = deferred<IndexStatus>();
    const maintenance = derivedIndexClient();
    vi.mocked(maintenance.embed).mockImplementationOnce(() => held.promise);
    const foreground = derivedIndexClient();
    const service = indexingService(settings, undefined, maintenance, foreground);

    const embedding = service.embed("settings");
    await Promise.resolve();
    const result = await service.search("needle");
    const status = await service.getMeasuredStatus();

    expect(foreground.search).toHaveBeenCalledWith(
      expect.objectContaining({ searchEngine: "filesystem" }),
      "/workspace/.exograph",
      "needle",
      {},
      expect.anything(),
    );
    expect(result.warnings).toContain("Index maintenance is running; showing Simple search results until it completes.");
    expect(foreground.status).not.toHaveBeenCalled();
    expect(status.warnings).toContain("Index maintenance is running; showing the last available index status until it finishes.");

    held.resolve(indexStatus(0));
    await embedding;
    service.dispose();
  });

  it("keeps foreground surfaces explicit while an eligible automatic slice converges", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const settings = workspaceSettings();
    settings.indexing = { enabled: true, mode: "hybrid", backend: "qmd" };
    const held = deferred<IndexStatus>();
    const maintenance = derivedIndexClient();
    vi.mocked(maintenance.update).mockResolvedValue(indexStatus(1));
    vi.mocked(maintenance.embed).mockImplementationOnce(() => held.promise);
    const foreground = derivedIndexClient();
    vi.mocked(foreground.status).mockResolvedValue(indexStatus(0));
    const events: Parameters<IndexingServiceOptions["sendState"]>[0][] = [];
    const immediatePolicy: AutoEmbeddingPolicy = {
      quietPeriodMs: 0,
      idlePeriodMs: 0,
      maxPendingEmbeddings: 4,
      retryBaseDelayMs: 50,
      retryMaxDelayMs: 50,
      maxRetryAttempts: 2,
    };
    const service = indexingService(settings, undefined, maintenance, foreground, {
      getSystemIdleTimeMs: () => 10_000,
      autoEmbeddingPolicy: immediatePolicy,
      sendState: (event) => events.push(event),
    });

    service.scheduleReconciliation("startup", 0);
    await vi.advanceTimersByTimeAsync(0);
    expect(maintenance.embed).toHaveBeenCalledOnce();

    const search = await service.search("needle");
    const during = await service.getMeasuredStatus();
    expect(search).toMatchObject({ source: "qmd" });
    expect(search.warnings).toContain("Index maintenance is running; showing Simple search results until it completes.");
    expect(during.pendingEmbeddings).toBe(1);
    expect(during.warnings).toContain("1 document hash needs embeddings and is waiting for automatic catch-up.");
    expect(during.warnings).toContain("Index maintenance is running; showing the last available index status until it finishes.");

    held.resolve(indexStatus(0));
    await vi.advanceTimersByTimeAsync(0);
    const converged = await service.getMeasuredStatus();
    expect(converged.pendingEmbeddings).toBe(0);
    expect(converged.recentJobs).toContainEqual(expect.objectContaining({
      kind: "embed",
      reason: "automatic-embedding",
      status: "completed",
      pendingEmbeddings: 0,
    }));
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ state: "running", reason: "automatic-embedding" }),
      expect.objectContaining({ state: "idle", reason: "automatic-embedding" }),
    ]));
    service.dispose();
  });

  it.each([
    ["on-save", 1, "1 document hash needs embeddings and is waiting for automatic catch-up."],
    ["on-save", 5, "5 document hashes need embeddings; automatic catch-up only runs for 4 or fewer."],
    ["manual", 1, "1 document hash needs embeddings; automatic updates are paused."],
  ] as const)("describes %s pending-vector policy truthfully", async (strategy, pending, warning) => {
    const settings = workspaceSettings();
    settings.indexing = { enabled: true, mode: "hybrid", backend: "qmd" };
    settings.indexUpdateStrategy = strategy;
    const foreground = derivedIndexClient();
    vi.mocked(foreground.status).mockResolvedValue({
      ...indexStatus(pending),
      warnings: ["runtime warning"],
    });
    const service = indexingService(settings, undefined, derivedIndexClient(), foreground);

    const status = await service.getMeasuredStatus();
    expect(status.warnings).toContain("runtime warning");
    expect(status.warnings).toContain(warning);
    expect(status.warnings.join(" ")).not.toContain("exograph index sync");
    service.dispose();
  });

  it("retries no-progress slices with backoff and cools down between successful slices", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const settings = workspaceSettings();
    settings.indexing = { enabled: true, mode: "hybrid", backend: "qmd" };
    const maintenance = derivedIndexClient();
    vi.mocked(maintenance.update).mockResolvedValue(indexStatus(2));
    vi.mocked(maintenance.embed)
      .mockResolvedValueOnce(indexStatus(2))
      .mockResolvedValueOnce(indexStatus(1))
      .mockResolvedValueOnce(indexStatus(0));
    const retryPolicy: AutoEmbeddingPolicy = {
      quietPeriodMs: 0,
      idlePeriodMs: 100,
      maxPendingEmbeddings: 4,
      retryBaseDelayMs: 50,
      retryMaxDelayMs: 50,
      maxRetryAttempts: 2,
    };
    const service = indexingService(settings, undefined, maintenance, derivedIndexClient(), {
      getSystemIdleTimeMs: () => 10_000,
      autoEmbeddingPolicy: retryPolicy,
    });

    service.scheduleReconciliation("startup", 0);
    await vi.advanceTimersByTimeAsync(0);
    expect(maintenance.embed).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(49);
    expect(maintenance.embed).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(maintenance.embed).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(99);
    expect(maintenance.embed).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(maintenance.embed).toHaveBeenCalledTimes(3);
    service.dispose();
  });

  it("reports exhausted automatic work and lets a new canonical save recover it", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const settings = workspaceSettings();
    settings.indexing = { enabled: true, mode: "hybrid", backend: "qmd" };
    const maintenance = derivedIndexClient();
    vi.mocked(maintenance.update).mockResolvedValue(indexStatus(1));
    vi.mocked(maintenance.embed)
      .mockRejectedValueOnce(new Error("model unavailable"))
      .mockRejectedValueOnce(new Error("model unavailable"))
      .mockResolvedValueOnce(indexStatus(0));
    const foreground = derivedIndexClient();
    vi.mocked(foreground.status)
      .mockResolvedValueOnce(indexStatus(1))
      .mockResolvedValue(indexStatus(0));
    const retryPolicy: AutoEmbeddingPolicy = {
      quietPeriodMs: 0,
      idlePeriodMs: 0,
      maxPendingEmbeddings: 4,
      retryBaseDelayMs: 10,
      retryMaxDelayMs: 10,
      maxRetryAttempts: 1,
    };
    const service = indexingService(settings, undefined, maintenance, foreground, {
      getSystemIdleTimeMs: () => 10_000,
      autoEmbeddingPolicy: retryPolicy,
    });

    service.scheduleReconciliation("startup", 0);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(10);
    expect(maintenance.embed).toHaveBeenCalledTimes(2);

    const exhausted = await service.getMeasuredStatus();
    expect(exhausted.pendingEmbeddings).toBe(1);
    expect(exhausted.warnings).toContain(
      "1 document hash needs embeddings; automatic catch-up failed after 2 attempts. Run Sync to repair it.",
    );
    expect(exhausted.warnings.join(" ")).not.toContain("waiting for automatic catch-up");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(maintenance.embed).toHaveBeenCalledTimes(2);

    service.scheduleForFile("/workspace/notes/new-canonical-work.md", "note-save");
    await vi.advanceTimersByTimeAsync(15_000);
    expect(maintenance.update).toHaveBeenCalledTimes(2);
    expect(maintenance.embed).toHaveBeenCalledTimes(3);

    const converged = await service.getMeasuredStatus();
    expect(converged.pendingEmbeddings).toBe(0);
    expect(converged.warnings.join(" ")).not.toMatch(/failed after|waiting for automatic catch-up/);
    expect(converged.recentJobs).toContainEqual(expect.objectContaining({
      kind: "embed",
      reason: "automatic-embedding",
      status: "completed",
      pendingEmbeddings: 0,
    }));
    service.dispose();
  });

  it("lets a started slice finish while Manual only cancels its future retry", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const settings = workspaceSettings();
    settings.indexing = { enabled: true, mode: "hybrid", backend: "qmd" };
    const held = deferred<IndexStatus>();
    const maintenance = derivedIndexClient();
    vi.mocked(maintenance.update).mockResolvedValue(indexStatus(1));
    vi.mocked(maintenance.embed).mockImplementationOnce(() => held.promise);
    const immediatePolicy: AutoEmbeddingPolicy = {
      quietPeriodMs: 0,
      idlePeriodMs: 0,
      maxPendingEmbeddings: 4,
      retryBaseDelayMs: 50,
      retryMaxDelayMs: 50,
      maxRetryAttempts: 2,
    };
    const service = indexingService(settings, undefined, maintenance, derivedIndexClient(), {
      getSystemIdleTimeMs: () => 10_000,
      autoEmbeddingPolicy: immediatePolicy,
    });

    service.scheduleReconciliation("startup", 0);
    await vi.advanceTimersByTimeAsync(0);
    expect(maintenance.embed).toHaveBeenCalledTimes(1);

    settings.indexUpdateStrategy = "manual";
    service.applyCurrentAutomaticPolicy();
    expect(maintenance.dispose).not.toHaveBeenCalled();
    held.reject(new Error("model unavailable"));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(maintenance.embed).toHaveBeenCalledTimes(1);
    service.dispose();
  });

  it("reconciles roots through update-only startup work and disposes both clients and timers", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const settings = workspaceSettings();
    settings.indexing = { enabled: true, mode: "hybrid", backend: "qmd" };
    const maintenance = derivedIndexClient();
    vi.mocked(maintenance.update).mockResolvedValue(indexStatus(0));
    const foreground = derivedIndexClient();
    const service = indexingService(settings, undefined, maintenance, foreground, {
      getSystemIdleTimeMs: () => 60_000,
    });

    service.scheduleReconciliation("startup", 0);
    await vi.advanceTimersByTimeAsync(0);
    expect(maintenance.update).toHaveBeenCalledWith(expect.anything(), "/workspace/.exograph", ["index-notes"], expect.anything());
    expect(maintenance.sync).not.toHaveBeenCalled();

    service.scheduleForFile("/workspace/notes/later.md", "note-save");
    service.dispose();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(maintenance.update).toHaveBeenCalledTimes(1);
    expect(maintenance.dispose).toHaveBeenCalledOnce();
    expect(foreground.dispose).toHaveBeenCalledOnce();
  });
});

function indexingService(
  settings: WorkspaceSettings,
  saveWorkspaceSettings: (settings: WorkspaceSettings) => Promise<WorkspaceSettings> = async (nextSettings) => nextSettings,
  maintenanceDerivedIndex: DerivedIndexClient = derivedIndexClient(),
  foregroundDerivedIndex: DerivedIndexClient = derivedIndexClient(),
  options: {
    getSystemIdleTimeMs?: () => number;
    autoEmbeddingPolicy?: AutoEmbeddingPolicy;
    sendState?: IndexingServiceOptions["sendState"];
    maintenanceDerivedIndexFactory?: () => DerivedIndexClient;
  } = {},
) {
  return new IndexingService({
    getWorkspaceModel: () => workspaceModel(settings),
    getCurrentSettings: () => settings,
    getRuntimeRoot: () => "/workspace/.exograph",
    saveWorkspaceSettings,
    sendState: options.sendState ?? (() => {}),
    errorMessage: (error) => error instanceof Error ? error.message : String(error),
    foregroundDerivedIndex,
    maintenanceDerivedIndex,
    maintenanceDerivedIndexFactory: options.maintenanceDerivedIndexFactory,
    now: () => Date.now(),
    getSystemIdleTimeMs: options.getSystemIdleTimeMs,
    autoEmbeddingPolicy: options.autoEmbeddingPolicy,
  });
}

function workspaceModel(settings: WorkspaceSettings): WorkspaceModel {
  return {
    workspaceRoot: settings.workspaceRoot,
    defaultTerminalCwd: settings.defaultTerminalCwd,
    noteRoots: settings.noteRoots.map((root, index) => ({ id: `note-${index + 1}`, label: `note-${index + 1}`, path: root })),
    indexedRoots: settings.indexedRoots,
    indexing: settings.indexing,
    searchEngine: settings.searchEngine,
  };
}

function derivedIndexClient(): DerivedIndexClient {
  const status = indexStatus();
  return {
    status: vi.fn(async () => status),
    search: vi.fn(async () => ({
      results: [], query: "", intent: "", mode: "hybrid" as const,
      source: "qmd" as const, provider: "qmd" as const, warnings: [],
    })),
    update: vi.fn(async () => status),
    embed: vi.fn(async () => status),
    sync: vi.fn(async () => ({ status, phases: [], warnings: [] })),
    graphTraverse: vi.fn(),
    graphContext: vi.fn(async () => null),
    graphTopology: vi.fn(async () => { throw new Error("graph topology is not used by indexing tests"); }),
    graphConceptSummaries: vi.fn(async () => { throw new Error("graph summaries are not used by indexing tests"); }),
    graphConceptLookup: vi.fn(async () => { throw new Error("graph lookup is not used by indexing tests"); }),
    graphConceptDetailByIndex: vi.fn(async () => { throw new Error("graph detail is not used by indexing tests"); }),
    graphRefresh: vi.fn(async () => {}),
    graphInvalidate: vi.fn(async () => {}),
    ontologyPreview: vi.fn(async () => { throw new Error("ontology review is not used by indexing tests"); }),
    ontologyKeep: vi.fn(async () => { throw new Error("ontology review is not used by indexing tests"); }),
    ontologyReject: vi.fn(async () => { throw new Error("ontology review is not used by indexing tests"); }),
    dispose: vi.fn(),
  };
}

function indexStatus(pendingEmbeddings = 1, mode: IndexStatus["mode"] = "hybrid"): IndexStatus {
  return {
    enabled: true,
    mode,
    backend: "qmd",
    dbPath: "/workspace/.exograph/qmd/index.sqlite",
    runtimePath: "/workspace/.exograph/qmd",
    indexedRoots: workspaceSettings().indexedRoots,
    documentCount: 1,
    pendingEmbeddings,
    hasVectorIndex: true,
    lastUpdated: null,
    warnings: [],
    errors: [],
  };
}

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<Value>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

function workspaceSettings(): WorkspaceSettings {
  return {
    workspaceRoot: "/workspace",
    defaultTerminalCwd: "/workspace",
    noteRoots: ["/workspace/notes"],
    indexedRoots: [
      {
        id: "index-notes",
        label: "notes",
        path: "/workspace/notes",
        kind: "notes",
        pattern: "**/*.md",
        ignore: [],
        backend: "qmd",
      },
    ],
    indexing: { enabled: true, mode: "lexical", backend: "qmd" },
    searchEngine: "qmd",
    appearanceMode: "system",
    colorThemeId: "exograph-neutral",
    editorFontSize: 15,
    terminalFontSize: 13,
    explorerScale: 1,
    graphInverseNavigation: true,
    graphShowOverflowLabels: true,
    exploreIndexSearchOnEnter: true,
    indexUpdateStrategy: "on-save",
  };
}
