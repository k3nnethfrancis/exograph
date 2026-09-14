import { expect, test } from "@playwright/test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { launchExographWorkspaceFixture } from "../helpers";

test("renders durable exo invocation envelopes as invocation UI", async () => {
  const invocationId = "11111111-1111-4111-8111-111111111111";
  const markdownContent = [
    "# Invocation compatibility",
    `<exo-invocation id="${invocationId}" agent="claude" status="sent">`,
    "@claude inspect this note",
    "</exo-invocation>",
    "",
    `<exo-agent-response invocation="${invocationId}" agent="claude">`,
    "The durable result.",
    "</exo-agent-response>",
    "",
  ].join("\n");

  const { page, cleanup } = await launchExographWorkspaceFixture({
    mutable: true,
    prepareWorkspace: async (workspaceRoot) => {
      const target = path.join(workspaceRoot, "notes/test-notes/invocation-compatibility.md");
      await writeFile(target, markdownContent, "utf8");
    },
  });

  try {
    await page.getByRole("button", { name: /invocation-compatibility/i }).first().click();
    const envelopeLines = page.locator(".cm-line.inline-agent-invocation__envelope-line");
    await expect(envelopeLines).toHaveCount(4);
    await expect(envelopeLines.first()).toHaveCSS("display", "none");
    await expect(page.locator(".inline-agent-composer__mark")).toContainText("@claude inspect this note");
    await expect(page.locator(".inline-agent-response__mark")).toContainText("The durable result.");
    await expect(page.getByText("<exo-invocation", { exact: false })).toBeHidden();
  } finally {
    await cleanup();
  }
});

test("renders underscore thematic breaks in markdown live preview", async () => {
  const markdownContent = `# Rule Test

Above.

___

Below.
`;

  const { page, cleanup } = await launchExographWorkspaceFixture({
    mutable: true,
    prepareWorkspace: async (workspaceRoot) => {
      const target = path.join(workspaceRoot, "notes/test-notes/rule-test.md");
      await writeFile(target, markdownContent, "utf8");
    },
  });

  await page.getByRole("button", { name: /rule-test/i }).first().click();

  await expect(page.locator(".exograph-md-line--rule")).toHaveCount(1);
  await expect(page.locator(".exograph-md-line--rule .exograph-md-syntax-hidden")).toContainText("___");
  await expect(page.locator(".exograph-md-line--rule")).toHaveCSS("border-top-style", "solid");

  await cleanup();
});

test("continues and exits markdown bullets in live preview", async () => {
  const { page, cleanup } = await launchExographWorkspaceFixture({
    mutable: true,
    prepareWorkspace: async (workspaceRoot) => {
      const target = path.join(workspaceRoot, "notes/test-notes/list-edit-test.md");
      await writeFile(target, "# List Edit Test\n\n- account strategy\n", "utf8");
    },
  });

  await page.getByRole("button", { name: /list-edit-test/i }).first().click();
  await page.locator(".cm-content").click();
  await page.evaluate(() => {
    const content = document.querySelector(".cm-content") as (HTMLElement & { cmView?: { view?: any } }) | null;
    const view = content?.cmView?.view;
    if (!view) {
      throw new Error("Unable to resolve CodeMirror view");
    }
    const target = view.state.doc.toString().indexOf("- account strategy") + "- account strategy".length;
    view.dispatch({ selection: { anchor: target } });
    view.focus();
  });

  await page.keyboard.press("Enter");
  await expect
    .poll(() =>
      page.evaluate(() => {
        const content = document.querySelector(".cm-content") as (HTMLElement & { cmView?: { view?: any } }) | null;
        return content?.cmView?.view?.state.doc.toString() ?? "";
      }),
    )
    .toBe("# List Edit Test\n\n- account strategy\n- \n");

  await page.keyboard.press("Enter");
  await expect
    .poll(() =>
      page.evaluate(() => {
        const content = document.querySelector(".cm-content") as (HTMLElement & { cmView?: { view?: any } }) | null;
        return content?.cmView?.view?.state.doc.toString() ?? "";
      }),
    )
    .toBe("# List Edit Test\n\n- account strategy\n\n");

  await cleanup();
});

test("indents and outdents a multi-line list selection from arbitrary text positions", async () => {
  const initialMarkdown = "# Grouped List Indent\n\n- bullet row\n1. numbered row\n- [ ] todo row\n";
  const { page, cleanup } = await launchExographWorkspaceFixture({
    mutable: true,
    prepareWorkspace: async (workspaceRoot) => {
      const target = path.join(workspaceRoot, "notes/test-notes/grouped-list-indent.md");
      await writeFile(target, initialMarkdown, "utf8");
    },
  });

  try {
    await page.getByRole("button", { name: /grouped-list-indent/i }).first().click();
    await page.locator(".cm-content").click();
    await page.evaluate(() => {
      const content = document.querySelector(".cm-content") as (HTMLElement & { cmView?: { view?: any } }) | null;
      const view = content?.cmView?.view;
      if (!view) throw new Error("Unable to resolve CodeMirror view");
      const doc = view.state.doc.toString();
      const firstStart = doc.indexOf("- bullet row");
      const taskStart = doc.indexOf("- [ ] todo row");
      const firstTextStart = firstStart + "- ".length;
      view.dispatch({ selection: { anchor: firstTextStart + 2, head: taskStart } });
      view.focus();
    });

    await page.keyboard.press("Tab");
    await expect
      .poll(() => page.evaluate(() => {
        const content = document.querySelector(".cm-content") as (HTMLElement & { cmView?: { view?: any } }) | null;
        return content?.cmView?.view?.state.doc.toString() ?? "";
      }))
      .toBe("# Grouped List Indent\n\n  - bullet row\n  1. numbered row\n  - [ ] todo row\n");

    await page.evaluate(() => {
      const content = document.querySelector(".cm-content") as (HTMLElement & { cmView?: { view?: any } }) | null;
      const view = content?.cmView?.view;
      if (!view) throw new Error("Unable to resolve CodeMirror view");
      const doc = view.state.doc.toString();
      const firstMarker = doc.indexOf("- bullet row");
      const taskMarker = doc.indexOf("- [ ] todo row");
      view.dispatch({ selection: { anchor: firstMarker + "- ".length, head: taskMarker - 2 } });
      view.focus();
    });
    await page.keyboard.press("Shift+Tab");
    await expect
      .poll(() => page.evaluate(() => {
        const content = document.querySelector(".cm-content") as (HTMLElement & { cmView?: { view?: any } }) | null;
        return content?.cmView?.view?.state.doc.toString() ?? "";
      }))
      .toBe(initialMarkdown);
  } finally {
    await cleanup();
  }
});

