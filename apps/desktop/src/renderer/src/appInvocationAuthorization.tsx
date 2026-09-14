import type { AgentCommand } from "@exograph/core";

import {
  InvocationAuthorizationPopover,
  type InvocationAuthorizationDecision,
} from "./components/invocation";
import type { InlineAgentDraft } from "./components/inlineAgentComposer";

export interface AppInvocationAuthorizationRequest {
  command: AgentCommand;
  cwd: string;
  draft: Pick<InlineAgentDraft, "anchor" | "message">;
  fingerprint: string;
  reason: string;
}

export function invocationAuthorizationForDecision(
  decision: InvocationAuthorizationDecision,
): { kind: "run-once" | "always-allow" } {
  return { kind: decision === "workspace" ? "always-allow" : "run-once" };
}

/** The App-owned adapter from untrusted invocation state to the page popover. */
export function AppInvocationAuthorizationGate({
  pending,
  onAuthorize,
  onCancel,
}: {
  pending: AppInvocationAuthorizationRequest;
  onAuthorize: (authorization: { kind: "run-once" | "always-allow" }) => void;
  onCancel: () => void;
}) {
  return (
    <InvocationAuthorizationPopover
      commandHandle={pending.command.handle}
      commandAppearance={pending.command.appearance}
      commandLabel={pending.command.label}
      details={{
        command: pending.command.command,
        cwd: pending.cwd,
        adapter: pending.command.adapter,
        continuity: pending.command.continuityPolicy,
        fingerprint: pending.fingerprint,
        reason: pending.reason,
      }}
      position={pending.draft.anchor}
      request={pending.draft.message}
      onAuthorize={(decision) => onAuthorize(invocationAuthorizationForDecision(decision))}
      onCancel={onCancel}
    />
  );
}
