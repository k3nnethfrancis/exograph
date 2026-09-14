import { EventEmitter } from "node:events";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const electronMock = vi.hoisted(() => ({
  appQuit: vi.fn(),
  commandServerStatus: { listening: true, port: 4317 as number | null },
  dialogResponse: 1,
  openSettings: vi.fn(),
  restartCommandServer: vi.fn(),
  openExternal: vi.fn(),
  showMessageBox: vi.fn(),
  showDefinitionForSelection: vi.fn(),
  replaceMisspelling: vi.fn(),
  addWordToSpellCheckerDictionary: vi.fn(),
  trayImageCreateFromDataURL: vi.fn(),
  trayImageCreateFromPath: vi.fn(),
  trayImageSetTemplateImage: vi.fn(),
  trayImageIsEmpty: false,
  trayInstances: [] as Array<any>,
  windows: [] as Array<any>,
  menuTemplate: [] as Array<Record<string, unknown>>,
}));

vi.mock("electron", () => ({
  app: {
    quit: electronMock.appQuit,
  },
  dialog: {
    showMessageBox: electronMock.showMessageBox,
  },
  shell: {
    openExternal: electronMock.openExternal,
  },
  BrowserWindow: class MockBrowserWindow extends EventEmitter {
    static getAllWindows() {
      return electronMock.windows.filter((window) => !window.destroyed);
    }

    readonly mainFrame = {};
    readonly webContents = Object.assign(new EventEmitter(), {
      id: electronMock.windows.length + 1,
      mainFrame: this.mainFrame,
      executeJavaScript: vi.fn(async () => undefined),
      setWindowOpenHandler: vi.fn((handler) => {
        this.windowOpenHandler = handler;
      }),
      replaceMisspelling: electronMock.replaceMisspelling,
      showDefinitionForSelection: electronMock.showDefinitionForSelection,
      session: {
        addWordToSpellCheckerDictionary: electronMock.addWordToSpellCheckerDictionary,
      },
    });
    windowOpenHandler: ((details: { url: string }) => { action: string }) | null = null;
    destroyed = false;
    visible = false;
    hidden = false;
    minimized = false;
    focused = false;
    backgroundColor = "";

    constructor(readonly options: Record<string, unknown>) {
      super();
      electronMock.windows.push(this);
    }

    loadURL = vi.fn(async () => undefined);
    loadFile = vi.fn(async () => undefined);

    isDestroyed() {
      return this.destroyed;
    }

    isVisible() {
      return this.visible;
    }

    show() {
      this.visible = true;
      this.hidden = false;
    }

    hide() {
      this.visible = false;
      this.hidden = true;
    }

    focus() {
      this.focused = true;
    }

    isMinimized() {
      return this.minimized;
    }

    restore() {
      this.minimized = false;
    }

    setBackgroundColor(color: string) {
      this.backgroundColor = color;
    }
  },
  Menu: {
    buildFromTemplate: (template: Array<Record<string, unknown>>) => {
      electronMock.menuTemplate = template;
      return { template, popup: vi.fn() };
    },
  },
  nativeImage: {
    createEmpty: () => ({
      isEmpty: () => electronMock.trayImageIsEmpty,
      setTemplateImage: electronMock.trayImageSetTemplateImage,
    }),
    createFromDataURL: (dataUrl: string) => {
      electronMock.trayImageCreateFromDataURL(dataUrl);
      return {
        isEmpty: () => electronMock.trayImageIsEmpty,
        setTemplateImage: electronMock.trayImageSetTemplateImage,
      };
    },
    createFromPath: (iconPath: string) => {
      electronMock.trayImageCreateFromPath(iconPath);
      return {
        isEmpty: () => electronMock.trayImageIsEmpty,
        setTemplateImage: electronMock.trayImageSetTemplateImage,
      };
    },
  },
  nativeTheme: {
    shouldUseDarkColors: true,
  },
  Tray: class MockTray extends EventEmitter {
    setToolTip = vi.fn();
    setContextMenu = vi.fn();

    constructor(readonly image: unknown) {
      super();
      electronMock.trayInstances.push(this);
    }
  },
}));

