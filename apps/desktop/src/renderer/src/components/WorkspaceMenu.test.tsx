import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { EXOGRAPH_CLI_COMMANDS } from "@exograph/core/operator-help";

import { workspaceHelpKeybindings } from "../shellHelpModel";
import { WorkspaceHelpPanel } from "./WorkspaceMenu";

describe("workspace help menu", () => {
  it("renders one compact help surface from the current keybinding and CLI catalogs", () => {
    const html = renderToStaticMarkup(<WorkspaceHelpPanel isMac onBack={() => {}} />);

    expect(html).toContain("Keyboard");
    expect(html).toContain("CLI");
    for (const shortcut of workspaceHelpKeybindings(undefined, true)) {
      expect(html).toContain(shortcut.label);
      expect(html).toContain(shortcut.mac);
    }
    for (const command of EXOGRAPH_CLI_COMMANDS) {
      expect(html).toContain(command.syntax.replaceAll("<", "&lt;").replaceAll(">", "&gt;"));
    }
    expect(html).toContain('aria-label="Back to workspace menu"');
  });
});
