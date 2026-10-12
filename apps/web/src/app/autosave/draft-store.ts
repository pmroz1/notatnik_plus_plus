import { DocNode } from '../core/api.types';

/**
 * Temporary recovery drafts for edits the server has not acknowledged yet.
 *
 * Privacy: drafts are stored in this browser's localStorage (unencrypted, same origin only)
 * and are removed as soon as the server confirms the save or the user discards them.
 */
export interface Draft {
  pageId: string;
  /** Server revision the draft was based on. */
  baseRevision: number;
  doc: DocNode;
  savedAt: string;
}

export interface DraftStorage {
  read(pageId: string): Draft | null;
  write(draft: Draft): void;
  remove(pageId: string): void;
  list(): Draft[];
  clearAll(): void;
}

const PREFIX = 'notatnik.draft.';

export class LocalStorageDrafts implements DraftStorage {
  constructor(private readonly storage: Storage = window.localStorage) {}

  read(pageId: string): Draft | null {
    try {
      const raw = this.storage.getItem(PREFIX + pageId);
      if (!raw) {
        return null;
      }
      const parsed = JSON.parse(raw) as Draft;
      if (
        parsed?.pageId !== pageId ||
        typeof parsed.baseRevision !== 'number' ||
        parsed.doc?.type !== 'doc'
      ) {
        return null;
      }
      return parsed;
    } catch {
      return null;
    }
  }

  write(draft: Draft): void {
    try {
      this.storage.setItem(PREFIX + draft.pageId, JSON.stringify(draft));
    } catch (err) {
      // Quota exceeded or storage disabled: the in-memory draft and save retries still apply.
      console.warn('Could not store recovery draft', err);
    }
  }

  remove(pageId: string): void {
    try {
      this.storage.removeItem(PREFIX + pageId);
    } catch {
      // ignore unavailable storage
    }
  }

  list(): Draft[] {
    const drafts: Draft[] = [];
    try {
      for (let i = 0; i < this.storage.length; i++) {
        const key = this.storage.key(i);
        if (key?.startsWith(PREFIX)) {
          const draft = this.read(key.slice(PREFIX.length));
          if (draft) {
            drafts.push(draft);
          }
        }
      }
    } catch {
      // ignore unavailable storage
    }
    return drafts;
  }

  clearAll(): void {
    for (const d of this.list()) {
      this.remove(d.pageId);
    }
  }
}

/** In-memory implementation for tests. */
export class MemoryDrafts implements DraftStorage {
  readonly map = new Map<string, Draft>();
  read(pageId: string): Draft | null {
    return this.map.get(pageId) ?? null;
  }
  write(draft: Draft): void {
    this.map.set(draft.pageId, structuredClone(draft));
  }
  remove(pageId: string): void {
    this.map.delete(pageId);
  }
  list(): Draft[] {
    return [...this.map.values()];
  }
  clearAll(): void {
    this.map.clear();
  }
}
