import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { ConfirmService } from '../shared/confirm.service';
import { PagesStore } from './pages.store';
import { PageActions } from './page-actions.service';
import { displayTitle } from './tree';

@Component({
  selector: 'app-trash',
  imports: [RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="mx-auto max-w-[800px] px-6 py-12">
      <h1 class="text-3xl font-bold">Trash</h1>
      <p class="mt-1 text-sm text-muted">
        Deleted pages keep their subpages and content until you delete them forever.
      </p>
      @if (!entries().length) {
        <p
          class="mt-10 rounded-lg border border-dashed border-line p-6 text-center text-muted"
          data-testid="trash-empty"
        >
          Trash is empty.
        </p>
      } @else {
        <ul
          class="mt-6 divide-y divide-line rounded-lg border border-line"
          data-testid="trash-list"
        >
          @for (e of entries(); track e.page.id) {
            <li class="flex flex-wrap items-center gap-3 px-4 py-3">
              <a
                [routerLink]="['/p', e.page.id]"
                class="flex min-w-0 flex-1 items-center gap-2 hover:underline"
              >
                <span aria-hidden="true">{{ e.page.icon ?? '📄' }}</span>
                <span class="truncate">{{ title(e.page) }}</span>
                @if (e.descendants) {
                  <span class="shrink-0 text-xs text-muted"
                    >+{{ e.descendants }} subpage{{ e.descendants === 1 ? '' : 's' }}</span
                  >
                }
              </a>
              <span class="text-xs text-muted"
                >{{ e.page.deletedAt?.slice(0, 16)?.replace('T', ' ') }} UTC</span
              >
              <button
                type="button"
                class="btn btn-sm"
                (click)="actions.restore(e.page.id)"
                data-testid="trash-restore"
              >
                Restore
              </button>
              <button
                type="button"
                class="btn btn-sm btn-danger"
                (click)="deleteForever(e.page.id, title(e.page), e.descendants)"
                data-testid="trash-delete"
              >
                Delete forever
              </button>
            </li>
          }
        </ul>
      }
    </div>
  `,
})
export class TrashComponent {
  readonly store = inject(PagesStore);
  readonly actions = inject(PageActions);
  private readonly confirm = inject(ConfirmService);
  readonly title = displayTitle;

  readonly entries = computed(() => {
    const all = this.store.all();
    return this.store.trash().map((page) => ({
      page,
      descendants: all.filter((p) => p.deletedRootId === page.id && p.id !== page.id).length,
    }));
  });

  async deleteForever(id: string, title: string, descendants: number): Promise<void> {
    const extra = descendants ? ` and ${descendants} subpage${descendants === 1 ? '' : 's'}` : '';
    const ok = await this.confirm.ask({
      title: 'Delete forever?',
      message: `“${title}”${extra} will be permanently deleted. This cannot be undone.`,
      confirmLabel: 'Delete forever',
      danger: true,
    });
    if (ok) {
      await this.actions.deletePermanently(id);
    }
  }
}
