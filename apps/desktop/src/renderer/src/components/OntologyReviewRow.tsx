import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { LoaderCircle, RefreshCw, Sparkles, X } from "lucide-react";
import type { OntologyReviewState } from "@exograph/core";

type BusyState = "preview" | "keep" | "reject" | "discover" | null;

export function OntologyReviewRow({ compact = false }: { compact?: boolean }) {
  const [review, setReview] = useState<OntologyReviewState | null>(null);
  const [busy, setBusy] = useState<BusyState>("preview");
  const [notice, setNotice] = useState<string | null>(null);
  const [reopened, setReopened] = useState(false);
  const operationEpochRef = useRef(0);
  const selectedSourceRef = useRef<string | null | undefined>(undefined);

  const preview = useCallback(async (sourcePath = selectedSourceRef.current) => {
    const epoch = ++operationEpochRef.current;
    setBusy("preview");
    try {
      const next = await window.exograph.workspace.previewOntology(sourcePath);
      if (operationEpochRef.current !== epoch) return;
      selectedSourceRef.current = next.guard.candidateSourcePath;
      setReview(next);
      setNotice(null);
      setReopened(false);
    } catch {
      if (operationEpochRef.current !== epoch) return;
      setReview(null);
      setNotice("Preview unavailable");
    } finally {
      if (operationEpochRef.current === epoch) setBusy(null);
    }
  }, []);

  useEffect(() => {
    void preview();
    return window.exograph.workspace.onOntologyCandidateChanged(() => void preview());
  }, [preview]);

  async function keep() {
    if (!review) return;
    const epoch = ++operationEpochRef.current;
    setBusy("keep");
    try {
      const result = await window.exograph.workspace.keepOntology(review.guard);
      if (operationEpochRef.current !== epoch) return;
      setReview(result.review);
      setReopened(false);
      setNotice(result.status === "stale" ? "Changed—review again" : "Activated");
    } catch {
      if (operationEpochRef.current !== epoch) return;
      setNotice("Could not apply");
    } finally {
      if (operationEpochRef.current === epoch) setBusy(null);
    }
  }

  async function reject() {
    if (!review) return;
    const epoch = ++operationEpochRef.current;
    setBusy("reject");
    try {
      const result = await window.exograph.workspace.rejectOntology(review.guard);
      if (operationEpochRef.current !== epoch) return;
      setReview(result.review);
      setReopened(false);
      setNotice(result.status === "stale" ? "Changed—review again" : null);
    } catch {
      if (operationEpochRef.current !== epoch) return;
      setNotice("Could not reject");
    } finally {
      if (operationEpochRef.current === epoch) setBusy(null);
    }
  }

  async function discover() {
    const epoch = ++operationEpochRef.current;
    setBusy("discover");
    setNotice(null);
    try {
      const result = await window.exograph.workspace.discoverOntology();
      if (operationEpochRef.current !== epoch) return;
      selectedSourceRef.current = result.review.guard.candidateSourcePath;
      setReview(result.review);
      setReopened(false);
      setNotice(result.status === "staged"
        ? "Proposal ready"
        : result.status === "question"
          ? result.question ?? "Needs input"
          : "No proposal");
    } catch (error) {
      if (operationEpochRef.current !== epoch) return;
      setNotice(discoveryError(error));
    } finally {
      if (operationEpochRef.current === epoch) setBusy(null);
    }
  }

  return (
    <OntologyReviewPresentation
      busy={busy}
      notice={notice}
      onKeep={() => void keep()}
      onReject={() => void reject()}
      onDiscover={() => void discover()}
      onReopen={() => { setReopened(true); setNotice(null); }}
      onSelect={(sourcePath) => {
        selectedSourceRef.current = sourcePath;
        void preview(sourcePath);
      }}
      compact={compact}
      reopened={reopened}
      review={review}
    />
  );
}

