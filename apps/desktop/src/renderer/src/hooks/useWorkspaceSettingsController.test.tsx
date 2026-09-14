import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type {
  WorkspaceSettings,
  WorkspaceSettingsSaveRequest,
} from "@exograph/core";

import type { WorkspaceSettingsSaveOutcome } from "../../../shared/api";
import { defaultIndexedRoot } from "../workspaceSettingsDialogTypes";
import { workspaceSettingsDialogFixture } from "../workspaceSettingsTestFixtures";
import {
  indexBusyStateForEvent,
  useWorkspaceSettingsController,
  workspaceSettingsFromDialog,
} from "./useWorkspaceSettingsController";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("workspace settings patch persistence", () => {
  it("applies consecutive local patches in order with the revision returned by each save", async () => {
    let persistedSettings = workspaceSettings();
    let persistedRevision = "revision-0";
    let saveTail = Promise.resolve();
    let appliedSaveCount = 0;
    const firstSaveGate = deferred<void>();
    const saveSettings = vi.fn((request: WorkspaceSettingsSaveRequest) => {
      const result = saveTail.then(async (): Promise<WorkspaceSettingsSaveOutcome> => {
        appliedSaveCount += 1;
        if (appliedSaveCount === 1) {
          await firstSaveGate.promise;
        }
        if (request.expectedRevision !== persistedRevision) {
          throw new Error("workspace-settings-stale");
        }
        persistedSettings = request.settings;
        persistedRevision = `revision-${appliedSaveCount}`;
        return {
          settings: persistedSettings,
          revision: persistedRevision,
          runtimeApply: { status: "applied" },
        };
      });
      saveTail = result.then(() => undefined, () => undefined);
      return result;
    });
    vi.stubGlobal("window", {
      exograph: {
        workspace: {
          getSettings: vi.fn(async () => ({ settings: persistedSettings, revision: persistedRevision })),
          saveSettings,
        },
      },
    });
    const settingsRef = { current: persistedSettings };
    const revisionRef = { current: persistedRevision };
    const controllerRef: { current: ReturnType<typeof useWorkspaceSettingsController> | null } = { current: null };

    renderToStaticMarkup(
      <WorkspaceSettingsControllerHarness
        controllerRef={controllerRef}
        options={{
          workspaceSettingsRef: settingsRef,
          workspaceSettingsRevisionRef: revisionRef,
          applyWorkspaceSettings: vi.fn(),
          refreshWorkspaceModel: vi.fn(async () => undefined),
          setIndexStatus: vi.fn(),
        }}
      />,
    );
    const controller = controllerRef.current;
    expect(controller).not.toBeNull();

    const firstPatch = controller!.saveSettingsPatch({ terminalFontSize: 14 });
    const secondPatch = controller!.saveSettingsPatch({ terminalFontSize: 15 });
    await Promise.resolve();

    expect(saveSettings).toHaveBeenCalledTimes(1);
    firstSaveGate.resolve();
    await expect(Promise.all([firstPatch, secondPatch])).resolves.toEqual([undefined, undefined]);
    expect(saveSettings.mock.calls.map(([request]) => request.expectedRevision)).toEqual([
      "revision-0",
      "revision-1",
    ]);
    expect(persistedSettings.terminalFontSize).toBe(15);
    expect(settingsRef.current.terminalFontSize).toBe(15);
    expect(revisionRef.current).toBe("revision-2");
  });

  it("publishes a committed runtime failure before saving the queued correction", async () => {
    let persistedSettings = workspaceSettings();
    let persistedRevision = "revision-0";
    let saveCount = 0;
    const saveSettings = vi.fn(async (request: WorkspaceSettingsSaveRequest): Promise<WorkspaceSettingsSaveOutcome> => {
      if (request.expectedRevision !== persistedRevision) {
        throw new Error("workspace-settings-stale");
      }
      saveCount += 1;
      persistedSettings = request.settings;
      persistedRevision = `revision-${saveCount}`;
      return saveCount === 1
        ? {
            settings: persistedSettings,
            revision: persistedRevision,
            runtimeApply: {
              status: "failed",
              errorMessage: "Runtime context is unavailable.",
            },
          }
        : {
            settings: persistedSettings,
            revision: persistedRevision,
            runtimeApply: { status: "applied" },
          };
    });
    vi.stubGlobal("window", {
      exograph: {
        workspace: {
          getSettings: vi.fn(async () => ({ settings: persistedSettings, revision: persistedRevision })),
          saveSettings,
        },
      },
    });
    const settingsRef = { current: persistedSettings };
    const revisionRef = { current: persistedRevision };
    const controllerRef: { current: ReturnType<typeof useWorkspaceSettingsController> | null } = { current: null };
    renderToStaticMarkup(
      <WorkspaceSettingsControllerHarness
        controllerRef={controllerRef}
        options={{
          workspaceSettingsRef: settingsRef,
          workspaceSettingsRevisionRef: revisionRef,
          applyWorkspaceSettings: vi.fn(),
          refreshWorkspaceModel: vi.fn(async () => undefined),
          setIndexStatus: vi.fn(),
        }}
      />,
    );
    const controller = controllerRef.current;
    expect(controller).not.toBeNull();

    const failedApply = controller!.saveSettingsPatch({ terminalFontSize: 14 });
    const correction = controller!.saveSettingsPatch({ terminalFontSize: 15 });

    await expect(failedApply).rejects.toThrow("Runtime context is unavailable.");
    await expect(correction).resolves.toBeUndefined();
    expect(saveSettings.mock.calls.map(([request]) => request.expectedRevision)).toEqual([
      "revision-0",
      "revision-1",
    ]);
    expect(settingsRef.current.terminalFontSize).toBe(15);
    expect(revisionRef.current).toBe("revision-2");
  });

  it("keeps a committed degraded runtime save published without throwing it away", async () => {
    const settings = workspaceSettings();
    const saveSettings = vi.fn(async (request: WorkspaceSettingsSaveRequest): Promise<WorkspaceSettingsSaveOutcome> => ({
      settings: request.settings,
      revision: "revision-1",
      runtimeApply: {
        status: "degraded",
        errorMessage: "The workspace is active, but command discovery needs recovery.",
      },
    }));
    vi.stubGlobal("window", workspaceWindow(settings, "revision-0", saveSettings));
    const settingsRef = { current: settings };
    const revisionRef = { current: "revision-0" };
    const applyWorkspaceSettings = vi.fn();
    const onSettingsSaved = vi.fn();
    const controllerRef: { current: ReturnType<typeof useWorkspaceSettingsController> | null } = { current: null };
    renderToStaticMarkup(
      <WorkspaceSettingsControllerHarness
        controllerRef={controllerRef}
        options={{
          workspaceSettingsRef: settingsRef,
          workspaceSettingsRevisionRef: revisionRef,
          applyWorkspaceSettings,
          refreshWorkspaceModel: vi.fn(async () => undefined),
          setIndexStatus: vi.fn(),
          onSettingsSaved,
        }}
      />,
    );

    await expect(controllerRef.current!.saveSettingsPatch({ terminalFontSize: 14 })).resolves.toBeUndefined();
    expect(settingsRef.current.terminalFontSize).toBe(14);
    expect(revisionRef.current).toBe("revision-1");
    expect(applyWorkspaceSettings).not.toHaveBeenCalled();
    expect(onSettingsSaved).toHaveBeenCalledOnce();
  });

  it("retries a degraded patch through the current serialized revision", async () => {
    let persistedSettings = workspaceSettings();
    let persistedRevision = "revision-0";
    const saveSettings = vi.fn(async (request: WorkspaceSettingsSaveRequest): Promise<WorkspaceSettingsSaveOutcome> => {
      persistedSettings = request.settings;
      persistedRevision = request.expectedRevision === "revision-0" ? "revision-1" : "revision-2";
      return {
        settings: persistedSettings,
        revision: persistedRevision,
        runtimeApply: request.expectedRevision === "revision-0"
          ? { status: "degraded", errorMessage: "Command discovery needs recovery." }
          : { status: "applied" },
      };
    });
    vi.stubGlobal("window", workspaceWindow(persistedSettings, persistedRevision, saveSettings));
    const settingsRef = { current: persistedSettings };
    const revisionRef = { current: persistedRevision };
    const controllerRef: { current: ReturnType<typeof useWorkspaceSettingsController> | null } = { current: null };
    renderToStaticMarkup(
      <WorkspaceSettingsControllerHarness
        controllerRef={controllerRef}
        options={{
          workspaceSettingsRef: settingsRef,
          workspaceSettingsRevisionRef: revisionRef,
          applyWorkspaceSettings: vi.fn(),
          refreshWorkspaceModel: vi.fn(async () => undefined),
          setIndexStatus: vi.fn(),
        }}
      />,
    );

    await controllerRef.current!.saveSettingsPatch({ terminalFontSize: 14 });
    await controllerRef.current!.retryRuntimeApply();

    expect(saveSettings.mock.calls.map(([request]) => request.expectedRevision)).toEqual([
      "revision-0",
      "revision-1",
    ]);
    expect(saveSettings.mock.calls[1]?.[0].settings.terminalFontSize).toBe(14);
  });

  it("never replays a degraded value over a newer queued setting", async () => {
    let persistedSettings = workspaceSettings();
    let persistedRevision = "revision-0";
    const newerSave = deferred<WorkspaceSettingsSaveOutcome>();
    const saveSettings = vi.fn()
      .mockImplementationOnce(async (request: WorkspaceSettingsSaveRequest): Promise<WorkspaceSettingsSaveOutcome> => {
        persistedSettings = request.settings;
        persistedRevision = "revision-1";
        return {
          settings: persistedSettings,
          revision: persistedRevision,
          runtimeApply: { status: "degraded", errorMessage: "Command discovery needs recovery." },
        };
      })
      .mockImplementationOnce(() => newerSave.promise)
      .mockImplementationOnce(async (request: WorkspaceSettingsSaveRequest): Promise<WorkspaceSettingsSaveOutcome> => {
        persistedSettings = request.settings;
        persistedRevision = "revision-3";
        return saveOutcome(persistedSettings, persistedRevision);
      });
    vi.stubGlobal("window", workspaceWindow(persistedSettings, persistedRevision, saveSettings));
    const settingsRef = { current: persistedSettings };
    const revisionRef = { current: persistedRevision };
    const controller = renderController(settingsRef, revisionRef);

    await controller.saveSettingsPatch({ terminalFontSize: 14 });
    const newerPatch = controller.saveSettingsPatch({ terminalFontSize: 15 });
    await waitForSaveCount(saveSettings, 2);
    const retry = controller.retryRuntimeApply();

    const newerRequest = saveSettings.mock.calls[1]?.[0] as WorkspaceSettingsSaveRequest;
    persistedSettings = newerRequest.settings;
    persistedRevision = "revision-2";
    newerSave.resolve(saveOutcome(persistedSettings, persistedRevision));
    await Promise.all([newerPatch, retry]);

    expect(saveSettings).toHaveBeenCalledTimes(2);
    expect(settingsRef.current.terminalFontSize).toBe(15);
  });

  it("clears an older degraded retry after a later patch applies", async () => {
    let persistedSettings = workspaceSettings();
    let persistedRevision = "revision-0";
    let saveCount = 0;
    const saveSettings = vi.fn(async (request: WorkspaceSettingsSaveRequest): Promise<WorkspaceSettingsSaveOutcome> => {
      saveCount += 1;
      persistedSettings = request.settings;
      persistedRevision = `revision-${saveCount}`;
      return {
        settings: persistedSettings,
        revision: persistedRevision,
        runtimeApply: saveCount === 1
          ? { status: "degraded", errorMessage: "Command discovery needs recovery." }
          : { status: "applied" },
      };
    });
    vi.stubGlobal("window", workspaceWindow(persistedSettings, persistedRevision, saveSettings));
    const settingsRef = { current: persistedSettings };
    const revisionRef = { current: persistedRevision };
    const controllerRef: { current: ReturnType<typeof useWorkspaceSettingsController> | null } = { current: null };
    renderToStaticMarkup(
      <WorkspaceSettingsControllerHarness
        controllerRef={controllerRef}
        options={{
          workspaceSettingsRef: settingsRef,
          workspaceSettingsRevisionRef: revisionRef,
          applyWorkspaceSettings: vi.fn(),
          refreshWorkspaceModel: vi.fn(async () => undefined),
          setIndexStatus: vi.fn(),
        }}
      />,
    );

    await controllerRef.current!.saveSettingsPatch({ terminalFontSize: 14 });
    await controllerRef.current!.saveSettingsPatch({ terminalFontSize: 15 });
    await controllerRef.current!.retryRuntimeApply();

    expect(saveSettings).toHaveBeenCalledTimes(2);
    expect(settingsRef.current.terminalFontSize).toBe(15);
  });

  it("queues dialog autosave before structural Apply and advances the revision", async () => {
    const firstSave = deferred<WorkspaceSettingsSaveOutcome>();
    const saveSettings = vi.fn()
      .mockImplementationOnce(() => firstSave.promise)
      .mockImplementationOnce(async (request: WorkspaceSettingsSaveRequest) =>
        saveOutcome(request.settings, "revision-2"));
    const settingsRef = { current: workspaceSettings() };
    const revisionRef = { current: "revision-0" };
    vi.stubGlobal("window", workspaceWindow(settingsRef.current, revisionRef.current, saveSettings));
    const controller = renderController(settingsRef, revisionRef);
    const autosaveDraft = workspaceSettingsDialogFixture({
      settingsRevision: "revision-0",
      terminalFontSize: "14",
    });
    const structuralDraft = {
      ...autosaveDraft,
      workspaceRoot: "/workspace ",
    };

    const autosave = controller.saveDialog(autosaveDraft);
    const apply = controller.saveDialog(structuralDraft, { includeStructural: true });
    await flushMicrotasks();

    expect(saveSettings).toHaveBeenCalledTimes(1);
    const firstRequest = saveSettings.mock.calls[0]?.[0] as WorkspaceSettingsSaveRequest;
    expect(firstRequest.expectedRevision).toBe("revision-0");
    firstSave.resolve(saveOutcome(firstRequest.settings, "revision-1"));
    await waitForSaveCount(saveSettings, 2);
    await Promise.all([autosave, apply]);

    expect(saveSettings.mock.calls.map(([request]) => request.expectedRevision)).toEqual([
      "revision-0",
      "revision-1",
    ]);
    expect(revisionRef.current).toBe("revision-2");
  });

  it("queues a settings patch after structural Apply and advances the revision", async () => {
    const firstSave = deferred<WorkspaceSettingsSaveOutcome>();
    const saveSettings = vi.fn()
      .mockImplementationOnce(() => firstSave.promise)
      .mockImplementationOnce(async (request: WorkspaceSettingsSaveRequest) =>
        saveOutcome(request.settings, "revision-2"));
    const settingsRef = { current: workspaceSettings() };
    const revisionRef = { current: "revision-0" };
    vi.stubGlobal("window", workspaceWindow(settingsRef.current, revisionRef.current, saveSettings));
    const controller = renderController(settingsRef, revisionRef);

    const apply = controller.saveDialog(
      workspaceSettingsDialogFixture({ settingsRevision: "revision-0", workspaceRoot: "/workspace " }),
      { includeStructural: true },
    );
    const patch = controller.saveSettingsPatch({ terminalFontSize: 16 });
    await flushMicrotasks();

    expect(saveSettings).toHaveBeenCalledTimes(1);
    const firstRequest = saveSettings.mock.calls[0]?.[0] as WorkspaceSettingsSaveRequest;
    firstSave.resolve(saveOutcome(firstRequest.settings, "revision-1"));
    await waitForSaveCount(saveSettings, 2);
    await Promise.all([apply, patch]);

    expect(saveSettings.mock.calls.map(([request]) => request.expectedRevision)).toEqual([
      "revision-0",
      "revision-1",
    ]);
    expect(settingsRef.current.terminalFontSize).toBe(16);
  });

  it("clears an older runtime issue when a dialog save applies", async () => {
    const settingsRef = { current: workspaceSettings() };
    const revisionRef = { current: "revision-0" };
    const saveSettings = vi.fn()
      .mockImplementationOnce(async (request: WorkspaceSettingsSaveRequest): Promise<WorkspaceSettingsSaveOutcome> => ({
        settings: request.settings,
        revision: "revision-1",
        runtimeApply: { status: "degraded", errorMessage: "Command discovery needs recovery." },
      }))
      .mockImplementationOnce(async (request: WorkspaceSettingsSaveRequest): Promise<WorkspaceSettingsSaveOutcome> =>
        saveOutcome(request.settings, "revision-2"));
    vi.stubGlobal("window", workspaceWindow(settingsRef.current, revisionRef.current, saveSettings));
    const controller = renderController(settingsRef, revisionRef);

    await controller.saveSettingsPatch({ terminalFontSize: 14 });
    await controller.saveDialog(workspaceSettingsDialogFixture({ terminalFontSize: "15" }));
    await controller.retryRuntimeApply();

    expect(saveSettings).toHaveBeenCalledTimes(2);
    expect(settingsRef.current.terminalFontSize).toBe(15);
  });

  it("retries the committed settings after a degraded structural dialog save", async () => {
    const settingsRef = { current: workspaceSettings() };
    const revisionRef = { current: "revision-0" };
    const saveSettings = vi.fn()
      .mockImplementationOnce(async (request: WorkspaceSettingsSaveRequest): Promise<WorkspaceSettingsSaveOutcome> => ({
        settings: request.settings,
        revision: "revision-1",
        runtimeApply: { status: "degraded", errorMessage: "Watcher recovery is required." },
      }))
      .mockImplementationOnce(async (request: WorkspaceSettingsSaveRequest): Promise<WorkspaceSettingsSaveOutcome> =>
        saveOutcome(request.settings, "revision-2"));
    vi.stubGlobal("window", workspaceWindow(settingsRef.current, revisionRef.current, saveSettings));
    const refreshWorkspaceModel = vi.fn(async () => undefined);
    const controllerRef: { current: ReturnType<typeof useWorkspaceSettingsController> | null } = { current: null };
    renderToStaticMarkup(
      <WorkspaceSettingsControllerHarness
        controllerRef={controllerRef}
        options={{
          workspaceSettingsRef: settingsRef,
          workspaceSettingsRevisionRef: revisionRef,
          applyWorkspaceSettings: vi.fn(),
          refreshWorkspaceModel,
          setIndexStatus: vi.fn(),
        }}
      />,
    );

    await controllerRef.current!.saveDialog(
      workspaceSettingsDialogFixture({ workspaceRoot: "/workspace-b" }),
      { includeStructural: true },
    );
    await controllerRef.current!.retryRuntimeApply();

    expect(saveSettings).toHaveBeenCalledTimes(2);
    expect(saveSettings.mock.calls[1]?.[0].settings.workspaceRoot).toBe("/workspace-b");
    expect(refreshWorkspaceModel).toHaveBeenCalledTimes(2);
  });

  it("keeps recovery available when retry applies but renderer publication fails", async () => {
    const settingsRef = { current: workspaceSettings() };
    const revisionRef = { current: "revision-0" };
    let saveCount = 0;
    const saveSettings = vi.fn(async (request: WorkspaceSettingsSaveRequest): Promise<WorkspaceSettingsSaveOutcome> => {
      saveCount += 1;
      return {
        settings: request.settings,
        revision: `revision-${saveCount}`,
        runtimeApply: saveCount === 1
          ? { status: "degraded", errorMessage: "Command discovery needs recovery." }
          : { status: "applied" },
      };
    });
    const refreshWorkspaceModel = vi.fn()
      .mockRejectedValueOnce(new Error("Workspace model refresh failed."))
      .mockResolvedValue(undefined);
    vi.stubGlobal("window", workspaceWindow(settingsRef.current, revisionRef.current, saveSettings));
    const controllerRef: { current: ReturnType<typeof useWorkspaceSettingsController> | null } = { current: null };
    renderToStaticMarkup(
      <WorkspaceSettingsControllerHarness
        controllerRef={controllerRef}
        options={{
          workspaceSettingsRef: settingsRef,
          workspaceSettingsRevisionRef: revisionRef,
          applyWorkspaceSettings: vi.fn(),
          refreshWorkspaceModel,
          setIndexStatus: vi.fn(),
        }}
      />,
    );

    await controllerRef.current!.saveSettingsPatch({ terminalFontSize: 14 });
    await expect(controllerRef.current!.retryRuntimeApply()).rejects.toThrow("Workspace model refresh failed.");
    await expect(controllerRef.current!.retryRuntimeApply()).resolves.toBeUndefined();

    expect(saveSettings).toHaveBeenCalledTimes(3);
    expect(refreshWorkspaceModel).toHaveBeenCalledTimes(2);
  });

  it("does not let an older retry publication failure overwrite a newer healthy save", async () => {
    const settingsRef = { current: workspaceSettings() };
    const revisionRef = { current: "revision-0" };
    let saveCount = 0;
    const saveSettings = vi.fn(async (request: WorkspaceSettingsSaveRequest): Promise<WorkspaceSettingsSaveOutcome> => {
      saveCount += 1;
      return {
        settings: request.settings,
        revision: `revision-${saveCount}`,
        runtimeApply: saveCount === 1
          ? { status: "degraded", errorMessage: "Command discovery needs recovery." }
          : { status: "applied" },
      };
    });
    const retryPublication = deferred<void>();
    vi.stubGlobal("window", workspaceWindow(settingsRef.current, revisionRef.current, saveSettings));
    const controllerRef: { current: ReturnType<typeof useWorkspaceSettingsController> | null } = { current: null };
    renderToStaticMarkup(
      <WorkspaceSettingsControllerHarness
        controllerRef={controllerRef}
        options={{
          workspaceSettingsRef: settingsRef,
          workspaceSettingsRevisionRef: revisionRef,
          applyWorkspaceSettings: vi.fn(),
          refreshWorkspaceModel: vi.fn(() => retryPublication.promise),
          setIndexStatus: vi.fn(),
        }}
      />,
    );

    await controllerRef.current!.saveSettingsPatch({ terminalFontSize: 14 });
    const retry = controllerRef.current!.retryRuntimeApply();
    await waitForSaveCount(saveSettings, 2);
    const newerPatch = controllerRef.current!.saveSettingsPatch({ terminalFontSize: 15 });
    retryPublication.reject(new Error("Old renderer publication failed."));

    await expect(retry).rejects.toThrow("Old renderer publication failed.");
    await expect(newerPatch).resolves.toBeUndefined();
    await expect(controllerRef.current!.retryRuntimeApply()).resolves.toBeUndefined();

    expect(saveSettings).toHaveBeenCalledTimes(3);
    expect(settingsRef.current.terminalFontSize).toBe(15);
  });

  it("publishes the returned settings after a non-structural dialog save", async () => {
    const settingsRef = { current: workspaceSettings() };
    const revisionRef = { current: "revision-0" };
    const returnedSettings = { ...settingsRef.current, terminalFontSize: 16 };
    const saveSettings = vi.fn(async () => saveOutcome(returnedSettings, "revision-1"));
    const applyWorkspaceSettings = vi.fn();
    const refreshWorkspaceModel = vi.fn(async () => undefined);
    vi.stubGlobal("window", workspaceWindow(settingsRef.current, revisionRef.current, saveSettings));
    const controllerRef: { current: ReturnType<typeof useWorkspaceSettingsController> | null } = { current: null };
    renderToStaticMarkup(
      <WorkspaceSettingsControllerHarness
        controllerRef={controllerRef}
        options={{
          workspaceSettingsRef: settingsRef,
          workspaceSettingsRevisionRef: revisionRef,
          applyWorkspaceSettings,
          refreshWorkspaceModel,
          setIndexStatus: vi.fn(),
        }}
      />,
    );
    const controller = controllerRef.current;
    if (!controller) throw new Error("Workspace Settings controller did not render.");

    await controller.saveDialog(workspaceSettingsDialogFixture({ terminalFontSize: "14" }));

    expect(applyWorkspaceSettings).toHaveBeenCalledWith(returnedSettings);
    expect(refreshWorkspaceModel).not.toHaveBeenCalled();
  });

  it("publishes each structural Apply model and index status before the next Apply starts", async () => {
    const firstSave = deferred<WorkspaceSettingsSaveOutcome>();
    const secondSave = deferred<WorkspaceSettingsSaveOutcome>();
    const firstRefresh = deferred<void>();
    const secondRefresh = deferred<void>();
    const firstStatus = deferred<ReturnType<typeof indexStatus>>();
    const secondStatus = deferred<ReturnType<typeof indexStatus>>();
    const settingsRef = { current: workspaceSettings() };
    const revisionRef = { current: "revision-0" };
    const ui = {
      settings: settingsRef.current,
      modelWorkspaceRoot: null as string | null,
      indexStatus: null as ReturnType<typeof indexStatus> | null,
    };
    const saveSettings = vi.fn()
      .mockImplementationOnce(() => firstSave.promise)
      .mockImplementationOnce(() => secondSave.promise);
    const refreshWorkspaceModel = vi.fn(async () => {
      const modelWorkspaceRoot = settingsRef.current.workspaceRoot;
      const refresh = modelWorkspaceRoot === "/workspace-a" ? firstRefresh : secondRefresh;
      await refresh.promise;
      ui.modelWorkspaceRoot = modelWorkspaceRoot;
    });
    const getIndexStatus = vi.fn(() =>
      settingsRef.current.workspaceRoot === "/workspace-a" ? firstStatus.promise : secondStatus.promise);
    vi.stubGlobal("window", {
      exograph: {
        workspace: {
          getSettings: vi.fn(async () => ({ settings: settingsRef.current, revision: revisionRef.current })),
          saveSettings,
          getIndexStatus,
        },
      },
    });
    const controllerRef: { current: ReturnType<typeof useWorkspaceSettingsController> | null } = { current: null };
    renderToStaticMarkup(
      <WorkspaceSettingsControllerHarness
        controllerRef={controllerRef}
        options={{
          workspaceSettingsRef: settingsRef,
          workspaceSettingsRevisionRef: revisionRef,
          applyWorkspaceSettings: (settings) => { ui.settings = settings; },
          refreshWorkspaceModel,
          setIndexStatus: (status) => { ui.indexStatus = typeof status === "function" ? status(ui.indexStatus) : status; },
        }}
      />,
    );
    const controller = controllerRef.current;
    if (!controller) throw new Error("Workspace Settings controller did not render.");

    const applyA = controller.saveDialog(
      workspaceSettingsDialogFixture({ workspaceRoot: "/workspace-a" }),
      { includeStructural: true },
    );
    const applyB = controller.saveDialog(
      workspaceSettingsDialogFixture({ workspaceRoot: "/workspace-b" }),
      { includeStructural: true },
    );

    await flushMicrotasks();
    firstSave.resolve(saveOutcome({ ...settingsRef.current, workspaceRoot: "/workspace-a" }, "revision-1"));
    await flushMicrotasks();
    expect(refreshWorkspaceModel).toHaveBeenCalledTimes(1);
    expect(saveSettings).toHaveBeenCalledTimes(1);

    firstRefresh.resolve();
    await flushMicrotasks();
    expect(getIndexStatus).toHaveBeenCalledTimes(1);
    expect(saveSettings).toHaveBeenCalledTimes(1);

    firstStatus.resolve(indexStatus("A"));
    await waitForSaveCount(saveSettings, 2);
    secondSave.resolve(saveOutcome({ ...settingsRef.current, workspaceRoot: "/workspace-b" }, "revision-2"));
    await flushMicrotasks();
    expect(refreshWorkspaceModel).toHaveBeenCalledTimes(2);

    secondRefresh.resolve();
    await flushMicrotasks();
    expect(getIndexStatus).toHaveBeenCalledTimes(2);
    secondStatus.resolve(indexStatus("B"));
    await Promise.all([applyA, applyB]);

    expect(ui).toMatchObject({
      settings: { workspaceRoot: "/workspace-b" },
      modelWorkspaceRoot: "/workspace-b",
      indexStatus: indexStatus("B"),
    });
    expect(revisionRef.current).toBe("revision-2");
  });

  it("surfaces a genuine external revision conflict without overwriting local settings", async () => {
    const settingsRef = { current: workspaceSettings() };
    const revisionRef = { current: "revision-0" };
    const saveSettings = vi.fn(async () => {
      throw new Error("workspace-settings-stale");
    });
    vi.stubGlobal("window", workspaceWindow(settingsRef.current, revisionRef.current, saveSettings));
    const controller = renderController(settingsRef, revisionRef);

    await expect(controller.saveSettingsPatch({ terminalFontSize: 18 })).rejects.toThrow("workspace-settings-stale");

    expect(saveSettings).toHaveBeenCalledTimes(1);
    expect(settingsRef.current.terminalFontSize).toBe(13);
    expect(revisionRef.current).toBe("revision-0");
  });
});