test("renders ordered-list markers at the text size and vertical center", async ({}, testInfo) => {
  const { page, cleanup } = await launchExographWorkspaceFixture({
    mutable: true,
    prepareWorkspace: async (workspaceRoot) => {
      const target = path.join(workspaceRoot, "notes/test-notes/ordered-list-rendering.md");
      await writeFile(target, "# Ordered list\n\n1. First item\n10. Tenth item\n100. Hundredth item\n", "utf8");
    },
  });

  try {
    await page.getByRole("button", { name: /ordered-list-rendering/i }).first().click();
    const firstItem = page.locator(".exograph-md-line--list-ordered").first();

    await expect.poll(() => firstItem.evaluate((line) => {
      const lineStyle = window.getComputedStyle(line);
      const markerStyle = window.getComputedStyle(line, "::before");
      return {
        content: markerStyle.content,
        fontSize: markerStyle.fontSize,
        lineFontSize: lineStyle.fontSize,
        top: markerStyle.top,
        paddingRight: markerStyle.paddingRight,
        boxSizing: markerStyle.boxSizing,
        fontWeight: markerStyle.fontWeight,
        whiteSpace: markerStyle.whiteSpace,
        wrapMode: markerStyle.getPropertyValue("text-wrap-mode"),
      };
    })).toEqual({
      content: '"1."',
      fontSize: "16px",
      lineFontSize: "16px",
      top: "0px",
      paddingRight: "8px",
      boxSizing: "border-box",
      fontWeight: "500",
      whiteSpace: "pre",
      wrapMode: "nowrap",
    });
    await expect(page.locator(".exograph-md-line--list-ordered").nth(1)).toHaveAttribute("data-exograph-list-marker", "10.");
    await expect(page.locator(".exograph-md-line--list-ordered").nth(2)).toHaveAttribute("data-exograph-list-marker", "100.");
    await page.screenshot({ path: testInfo.outputPath("ordered-list-markers.png") });
  } finally {
    await cleanup();
  }
});

test("continues and exits markdown task list items in live preview", async () => {
  const { page, cleanup } = await launchExographWorkspaceFixture({
    mutable: true,
    prepareWorkspace: async (workspaceRoot) => {
      const target = path.join(workspaceRoot, "notes/test-notes/task-list-edit-test.md");
      await writeFile(target, "# Task List Edit Test\n\n- [x] follow up\n", "utf8");
    },
  });

  await page.getByRole("button", { name: /task-list-edit-test/i }).first().click();
  await page.locator(".cm-content").click();
  const taskTextStart = await page.evaluate(() => {
    const content = document.querySelector(".cm-content") as (HTMLElement & { cmView?: { view?: any } }) | null;
    const view = content?.cmView?.view;
    if (!view) {
      throw new Error("Unable to resolve CodeMirror view");
    }
    const text = view.state.doc.toString();
    const textStart = text.indexOf("- [x] follow up") + "- [x] ".length;
    view.dispatch({ selection: { anchor: textStart } });
    view.focus();
    return textStart;
  });
  await expect(page.locator(".exograph-md-checkbox")).toHaveCount(1);
  await expect.poll(() => page.evaluate(() => {
    const content = document.querySelector(".cm-content") as (HTMLElement & { cmView?: { view?: any } }) | null;
    return content?.cmView?.view?.state.selection.main.head ?? -1;
  })).toBe(taskTextStart);

  await page.evaluate(() => {
    const content = document.querySelector(".cm-content") as (HTMLElement & { cmView?: { view?: any } }) | null;
    const view = content?.cmView?.view;
    if (!view) throw new Error("Unable to resolve CodeMirror view");
    const target = view.state.doc.toString().indexOf("- [x] follow up") + "- [x] follow up".length;
    view.dispatch({ selection: { anchor: target } });
    view.focus();
  });

  await page.keyboard.press("Enter");
  await expect
    .poll(() =>
      page.evaluate(() => {
        const content = document.querySelector(".cm-content") as (HTMLElement & { cmView?: { view?: any } }) | null;
        return content?.cmView?.view?.state.doc.toString() ?? "";
      }),
    )
    .toBe("# Task List Edit Test\n\n- [x] follow up\n- [ ] \n");
  await expect(page.locator(".exograph-md-checkbox")).toHaveCount(2);

  await page.keyboard.press("Enter");
  await expect
    .poll(() =>
      page.evaluate(() => {
        const content = document.querySelector(".cm-content") as (HTMLElement & { cmView?: { view?: any } }) | null;
        return content?.cmView?.view?.state.doc.toString() ?? "";
      }),
    )
    .toBe("# Task List Edit Test\n\n- [x] follow up\n\n");

  await cleanup();
});