export function OntologyReviewPresentation({
  busy,
  notice,
  onKeep,
  onReject,
  onDiscover,
  onReopen,
  onSelect,
  compact = false,
  reopened,
  review,
}: {
  busy: BusyState;
  notice: string | null;
  onKeep: () => void;
  onReject: () => void;
  onDiscover?: () => void;
  onReopen: () => void;
  onSelect?: (sourcePath: string | null) => void;
  compact?: boolean;
  reopened: boolean;
  review: OntologyReviewState | null;
}) {
  const pending = review?.candidate.pending ?? false;
  const rejected = review?.candidate.rejected ?? false;
  const activeUnavailable = review?.active.state === "invalid-state";
  const showActions = pending && !activeUnavailable && (!rejected || reopened);
  const identity = review ? activeIdentity(review) : busy === "preview" ? "Loading…" : "Unavailable";
  const candidateIdentity = review && pending ? pendingIdentity(review) : null;
  const effects = review?.effects;
  const findingCount = effects
    ? effects.after.findings.info + effects.after.findings.warning + effects.after.findings.error
    : 0;
  const relationDelta = effects ? effects.after.ontologyRelations - effects.before.ontologyRelations : 0;
  const firstDiagnostic = review?.diagnostics[0];

  const panel = (
    <section className="ontology-review" data-testid={compact ? "graph-ontology-review" : "workspace-settings-ontology"}>
      <div className="ontology-review__main">
        <div className="ontology-review__identity">
          <span className="dialog-field__label">Ontology</span>
          <span className="ontology-review__active">Active: <strong>{identity}</strong></span>
          {review && onSelect ? (
            <label className="ontology-review__choice">
              <span>Preview</span>
            <select
              aria-label="Preview ontology"
              className="ontology-review__select"
              disabled={Boolean(busy)}
              onChange={(event) => {
                const sourceIndex = Number(event.target.value.replace("source:", ""));
                onSelect(event.target.value === "__generic__"
                  ? null
                  : review.library[sourceIndex]?.sourcePath ?? null);
              }}
              title="Preview an ontology before activating it"
              value={ontologySelectionValue(review)}
            >
              <option value="__generic__">Generic</option>
              {review.library.map((entry, index) => (
                <option key={entry.sourcePath} value={`source:${index}`}>
                  {entry.label ?? entry.id ?? ontologyFilename(entry.sourcePath)}
                </option>
              ))}
            </select>
            </label>
          ) : null}
          {candidateIdentity ? <span className="ontology-review__candidate">Preview: {candidateIdentity}</span> : null}
        </div>
        <div className="ontology-review__tokens" aria-label={pending ? "Preview graph effects" : "Active graph effects"}>
          {effects ? <span>{effects.after.typedConcepts} typed</span> : null}
          {effects ? <span>{signedCount(relationDelta)} relations</span> : null}
          {effects ? <span>{findingCount} findings</span> : null}
          {notice ? <span className="ontology-review__notice" role="status" title={notice}>{notice}</span> : null}
          {busy ? <span className="ontology-review__notice" role="status">{busy === "preview" ? "Previewing…" : busy === "discover" ? "Discovering…" : "Applying…"}</span> : null}
          {rejected && !reopened ? <span className="ontology-review__notice">Not applied</span> : null}
        </div>
      </div>
      <div className="ontology-review__actions">
        {busy ? <LoaderCircle aria-label={busy === "preview" ? "Previewing ontology" : busy === "discover" ? "Discovering ontology" : "Applying ontology review"} className="ontology-review__spinner" size={15} /> : null}
        {!busy && onDiscover && !showActions ? (
          <button aria-label="Discover ontology" className="icon-button" onClick={onDiscover} title="Discover structure" type="button">
            <Sparkles size={15} aria-hidden="true" />
          </button>
        ) : null}
        {!busy && rejected && !reopened ? (
          <button aria-label="Review ontology again" className="icon-button" onClick={onReopen} title="Review again" type="button">
            <RefreshCw size={15} aria-hidden="true" />
          </button>
        ) : null}
        {!busy && showActions ? (
          <>
            <button
              aria-label="Activate ontology"
              className="toolbar-button"
              disabled={review?.candidate.state === "invalid"}
              onClick={onKeep}
              title={candidateIdentity ? `Activate ${candidateIdentity}` : "Activate ontology"}
              type="button"
            >
              Activate
            </button>
            <button aria-label="Reject ontology" className="icon-button" onClick={onReject} title="Reject" type="button">
              <X size={16} aria-hidden="true" />
            </button>
          </>
        ) : null}
      </div>
      {pending ? <p className="ontology-review__hint">Preview only. Activate makes this ontology active in the graph.</p> : null}
      {firstDiagnostic ? (
        review && review.diagnostics.length + review.omittedDiagnostics > 1 ? (
          <details className="ontology-review__diagnostic">
            <summary>{firstDiagnostic.message}</summary>
            {review.diagnostics.slice(1).map((diagnostic) => <div key={`${diagnostic.code}:${diagnostic.message}`}>{diagnostic.message}</div>)}
            {review.omittedDiagnostics > 0 ? <div>{review.omittedDiagnostics} more</div> : null}
          </details>
        ) : <div className="ontology-review__diagnostic">{firstDiagnostic.message}</div>
      ) : null}
    </section>
  );
  return compact ? (
    <OntologyReviewDisclosure identity={identity}>{panel}</OntologyReviewDisclosure>
  ) : panel;
}

