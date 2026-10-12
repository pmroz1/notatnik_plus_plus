import { computed, signal } from '@angular/core';
import { DocNode } from '../core/api.types';
import { DraftStorage } from './draft-store';

export type SaveStatus = 'saved' | 'unsaved' | 'saving' | 'error' | 'conflict';

export type SaveOutcome =
  | { kind: 'ok'; revision: number }
  | { kind: 'conflict'; currentRevision: number }
  | { kind: 'error'; transient: boolean; message: string };

export type SaveFn = (pageId: string, doc: DocNode, expectedRevision: number) => Promise<SaveOutcome>;

export interface SaveControllerOptions {
  debounceMs: number;
  /** Delays between automatic retries of transient failures. */
  retryDelaysMs: number[];
  /** Delay before writing the local recovery draft after a change. */
  draftDelayMs: number;
}

export const DEFAULT_SAVE_OPTIONS: SaveControllerOptions = {
  debounceMs: 700,
  retryDelaysMs: [1000, 2000, 5000, 10000, 20000],
  draftDelayMs: 250,
};

/**
 * Autosave state machine for a single page.
 *
 * Guarantees:
 * - at most one request in flight per page (saves are serialized, never reordered);
 * - every save carries the revision acknowledged by the previous save (compare-and-swap);
 * - "saved" is shown only when the server acknowledged exactly the latest local version;
 * - a revision conflict stops autosave until the user resolves it explicitly;
 * - unsaved content is mirrored to a local recovery draft until acknowledged.
 */
export class PageSaveController {
  readonly status = signal<SaveStatus>('saved');
  readonly errorMessage = signal<string | null>(null);
  readonly conflictRevision = signal<number | null>(null);
  readonly hasUnsavedChanges = computed(() => this.status() !== 'saved');

  private revision: number;
  private version = 0;
  private savedVersion = 0;
  private source: (() => DocNode) | null = null;
  private detachedDoc: DocNode | null = null;
  private inFlight: Promise<void> | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private draftTimer: ReturnType<typeof setTimeout> | null = null;
  private retryAttempt = 0;
  private disposed = false;

  constructor(
    readonly pageId: string,
    baseRevision: number,
    private readonly saveFn: SaveFn,
    private readonly drafts: DraftStorage,
    private readonly options: SaveControllerOptions = DEFAULT_SAVE_OPTIONS,
  ) {
    this.revision = baseRevision;
  }

  get currentRevision(): number {
    return this.revision;
  }

  /** True while there is nothing left to do for this page. */
  get idle(): boolean {
    return this.status() === 'saved' && !this.inFlight;
  }

  /** Connects a live editor. The document is read lazily, only when saving. */
  attachSource(source: () => DocNode): void {
    this.source = source;
    this.detachedDoc = null;
  }

  /** Called when the editor is destroyed: keeps a snapshot so pending saves can complete. */
  detachSource(): void {
    if (this.source) {
      this.detachedDoc = this.source();
      this.source = null;
    }
  }

  /** Latest local document (editor or snapshot). */
  currentDoc(): DocNode | null {
    return this.source ? this.source() : this.detachedDoc;
  }

  /** Marks a local change. Call on every editor update. */
  markDirty(): void {
    if (this.disposed) {
      return;
    }
    this.version++;
    if (this.status() !== 'conflict') {
      if (this.status() !== 'saving') {
        this.status.set('unsaved');
      }
      this.scheduleSave(this.options.debounceMs);
    }
    this.scheduleDraft();
  }

  /** Saves immediately (skipping debounce/backoff). Resolves true once everything is saved. */
  async flush(): Promise<boolean> {
    this.clearTimer('debounce');
    for (let guard = 0; guard < 20; guard++) {
      if (this.inFlight) {
        await this.inFlight;
        continue;
      }
      if (this.status() === 'conflict') {
        return false;
      }
      if (this.savedVersion === this.version) {
        return true;
      }
      this.startSave();
      if (!this.inFlight) {
        return false;
      }
      await this.inFlight;
      if (this.status() === 'error') {
        return false;
      }
    }
    return this.savedVersion === this.version;
  }