test("renders and edits ordered lists with aligned nested markers", async () => {
  const { page, cleanup } = await launchExographWorkspaceFixture({
    mutable: true,
    prepareWorkspace: async (workspaceRoot) => {
      const target = path.join(workspaceRoot, "notes/test-notes/ordered-list-edit-test.md");
      await writeFile(target, "# Ordered List Edit Test\n\n9. first\n   1. nested\n10. second\n", "utf8");
    },
  });

  await page.getByRole("button", { name: /ordered-list-edit-test/i }).first().click();
  const orderedLines = page.locator(".exograph-md-line--list-ordered");
  await expect(orderedLines).toHaveCount(3);
  await expect
    .poll(() => orderedLines.evaluateAll((nodes) => nodes.map((node) => ({
      marker: node.getAttribute("data-exograph-list-marker"),
      depth: node.getAttribute("data-exograph-list-depth"),
      paddingLeft: window.getComputedStyle(node).paddingLeft,
      markerContent: window.getComputedStyle(node, "::before").content,
    }))))
    .toEqual([
      { marker: "9.", depth: "0", paddingLeft: "30px", markerContent: '"9."' },
      { marker: "1.", depth: "1", paddingLeft: "58px", markerContent: '"1."' },
      { marker: "10.", depth: "0", paddingLeft: "30px", markerContent: '"10."' },
    ]);

  await page.evaluate(() => {
    const content = document.querySelector(".cm-content") as (HTMLElement & { cmView?: { view?: any } }) | null;
    const view = content?.cmView?.view;
    if (!view) throw new Error("Unable to resolve CodeMirror view");
    const target = view.state.doc.toString().indexOf("10. second") + "10. second".length;
    view.dispatch({ selection: { anchor: target } });
    view.focus();
  });
  await page.keyboard.press("Enter");
  await expect.poll(() => page.evaluate(() => {
    const content = document.querySelector(".cm-content") as (HTMLElement & { cmView?: { view?: any } }) | null;
    return content?.cmView?.view?.state.doc.toString() ?? "";
  })).toContain("10. second\n11. ");

  await cleanup();
});

test("expands slash dates into normal wikilinks and opens the root daily note", async () => {
  const { page, cleanup, workspaceRoot } = await launchExographWorkspaceFixture({
    mutable: true,
    initialNoteLabel: null,
    prepareWorkspace: async (root) => {
      await writeFile(path.join(root, "notes/test-notes/slash-date-test.md"), "# Slash Date Test\n\n", "utf8");
    },
  });
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const date = [tomorrow.getFullYear(), String(tomorrow.getMonth() + 1).padStart(2, "0"), String(tomorrow.getDate()).padStart(2, "0")].join("-");

  await page.getByRole("button", { name: /slash-date-test/i }).first().click();
  await page.locator(".cm-content").click();
  await page.evaluate(() => {
    const content = document.querySelector(".cm-content") as (HTMLElement & { cmView?: { view?: any } }) | null;
    const view = content?.cmView?.view;
    if (!view) throw new Error("Unable to resolve CodeMirror view");
    view.dispatch({ selection: { anchor: view.state.doc.length } });
    view.focus();
  });
  await page.keyboard.type("/tomorrow");
  await page.keyboard.press("Enter");
  await expect.poll(() => page.evaluate(() => {
    const content = document.querySelector(".cm-content") as (HTMLElement & { cmView?: { view?: any } }) | null;
    return content?.cmView?.view?.state.doc.toString() ?? "";
  })).toContain(`[[${date}]]`);

  await page.locator(`[data-exograph-link-target="${date}"]`).click();
  const dailyPath = path.join(workspaceRoot, "notes/test-notes", `${date}.md`);
  await expect.poll(() => readFile(dailyPath, "utf8").catch(() => "")).toContain(`# ${date}`);
  await expect(page.getByRole("button", { name: date }).last()).toBeVisible();

  await cleanup();
});

test("opens inline tags as normal note links while keeping the hash visible", async () => {
  const { page, cleanup, workspaceRoot } = await launchExographWorkspaceFixture({
    mutable: true,
    initialNoteLabel: null,
    prepareWorkspace: async (root) => {
      await writeFile(path.join(root, "notes/test-notes/tag-link-test.md"), "# Tag Link Test\n\nDiscuss #strategy today.\n", "utf8");
    },
  });

  await page.getByRole("button", { name: /tag-link-test/i }).first().click();
  const tag = page.locator('[data-exograph-tag="strategy"]');
  await expect(tag).toHaveText("#strategy");
  await expect(tag).toHaveCSS("cursor", "pointer");
  await tag.click();

  await expect.poll(() => readFile(path.join(workspaceRoot, "notes/test-notes/strategy.md"), "utf8").catch(() => "")).toContain("# strategy");
  await expect(page.getByRole("button", { name: "strategy" }).last()).toBeVisible();

  await cleanup();
});

