import { describe, expect, it } from "vitest";

import { formatDocumentAgentInvocation } from "@exograph/core/document-agent-protocol";

import {
  InlineAgentAffordanceWidget,
  cancelInlineAgentDraft,
  captureInlineInvocationAnchor,
  inlineAgentComposerInsertion,
  restoreInlineInvocationText,
  type ComposerState,
} from "./inlineAgentComposer";

function composer(overrides: Partial<ComposerState> = {}): ComposerState {
  return {
    id: 1,
    handle: "claude",
    from: 0,
    messageFrom: 7,
    to: 8,
    ...overrides,
  };
}

describe("inline agent affordance", () => {
  it("replaces an open composer widget after appearance changes", () => {
    const first = new InlineAgentAffordanceWidget(composer(), { color: "#112233" });
    const changed = new InlineAgentAffordanceWidget(composer(), { color: "#445566" });
    expect(first.eq(changed)).toBe(false);
    expect(first.eq(new InlineAgentAffordanceWidget(composer(), { color: "#112233" }))).toBe(true);
    expect(first.eq(new InlineAgentAffordanceWidget(composer()))).toBe(false);
  });
  it("builds a prefilled Skill request as ordinary inline composer text", () => {
    expect(inlineAgentComposerInsertion({
      handle: "claude",
      initialMessage: "Use the selected Skill.",
      prefix: "\n\n",
    })).toEqual({
      inserted: "\n\n@claude Use the selected Skill.",
      mentionOffset: 2,
      messageOffset: 9,
    });
  });

  it("keeps the same DOM widget while the active request grows", () => {
    const before = new InlineAgentAffordanceWidget(composer());
    const afterTyping = new InlineAgentAffordanceWidget(composer({ to: 42 }));

    expect(before.eq(afterTyping)).toBe(true);
  });

  it("replaces the widget when its rendered agent identity changes", () => {
    const claude = new InlineAgentAffordanceWidget(composer());
    const codex = new InlineAgentAffordanceWidget(composer({ handle: "codex" }));

    expect(claude.eq(codex)).toBe(false);
  });

  it("anchors authorization beside the composer without leaving the viewport", () => {
    expect(captureInlineInvocationAnchor(
      { left: 820, top: 100, bottom: 118 },
      { width: 1_000, height: 700 },
    )).toEqual({ left: 598, top: 124, origin: "top left" });

    expect(captureInlineInvocationAnchor(
      { left: 80, top: 610, bottom: 628 },
      { width: 1_000, height: 700 },
    )).toEqual({ left: 80, top: 384, origin: "bottom left" });
  });

  it("replaces the exact persisted envelope with the original live composer", () => {
    const protocolInvocationId = "ce4b9e26-2574-4433-a054-1110cd403792";
    const source = "@claude review this paragraph";
    const envelope = formatDocumentAgentInvocation({
      id: protocolInvocationId,
      agent: "claude",
      message: source,
    });
    const restored = restoreInlineInvocationText(`Before\n${envelope}\nAfter`, {
      protocolInvocationId,
      handle: "claude",
      source,
    });

    expect(restored?.documentBody).toBe(`Before\n${source}\nAfter`);
    expect(restored?.composer).toMatchObject({
      handle: "claude",
      from: 7,
      messageFrom: 14,
      to: 36,
    });
  });

  it("does not alter a document when the pending envelope is gone", () => {
    expect(restoreInlineInvocationText("Unrelated text", {
      protocolInvocationId: "ce4b9e26-2574-4433-a054-1110cd403792",
      handle: "claude",
      source: "@claude hello",
    })).toBeNull();
  });

  it("restores and focuses the composer before authorization cancellation finishes", () => {
    const events: string[] = [];
    const restored = cancelInlineAgentDraft({
      protocolInvocationId: "ce4b9e26-2574-4433-a054-1110cd403792",
      handle: "claude",
      message: "hello",
      documentBody: "envelope",
      anchor: { left: 20, top: 40, origin: "top left" },
      restoreComposer: () => {
        events.push("restore+publish");
        return "@claude hello";
      },
      focusComposer: () => events.push("focus"),
    }, () => events.push("close"));

    expect(restored).toBe("@claude hello");
    expect(events).toEqual(["restore+publish", "close", "focus"]);
  });
});
