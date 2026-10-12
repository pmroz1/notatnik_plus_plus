import { Injectable, computed, inject, signal } from '@angular/core';
import { ApiService } from '../core/api.service';
import { PageSummary } from '../core/api.types';
import { buildTree, displayTitle, trashRoots } from './tree';

const EXPANDED_KEY = 'notatnik.expanded';

/** Application-wide page list state (sidebar tree, favorites, recents, trash). */
@Injectable({ providedIn: 'root' })
export class PagesStore {
  private readonly api = inject(ApiService);

  /** All pages including trashed ones. */
  readonly all = signal<PageSummary[]>([]);
  readonly loading = signal(false);
  readonly loaded = signal(false);
  readonly error = signal<string | null>(null);
  readonly expanded = signal<ReadonlySet<string>>(readExpanded());
  readonly tagFilter = signal<string | null>(null);

  readonly live = computed(() => this.all().filter((p) => !p.deletedAt));
  readonly tree = computed(() => buildTree(this.all()));
  readonly favorites = computed(() =>
    this.live()
      .filter((p) => p.isFavorite)
      .sort((a, b) => displayTitle(a).localeCompare(displayTitle(b))),
  );
  readonly recent = computed(() =>
    this.live()
      .filter((p) => p.lastOpenedAt)
      .sort((a, b) => (b.lastOpenedAt ?? '').localeCompare(a.lastOpenedAt ?? ''))
      .slice(0, 5),
  );
  readonly trash = computed(() => trashRoots(this.all()));
  readonly tags = computed(() => {
    const counts = new Map<string, number>();
    for (const p of this.live()) {
      for (const t of p.tags) {
        counts.set(t, (counts.get(t) ?? 0) + 1);
      }
    }
    return [...counts.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => a.name.localeCompare(b.name));
  });
  readonly taggedPages = computed(() => {
    const tag = this.tagFilter();
    return tag ? this.live().filter((p) => p.tags.includes(tag)) : [];
  });

  byId(id: string): PageSummary | undefined {
    return this.all().find((p) => p.id === id);
  }

  async refresh(): Promise<void> {
    this.loading.set(true);
    try {
      this.all.set(await this.api.listPages(true));
      this.error.set(null);
      this.loaded.set(true);
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : 'Could not load pages');
      throw err;
    } finally {
      this.loading.set(false);
    }
  }

  /** Applies a server-confirmed summary locally without refetching everything. */
  upsert(summary: PageSummary): void {
    this.all.update((list) => {
      const idx = list.findIndex((p) => p.id === summary.id);
      if (idx === -1) {
        return [...list, summary];
      }
      const copy = list.slice();
      copy[idx] = summary;
      return copy;
    });
  }

  /** Optimistically updates a title in the sidebar while the user types. */
  setLocalTitle(id: string, title: string): void {
    this.all.update((list) => list.map((p) => (p.id === id ? { ...p, title } : p)));
  }

  setLocalIcon(id: string, icon: string | null): void {
    this.all.update((list) => list.map((p) => (p.id === id ? { ...p, icon } : p)));
  }

  isExpanded(id: string): boolean {
    return this.expanded().has(id);
  }

  setExpanded(id: string, open: boolean): void {
    const next = new Set(this.expanded());
    if (open) {
      next.add(id);
    } else {
      next.delete(id);
    }
    this.expanded.set(next);
    try {
      localStorage.setItem(EXPANDED_KEY, JSON.stringify([...next]));
    } catch {
      // ignore unavailable storage
    }
  }

  expandAll(ids: string[]): void {
    const next = new Set(this.expanded());
    let changed = false;
    for (const id of ids) {
      if (!next.has(id)) {
        next.add(id);
        changed = true;
      }
    }
    if (changed) {
      this.expanded.set(next);
    }
  }
}

function readExpanded(): ReadonlySet<string> {
  try {
    const raw = localStorage.getItem(EXPANDED_KEY);
    const arr = raw ? (JSON.parse(raw) as unknown) : [];
    return new Set(Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
}
