import { useSyncExternalStore } from "react";
import type { EditorialDisplayMode } from "./editorialTypes";
export interface EditorialPreferences { hidden: boolean; mode: EditorialDisplayMode }
const key = "exograph.editorial.preferences.v1";
let snapshot: EditorialPreferences | null = null;
const listeners = new Set<() => void>();
function read(): EditorialPreferences {
  if (snapshot) return snapshot;
  try { const saved = JSON.parse(localStorage.getItem(key) ?? "{}"); snapshot = { hidden:saved.hidden === true, mode:["original","diff","preview"].includes(saved.mode) ? saved.mode : saved.showDiff === true ? "diff" : "original" }; }
  catch { snapshot = { hidden:false, mode:"original" }; }
  return snapshot;
}
export function setEditorialPreferences(next: EditorialPreferences) {
  snapshot = next;
  try { localStorage.setItem(key, JSON.stringify(next)); } catch { /* Storage may be disabled; preferences still work for this session. */ }
  listeners.forEach(listener => listener());
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => { if (event.key === key) { snapshot = null; listeners.forEach(item => item()); } };
  window.addEventListener("storage", onStorage);
  return () => { listeners.delete(listener); window.removeEventListener("storage", onStorage); };
}
export function getEditorialPreferences() { return read(); }
export function useEditorialPreferences() { return useSyncExternalStore(subscribe, read, read); }
