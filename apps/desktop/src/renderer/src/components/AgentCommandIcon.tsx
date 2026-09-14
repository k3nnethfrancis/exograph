import { useState } from "react";
import { Bot } from "lucide-react";
import { normalizeAgentCommandAppearance, type AgentCommand } from "@exograph/core/agent-command-configuration";
import { AgentIcon } from "./AgentIcon";
import "./agent-command-appearance.css";

export function AgentCommandIcon({ command, size = 16 }: {
  command: Pick<AgentCommand, "handle" | "appearance">;
  size?: number;
}) {
  const appearance = normalizeAgentCommandAppearance(command.appearance);
  const [failedIcon, setFailedIcon] = useState<string>();
  return <span aria-hidden="true" className="agent-command-icon" style={{ color: appearance?.color, width: size, height: size, borderColor: appearance?.color }}>
    {appearance?.iconDataUrl && failedIcon !== appearance.iconDataUrl
      ? <img alt="" src={appearance.iconDataUrl} width={size} height={size} onError={() => setFailedIcon(appearance.iconDataUrl)} />
      : command.handle === "claude" || command.handle === "codex"
        ? <AgentIcon kind={command.handle} size={size} />
        : <Bot size={size} />}
  </span>;
}