import { AppLifecycleController } from "./app-lifecycle";

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));

describe("AppLifecycleController", () => {
  beforeEach(() => {
    delete process.env.EXOGRAPH_TEST;
    delete process.env.ELECTRON_RENDERER_URL;
    delete process.env.VITE_DEV_SERVER_URL;
    electronMock.appQuit.mockClear();
    electronMock.commandServerStatus = { listening: true, port: 4317 };
    electronMock.dialogResponse = 1;
    electronMock.openSettings.mockClear();
    electronMock.restartCommandServer.mockClear();
    electronMock.openExternal.mockClear();
    electronMock.showMessageBox.mockReset();
    electronMock.showMessageBox.mockImplementation(async () => ({ response: electronMock.dialogResponse }));
    electronMock.trayImageCreateFromDataURL.mockClear();
    electronMock.trayImageCreateFromPath.mockClear();
    electronMock.trayImageSetTemplateImage.mockClear();
    electronMock.trayImageIsEmpty = false;
    electronMock.trayInstances.length = 0;
    electronMock.windows.length = 0;
    electronMock.menuTemplate = [];
    electronMock.showDefinitionForSelection.mockClear();
    electronMock.replaceMisspelling.mockClear();
    electronMock.addWordToSpellCheckerDictionary.mockClear();
  });

  it("blocks Workspace replacement when renderer preparation reports a conflict", async () => {
    const controller = appLifecycleController();
    const window = controller.createWindow() as any;
    window.webContents.emit("did-finish-load");
    window.webContents.executeJavaScript.mockRejectedValueOnce(new Error("Resolve document conflict"));
    const replaceWorkspace = vi.fn(async () => undefined);
    await expect(controller.withDocumentsFlushed(replaceWorkspace)).rejects.toThrow("Resolve document conflict");
    expect(replaceWorkspace).not.toHaveBeenCalled();
  });

  it("keeps editing frozen across a Workspace mutation and releases it even if the mutation fails", async () => {
    const controller = appLifecycleController();
    const window = controller.createWindow() as any;
    window.webContents.emit("did-finish-load");
    const order: string[] = [];
    window.webContents.executeJavaScript.mockImplementation(async (script: string) => { order.push(script.includes("Prepare") ? "prepare" : "finish"); });
    await expect(controller.withDocumentsFlushed(async () => { order.push("replace"); throw new Error("failed"); })).rejects.toThrow("failed");
    expect(order).toEqual(["prepare", "replace", "finish"]);
  });

  it("blocks packaged Cmd-R when a conflict prevents preparation", async () => {
    const controller = appLifecycleController();
    const window = controller.createWindow() as any;
    window.webContents.emit("did-finish-load");
    window.webContents.executeJavaScript.mockRejectedValueOnce(new Error("Resolve document conflict"));
    const event = { preventDefault: vi.fn() };
    window.webContents.emit("before-input-event", event, { type: "keyDown", meta: true, key: "r" });
    await Promise.resolve();
    await Promise.resolve();
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(window.loadFile).toHaveBeenCalledOnce();
  });

  it("hides the workspace window on close so the process can keep running", () => {
    const controller = appLifecycleController();
    const window = controller.createWindow() as any;
    const event = { preventDefault: vi.fn() };

    window.show();
    window.emit("close", event);

    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(window.hidden).toBe(true);
    expect(controller.getMainWindow()).toBe(window);
  });

  it("hardens the privileged renderer and rejects unexpected navigation or windows", () => {
    const controller = appLifecycleController();
    const window = controller.createWindow() as any;
    const webPreferences = window.options.webPreferences;
    expect(webPreferences).toMatchObject({ contextIsolation: true, nodeIntegration: false, sandbox: true });

    const navigation = { preventDefault: vi.fn() };
    window.webContents.emit("will-navigate", navigation, "https://example.com/phishing");
    expect(navigation.preventDefault).toHaveBeenCalledOnce();

    expect(window.windowOpenHandler({ url: "file:///tmp/private" })).toEqual({ action: "deny" });
    expect(electronMock.openExternal).not.toHaveBeenCalled();
    expect(window.windowOpenHandler({ url: "https://example.com/docs" })).toEqual({ action: "deny" });
    expect(electronMock.openExternal).toHaveBeenCalledWith("https://example.com/docs");
  });

  it("destroys windows during explicit quit", async () => {
    const controller = appLifecycleController();
    const window = controller.createWindow() as any;
    const event = { preventDefault: vi.fn() };

    await controller.requestQuit();
    window.emit("close", event);

    expect(electronMock.appQuit).toHaveBeenCalledOnce();
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it("warns before quitting with live terminals", async () => {
    electronMock.dialogResponse = 0;
    const controller = appLifecycleController([{ id: "term-1", status: "running" }]);

    await controller.requestQuit();

    expect(electronMock.showMessageBox).toHaveBeenCalledOnce();
    expect(electronMock.appQuit).not.toHaveBeenCalled();
  });

  it("restores a hidden window from the tray show path", () => {
    const controller = appLifecycleController();
    const window = controller.createWindow() as any;
    window.hide();

    controller.showMainWindow();

    expect(window.visible).toBe(true);
    expect(window.focused).toBe(true);
  });

  it("builds a resident menu with status and recovery actions", () => {
    const controller = appLifecycleController([
      { id: "term-1", status: "running" },
      { id: "term-2", status: "exited" },
    ]);

    controller.createWindow();
    controller.setupTray();

    expect(electronMock.trayImageCreateFromDataURL).toHaveBeenCalledWith(expect.stringMatching(/^data:image\/png;base64,/));
    expect(electronMock.trayImageCreateFromPath).not.toHaveBeenCalled();
    expect(electronMock.trayImageSetTemplateImage).toHaveBeenCalledWith(true);
    expect(electronMock.trayInstances).toHaveLength(1);
    expect(electronMock.trayInstances[0].setToolTip).toHaveBeenCalledWith("Exograph");
    expect(menuLabels()).toContain("Show Exograph");
    expect(menuLabels()).toContain("Settings...");
    expect(menuLabels()).toContain("Exograph is Running");
    expect(menuLabels()).toContain("Window: Hidden");
    expect(menuLabels()).toContain("Command Server: Running:4317");
    expect(menuLabels()).toContain("Live Terminals: 1");
    expect(menuLabels()).toContain("Restart Command Server");
    expect(menuLabels()).toContain("Quit Exograph");
  });

  it("does not require a packaged tray asset on disk", () => {
    const controller = appLifecycleController([], {
      currentDirectory: path.join(currentDirectory, "missing-packaged-dist"),
    });

    controller.setupTray();

    expect(electronMock.trayImageCreateFromDataURL).toHaveBeenCalledWith(expect.stringMatching(/^data:image\/png;base64,/));
    expect(electronMock.trayImageCreateFromPath).not.toHaveBeenCalled();
    expect(electronMock.trayInstances).toHaveLength(1);
  });

  it("uses the canonical six-branch mark as a transparent template tray glyph", () => {
    const controller = appLifecycleController();

    controller.setupTray();

    const dataUrl = electronMock.trayImageCreateFromDataURL.mock.calls[0]?.[0];
    expect(dataUrl).toEqual(expect.stringMatching(/^data:image\/png;base64,/));
  });

  it("fails loudly instead of installing an invisible menu-bar status item", () => {
    const controller = appLifecycleController();
    electronMock.trayImageIsEmpty = true;

    expect(() => controller.setupTray()).toThrow(/Failed to decode Exograph's macOS menu-bar icon/);
    expect(electronMock.trayInstances).toHaveLength(0);
  });

  it("opens settings from the resident menu without quitting the runtime", () => {
    const controller = appLifecycleController();
    controller.createWindow();
    controller.setupTray();

    clickMenuItem("Settings...");

    expect(electronMock.openSettings).toHaveBeenCalledOnce();
    expect(electronMock.appQuit).not.toHaveBeenCalled();
  });

  it("uses Electron's native editable context menu with spelling and selection actions", () => {
    const controller = appLifecycleController();
    const window = controller.createWindow() as any;
    const event = { preventDefault: vi.fn() };

    window.webContents.emit("context-menu", event, editableContext({
      selectionText: "teh",
      misspelledWord: "teh",
      dictionarySuggestions: ["the"],
    }));

    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(menuLabels()).toEqual(expect.arrayContaining(["the", "Add to Dictionary"]));
    expect(menuRoles()).toEqual(expect.arrayContaining([
      "undo",
      "redo",
      "cut",
      "copy",
      "paste",
      "pasteAndMatchStyle",
      "delete",
      "selectAll",
    ]));
    clickMenuItem("the");
    expect(electronMock.replaceMisspelling).toHaveBeenCalledWith("the");
    clickMenuItem("Add to Dictionary");
    expect(electronMock.addWordToSpellCheckerDictionary).toHaveBeenCalledWith("teh");
    if (process.platform === "darwin") {
      clickMenuItem("Look Up");
      expect(electronMock.showDefinitionForSelection).toHaveBeenCalledOnce();
    }
  });

  it("leaves non-editable context menus alone", () => {
    const controller = appLifecycleController();
    const window = controller.createWindow() as any;
    const event = { preventDefault: vi.fn() };

    window.webContents.emit("context-menu", event, editableContext({ isEditable: false }));

    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(electronMock.menuTemplate).toEqual([]);
  });

  it("restarts command-server discovery from the resident menu", () => {
    const controller = appLifecycleController();
    controller.createWindow();
    controller.setupTray();

    clickMenuItem("Restart Command Server");

    expect(electronMock.restartCommandServer).toHaveBeenCalledOnce();
    expect(electronMock.appQuit).not.toHaveBeenCalled();
  });

  it("reloads the renderer when Electron reports a killed renderer process", () => {
    vi.useFakeTimers();
    try {
      const controller = appLifecycleController();
      const window = controller.createWindow() as any;

      window.webContents.emit("render-process-gone", {}, { reason: "killed", exitCode: 15 });
      vi.advanceTimersByTime(750);

      expect(window.loadFile).toHaveBeenCalledTimes(2);
      expect(window.visible).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("recovers the packaged renderer entry after a failed hard reload without retrying Preview failures", () => {
    vi.useFakeTimers();
    try {
      const controller = appLifecycleController();
      const window = controller.createWindow() as any;
      const rendererUrl = pathToFileURL(path.join(currentDirectory, "../renderer/index.html")).toString();

      window.webContents.emit("did-fail-load", {}, -2, "ERR_FAILED", rendererUrl);
      vi.advanceTimersByTime(750);

      expect(window.loadFile).toHaveBeenCalledTimes(2);

      window.webContents.emit("did-fail-load", {}, -102, "ERR_CONNECTION_REFUSED", "http://localhost:8765");
      vi.advanceTimersByTime(750);

      expect(window.loadFile).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

function appLifecycleController(
  terminals: Array<{ id: string; status: string }> = [],
  overrides: Partial<ConstructorParameters<typeof AppLifecycleController>[0]> = {},
) {
  return new AppLifecycleController({
    currentDirectory,
    getTerminals: () => terminals as any,
    getCommandServerStatus: () => electronMock.commandServerStatus,
    openSettings: electronMock.openSettings,
    restartCommandServer: electronMock.restartCommandServer,
    logMain: () => {},
    ...overrides,
  });
}

function menuLabels(): string[] {
  return electronMock.menuTemplate
    .map((item) => item.label)
    .filter((label): label is string => typeof label === "string");
}

function menuRoles(): string[] {
  return electronMock.menuTemplate
    .map((item) => item.role)
    .filter((role): role is string => typeof role === "string");
}

function clickMenuItem(label: string): void {
  const item = electronMock.menuTemplate.find((entry) => entry.label === label);
  expect(item).toBeTruthy();
  expect(item?.click).toBeTypeOf("function");
  (item!.click as () => void)();
}

function editableContext(overrides: Record<string, unknown> = {}): any {
  return {
    isEditable: true,
    selectionText: "",
    misspelledWord: "",
    dictionarySuggestions: [],
    editFlags: {
      canUndo: true,
      canRedo: true,
      canCut: true,
      canCopy: true,
      canPaste: true,
      canDelete: true,
      canSelectAll: true,
      canEditRichly: false,
    },
    ...overrides,
  };
}