describe("index activity presentation", () => {
  it("maps identifiable automatic embedding work to the embedding state", () => {
    expect(indexBusyStateForEvent({ state: "running", reason: "automatic-embedding-catch-up" })).toBe("embedding");
    expect(indexBusyStateForEvent({ state: "running", reason: "note-save" })).toBe("updating");
    expect(indexBusyStateForEvent({ state: "running", reason: "settings" }, "embedding")).toBe("embedding");
    expect(indexBusyStateForEvent({ state: "idle", reason: "automatic-embedding-catch-up" }, "embedding")).toBeNull();
  });
});

describe("workspace settings structural persistence", () => {
  it("blocks malformed or colliding Command drafts before a Settings save", () => {
    const claude = {
      id: "claude",
      label: "Claude",
      handle: "claude",
      command: "/bin/echo",
      adapter: "generic" as const,
      continuityPolicy: "fresh" as const,
      cwdPolicy: "workspace_root" as const,
      promptDelivery: "stdin" as const,
      version: 1,
      enabled: true,
    };
    const current = workspaceSettings();

    expect(() => workspaceSettingsFromDialog(
      workspaceSettingsDialogFixture({ agentCommands: [{ ...claude, command: "" }] }),
      { includeStructural: false },
      current,
    )).toThrow("Command 1 is malformed");
    expect(() => workspaceSettingsFromDialog(
      workspaceSettingsDialogFixture({ agentCommands: [claude, { ...claude, id: "copy" }] }),
      { includeStructural: false },
      current,
    )).toThrow("Command handle @claude is already configured");
  });

  it("persists an explicit overflow-label preference without a structural Apply", () => {
    const current = workspaceSettings();
    const next = workspaceSettingsFromDialog(
      workspaceSettingsDialogFixture({ graphShowOverflowLabels: false }),
      { includeStructural: false },
      current,
    );
    expect(next.graphShowOverflowLabels).toBe(false);
    expect(next.noteRoots).toEqual(current.noteRoots);
  });

  it("retains complete existing indexed roots while applying structural settings", () => {
    const root = {
      id: "research-docs",
      label: "Research documents",
      path: "/workspace/notes/research",
      kind: "docs" as const,
      pattern: "**/*.{md,mdx}",
      ignore: ["private/**", "archive/**"],
      backend: "filesystem" as const,
      futureRootOption: { source: "newer-exograph" },
    };
    const current = {
      ...workspaceSettings(),
      indexedRoots: [root],
      indexing: { enabled: true, mode: "lexical" as const, backend: "qmd" as const },
      searchEngine: "qmd" as const,
    } as WorkspaceSettings;

    const next = workspaceSettingsFromDialog(
      workspaceSettingsDialogFixture({ indexedRoots: [root] }),
      { includeStructural: true },
      current,
    );

    expect(next.indexedRoots).toEqual([root]);
  });

  it("removes omitted roots and applies defaults only to new paths", () => {
    const retained = {
      id: "research-docs",
      label: "Research documents",
      path: "/workspace/notes/research",
      kind: "docs" as const,
      pattern: "**/*.mdx",
      ignore: ["private/**"],
      backend: "qmd" as const,
    };
    const removed = {
      id: "archive",
      label: "Archive",
      path: "/workspace/notes/archive",
      kind: "notes" as const,
      pattern: "**/*.md",
      ignore: [],
      backend: "qmd" as const,
    };
    const current = {
      ...workspaceSettings(),
      indexedRoots: [retained, removed],
    } as WorkspaceSettings;

    const next = workspaceSettingsFromDialog(
      workspaceSettingsDialogFixture({ indexedRoots: [retained, defaultIndexedRoot("/workspace/notes/new", 1)] }),
      { includeStructural: true },
      current,
    );

    expect(next.indexedRoots).toEqual([
      retained,
      {
        id: "index-root-2",
        label: "new",
        path: "/workspace/notes/new",
        kind: "mixed",
        pattern: "**/*.md",
        ignore: [],
        backend: "qmd",
      },
    ]);
  });
});