test("Tab and Enter exit wikilinks without adding whitespace", async () => {
  const { page, cleanup } = await launchExographWorkspaceFixture({
    mutable: true,
    prepareWorkspace: async (workspaceRoot) => {
      const target = path.join(workspaceRoot, "notes/test-notes/wikilink-edit-test.md");
      await writeFile(target, "# Wikilink Edit Test\n\nDiscuss [[customer-name]]today\nNext [[account-name]] step\n", "utf8");
    },
  });

  await page.getByRole("button", { name: /wikilink-edit-test/i }).first().click();
  await page.locator(".cm-content").click();
  await page.evaluate(() => {
    const content = document.querySelector(".cm-content") as (HTMLElement & { cmView?: { view?: any } }) | null;
    const view = content?.cmView?.view;
    if (!view) {
      throw new Error("Unable to resolve CodeMirror view");
    }
    const pos = view.state.doc.toString().indexOf("[[customer-name]]") + "[[customer-name".length;
    view.dispatch({ selection: { anchor: pos } });
    view.focus();
  });
  await page.keyboard.press("Tab");
  await expect
    .poll(() =>
      page.evaluate(() => {
        const content = document.querySelector(".cm-content") as (HTMLElement & { cmView?: { view?: any } }) | null;
        return content?.cmView?.view?.state.doc.toString() ?? "";
      }),
    )
    .toContain("Discuss [[customer-name]]today");
  await expect
    .poll(() =>
      page.evaluate(() => {
        const content = document.querySelector(".cm-content") as (HTMLElement & { cmView?: { view?: any } }) | null;
        return content?.cmView?.view?.state.selection.main.head ?? -1;
      }),
    )
    .toBe("# Wikilink Edit Test\n\nDiscuss [[customer-name]]".length);

  await page.evaluate(() => {
    const content = document.querySelector(".cm-content") as (HTMLElement & { cmView?: { view?: any } }) | null;
    const view = content?.cmView?.view;
    if (!view) {
      throw new Error("Unable to resolve CodeMirror view");
    }
    const pos = view.state.doc.toString().indexOf("[[account-name]]") + "[[account-name".length;
    view.dispatch({ selection: { anchor: pos } });
    view.focus();
  });
  await page.keyboard.press("Enter");
  await expect
    .poll(() =>
      page.evaluate(() => {
        const content = document.querySelector(".cm-content") as (HTMLElement & { cmView?: { view?: any } }) | null;
        return content?.cmView?.view?.state.doc.toString() ?? "";
      }),
    )
    .toContain("Next [[account-name]] step");
  await expect
    .poll(() =>
      page.evaluate(() => {
        const content = document.querySelector(".cm-content") as (HTMLElement & { cmView?: { view?: any } }) | null;
        return content?.cmView?.view?.state.selection.main.head ?? -1;
      }),
    )
    .toBe("# Wikilink Edit Test\n\nDiscuss [[customer-name]]today\nNext [[account-name]]".length);

  await cleanup();
});

test("suggests existing note targets while typing wikilinks", async () => {
  const { page, cleanup } = await launchExographWorkspaceFixture({
    mutable: true,
    initialNoteLabel: null,
    prepareWorkspace: async (workspaceRoot) => {
      const notesRoot = path.join(workspaceRoot, "notes/test-notes");
      await mkdir(path.join(notesRoot, "nested"), { recursive: true });
      await writeFile(path.join(notesRoot, "wikilink-suggest-test.md"), "# Wikilink Suggest Test\n\n", "utf8");
      await writeFile(path.join(notesRoot, "customer-alpha.md"), "# Customer Alpha\n", "utf8");
      await writeFile(path.join(notesRoot, "customer-beta.md"), "# Customer Beta\n", "utf8");
      await writeFile(path.join(notesRoot, "customer-gamma.md"), "# Customer Gamma\n", "utf8");
      await writeFile(path.join(notesRoot, "customer-delta.md"), "# Customer Delta\n", "utf8");
      await writeFile(path.join(notesRoot, "nested/some-item.md"), "# Some Item\n", "utf8");
    },
  });

  await page.getByRole("button", { name: /wikilink-suggest-test/i }).first().click();
  await page.locator(".cm-content").click();
  await page.evaluate(() => {
    const content = document.querySelector(".cm-content") as (HTMLElement & { cmView?: { view?: any } }) | null;
    const view = content?.cmView?.view;
    if (!view) {
      throw new Error("Unable to resolve CodeMirror view");
    }
    view.dispatch({ selection: { anchor: view.state.doc.length } });
    view.focus();
  });

  await page.keyboard.type("[[cus");
  await expect(page.getByTestId("wikilink-suggestions")).toBeVisible();
  await expect(page.locator(".wikilink-suggestions__item")).toHaveCount(3);
  await page.keyboard.press("Enter");
  await expect
    .poll(() =>
      page.evaluate(() => {
        const content = document.querySelector(".cm-content") as (HTMLElement & { cmView?: { view?: any } }) | null;
        return content?.cmView?.view?.state.doc.toString() ?? "";
      }),
    )
    .toContain("[[customer-alpha]]");
  await expect(page.getByTestId("wikilink-suggestions")).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const content = document.querySelector(".cm-content") as (HTMLElement & { cmView?: { view?: any } }) | null;
        const view = content?.cmView?.view;
        if (!view) {
          return -1;
        }
        return view.state.selection.main.head;
      }),
    )
    .toBe("# Wikilink Suggest Test\n\n[[customer-alpha]]".length);

  await page.keyboard.type("\n[[no-such-existing-note");
  await expect(page.getByTestId("wikilink-suggestions")).toHaveCount(0);

  await page.keyboard.type("\n[[some");
  await expect(page.getByTestId("wikilink-suggestions")).toBeVisible();
  await page.getByRole("button", { name: /some-item/i }).click();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const content = document.querySelector(".cm-content") as (HTMLElement & { cmView?: { view?: any } }) | null;
        return content?.cmView?.view?.state.doc.toString() ?? "";
      }),
    )
    .toContain("[[nested/some-item|some-item]]");
  await expect
    .poll(() =>
      page.evaluate(() => {
        const content = document.querySelector(".cm-content") as (HTMLElement & { cmView?: { view?: any } }) | null;
        return content?.cmView?.view?.state.doc.toString() ?? "";
      }),
    )
    .not.toContain("//some-item");

  await page.keyboard.type("\n[[customer");
  await expect(page.getByTestId("wikilink-suggestions")).toBeVisible();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect
    .poll(() =>
      page.evaluate(() => {
        const content = document.querySelector(".cm-content") as (HTMLElement & { cmView?: { view?: any } }) | null;
        return content?.cmView?.view?.state.doc.toString() ?? "";
      }),
    )
    .toContain("[[customer-beta]]");

  await cleanup();
});

