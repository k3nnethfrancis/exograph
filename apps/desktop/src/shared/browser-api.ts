import type { DesktopApi } from "./api";
import type { WorkspaceModel } from "@exograph/core";

/** Deliberately narrower than Electron IPC: no shell, terminals, publishing, or settings mutation. */
export interface BrowserApi {
  bootstrap: () => Promise<WorkspaceModel>;
  listTree: DesktopApi["workspace"]["listTree"];
  search: DesktopApi["workspace"]["searchIndex"];
  read: DesktopApi["notes"]["read"];
  save: DesktopApi["notes"]["save"];
  saveCopy: DesktopApi["notes"]["saveCopy"];
  getGraphContext: DesktopApi["notes"]["getGraphContext"];
  getGraphTopology: DesktopApi["notes"]["getGraphTopology"];
  getGraphConceptSummaries: DesktopApi["notes"]["getGraphConceptSummaries"];
  graphConceptLookup: DesktopApi["notes"]["graphConceptLookup"];
  getGraphConceptDetailByIndex: DesktopApi["notes"]["getGraphConceptDetailByIndex"];
  resolveTarget: DesktopApi["notes"]["resolveTarget"];
  suggestTargets: DesktopApi["notes"]["suggestTargets"];
  resolveMarkdownImage: DesktopApi["notes"]["resolveMarkdownImage"];
}
export type BrowserMethod = keyof BrowserApi;
export type BrowserGraphApi = {
  notes: Pick<
    DesktopApi["notes"],
    | "getGraphTopology"
    | "getGraphConceptSummaries"
    | "getGraphConceptDetailByIndex"
    | "graphConceptLookup"
  >;
  workspace: Pick<DesktopApi["workspace"], "onDidChange" | "onGraphChanged">;
  test?: DesktopApi["test"];
};
