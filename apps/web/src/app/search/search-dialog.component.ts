import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { Router } from '@angular/router';
import { ApiService } from '../core/api.service';
import { errorMessage } from '../core/api-error';
import { PagesStore } from '../pages/pages.store';
import { PageActions } from '../pages/page-actions.service';
import { displayTitle } from '../pages/tree';
import { SnippetPart, parseSnippet } from './snippet';

interface ResultItem {
  kind: 'page' | 'action';
  id: string;
  title: string;
  icon: string | null;
  snippet: SnippetPart[];
  run?: () => void;
}

const SEARCH_DEBOUNCE_MS = 150;

/** Command palette / search dialog (Ctrl/Cmd+K). */
@Component({
  selector: 'app-search-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <!-- Backdrop clicks close the dialog; keyboard users close it with Escape (native). -->
    <!-- eslint-disable-next-line @angular-eslint/template/click-events-have-key-events, @angular-eslint/template/interactive-supports-focus -->
    <dialog
      #dialog
      class="dialog-panel top-[12vh] mt-0 w-[min(40rem,calc(100vw-1.5rem))]"
      aria-label="Search pages"
      (close)="restoreFocus(); closed.emit()"
      (click)="onBackdropClick($event)"
      data-testid="search-dialog"
    >
      <div class="flex items-center gap-2 border-b border-line px-4">
        <span class="text-muted" aria-hidden="true">⌕</span>
        <input
          #input
          class="h-12 min-w-0 flex-1 bg-transparent text-base outline-none"
          placeholder="Search pages or type a command…"
          role="combobox"
          aria-autocomplete="list"
          aria-controls="search-results"
          [attr.aria-expanded]="items().length > 0"
          [attr.aria-activedescendant]="items().length ? 'search-opt-' + active() : null"
          [value]="query()"
          (input)="onInput(input.value)"
          (keydown)="onKeydown($event)"
          data-testid="search-input"
        />
        @if (loading()) {
          <span class="text-xs text-muted" aria-live="polite">Searching…</span>
        }
      </div>
      <ul
        id="search-results"
        role="listbox"
        class="max-h-[60vh] overflow-y-auto p-2"
        aria-label="Results"
      >
        @if (!query().trim()) {
          <li
            class="px-2 pb-1 pt-2 text-xs font-medium uppercase tracking-wide text-muted"
            role="presentation"
          >
            Recent pages and actions
          </li>
        }
        @for (item of items(); track item.kind + item.id; let i = $index) {
          <li
            role="option"
            [id]="'search-opt-' + i"
            [attr.aria-selected]="i === active()"
            class="flex cursor-pointer items-start gap-3 rounded-md px-2 py-2"
            [class.bg-hover]="i === active()"
            (mousemove)="active.set(i)"
            tabindex="-1"
            (click)="choose(i)"
            (keydown.enter)="choose(i)"
            data-testid="search-result"
          >
            <span class="w-5 shrink-0 text-center" aria-hidden="true">{{
              item.icon ?? (item.kind === 'action' ? '›' : '📄')
            }}</span>
            <span class="min-w-0 flex-1">
              <span class="block truncate font-medium">{{ item.title }}</span>
              @if (item.snippet.length) {
                <span class="line-clamp-2 block text-xs text-muted">
                  @for (part of item.snippet; track $index) {
                    @if (part.match) {
                      <mark
                        class="rounded-sm bg-amber-200/70 px-0.5 text-ink dark:bg-amber-500/30"
                        >{{ part.text }}</mark
                      >
                    } @else {
                      {{ part.text }}
                    }
                  }
                </span>
              }
            </span>
          </li>
        } @empty {
          @if (query().trim() && !loading()) {
            <li class="px-2 py-6 text-center text-sm text-muted" role="presentation">
              {{ error() ?? 'No pages match “' + query().trim() + '”.' }}
            </li>
          }
        }
      </ul>
      <div class="flex gap-4 border-t border-line px-4 py-2 text-xs text-muted">
        <span><kbd class="kbd">↑↓</kbd> navigate</span>
        <span><kbd class="kbd">Enter</kbd> open</span>
        <span><kbd class="kbd">Esc</kbd> close</span>
      </div>
    </dialog>
  `,
})
export class SearchDialogComponent {
  readonly open = input(false);
  readonly closed = output<void>();

  private readonly api = inject(ApiService);
  private readonly router = inject(Router);
  private readonly store = inject(PagesStore);
  private readonly actions = inject(PageActions);
  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');
  private readonly inputEl = viewChild.required<ElementRef<HTMLInputElement>>('input');

  readonly query = signal('');
  readonly results = signal<ResultItem[]>([]);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  readonly active = signal(0);

  private timer: ReturnType<typeof setTimeout> | null = null;
  private requestSeq = 0;
  private previousFocus: HTMLElement | null = null;

  readonly items = computed<ResultItem[]>(() => {
    if (this.query().trim()) {
      return this.results();
    }
    const recent: ResultItem[] = this.store.recent().map((p) => ({
      kind: 'page',
      id: p.id,
      title: displayTitle(p),
      icon: p.icon,
      snippet: [],
    }));
    const commands: ResultItem[] = [
      {
        kind: 'action',
        id: 'new',
        title: 'Create a new page',
        icon: '+',
        snippet: [],
        run: () => void this.actions.create(),
      },
      {
        kind: 'action',
        id: 'settings',
        title: 'Open settings',
        icon: '⚙',
        snippet: [],
        run: () => void this.router.navigate(['/settings']),
      },
      {
        kind: 'action',
        id: 'trash',
        title: 'Open trash',
        icon: '🗑',
        snippet: [],
        run: () => void this.router.navigate(['/trash']),
      },
    ];
    return [...recent, ...commands];
  });

  constructor() {
    effect(() => {
      const el = this.dialog().nativeElement;
      if (this.open() && !el.open) {
        this.previousFocus = document.activeElement as HTMLElement | null;
        this.query.set('');
        this.results.set([]);
        this.error.set(null);
        this.active.set(0);
        el.showModal();
        this.inputEl().nativeElement.focus();
      } else if (!this.open() && el.open) {
        el.close();
      }
    });
  }

  onInput(value: string): void {
    this.query.set(value);
    this.active.set(0);
    if (this.timer) {
      clearTimeout(this.timer);
    }
    if (!value.trim()) {
      this.results.set([]);
      this.loading.set(false);
      return;
    }
    this.loading.set(true);
    this.timer = setTimeout(() => void this.search(value), SEARCH_DEBOUNCE_MS);
  }

  private async search(q: string): Promise<void> {
    const seq = ++this.requestSeq;
    try {
      const res = await this.api.search(q);
      if (seq !== this.requestSeq) {
        return; // a newer query superseded this one
      }
      this.error.set(null);
      this.results.set(
        res.map((r) => ({
          kind: 'page' as const,
          id: r.id,
          title: displayTitle(r),
          icon: r.icon,
          snippet: parseSnippet(r.snippet),
        })),
      );
    } catch (err) {
      if (seq === this.requestSeq) {
        this.results.set([]);
        this.error.set(errorMessage(err, 'Search failed'));
      }
    } finally {
      if (seq === this.requestSeq) {
        this.loading.set(false);
      }
    }
  }

  onKeydown(event: KeyboardEvent): void {
    const count = this.items().length;
    if (event.key === 'ArrowDown' && count) {
      event.preventDefault();
      this.active.set((this.active() + 1) % count);
      this.scrollActive();
    } else if (event.key === 'ArrowUp' && count) {
      event.preventDefault();
      this.active.set((this.active() - 1 + count) % count);
      this.scrollActive();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      this.choose(this.active());
    }
  }

  private scrollActive(): void {
    setTimeout(() =>
      this.dialog()
        .nativeElement.querySelector(`#search-opt-${this.active()}`)
        ?.scrollIntoView({ block: 'nearest' }),
    );
  }

  choose(index: number): void {
    const item = this.items()[index];
    if (!item) {
      return;
    }
    this.previousFocus = null;
    this.dialog().nativeElement.close();
    if (item.kind === 'page') {
      void this.router.navigate(['/p', item.id]);
    } else {
      item.run?.();
    }
  }

  onBackdropClick(event: MouseEvent): void {
    if (event.target === this.dialog().nativeElement) {
      this.dialog().nativeElement.close();
    }
  }

  /** Restores focus after a plain close (Escape/backdrop). */
  restoreFocus(): void {
    this.previousFocus?.focus?.();
    this.previousFocus = null;
  }
}