interface WorkspaceSettingsControllerHarnessProps {
  controllerRef: { current: ReturnType<typeof useWorkspaceSettingsController> | null };
  options: Parameters<typeof useWorkspaceSettingsController>[0];
}

function WorkspaceSettingsControllerHarness(props: WorkspaceSettingsControllerHarnessProps) {
  props.controllerRef.current = useWorkspaceSettingsController(props.options);
  return null;
}

function renderController(
  settingsRef: { current: WorkspaceSettings },
  revisionRef: { current: string },
): ReturnType<typeof useWorkspaceSettingsController> {
  const controllerRef: { current: ReturnType<typeof useWorkspaceSettingsController> | null } = { current: null };
  renderToStaticMarkup(
    <WorkspaceSettingsControllerHarness
      controllerRef={controllerRef}
      options={{
        workspaceSettingsRef: settingsRef,
        workspaceSettingsRevisionRef: revisionRef,
        applyWorkspaceSettings: vi.fn(),
        refreshWorkspaceModel: vi.fn(async () => undefined),
        setIndexStatus: vi.fn(),
      }}
    />,
  );
  if (!controllerRef.current) {
    throw new Error("Workspace Settings controller did not render.");
  }
  return controllerRef.current;
}

function workspaceWindow(
  settings: WorkspaceSettings,
  revision: string,
  saveSettings: (request: WorkspaceSettingsSaveRequest) => Promise<WorkspaceSettingsSaveOutcome>,
) {
  return {
    exograph: {
      workspace: {
        getSettings: vi.fn(async () => ({ settings, revision })),
        saveSettings,
        getIndexStatus: vi.fn(async () => indexStatus("default")),
      },
    },
  };
}