test("selects the complete active Markdown source with the platform Select All shortcut", async () => {
  const source = "- first item\n- second item\n";
  const { page, cleanup } = await launchExographWorkspaceFixture({
    mutable: true,
    prepareWorkspace: async (workspaceRoot) => {
      await writeFile(path.join(workspaceRoot, "notes/test-notes/select-all-list.md"), source, "utf8");
    },
  });

  try {
    await page.getByRole("button", { name: /select-all-list/i }).first().click();
    await page.locator(".cm-content").click();
    await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A");

    await expect.poll(() => page.evaluate(() => {
      const content = document.querySelector(".cm-content") as (HTMLElement & { cmView?: { view?: any } }) | null;
      const view = content?.cmView?.view;
      const selection = view?.state.selection.main;
      return selection ? { from: selection.from, to: selection.to, length: view.state.doc.length } : null;
    })).toEqual({ from: 0, to: source.length, length: source.length });

    const sourceTab = await page.getByRole("button", { name: "related-note" }).first().boundingBox();
    const editor = await page.locator(".workspace-shell__canvas .pane-leaf--editor").first().boundingBox();
    expect(sourceTab).not.toBeNull();
    expect(editor).not.toBeNull();
    await page.mouse.move(sourceTab!.x + sourceTab!.width / 2, sourceTab!.y + sourceTab!.height / 2);
    await page.mouse.down();
    await page.mouse.move(editor!.x + editor!.width * 0.88, editor!.y + editor!.height / 2, { steps: 8 });
    await page.mouse.up();

    const editorPanes = page.locator(".workspace-shell__canvas .pane-leaf--editor");
    await expect(editorPanes).toHaveCount(2);
    const firstContent = editorPanes.nth(0).locator(".cm-content");
    const secondContent = editorPanes.nth(1).locator(".cm-content");
    await firstContent.click();
    await secondContent.click();
    await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
    const paneSelections = await Promise.all([firstContent, secondContent].map((content) => content.evaluate((node) => {
      const view = (node as HTMLElement & { cmView?: { view?: any } }).cmView?.view;
      const selection = view?.state.selection.main;
      return selection ? { from: selection.from, to: selection.to, length: view.state.doc.length } : null;
    })));
    expect(paneSelections[1]).toEqual({ from: 0, to: paneSelections[1]?.length, length: paneSelections[1]?.length });
    expect(paneSelections[0]).not.toEqual({ from: 0, to: paneSelections[0]?.length, length: paneSelections[0]?.length });

    const search = page.getByTestId("workspace-search-input");
    await search.fill("find this phrase");
    await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
    await expect.poll(() => search.evaluate((input) => ({
      start: (input as HTMLInputElement).selectionStart,
      end: (input as HTMLInputElement).selectionEnd,
      length: (input as HTMLInputElement).value.length,
    }))).toEqual({ start: 0, end: 16, length: 16 });
  } finally {
    await cleanup();
  }
});

test("keeps an empty-line caret on the root content rail", async () => {
  const source = ["Body", "", "## Tasks", "", "1. ordered", "", "- bullet", "", "- [ ] task"].join("\n");
  const { page, cleanup } = await launchExographWorkspaceFixture({
    mutable: true,
    prepareWorkspace: async (workspaceRoot) => {
      await writeFile(path.join(workspaceRoot, "notes/test-notes/empty-caret.md"), source, "utf8");
    },
  });

  try {
    await page.getByRole("button", { name: /empty-caret/i }).first().click();
    await expect(page.locator(".cm-content")).toContainText("ordered");
    const geometry = await page.locator(".cm-content").evaluate(async (content) => {
      const view = (content as HTMLElement & { cmView?: { view?: any } }).cmView?.view;
      if (!view) throw new Error("Unable to resolve CodeMirror view");
      const lineElements = [...content.querySelectorAll<HTMLElement>(":scope > .cm-line")];
      const bodyOrigin = lineElements[0]?.getBoundingClientRect().left ?? null;
      const measured: Array<{ offset: number | null; text: string; className: string }> = [];
      for (const lineNumber of [2, 4, 6, 8]) {
        const line = lineElements[lineNumber - 1];
        measured.push({
          offset: line && bodyOrigin !== null ? line.getBoundingClientRect().left - bodyOrigin : null,
          text: line.textContent ?? "",
          className: line.className,
        });
      }
      return measured;
    });
    expect(geometry).toEqual(Array.from({ length: 4 }, () => ({
      offset: 0,
      text: "",
      className: "exograph-md-line exograph-md-line--body cm-line",
    })));
    const firstBlank = page.locator(".cm-line").nth(1);
    await firstBlank.click();
    await page.keyboard.type("x");
    await page.keyboard.press("Backspace");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowUp");
    await expect(firstBlank).toHaveClass(/exograph-md-line--body/);
    await expect(firstBlank).toHaveText("");
  } finally {
    await cleanup();
  }
});

