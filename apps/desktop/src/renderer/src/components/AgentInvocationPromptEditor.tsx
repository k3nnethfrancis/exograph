import { useEffect, useState, type ReactNode } from "react";
import { Check, Pencil, X } from "lucide-react";
import { DEFAULT_AGENT_INVOCATION_PROMPT } from "@exograph/core/agent-invocation-prompt";

interface AgentInvocationPromptEditorProps {
  value: string | undefined;
  onSave: (value: string) => void;
  testId: string;
  defaultValue?: string;
  title?: string;
  subtitle?: string;
  hint?: ReactNode;
  ariaLabel?: string;
  promptName?: string;
}

/** Compact advanced prompt editor shared by agent-owned product features. */
export function AgentInvocationPromptEditor({
  value,
  onSave,
  testId,
  defaultValue = DEFAULT_AGENT_INVOCATION_PROMPT,
  title = "Invocation prompt",
  subtitle = "Shared by every @ agent",
  hint,
  ariaLabel = "Invocation prompt",
  promptName = "invocation prompt",
}: AgentInvocationPromptEditorProps) {
  const effectiveValue = value?.trim() || defaultValue;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(effectiveValue);

  useEffect(() => {
    if (!editing) setDraft(effectiveValue);
  }, [effectiveValue, editing]);

  const save = () => {
    const next = draft.trim();
    if (!next) return;
    onSave(next);
    setEditing(false);
  };

  return (
    <section className="agent-invocation-prompt" data-testid={testId}>
      <div className="agent-invocation-prompt__header">
        <div>
          <strong>{title}</strong>
          <span>{subtitle}</span>
        </div>
        <div className="agent-invocation-prompt__actions">
          {editing ? (
            <>
              <button
                aria-label={`Save ${promptName}`}
                className="icon-button"
                data-testid={`${testId}-save`}
                onClick={save}
                title="Save prompt"
                type="button"
              >
                <Check size={15} />
              </button>
              <button
                aria-label={`Cancel editing ${promptName}`}
                className="icon-button"
                data-testid={`${testId}-cancel`}
                onClick={() => { setDraft(effectiveValue); setEditing(false); }}
                title="Cancel"
                type="button"
              >
                <X size={15} />
              </button>
            </>
          ) : (
            <button
              aria-label={`Edit ${promptName}`}
              className="icon-button"
              data-testid={`${testId}-edit`}
              onClick={() => setEditing(true)}
              title="Edit prompt"
              type="button"
            >
              <Pencil size={15} />
            </button>
          )}
        </div>
      </div>
      {editing ? (
        <textarea
          aria-label={ariaLabel}
          className="agent-invocation-prompt__input"
          data-testid={`${testId}-input`}
          onChange={(event) => setDraft(event.target.value)}
          spellCheck={false}
          value={draft}
        />
      ) : (
        <pre className="agent-invocation-prompt__preview">{effectiveValue}</pre>
      )}
      <div className="agent-invocation-prompt__hint">
        {hint ?? <>Keep <code>{"{{message}}"}</code>, <code>{"{{working_note}}"}</code>, and <code>{"{{protocol}}"}</code> for full Exograph context and review.</>}
      </div>
    </section>
  );
}
