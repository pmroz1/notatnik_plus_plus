import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { BreakpointObserver } from '@angular/cdk/layout';
import { toSignal } from '@angular/core/rxjs-interop';
import { map } from 'rxjs';
import { PagesStore } from '../pages/pages.store';
import { SidebarComponent } from './sidebar.component';
import { SearchDialogComponent } from '../search/search-dialog.component';

const SIDEBAR_KEY = 'notatnik.sidebar';

@Component({
  selector: 'app-shell',
  imports: [RouterOutlet, SidebarComponent, SearchDialogComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'flex h-dvh overflow-hidden',
    '(document:keydown)': 'onGlobalKeydown($event)',
  },
  template: `
    <a
      href="#main"
      class="sr-only focus:not-sr-only focus:fixed focus:left-2 focus:top-2 focus:z-[70] focus:rounded focus:bg-panel focus:px-3 focus:py-2"
      >Skip to content</a
    >
    @if (isMobile() && mobileOpen()) {
      <div
        class="fixed inset-0 z-30 bg-black/40"
        aria-hidden="true"
        (click)="mobileOpen.set(false)"
      ></div>
    }
    @if (sidebarVisible()) {
      <aside
        class="z-40 h-full w-72 shrink-0 border-r border-line"
        [class.fixed]="isMobile()"
        [class.inset-y-0]="isMobile()"
        [class.left-0]="isMobile()"
        [class.shadow-2xl]="isMobile()"
        aria-label="Sidebar"
        data-testid="sidebar"
      >
        <app-sidebar
          (openSearch)="searchOpen.set(true)"
          (collapse)="toggleSidebar()"
          (navigated)="onNavigated()"
        />
      </aside>
    }
    <main id="main" class="relative min-w-0 flex-1 overflow-y-auto bg-canvas" tabindex="-1">
      @if (!sidebarVisible()) {
        <button
          type="button"
          class="icon-btn fixed left-2 top-1.5 z-30 bg-canvas"
          aria-label="Open sidebar"
          title="Open sidebar (Ctrl/Cmd+\\)"
          (click)="toggleSidebar()"
          data-testid="open-sidebar"
        >
          ☰
        </button>
      }
      <div [class.pl-10]="!sidebarVisible()" class="min-h-full">
        <router-outlet />
      </div>
    </main>
    <app-search-dialog [open]="searchOpen()" (closed)="searchOpen.set(false)" />
  `,
})
export class ShellComponent implements OnInit {
  private readonly store = inject(PagesStore);
  readonly isMobile = toSignal(
    inject(BreakpointObserver)
      .observe('(max-width: 767px)')
      .pipe(map((s) => s.matches)),
    { initialValue: window.matchMedia('(max-width: 767px)').matches },
  );
  readonly desktopOpen = signal(readSidebarPref());
  readonly mobileOpen = signal(false);
  readonly searchOpen = signal(false);

  sidebarVisible(): boolean {
    return this.isMobile() ? this.mobileOpen() : this.desktopOpen();
  }

  ngOnInit(): void {
    this.store.refresh().catch(() => undefined);
  }

  toggleSidebar(): void {
    if (this.isMobile()) {
      this.mobileOpen.update((v) => !v);
    } else {
      const next = !this.desktopOpen();
      this.desktopOpen.set(next);
      try {
        localStorage.setItem(SIDEBAR_KEY, next ? 'open' : 'closed');
      } catch {
        // ignore unavailable storage
      }
    }
  }

  onNavigated(): void {
    if (this.isMobile()) {
      this.mobileOpen.set(false);
    }
  }

  onGlobalKeydown(event: KeyboardEvent): void {
    const mod = event.ctrlKey || event.metaKey;
    if (mod && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      this.searchOpen.set(true);
    } else if (mod && event.key === '\\') {
      event.preventDefault();
      this.toggleSidebar();
    } else if (
      event.key === 'Escape' &&
      this.isMobile() &&
      this.mobileOpen() &&
      !this.searchOpen()
    ) {
      this.mobileOpen.set(false);
    }
  }
}

function readSidebarPref(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_KEY) !== 'closed';
  } catch {
    return true;
  }
}