  /** Retry after a failure, e.g. from a "Retry" button or after logging in again. */
  retryNow(): void {
    if (this.status() === 'error') {
      this.retryAttempt = 0;
      this.scheduleSave(0);
    }
  }

  /**
   * Conflict resolution "keep my version": the user explicitly chose to overwrite the
   * server copy with the local document, based on the given (freshly fetched) revision.
   */
  overwriteRemote(latestRevision: number): void {
    this.revision = latestRevision;
    this.conflictRevision.set(null);
    this.errorMessage.set(null);
    this.status.set('unsaved');
    this.savedVersion = -1;
    this.scheduleSave(0);
  }

  /** Persists the recovery draft synchronously (used on page unload). */
  persistDraftNow(): void {
    this.clearTimer('draft');
    if (this.savedVersion !== this.version) {
      this.writeDraft();
    }
  }

  /** Stops timers. Unsaved content remains in the recovery draft. */
  dispose(): void {
    this.persistDraftNow();
    this.disposed = true;
    this.clearTimer('debounce');
    this.clearTimer('draft');
  }

  /** Drops local changes and the recovery draft (after an explicit user decision). */
  discardLocalChanges(): void {
    this.dispose();
    this.drafts.remove(this.pageId);
  }

  private scheduleSave(delay: number): void {
    this.clearTimer('debounce');
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      if (!this.inFlight) {
        this.startSave();
      }
    }, delay);
  }

  private scheduleDraft(): void {
    if (this.draftTimer) {
      return;
    }
    this.draftTimer = setTimeout(() => {
      this.draftTimer = null;
      if (this.savedVersion !== this.version) {
        this.writeDraft();
      }
    }, this.options.draftDelayMs);
  }

  private writeDraft(): void {
    const doc = this.currentDoc();
    if (doc) {
      this.drafts.write({
        pageId: this.pageId,
        baseRevision: this.revision,
        doc,
        savedAt: new Date().toISOString(),
      });
    }
  }

  private startSave(): void {
    if (this.disposed || this.inFlight || this.status() === 'conflict') {
      return;
    }
    if (this.savedVersion === this.version) {
      this.status.set('saved');
      return;
    }
    const doc = this.currentDoc();
    if (!doc) {
      return;
    }
    const version = this.version;
    const expected = this.revision;
    this.status.set('saving');
    this.inFlight = this.saveFn(this.pageId, doc, expected)
      .catch(
        (err: unknown): SaveOutcome => ({
          kind: 'error',
          transient: true,
          message: err instanceof Error ? err.message : 'Save failed',
        }),
      )
      .then((outcome) => {
        this.inFlight = null;
        this.handleOutcome(outcome, version);
      });
  }

  private handleOutcome(outcome: SaveOutcome, version: number): void {
    switch (outcome.kind) {
      case 'ok': {
        this.revision = outcome.revision;
        this.savedVersion = version;
        this.retryAttempt = 0;
        this.errorMessage.set(null);
        if (this.version === version) {
          this.status.set('saved');
          this.clearTimer('draft');
          this.drafts.remove(this.pageId);
        } else {
          // More edits arrived while saving; keep the draft current and save again.
          this.status.set('unsaved');
          this.writeDraft();
          if (!this.debounceTimer) {
            this.scheduleSave(this.options.debounceMs);
          }
        }
        return;
      }
      case 'conflict': {
        this.clearTimer('debounce');
        this.conflictRevision.set(outcome.currentRevision);
        this.errorMessage.set('This page was changed in another tab or device.');
        this.status.set('conflict');
        this.writeDraft();
        return;
      }
      case 'error': {
        this.status.set('error');
        this.writeDraft();
        const delay = this.options.retryDelaysMs[this.retryAttempt];
        if (outcome.transient && delay !== undefined && !this.disposed) {
          this.retryAttempt++;
          this.errorMessage.set(`${outcome.message} — retrying in ${Math.round(delay / 1000)}s`);
          this.scheduleSave(delay);
        } else {
          this.errorMessage.set(outcome.message);
        }
        return;
      }
    }
  }

  private clearTimer(which: 'debounce' | 'draft'): void {
    if (which === 'debounce' && this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (which === 'draft' && this.draftTimer) {
      clearTimeout(this.draftTimer);
      this.draftTimer = null;
    }
  }
}
