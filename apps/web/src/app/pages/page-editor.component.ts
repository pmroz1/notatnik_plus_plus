import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnDestroy,
  OnInit,
  computed,
  inject,
  input,
  signal,
  viewChild,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { CdkMenu, CdkMenuItem, CdkMenuTrigger } from '@angular/cdk/menu';
import { ApiService } from '../core/api.service';
import { errorMessage } from '../core/api-error';
import { DocNode, PageDetail, PageSummary } from '../core/api.types';
import { ToastService } from '../core/toast.service';
import { SaveCoordinator } from '../autosave/save-coordinator.service';
import { Draft } from '../autosave/draft-store';
import { PageSaveController } from '../autosave/page-save-controller';
import { TiptapEditorComponent } from '../editor/tiptap-editor.component';
import { docToMarkdown } from '../editor/markdown';
import { ConfirmService } from '../shared/confirm.service';
import { SaveIndicatorComponent } from '../shared/save-indicator.component';
import { downloadText, safeFileName } from '../shared/download';
import { PagesStore } from './pages.store';
import { PageActions } from './page-actions.service';
import { ancestorIds, displayTitle } from './tree';

const ICONS = [
  '📄', '📝', '📌', '📚', '💡', '✅', '🗂️', '📅', '🧠', '🔖', '⭐', '🔥',
  '🚀', '🎯', '🛠️', '🧪', '📈', '💬', '🏠', '✈️', '🍳', '🎵', '🌱', '❤️',
];

const TITLE_DEBOUNCE_MS = 600;