function saveOutcome(settings: WorkspaceSettings, revision: string): WorkspaceSettingsSaveOutcome {
  return {
    settings,
    revision,
    runtimeApply: { status: "applied" },
  };
}

function workspaceSettings(): WorkspaceSettings {
  return {
    workspaceRoot: "/workspace",
    defaultTerminalCwd: "/workspace",
    noteRoots: ["/workspace/notes"],
    indexedRoots: [],
    indexing: { enabled: false, mode: "off", backend: "qmd" },
    appearanceMode: "system",
    colorThemeId: "exograph-neutral",
    editorFontSize: 15,
    terminalFontSize: 13,
    explorerScale: 1,
    graphInverseNavigation: true,
    graphShowOverflowLabels: true,
    exploreIndexSearchOnEnter: false,
    indexUpdateStrategy: "on-save",
  };
}

function indexStatus(label: string) {
  return {
    workspaceId: `workspace-${label}`,
    updatedAt: 0,
    roots: [],
  } as unknown as import("@exograph/core").IndexStatus;
}

function deferred<Value>() {
  let resolve!: (value: Value | PromiseLike<Value>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve();
  }
}

async function waitForSaveCount(saveSettings: ReturnType<typeof vi.fn>, count: number): Promise<void> {
  for (let index = 0; index < 50; index += 1) {
    if (saveSettings.mock.calls.length >= count) {
      return;
    }
    await Promise.resolve();
  }
  throw new Error(`Expected ${count} Settings saves, received ${saveSettings.mock.calls.length}.`);
}
