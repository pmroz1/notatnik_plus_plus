import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { PagesStore } from './pages.store';
import { PageActions } from './page-actions.service';
import { displayTitle } from './tree';

@Component({
  selector: 'app-home',
  imports: [RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="mx-auto flex max-w-[720px] flex-col gap-8 px-6 py-20">
      <div>
        <h1 class="text-3xl font-bold">Welcome back</h1>
        <p class="mt-1 text-muted">Pick up where you left off or start something new.</p>
      </div>
      <div class="flex flex-wrap gap-2">
        <button
          type="button"
          class="btn btn-primary"
          (click)="actions.create()"
          data-testid="home-new-page"
        >
          New page
        </button>
        <span class="self-center text-sm text-muted"
          >or press <kbd class="kbd">Ctrl K</kbd> to search</span
        >
      </div>
      @if (store.recent().length) {
        <section aria-labelledby="home-recent">
          <h2 id="home-recent" class="section-heading px-0">Recently opened</h2>
          <ul class="grid gap-2 sm:grid-cols-2">
            @for (p of store.recent(); track p.id) {
              <li>
                <a
                  [routerLink]="['/p', p.id]"
                  class="flex items-center gap-2 rounded-lg border border-line p-3 hover:bg-hover"
                >
                  <span aria-hidden="true">{{ p.icon ?? '📄' }}</span>
                  <span class="truncate">{{ title(p) }}</span>
                </a>
              </li>
            }
          </ul>
        </section>
      } @else if (store.loaded() && !store.live().length) {
        <p class="rounded-lg border border-dashed border-line p-6 text-center text-muted">
          Your workspace is empty. Create your first page to get started.
        </p>
      }
    </div>
  `,
})
export class HomeComponent {
  readonly store = inject(PagesStore);
  readonly actions = inject(PageActions);
  readonly title = displayTitle;
}