test("keeps wikilink completion overlays outside editor clipping", async () => {
  const { page, cleanup } = await launchExographWorkspaceFixture({
    mutable: true,
    initialNoteLabel: null,
    prepareWorkspace: async (workspaceRoot) => {
      const notesRoot = path.join(workspaceRoot, "notes/test-notes");
      await writeFile(path.join(notesRoot, "short-wikilink-popup.md"), "# Short Wikilink Popup\n\n", "utf8");
      await writeFile(path.join(notesRoot, "goals.md"), "# Goals\n", "utf8");
      await writeFile(path.join(notesRoot, "governance.md"), "# Governance\n", "utf8");
      await writeFile(path.join(notesRoot, "goose.md"), "# Goose\n", "utf8");
    },
  });

  await page.getByRole("button", { name: /short-wikilink-popup/i }).first().click();
  await page.locator(".cm-content").click();
  await page.evaluate(() => {
    const content = document.querySelector(".cm-content") as (HTMLElement & { cmView?: { view?: any } }) | null;
    const view = content?.cmView?.view;
    if (!view) {
      throw new Error("Unable to resolve CodeMirror view");
    }
    view.dispatch({ selection: { anchor: view.state.doc.length } });
    view.focus();
  });

  await page.keyboard.type("[[go");
  await expect(page.getByTestId("wikilink-suggestions")).toBeVisible();
  await expect(page.locator(".wikilink-suggestions__item")).toHaveCount(3);
  await expect
    .poll(() =>
      page.getByTestId("wikilink-suggestions").evaluate((node) => {
        const popup = node.getBoundingClientRect();
        let current = node.parentElement;
        while (current) {
          const style = window.getComputedStyle(current);
          const clips = [style.overflow, style.overflowX, style.overflowY].some((value) => value === "hidden" || value === "clip");
          if (clips) {
            const rect = current.getBoundingClientRect();
            if (popup.bottom > rect.bottom || popup.right > rect.right || popup.left < rect.left || popup.top < rect.top) {
              return false;
            }
          }
          current = current.parentElement;
        }
        return true;
      }),
    )
    .toBe(true);

  await cleanup();
});

test("lets Enter add a line above a first-line wikilink", async () => {
  const { page, cleanup } = await launchExographWorkspaceFixture({
    mutable: true,
    initialNoteLabel: null,
    prepareWorkspace: async (workspaceRoot) => {
      const target = path.join(workspaceRoot, "notes/test-notes/top-line-wikilink.md");
      await writeFile(target, "[[goals]]\n", "utf8");
      await writeFile(path.join(workspaceRoot, "notes/test-notes/goals.md"), "# Goals\n", "utf8");
    },
  });

  await page.getByRole("button", { name: /top-line-wikilink/i }).first().click();
  await page.locator(".cm-content").click();
  await page.evaluate(() => {
    const content = document.querySelector(".cm-content") as (HTMLElement & { cmView?: { view?: any } }) | null;
    const view = content?.cmView?.view;
    if (!view) {
      throw new Error("Unable to resolve CodeMirror view");
    }
    view.dispatch({ selection: { anchor: 0 } });
    view.focus();
  });

  await expect(page.getByTestId("wikilink-suggestions")).toHaveCount(0);
  await page.keyboard.press("Enter");
  await expect
    .poll(() =>
      page.evaluate(() => {
        const content = document.querySelector(".cm-content") as (HTMLElement & { cmView?: { view?: any } }) | null;
        return content?.cmView?.view?.state.doc.toString() ?? "";
      }),
    )
    .toBe("\n[[goals]]\n");

  await cleanup();
});

test("keeps generated graph references stable, scroll-owned, and outside editable list layout", async () => {
  const { page, cleanup } = await launchExographWorkspaceFixture({
    mutable: true,
    prepareWorkspace: async (workspaceRoot) => {
      const notesRoot = path.join(workspaceRoot, "notes/test-notes");
      await writeFile(path.join(notesRoot, "source-ref.md"), "See [[refs-list-target]].\n", "utf8");
      await writeFile(path.join(notesRoot, "refs-list-target.md"), "# Refs List Target\n\n- \n", "utf8");
    },
  });

  await page.getByRole("button", { name: /refs-list-target/i }).first().click();
  const referencesSection = page.locator("section.markdown-graph-references");
  await expect(referencesSection).toHaveCount(1);
  const scrollable = await page.evaluate(() => {
    const scroller = document.querySelector(".editor-surface .cm-scroller") as HTMLElement | null;
    if (!scroller) throw new Error("Editor scroller unavailable");
    scroller.style.setProperty("height", "80px", "important");
    scroller.style.setProperty("max-height", "80px", "important");
    scroller.scrollTop = 0;
    scroller.dispatchEvent(new Event("scroll"));
    return scroller.scrollHeight - scroller.clientHeight;
  });
  expect(scrollable).toBeGreaterThan(1);
  await expect(referencesSection).toBeHidden();
  await page.mouse.move(100, 300);
  await page.mouse.move(120, 320);
  await expect(referencesSection).toBeHidden();

  const scrollToProgress = (progress: number) => page.evaluate((nextProgress) => {
    const scroller = document.querySelector(".editor-surface .cm-scroller") as HTMLElement | null;
    if (!scroller) throw new Error("Editor scroller unavailable");
    scroller.scrollTop = (scroller.scrollHeight - scroller.clientHeight) * nextProgress;
    scroller.dispatchEvent(new Event("scroll"));
  }, progress);

  await scrollToProgress(0.75);
  await expect(referencesSection).toBeVisible();
  await scrollToProgress(0.65);
  await expect(referencesSection).toBeVisible();
  await scrollToProgress(0.55);
  await expect(referencesSection).toBeHidden();
  await scrollToProgress(0.75);
  await expect(referencesSection).toBeVisible();
  const referenceStructure = await referencesSection.evaluate((node) => ({
    editable: node.getAttribute("contenteditable"),
    directEditorBlock: node.parentElement?.classList.contains("cm-content") ?? false,
  }));
  expect(referenceStructure).toEqual({ editable: "false", directEditorBlock: true });

  const caretGeometry = await page.locator(".cm-content").evaluate((content) => {
    const view = (content as HTMLElement & { cmView?: { view?: any } }).cmView?.view;
    if (!view) throw new Error("Unable to resolve CodeMirror view");
    view.focus();
    view.dispatch({ selection: { anchor: view.state.doc.length } });
    const cursor = document.querySelector<HTMLElement>(".cm-cursor");
    const references = document.querySelector<HTMLElement>(".markdown-graph-references");
    return {
      cursorHeight: cursor?.getBoundingClientRect().height ?? null,
      referencesHeight: references?.getBoundingClientRect().height ?? null,
    };
  });
  expect(caretGeometry.cursorHeight).not.toBeNull();
  expect(caretGeometry.referencesHeight).not.toBeNull();
  expect(caretGeometry.cursorHeight!).toBeLessThan(40);
  expect(caretGeometry.cursorHeight!).toBeLessThan(caretGeometry.referencesHeight! / 2);

  await referencesSection.getByRole("button", { name: "source-ref" }).focus();
  await expect(referencesSection.getByRole("button", { name: "source-ref" })).toBeFocused();

  await cleanup();
});

