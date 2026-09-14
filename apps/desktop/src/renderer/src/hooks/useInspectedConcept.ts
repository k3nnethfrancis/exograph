import { useCallback, useReducer } from "react";

export interface InspectedConcept {
  conceptId?: string;
  filePath?: string;
}

export interface GraphFocusRequest {
  concept: InspectedConcept;
  sequence: number;
}

export interface InspectedConceptState {
  concept: InspectedConcept | null;
  focusRequest: GraphFocusRequest | null;
}

type InspectedConceptAction =
  | { type: "inspect"; concept: InspectedConcept | null }
  | { type: "focus"; concept: InspectedConcept };

export const EMPTY_INSPECTED_CONCEPT_STATE: InspectedConceptState = {
  concept: null,
  focusRequest: null,
};

export function reduceInspectedConcept(
  state: InspectedConceptState,
  action: InspectedConceptAction,
): InspectedConceptState {
  if (action.type === "inspect") {
    return {
      ...state,
      concept: action.concept,
    };
  }
  return {
    concept: action.concept,
    focusRequest: {
      concept: action.concept,
      sequence: (state.focusRequest?.sequence ?? 0) + 1,
    },
  };
}

export function useInspectedConcept() {
  const [state, dispatch] = useReducer(reduceInspectedConcept, EMPTY_INSPECTED_CONCEPT_STATE);
  const inspect = useCallback((concept: InspectedConcept | null) => {
    dispatch({ type: "inspect", concept });
  }, []);
  const focus = useCallback((concept: InspectedConcept) => {
    dispatch({ type: "focus", concept });
  }, []);
  return { state, inspect, focus };
}