function OntologyReviewDisclosure({ identity, children }: { identity: string; children: ReactNode }) {
  const disclosureRef = useRef<HTMLDetailsElement>(null);
  const summaryRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const dismissOutside = (event: PointerEvent) => {
      const disclosure = disclosureRef.current;
      if (disclosure?.open && event.target instanceof Node && !disclosure.contains(event.target)) disclosure.open = false;
    };
    const disclosure = disclosureRef.current;
    const graph = disclosure?.closest(".spatial-graph");
    const toolbar = disclosure?.closest(".spatial-graph__toolbar");
    const measureAvailableHeight = () => {
      if (!graph || !toolbar || !disclosure) return;
      const height = Math.max(0, graph.getBoundingClientRect().bottom - toolbar.getBoundingClientRect().bottom - 6);
      disclosure.style.setProperty("--ontology-review-height", `${height}px`);
    };
    const observer = new ResizeObserver(measureAvailableHeight);
    if (graph) observer.observe(graph);
    if (toolbar) observer.observe(toolbar);
    measureAvailableHeight();
    document.addEventListener("pointerdown", dismissOutside);
    return () => {
      observer.disconnect();
      document.removeEventListener("pointerdown", dismissOutside);
    };
  }, []);
  return (
    <details ref={disclosureRef} className="ontology-review-control" data-testid="graph-ontology"
      onKeyDown={(event) => {
        if (event.key !== "Escape" || event.defaultPrevented || !disclosureRef.current?.open) return;
        event.preventDefault();
        event.stopPropagation();
        disclosureRef.current.open = false;
        summaryRef.current?.focus();
      }}>
      <summary ref={summaryRef} aria-label={`Ontology; active ${identity}`} title={`Ontology · Active: ${identity}`}>Active: {identity}</summary>
      {children}
    </details>
  );
}

function activeIdentity(review: OntologyReviewState): string {
  if (review.active.state === "invalid-state") return "Active unavailable";
  if (review.active.state !== "active") return "Generic";
  return `${review.active.label ?? review.active.id ?? "Active"}${review.active.version ? ` · v${review.active.version}` : ""}`;
}

function pendingIdentity(review: OntologyReviewState): string {
  if (review.candidate.state === "absent") return "Generic";
  if (review.candidate.state === "invalid") return "Invalid candidate";
  return `${review.candidate.label ?? review.candidate.id ?? "Candidate"}${review.candidate.version ? ` · v${review.candidate.version}` : ""}`;
}

function signedCount(value: number): string {
  return value > 0 ? `+${value}` : String(value);
}

function ontologyFilename(sourcePath: string): string {
  return sourcePath.split("/").at(-1)?.replace(/\.yaml$/u, "") ?? sourcePath;
}

function ontologySelectionValue(review: OntologyReviewState): string {
  if (review.guard.candidateSourcePath === null) return "__generic__";
  const index = review.library.findIndex((entry) => entry.sourcePath === review.guard.candidateSourcePath);
  return index >= 0 ? `source:${index}` : "__generic__";
}

function discoveryError(error: unknown): string {
  const message = error instanceof Error ? error.message : "Discovery unavailable";
  const normalized = message.replace(/^Error invoking remote method '[^']+': Error:\s*/u, "").trim();
  return normalized.length > 96 ? `${normalized.slice(0, 95)}…` : normalized;
}