test("folds heading sections and leading-tag groups without changing Markdown", async () => {
  const source = [
    "# Parent",
    "Heading child",
    "## Nested",
    "Nested child",
    "# Next",
    "#project",
    "  owner: Kenneth",
    "  status: active",
    "After",
  ].join("\n");
  const { page, cleanup } = await launchExographWorkspaceFixture({
    mutable: true,
    prepareWorkspace: async (workspaceRoot) => {
      await writeFile(path.join(workspaceRoot, "notes/test-notes/outline-folds.md"), source, "utf8");
    },
  });
  const rendererErrors: string[] = [];
  page.on("pageerror", (error) => rendererErrors.push(error.message));

  await page.getByRole("button", { name: /outline-folds/i }).first().click();
  const toggles = page.locator("[data-exograph-fold-anchor]");
  await expect(page.locator(".cm-content")).toContainText("Parent");
  await expect.poll(async () => ({ count: await toggles.count(), rendererErrors })).toEqual({ count: 4, rendererErrors: [] });

  await toggles.nth(0).focus();
  await page.keyboard.press("Enter");
  await expect(page.locator(".cm-line", { hasText: "Heading child" })).toBeHidden();
  await expect(page.locator(".cm-line", { hasText: "Nested child" })).toBeHidden();
  await expect(page.locator(".cm-line", { hasText: "Next" })).toBeVisible();

  await page.locator("[data-exograph-fold-anchor]").last().focus();
  await page.keyboard.press("Enter");
  await expect(page.locator(".cm-line", { hasText: "owner: Kenneth" })).toBeHidden();
  await expect(page.locator(".cm-line", { hasText: "After" })).toBeVisible();

  const markdown = await page.locator(".cm-content").evaluate((content) => {
    const view = (content as HTMLElement & { cmView?: { view?: { state: { doc: { toString(): string } } } } }).cmView?.view;
    return view?.state.doc.toString();
  });
  expect(markdown).toBe(source);
  await cleanup();
});