@Component({
  selector: 'app-page-editor',
  imports: [
    RouterLink,
    CdkMenu,
    CdkMenuItem,
    CdkMenuTrigger,
    TiptapEditorComponent,
    SaveIndicatorComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './page-editor.component.html',
})
export class PageEditorComponent implements OnInit, OnDestroy {
  readonly pageId = input.required<string>();

  private readonly api = inject(ApiService);
  private readonly saves = inject(SaveCoordinator);
  private readonly toasts = inject(ToastService);
  private readonly confirm = inject(ConfirmService);
  readonly store = inject(PagesStore);
  readonly actions = inject(PageActions);

  private readonly editor = viewChild<TiptapEditorComponent>('editor');
  private readonly titleInput = viewChild<ElementRef<HTMLTextAreaElement>>('titleInput');

  readonly icons = ICONS;
  readonly page = signal<PageDetail | null>(null);
  readonly loadError = signal<string | null>(null);
  readonly initialDoc = signal<DocNode | null>(null);
  /** Bumped to recreate the editor with new content (e.g. after loading the latest version). */
  readonly editorKey = signal(0);
  readonly controller = signal<PageSaveController | null>(null);
  readonly staleDraft = signal<Draft | null>(null);
  readonly title = signal('');
  readonly iconPickerOpen = signal(false);
  readonly tagDraft = signal('');
  readonly busy = signal(false);

  readonly summary = computed(() => this.store.byId(this.pageId()));
  readonly isTrashed = computed(() => !!(this.summary()?.deletedAt ?? this.page()?.deletedAt));
  readonly icon = computed(() => this.summary()?.icon ?? this.page()?.icon ?? null);
  readonly tags = computed(() => this.summary()?.tags ?? this.page()?.tags ?? []);
  readonly isFavorite = computed(() => this.summary()?.isFavorite ?? false);
  readonly status = computed(() => this.controller()?.status() ?? 'saved');
  readonly breadcrumbs = computed(() =>
    ancestorIds(this.store.all(), this.pageId())
      .reverse()
      .map((id) => this.store.byId(id))
      .filter((p) => !!p)
      .map((p) => ({ id: p.id, title: displayTitle(p), icon: p.icon })),
  );

  private titleTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingTitle: string | null = null;
  private focusTitleOnLoad = false;

  ngOnInit(): void {
    const state = history.state as { focusTitle?: boolean } | null;
    this.focusTitleOnLoad = !!state?.focusTitle;
    void this.load();
  }

  ngOnDestroy(): void {
    void this.flushTitle();
    this.saves.release(this.pageId());
  }

  async load(): Promise<void> {
    const id = this.pageId();
    this.loadError.set(null);
    let page: PageDetail;
    try {
      page = await this.api.getPage(id);
    } catch (err) {
      this.loadError.set(errorMessage(err, 'Could not load this page'));
      return;
    }
    if (this.pageId() !== id) {
      return;
    }
    this.page.set(page);
    this.title.set(page.title);
    this.store.upsert(stripContent(page));

    const pending = this.saves.existing(id);
    if (pending && !pending.idle) {
      // Edits from an earlier visit are still being saved: keep showing them.
      this.controller.set(pending);
      this.initialDoc.set(pending.currentDoc() ?? page.contentJson);
      this.editorKey.update((k) => k + 1);
      return;
    }

    const controller = this.saves.open(id, page.revision);
    this.controller.set(controller);
    const draft = this.saves.drafts.read(id);
    let doc = page.contentJson;
    let restored = false;
    if (draft && !sameDoc(draft.doc, page.contentJson)) {
      if (draft.baseRevision === page.revision && !page.deletedAt) {
        // Nothing changed on the server since the draft was taken: safe to restore.
        doc = draft.doc;
        restored = true;
      } else {
        this.staleDraft.set(draft);
      }
    } else if (draft) {
      this.saves.drafts.remove(id);
    }
    this.initialDoc.set(doc);
    this.editorKey.update((k) => k + 1);
    if (restored) {
      this.pendingRestoreMark = true;
      this.toasts.show('info', 'Recovered unsaved changes from this browser and saving them now.');
    }
  }

  private pendingRestoreMark = false;

  onEditorReady(): void {
    const controller = this.controller();
    const editor = this.editor();
    if (!controller || !editor) {
      return;
    }
    controller.attachSource(() => editor.getJSON());
    if (this.pendingRestoreMark) {
      this.pendingRestoreMark = false;
      controller.markDirty();
    }
    if (this.focusTitleOnLoad) {
      this.focusTitleOnLoad = false;
      setTimeout(() => this.titleInput()?.nativeElement.focus());
    }
  }

  onEditorChanged(): void {
    this.controller()?.markDirty();
  }

  retrySave(): void {
    this.controller()?.retryNow();
  }

  // ----- title / icon / tags / favorite -----

  onTitleInput(value: string): void {
    const title = value.replace(/[\r\n]+/g, ' ');
    this.title.set(title);
    this.store.setLocalTitle(this.pageId(), title);
    this.pendingTitle = title;
    if (this.titleTimer) {
      clearTimeout(this.titleTimer);
    }
    this.titleTimer = setTimeout(() => void this.flushTitle(), TITLE_DEBOUNCE_MS);
  }

  onTitleKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter' || (event.key === 'ArrowDown' && !event.shiftKey)) {
      event.preventDefault();
      void this.flushTitle();
      this.editor()?.focus('start');
    }
  }

  async flushTitle(): Promise<void> {
    if (this.titleTimer) {
      clearTimeout(this.titleTimer);
      this.titleTimer = null;
    }
    const title = this.pendingTitle;
    if (title === null) {
      return;
    }
    this.pendingTitle = null;
    await this.actions.rename(this.pageId(), title.trim());
  }

  async setIcon(icon: string | null): Promise<void> {
    this.iconPickerOpen.set(false);
    const id = this.pageId();
    try {
      this.store.upsert(await this.api.updateMetadata(id, { icon }));
    } catch (err) {
      this.toasts.error(errorMessage(err, 'Could not change icon'));
    }
  }

  async addTag(): Promise<void> {
    const tag = this.tagDraft().trim();
    if (!tag) {
      return;
    }
    this.tagDraft.set('');
    if (this.tags().some((t) => t.toLowerCase() === tag.toLowerCase())) {
      return;
    }
    await this.saveTags([...this.tags(), tag]);
  }

  async removeTag(tag: string): Promise<void> {
    await this.saveTags(this.tags().filter((t) => t !== tag));
  }

  private async saveTags(tags: string[]): Promise<void> {
    const id = this.pageId();
    try {
      const saved = await this.api.setTags(id, tags);
      const summary = this.store.byId(id);
      if (summary) {
        this.store.upsert({ ...summary, tags: saved });
      }
    } catch (err) {
      this.toasts.error(errorMessage(err, 'Could not update tags'));
    }
  }

  // ----- export helpers -----

  private localDoc(): DocNode {
    return this.controller()?.currentDoc() ?? this.editor()?.getJSON() ?? this.page()!.contentJson;
  }

  downloadDraft(doc: DocNode = this.localDoc()): void {
    const name = safeFileName(this.title());
    downloadText(`${name}.draft.json`, JSON.stringify(doc, null, 2), 'application/json');
  }

  async copyDraftText(doc: DocNode = this.localDoc()): Promise<void> {
    try {
      await navigator.clipboard.writeText(docToMarkdown(doc, this.title()));
      this.toasts.success('Copied your version to the clipboard as Markdown');
    } catch {
      this.toasts.error('Clipboard is not available. Use “Download my version” instead.');
    }
  }

  exportMarkdown(): void {
    const name = safeFileName(this.title());
    downloadText(`${name}.md`, docToMarkdown(this.localDoc(), this.title()), 'text/markdown');
  }

  // ----- conflict resolution -----

  async loadLatest(): Promise<void> {
    const ok = await this.confirm.ask({
      title: 'Load the latest version?',
      message:
        'Your local changes to this page will be discarded and replaced by the version saved elsewhere.\n\nDownload or copy your version first if you want to keep it.',
      confirmLabel: 'Discard mine and load latest',
      danger: true,
    });
    if (!ok) {
      return;
    }
    this.saves.discard(this.pageId());
    this.controller.set(null);
    this.staleDraft.set(null);
    this.initialDoc.set(null);
    await this.load();
  }

  async keepMine(): Promise<void> {
    const ok = await this.confirm.ask({
      title: 'Overwrite the other version?',
      message:
        'The version saved in the other tab or device will be replaced by what you see here. This cannot be undone.',
      confirmLabel: 'Overwrite with my version',
      danger: true,
    });
    if (!ok) {
      return;
    }
    try {
      this.busy.set(true);
      const latest = await this.api.getPage(this.pageId());
      this.controller()?.overwriteRemote(latest.revision);
    } catch (err) {
      this.toasts.error(errorMessage(err, 'Could not load the latest revision'));
    } finally {
      this.busy.set(false);
    }
  }

  // ----- stale recovery draft -----

  async useStaleDraft(): Promise<void> {
    const draft = this.staleDraft();
    const controller = this.controller();
    const page = this.page();
    if (!draft || !controller || !page) {
      return;
    }
    const ok = await this.confirm.ask({
      title: 'Replace the page with your unsaved draft?',
      message:
        'The page was changed after this draft was written. Using the draft replaces the current server version.',
      confirmLabel: 'Use draft',
      danger: true,
    });
    if (!ok) {
      return;
    }
    this.staleDraft.set(null);
    this.editor()?.setContent(draft.doc);
    controller.markDirty();
  }

  async discardStaleDraft(): Promise<void> {
    const ok = await this.confirm.ask({
      title: 'Discard the unsaved draft?',
      message: 'The recovered draft will be deleted from this browser.',
      confirmLabel: 'Discard draft',
      danger: true,
    });
    if (ok) {
      this.saves.drafts.remove(this.pageId());
      this.staleDraft.set(null);
    }
  }

  // ----- misc -----

  async restoreFromTrash(): Promise<void> {
    const summary = this.summary();
    if (!summary) {
      return;
    }
    await this.actions.restore(summary.deletedRootId ?? summary.id);
  }

  displayTitle = displayTitle;
}

function stripContent(page: PageDetail): PageSummary {
  const summary: PageSummary & { contentJson?: DocNode } = { ...page };
  delete summary.contentJson;
  return summary;
}

function sameDoc(a: DocNode, b: DocNode): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
