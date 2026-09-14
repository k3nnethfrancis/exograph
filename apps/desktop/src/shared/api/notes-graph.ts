import type {
  GraphConceptDetailByIndexResult,
  GraphConceptLookupReference,
  GraphConceptLookupResult,
  GraphConceptSummaryResult,
  GraphTopology,
  VersionedNoteDocument,
  DocumentSaveResult,
  WorkspaceGraphContext,
} from "@exograph/core";

export interface FileStatInfo {
  size: number;
  mtimeMs: number;
}

export interface ResolvedMarkdownImage {
  url: string;
}

export interface NotesGraphApi {
  read: (filePath: string) => Promise<VersionedNoteDocument>;
  save: (filePath: string, frontmatter: Record<string, unknown>, body: string, expectedRevision: string) => Promise<DocumentSaveResult>;
  saveCopy: (filePath: string, frontmatter: Record<string, unknown>, body: string) => Promise<VersionedNoteDocument>;
  stat: (filePath: string) => Promise<FileStatInfo | null>;
  getGraphContext: (filePath: string) => Promise<WorkspaceGraphContext | null>;
  getGraphTopology: () => Promise<GraphTopology>;
  getGraphConceptSummaries: (indexes: number[], sourceSnapshotId: string) => Promise<GraphConceptSummaryResult>;
  graphConceptLookup: (reference: GraphConceptLookupReference, sourceSnapshotId: string) => Promise<GraphConceptLookupResult>;
  getGraphConceptDetailByIndex: (index: number, sourceSnapshotId: string) => Promise<GraphConceptDetailByIndexResult>;
  resolveTarget: (sourceFilePath: string, target: string) => Promise<string | null>;
  resolveMarkdownImage: (sourceFilePath: string, target: string, lookupByFilename?: boolean) => Promise<ResolvedMarkdownImage>;
  ensureTarget: (sourceFilePath: string, target: string) => Promise<string>;
  suggestTargets: (
    sourceFilePath: string,
    query: string,
  ) => Promise<Array<{ filePath: string; title: string; target: string; snippet: string }>>;
}
