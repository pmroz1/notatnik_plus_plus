import { Injectable, inject } from '@angular/core';
import { Router } from '@angular/router';
import { ApiService } from '../core/api.service';
import { errorMessage } from '../core/api-error';
import { ToastService } from '../core/toast.service';
import { SaveCoordinator } from '../autosave/save-coordinator.service';
import { PagesStore } from './pages.store';
import { displayTitle, isSelfOrDescendant } from './tree';

/** User-level page operations with consistent feedback (toasts) and state refresh. */
@Injectable({ providedIn: 'root' })
export class PageActions {
  private readonly api = inject(ApiService);
  private readonly store = inject(PagesStore);
  private readonly toasts = inject(ToastService);
  private readonly router = inject(Router);
  private readonly saves = inject(SaveCoordinator);

  async create(parentId: string | null = null): Promise<void> {
    try {
      const page = await this.api.createPage({ parentId });
      this.store.upsert(page);
      if (parentId) {
        this.store.setExpanded(parentId, true);
      }
      await this.router.navigate(['/p', page.id], { state: { focusTitle: true } });
    } catch (err) {
      this.toasts.error(errorMessage(err, 'Could not create page'));
    }
  }

  async rename(id: string, title: string): Promise<void> {
    try {
      this.store.upsert(await this.api.updateMetadata(id, { title }));
    } catch (err) {
      this.toasts.error(errorMessage(err, 'Could not rename page'));
    }
  }

  async toggleFavorite(id: string): Promise<void> {
    const page = this.store.byId(id);
    if (!page) {
      return;
    }
    try {
      this.store.upsert(await this.api.updateMetadata(id, { isFavorite: !page.isFavorite }));
    } catch (err) {
      this.toasts.error(errorMessage(err, 'Could not update favorite'));
    }
  }

  async duplicate(id: string): Promise<void> {
    try {
      // Make sure the copy includes the latest local edits.
      await this.saves.existing(id)?.flush();
      const copy = await this.api.duplicate(id);
      await this.store.refresh();
      this.toasts.success(`Duplicated as “${displayTitle(copy)}”`);
      await this.router.navigate(['/p', copy.id]);
    } catch (err) {
      this.toasts.error(errorMessage(err, 'Could not duplicate page'));
    }
  }

  async move(id: string, parentId: string | null, index: number): Promise<boolean> {
    if (parentId && isSelfOrDescendant(this.store.all(), id, parentId)) {
      this.toasts.error('A page cannot be moved inside itself.');
      return false;
    }
    try {
      await this.api.move(id, parentId, index);
      if (parentId) {
        this.store.setExpanded(parentId, true);
      }
      await this.store.refresh();
      return true;
    } catch (err) {
      this.toasts.error(errorMessage(err, 'Could not move page'));
      await this.store.refresh().catch(() => undefined);
      return false;
    }
  }

  async moveToTrash(id: string): Promise<void> {
    const page = this.store.byId(id);
    try {
      await this.saves.existing(id)?.flush();
      await this.api.softDelete(id);
      await this.store.refresh();
      const current = this.router.url;
      const affected = this.store
        .all()
        .filter((p) => p.deletedRootId === id)
        .map((p) => p.id);
      if (affected.some((pid) => current.startsWith(`/p/${pid}`))) {
        await this.router.navigate(['/']);
      }
      this.toasts.success(`Moved “${page ? displayTitle(page) : 'page'}” to trash`, {
        label: 'Undo',
        run: () => void this.restore(id),
      });
    } catch (err) {
      this.toasts.error(errorMessage(err, 'Could not delete page'));
    }
  }

  async restore(id: string): Promise<void> {
    try {
      const restored = await this.api.restore(id);
      await this.store.refresh();
      this.toasts.success(`Restored “${displayTitle(restored)}”`);
    } catch (err) {
      this.toasts.error(errorMessage(err, 'Could not restore page'));
    }
  }

  async deletePermanently(id: string): Promise<void> {
    try {
      const res = await this.api.deletePermanently(id);
      this.saves.discard(id);
      await this.store.refresh();
      this.toasts.success(
        res.deletedPages === 1
          ? 'Page deleted forever'
          : `${res.deletedPages} pages deleted forever`,
      );
    } catch (err) {
      this.toasts.error(errorMessage(err, 'Could not delete page'));
    }
  }
}
