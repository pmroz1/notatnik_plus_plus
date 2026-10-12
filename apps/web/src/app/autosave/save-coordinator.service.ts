import { HttpErrorResponse } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { ApiService } from '../core/api.service';
import { errorMessage } from '../core/api-error';
import { DocNode } from '../core/api.types';
import { DraftStorage, LocalStorageDrafts } from './draft-store';
import { PageSaveController, SaveOutcome } from './page-save-controller';

/**
 * Owns one save controller per page with pending work. Controllers outlive the editor
 * component, so navigating away never cancels a pending save; late responses only ever
 * touch the controller (and therefore the page) they belong to.
 */
@Injectable({ providedIn: 'root' })
export class SaveCoordinator {
  private readonly api = inject(ApiService);
  readonly drafts: DraftStorage = new LocalStorageDrafts();
  private readonly controllers = new Map<string, PageSaveController>();

  constructor() {
    window.addEventListener('beforeunload', (event) => {
      this.persistAllDrafts();
      if (this.hasUnsavedChanges()) {
        event.preventDefault();
        // Legacy browsers require returnValue to be set to show the prompt.
        event.returnValue = '';
      }
    });
    window.addEventListener('pagehide', () => this.persistAllDrafts());
  }

  /** Existing controller with pending work for the page, if any. */
  existing(pageId: string): PageSaveController | undefined {
    return this.controllers.get(pageId);
  }

  /** Creates (or replaces an idle) controller for a freshly loaded page. */
  open(pageId: string, revision: number): PageSaveController {
    const current = this.controllers.get(pageId);
    if (current && !current.idle) {
      return current;
    }
    current?.dispose();
    const controller = new PageSaveController(
      pageId,
      revision,
      (id, doc, expected) => this.save(id, doc, expected),
      this.drafts,
    );
    this.controllers.set(pageId, controller);
    return controller;
  }

  /** Called when the editor for a page goes away; idle controllers are released. */
  release(pageId: string): void {
    const controller = this.controllers.get(pageId);
    if (!controller) {
      return;
    }
    controller.detachSource();
    if (controller.idle) {
      controller.dispose();
      this.controllers.delete(pageId);
    } else {
      void controller.flush().then(() => {
        if (controller.idle && this.controllers.get(pageId) === controller) {
          controller.dispose();
          this.controllers.delete(pageId);
        }
      });
    }
  }

  /** Drops local state for a page after the user explicitly discarded their changes. */
  discard(pageId: string): void {
    const controller = this.controllers.get(pageId);
    controller?.discardLocalChanges();
    this.controllers.delete(pageId);
    this.drafts.remove(pageId);
  }

  hasUnsavedChanges(): boolean {
    return [...this.controllers.values()].some((c) => c.hasUnsavedChanges());
  }

  unsavedPageIds(): string[] {
    return [...this.controllers.values()].filter((c) => c.hasUnsavedChanges()).map((c) => c.pageId);
  }

  /** Attempts to save everything; resolves true if nothing remains unsaved. */
  async flushAll(): Promise<boolean> {
    const results = await Promise.all([...this.controllers.values()].map((c) => c.flush()));
    return results.every(Boolean);
  }

  retryAll(): void {
    for (const c of this.controllers.values()) {
      c.retryNow();
    }
  }

  persistAllDrafts(): void {
    for (const c of this.controllers.values()) {
      c.persistDraftNow();
    }
  }

  private async save(pageId: string, doc: DocNode, expected: number): Promise<SaveOutcome> {
    try {
      const res = await this.api.saveContent(pageId, doc, expected);
      return { kind: 'ok', revision: res.revision };
    } catch (err) {
      if (err instanceof HttpErrorResponse) {
        if (err.status === 409) {
          const details = (err.error as { details?: { currentRevision?: number } } | null)?.details;
          return { kind: 'conflict', currentRevision: details?.currentRevision ?? -1 };
        }
        if (err.status === 401) {
          return {
            kind: 'error',
            transient: false,
            message: 'Session expired. Log in again; your draft is kept in this browser.',
          };
        }
        const transient = err.status === 0 || err.status === 429 || err.status >= 500;
        return { kind: 'error', transient, message: errorMessage(err, 'Save failed') };
      }
      return { kind: 'error', transient: true, message: errorMessage(err, 'Save failed') };
    }
  }
}
