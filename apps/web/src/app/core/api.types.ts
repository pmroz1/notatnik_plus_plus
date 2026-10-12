/** Tiptap / ProseMirror JSON document. This is the canonical persisted content format. */
export interface DocNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: DocNode[];
  marks?: { type: string; attrs?: Record<string, unknown> }[];
  text?: string;
}

export interface PageSummary {
  id: string;
  parentId: string | null;
  title: string;
  icon: string | null;
  sortOrder: number;
  isFavorite: boolean;
  createdAt: string;
  updatedAt: string;
  lastOpenedAt: string | null;
  deletedAt: string | null;
  deletedRootId: string | null;
  revision: number;
  tags: string[];
}

export interface PageDetail extends PageSummary {
  contentJson: DocNode;
}

export interface SaveContentResponse {
  revision: number;
  updatedAt: string;
}

export interface SearchResult {
  id: string;
  parentId: string | null;
  title: string;
  icon: string | null;
  /** Plain text with U+0002 / U+0003 around matched terms. Never HTML. */
  snippet: string;
  rank: number;
}

export interface TagInfo {
  name: string;
  pageCount: number;
}

export interface ImportSummary {
  mode: 'merge' | 'replace';
  importedPages: number;
  safetyBackup: string | null;
}

export interface ApiErrorBody {
  error: { code: string; message: string };
  details?: Record<string, unknown>;
}

export const EMPTY_DOC: DocNode = { type: 'doc', content: [{ type: 'paragraph' }] };
