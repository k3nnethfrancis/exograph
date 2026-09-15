import { decodeBrowserGraph } from "../../../shared/browser-graph-wire";
import type {
  BrowserApi,
  BrowserMethod,
  BrowserGraphApi,
} from "../../../shared/browser-api";

async function rpc<K extends BrowserMethod>(
  method: K,
  ...args: Parameters<BrowserApi[K]>
): Promise<Awaited<ReturnType<BrowserApi[K]>>> {
  const response = await fetch(`/api/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ args }),
  });
  const body = await response.json();
  if (!response.ok)
    throw new Error(body.error ?? "Exo could not complete this request.");
  return body.result;
}
export const browserApi: BrowserApi = {
  bootstrap: () => rpc("bootstrap"),
  listTree: (...args) => rpc("listTree", ...args),
  search: (...args) => rpc("search", ...args),
  read: (...args) => rpc("read", ...args),
  save: (...args) => rpc("save", ...args),
  saveCopy: (...args) => rpc("saveCopy", ...args),
  getGraphContext: (...args) => rpc("getGraphContext", ...args),
  getGraphTopology: async () =>
    decodeBrowserGraph(await rpc("getGraphTopology")),
  getGraphConceptSummaries: (...args) =>
    rpc("getGraphConceptSummaries", ...args),
  graphConceptLookup: (...args) => rpc("graphConceptLookup", ...args),
  getGraphConceptDetailByIndex: (...args) =>
    rpc("getGraphConceptDetailByIndex", ...args),
  resolveTarget: (...args) => rpc("resolveTarget", ...args),
  suggestTargets: (...args) => rpc("suggestTargets", ...args),
  resolveMarkdownImage: (...args) => rpc("resolveMarkdownImage", ...args),
};
const changes = new Set<() => void>();
const subscribe = (callback: () => void) => {
  changes.add(callback);
  return () => {
    changes.delete(callback);
  };
};
export const graphApi: BrowserGraphApi = {
  notes: browserApi,
  workspace: {
    onDidChange: (callback) =>
      subscribe(() =>
        callback({ rootPath: "", eventType: "change", filePath: null }),
      ),
    onGraphChanged: subscribe,
  },
};
export async function connectBrowser(
  onStatus: (status: "connected" | "reconnecting" | "expired") => void,
): Promise<() => void> {
  const ticket = new URLSearchParams(location.hash.slice(1)).get("token");
  history.replaceState(null, "", location.pathname);
  if (ticket) {
    const response = await fetch("/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: ticket }),
    });
    if (!response.ok) throw new Error((await response.json()).error);
  }
  await browserApi.bootstrap();
  const events = new EventSource("/events");
  events.onopen = () => onStatus("connected");
  events.onerror = () => onStatus("reconnecting");
  events.addEventListener("changed", () => {
    for (const callback of changes) callback();
  });
  events.addEventListener("expired", () => {
    events.close();
    onStatus("expired");
  });
  return () => events.close();
}
export const onBrowserChanged = subscribe;
