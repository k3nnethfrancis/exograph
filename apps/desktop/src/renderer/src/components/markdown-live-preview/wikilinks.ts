export interface WikilinkPresentation {
  target: string;
  label: string;
}

/** Return the compact label a path-only wikilink should show in rendered Markdown. */
export function wikilinkDisplayLabel(target: string): string {
  const trimmed = target.trim().replace(/\/+$/, "");
  const finalSegment = trimmed.split("/").filter(Boolean).at(-1) ?? trimmed;
  return finalSegment.replace(/\.md$/i, "") || target.trim();
}

export function wikilinkPresentation(target: string, alias?: string): WikilinkPresentation {
  const normalizedTarget = target.trim();
  const normalizedAlias = alias?.trim();
  return {
    target: normalizedTarget,
    label: normalizedAlias || wikilinkDisplayLabel(normalizedTarget),
  };
}
