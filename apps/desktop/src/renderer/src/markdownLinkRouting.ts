export type MarkdownLinkRoute =
  | { kind: "note"; target: string }
  | { kind: "pdf-preview"; target: string };

/** PDF links are existing artifacts, never implicit Note creation requests. */
export function routeMarkdownLink(target: string): MarkdownLinkRoute {
  return target.trim().toLowerCase().endsWith(".pdf")
    ? { kind: "pdf-preview", target }
    : { kind: "note", target };
}
