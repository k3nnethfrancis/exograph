export type UtilityDestination = "terminal" | "preview" | "graph" | "context";

export interface UtilitySurfaceState {
  open: boolean;
  destination: UtilityDestination;
}

export type UtilitySurfaceAction =
  | { type: "select"; destination: UtilityDestination }
  | { type: "toggle" }
  | { type: "close" };

export const DEFAULT_UTILITY_SURFACE_STATE: UtilitySurfaceState = {
  open: false,
  destination: "terminal",
};

export function reduceUtilitySurface(
  state: UtilitySurfaceState,
  action: UtilitySurfaceAction,
): UtilitySurfaceState {
  switch (action.type) {
    case "select":
      return { open: true, destination: action.destination };
    case "toggle":
      return { ...state, open: !state.open };
    case "close":
      return state.open ? { ...state, open: false } : state;
  }
}

export function isUtilityDestinationActive(
  state: UtilitySurfaceState,
  destination: UtilityDestination,
): boolean {
  return state.open && state.destination === destination;
}
