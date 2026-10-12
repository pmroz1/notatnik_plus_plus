import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  effect,
  inject,
  untracked,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { NavigationEnd, Router, RouterLink, RouterLinkActive } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import { filter, map } from 'rxjs';
import { CdkContextMenuTrigger, CdkMenu, CdkMenuItem, CdkMenuTrigger } from '@angular/cdk/menu';
import { AuthService } from '../core/auth.service';
import { PageSummary } from '../core/api.types';
import { PagesStore } from '../pages/pages.store';
import { PageActions } from '../pages/page-actions.service';
import {
  DropPosition,
  TreeNode,
  ancestorIds,
  displayTitle,
  moveTargetFor,
  siblingMove,
  visibleRows,
} from '../pages/tree';

/** Indentation is capped visually so very deep trees stay usable. */
const MAX_VISUAL_DEPTH = 12;

@Component({
  selector: 'app-sidebar',
  imports: [
    RouterLink,
    RouterLinkActive,
    CdkMenu,
    CdkMenuItem,
    CdkMenuTrigger,
    CdkContextMenuTrigger,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './sidebar.component.html',
})
export class SidebarComponent {
  readonly store = inject(PagesStore);
  readonly actions = inject(PageActions);
  readonly auth = inject(AuthService);
  private readonly router = inject(Router);

  readonly openSearch = output<void>();
  readonly collapse = output<void>();
  /** Emitted after navigating, so the mobile overlay can close. */
  readonly navigated = output<void>();

  private readonly renameInput = viewChild<ElementRef<HTMLInputElement>>('renameInput');

  readonly renamingId = signal<string | null>(null);
  readonly renameValue = signal('');
  readonly dragId = signal<string | null>(null);
  readonly dropHint = signal<{ id: string; position: DropPosition } | null>(null);

  private readonly url = toSignal(
    this.router.events.pipe(
      filter((e): e is NavigationEnd => e instanceof NavigationEnd),
      map((e) => e.urlAfterRedirects),
    ),
    { initialValue: this.router.url },
  );

  readonly selectedId = computed(() => {
    const m = /^\/p\/([^/?#]+)/.exec(this.url());
    return m ? decodeURIComponent(m[1]) : null;
  });

  readonly rows = computed(() => visibleRows(this.store.tree(), this.store.expanded()));

  constructor() {
    // Reveal the selected page in the tree (once per navigation).
    let lastRevealed: string | null = null;
    effect(() => {
      const id = this.selectedId();
      if (!id || id === lastRevealed || !this.store.loaded()) {
        return;
      }
      lastRevealed = id;
      untracked(() => this.store.expandAll(ancestorIds(this.store.all(), id)));
    });
  }

  indent(node: TreeNode): number {
    return Math.min(node.depth, MAX_VISUAL_DEPTH) * 14 + 6;
  }

  title(p: Pick<PageSummary, 'title'>): string {
    return displayTitle(p);
  }

  toggle(node: TreeNode, event?: Event): void {
    event?.preventDefault();
    event?.stopPropagation();
    this.store.setExpanded(node.page.id, !this.store.isExpanded(node.page.id));
  }

  onRowKeydown(event: KeyboardEvent, node: TreeNode): void {
    const hasChildren = node.children.length > 0;
    switch (event.key) {
      case 'F2':
        event.preventDefault();
        this.startRename(node.page);
        break;
      case 'ArrowRight':
        if (hasChildren && !this.store.isExpanded(node.page.id)) {
          event.preventDefault();
          this.store.setExpanded(node.page.id, true);
        }
        break;
      case 'ArrowLeft':
        if (hasChildren && this.store.isExpanded(node.page.id)) {
          event.preventDefault();
          this.store.setExpanded(node.page.id, false);
        }
        break;
      case 'ArrowDown':
      case 'ArrowUp': {
        if (event.altKey && event.shiftKey) {
          event.preventDefault();
          void this.moveBy(node.page, event.key === 'ArrowUp' ? 'up' : 'down');
          break;
        }
        event.preventDefault();
        const links = Array.from(
          (event.currentTarget as HTMLElement)
            .closest('[data-tree]')
            ?.querySelectorAll<HTMLElement>('[data-tree-link]') ?? [],
        );
        const at = links.indexOf(event.currentTarget as HTMLElement);
        links[at + (event.key === 'ArrowDown' ? 1 : -1)]?.focus();
        break;
      }
    }
  }

  // ----- rename -----

  startRename(page: PageSummary): void {
    this.renamingId.set(page.id);
    this.renameValue.set(page.title);
    setTimeout(() => {
      const el = this.renameInput()?.nativeElement;
      el?.focus();
      el?.select();
    });
  }

  async commitRename(): Promise<void> {
    const id = this.renamingId();
    if (!id) {
      return;
    }
    this.renamingId.set(null);
    const title = this.renameValue().trim();
    if (title !== (this.store.byId(id)?.title ?? '')) {
      this.store.setLocalTitle(id, title);
      await this.actions.rename(id, title);
    }
    this.focusRow(id);
  }

  cancelRename(): void {
    const id = this.renamingId();
    this.renamingId.set(null);
    if (id) {
      this.focusRow(id);
    }
  }

  private focusRow(id: string): void {
    setTimeout(() =>
      document.querySelector<HTMLElement>(`[data-tree-link="${CSS.escape(id)}"]`)?.focus(),
    );
  }

  // ----- moves -----

  async moveBy(page: PageSummary, direction: 'up' | 'down' | 'indent' | 'outdent'): Promise<void> {
    const target = siblingMove(this.store.all(), page.id, direction);
    if (target) {
      await this.actions.move(page.id, target.parentId, target.index);
      this.focusRow(page.id);
    }
  }

  canMove(page: PageSummary, direction: 'up' | 'down' | 'indent' | 'outdent'): boolean {
    return siblingMove(this.store.all(), page.id, direction) !== null;
  }

  onDragStart(event: DragEvent, node: TreeNode): void {
    this.dragId.set(node.page.id);
    event.dataTransfer?.setData('text/plain', node.page.id);
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'move';
    }
  }

  onDragOver(event: DragEvent, node: TreeNode): void {
    const dragged = this.dragId();
    if (!dragged) {
      return;
    }
    const el = event.currentTarget as HTMLElement;
    const rect = el.getBoundingClientRect();
    const y = (event.clientY - rect.top) / rect.height;
    const position: DropPosition = y < 0.25 ? 'before' : y > 0.75 ? 'after' : 'inside';
    if (!moveTargetFor(this.store.all(), dragged, node.page.id, position)) {
      this.dropHint.set(null);
      return;
    }
    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = 'move';
    }
    const hint = this.dropHint();
    if (hint?.id !== node.page.id || hint.position !== position) {
      this.dropHint.set({ id: node.page.id, position });
    }
  }

  async onDrop(event: DragEvent, node: TreeNode): Promise<void> {
    event.preventDefault();
    const dragged = this.dragId();
    const hint = this.dropHint();
    this.onDragEnd();
    if (!dragged || !hint || hint.id !== node.page.id) {
      return;
    }
    const target = moveTargetFor(this.store.all(), dragged, node.page.id, hint.position);
    if (target) {
      await this.actions.move(dragged, target.parentId, target.index);
    }
  }

  onDragEnd(): void {
    this.dragId.set(null);
    this.dropHint.set(null);
  }

  // ----- misc -----

  async newPage(parentId: string | null = null): Promise<void> {
    await this.actions.create(parentId);
    this.navigated.emit();
  }

  setTag(tag: string | null): void {
    this.store.tagFilter.set(this.store.tagFilter() === tag ? null : tag);
  }
}