test("keeps cursor and shortcut selections out of rendered list markers", async () => {
  const { page, cleanup } = await launchExographWorkspaceFixture({
    mutable: true,
    prepareWorkspace: async (workspaceRoot) => {
      const target = path.join(workspaceRoot, "notes/test-notes/list-cursor-boundaries.md");
      await writeFile(target, "# List Cursor Boundaries\n\nBefore\n- first item\n- second item\n- [ ] task item\n", "utf8");
    },
  });

  await page.getByRole("button", { name: /list-cursor-boundaries/i }).first().click();
  await page.locator(".cm-content").click();

  const positions = await page.evaluate(() => {
    const content = document.querySelector(".cm-content") as (HTMLElement & { cmView?: { view?: any } }) | null;
    const view = content?.cmView?.view;
    if (!view) {
      throw new Error("Unable to resolve CodeMirror view");
    }
    const doc = view.state.doc.toString();
    return {
      firstMarkerStart: doc.indexOf("- first item"),
      firstTextStart: doc.indexOf("- first item") + "- ".length,
      secondMarkerStart: doc.indexOf("- second item"),
      secondTextStart: doc.indexOf("- second item") + "- ".length,
      secondLineEnd: doc.indexOf("- second item") + "- second item".length,
      taskTextStart: doc.indexOf("- [ ] task item") + "- [ ] ".length,
      taskLineEnd: doc.indexOf("- [ ] task item") + "- [ ] task item".length,
    };
  });

  await page.evaluate(({ firstMarkerStart }) => {
    const content = document.querySelector(".cm-content") as (HTMLElement & { cmView?: { view?: any } }) | null;
    const view = content?.cmView?.view;
    if (!view) {
      throw new Error("Unable to resolve CodeMirror view");
    }
    view.dispatch({ selection: { anchor: firstMarkerStart } });
    view.focus();
  }, positions);

  await expect
    .poll(() =>
      page.evaluate(() => {
        const content = document.querySelector(".cm-content") as (HTMLElement & { cmView?: { view?: any } }) | null;
        return content?.cmView?.view?.state.selection.main.head ?? -1;
      }),
    )
    .toBe(positions.firstTextStart);

  await page.evaluate(({ secondLineEnd }) => {
    const content = document.querySelector(".cm-content") as (HTMLElement & { cmView?: { view?: any } }) | null;
    const view = content?.cmView?.view;
    if (!view) {
      throw new Error("Unable to resolve CodeMirror view");
    }
    view.dispatch({ selection: { anchor: secondLineEnd } });
    view.focus();
  }, positions);
  await page.keyboard.press(process.platform === "darwin" ? "Meta+Shift+ArrowLeft" : "Control+Shift+ArrowLeft");
  await expect
    .poll(() =>
      page.evaluate(() => {
        const content = document.querySelector(".cm-content") as (HTMLElement & { cmView?: { view?: any } }) | null;
        const selection = content?.cmView?.view?.state.selection.main;
        return selection ? { anchor: selection.anchor, head: selection.head } : null;
      }),
    )
    .toEqual({ anchor: positions.secondLineEnd, head: positions.secondTextStart });

  await page.evaluate(({ taskLineEnd }) => {
    const content = document.querySelector(".cm-content") as (HTMLElement & { cmView?: { view?: any } }) | null;
    const view = content?.cmView?.view;
    if (!view) {
      throw new Error("Unable to resolve CodeMirror view");
    }
    view.dispatch({ selection: { anchor: taskLineEnd } });
    view.focus();
  }, positions);
  await page.keyboard.press(process.platform === "darwin" ? "Meta+Shift+ArrowLeft" : "Control+Shift+ArrowLeft");
  await expect
    .poll(() =>
      page.evaluate(() => {
        const content = document.querySelector(".cm-content") as (HTMLElement & { cmView?: { view?: any } }) | null;
        const selection = content?.cmView?.view?.state.selection.main;
        return selection ? { anchor: selection.anchor, head: selection.head } : null;
      }),
    )
    .toEqual({ anchor: positions.taskLineEnd, head: positions.taskTextStart });

  await expect
    .poll(() =>
      page.evaluate(() => {
        const taskLine = document.querySelector(".exograph-md-line--task") as HTMLElement | null;
        const checkbox = taskLine?.querySelector(".exograph-md-checkbox") as HTMLElement | null;
        const textNode = taskLine
          ? Array.from(taskLine.childNodes).find((node) => node.nodeType === Node.TEXT_NODE && node.textContent?.includes("task item"))
          : null;
        if (!taskLine || !checkbox || !textNode?.textContent) {
          return null;
        }
        const range = document.createRange();
        range.setStart(textNode, textNode.textContent.indexOf("task item"));
        range.setEnd(textNode, textNode.textContent.indexOf("task item") + 1);
        const textRect = range.getBoundingClientRect();
        const checkboxRect = checkbox.getBoundingClientRect();
        const content = document.querySelector(".cm-content") as (HTMLElement & { cmView?: { view?: any } }) | null;
        const selection = content?.cmView?.view?.state.selection.main;
        return {
          gap: Math.round((textRect.left - checkboxRect.right) * 10) / 10,
          selectedText: selection ? content?.cmView?.view?.state.sliceDoc(selection.from, selection.to) : null,
        };
      }),
    )
    .toEqual({ gap: 8, selectedText: "task item" });

  await page.evaluate(({ secondTextStart }) => {
    const content = document.querySelector(".cm-content") as (HTMLElement & { cmView?: { view?: any } }) | null;
    const view = content?.cmView?.view;
    if (!view) {
      throw new Error("Unable to resolve CodeMirror view");
    }
    view.dispatch({ selection: { anchor: secondTextStart } });
    view.focus();
  }, positions);
  await page.keyboard.press("ArrowLeft");
  await expect
    .poll(() =>
      page.evaluate(() => {
        const content = document.querySelector(".cm-content") as (HTMLElement & { cmView?: { view?: any } }) | null;
        return content?.cmView?.view?.state.selection.main.head ?? -1;
      }),
    )
    .toBe(positions.secondMarkerStart + 1);

  await cleanup();
});

test("repairs structural list metadata before compiling the current viewport interaction", async () => {
  const { page, cleanup } = await launchExographWorkspaceFixture({
    mutable: true,
    prepareWorkspace: async (workspaceRoot) => {
      await writeFile(
        path.join(workspaceRoot, "notes/test-notes/preview-update-order.md"),
        "# Preview update order\n\n- parent\nplain item\n",
        "utf8",
      );
    },
  });

  try {
    await page.getByRole("button", { name: /preview-update-order/i }).first().click();
    await expect.poll(() => page.evaluate(() => {
      const content = document.querySelector(".cm-content") as (HTMLElement & { cmView?: { view?: any } }) | null;
      return content?.cmView?.view?.state.doc.toString() ?? "";
    })).toContain("plain item");
    await page.evaluate(() => {
      const content = document.querySelector(".cm-content") as (HTMLElement & { cmView?: { view?: any } }) | null;
      const view = content?.cmView?.view;
      if (!view) throw new Error("Unable to resolve CodeMirror view");
      const from = view.state.doc.toString().indexOf("plain item");
      view.dispatch({ changes: { from, to: from + "plain item".length, insert: "  - [ ] repaired task" } });
    });

    const checkbox = page.locator("[data-exograph-checkbox-pos]");
    await expect(checkbox).toHaveCount(1);
    await expect(
      page.locator('.exograph-md-line--task.exograph-md-line--list-start[data-exograph-list-depth="1"]'),
    ).toHaveCount(1);
    await checkbox.click();
    await expect.poll(() => page.evaluate(() => {
      const content = document.querySelector(".cm-content") as (HTMLElement & { cmView?: { view?: any } }) | null;
      return content?.cmView?.view?.state.doc.toString() ?? "";
    })).toContain("  - [x] repaired task");
  } finally {
    await cleanup();
  }
});
