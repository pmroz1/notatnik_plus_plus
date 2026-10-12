import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnDestroy,
  afterNextRender,
  effect,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { Editor } from '@tiptap/core';
import { SuggestionKeyDownProps, SuggestionProps } from '@tiptap/suggestion';
import { DocNode } from '../core/api.types';
import { baseExtensions } from './editor-extensions';
import { normalizeHref, isSafeHref } from './safe-url';
import {
  SlashCommand,
  SlashMenuRenderer,
  createSlashCommands,
} from './slash-commands';

interface FloatingPos {
  top: number;
  left: number;
}

/**
 * Framework-agnostic Tiptap editor wrapped in an Angular component. The editor instance is
 * created exactly once after the first render and destroyed with the component.
 */
@Component({
  selector: 'app-tiptap-editor',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div #host class="notes-editor" data-testid="editor"></div>

    @if (toolbarPos(); as pos) {
      <div
        class="fixed z-40 flex items-center gap-0.5 rounded-lg border border-line bg-panel p-1 shadow-lg"
        [style.top.px]="pos.top"
        [style.left.px]="pos.left"
        role="toolbar"
        aria-label="Text formatting"
        (mousedown)="$event.preventDefault()"
      >
        @if (linkEditing()) {
          <form class="flex items-center gap-1" (submit)="applyLink($event)">
            <label class="sr-only" for="link-input">Link URL</label>
            <input
              #linkInput
              id="link-input"
              class="w-56 rounded border border-line bg-canvas px-2 py-1 text-sm outline-none focus:ring-2 focus:ring-accent"
              placeholder="https://…"
              [value]="linkDraft()"
              (input)="linkDraft.set(linkInput.value)"
              (keydown.escape)="cancelLink()"
              (mousedown)="$event.stopPropagation()"
            />
            <button type="submit" class="toolbar-btn">Save</button>
            <button type="button" class="toolbar-btn" (click)="removeLink()">Remove</button>
          </form>
        } @else {
          @for (b of markButtons; track b.mark) {
            <button
              type="button"
              class="toolbar-btn"
              [class.is-active]="activeMarks().has(b.mark)"
              [attr.aria-pressed]="activeMarks().has(b.mark)"
              [attr.aria-label]="b.label"
              [title]="b.label + ' (' + b.shortcut + ')'"
              (click)="toggleMark(b.mark)"
            >
              <span [class]="b.cls">{{ b.text }}</span>
            </button>
          }
          <button
            type="button"
            class="toolbar-btn"
            [class.is-active]="activeMarks().has('link')"
            aria-label="Link"
            title="Link (Ctrl/Cmd+Alt+K)"
            (click)="startLink()"
          >
            🔗
          </button>
        }
      </div>
    }

    @if (slashOpen()) {
      <div
        class="fixed z-50 max-h-80 w-72 overflow-y-auto rounded-lg border border-line bg-panel p-1 shadow-xl"
        [style.top.px]="slashPos().top"
        [style.left.px]="slashPos().left"
        role="listbox"
        id="slash-menu"
        aria-label="Insert block"
        data-testid="slash-menu"
        (mousedown)="$event.preventDefault()"
      >
        @for (item of slashItems(); track item.id; let i = $index) {
          <div
            role="option"
            tabindex="-1"
            [id]="'slash-opt-' + item.id"
            [attr.aria-selected]="i === slashIndex()"
            class="flex cursor-pointer items-center gap-3 rounded-md px-2 py-1.5 text-sm"
            [class.bg-hover]="i === slashIndex()"
            (mouseenter)="slashIndex.set(i)"
            (click)="chooseSlash(i)"
            (keydown.enter)="chooseSlash(i)"
          >
            <span
              class="flex h-8 w-8 shrink-0 items-center justify-center rounded border border-line bg-canvas text-xs font-semibold text-muted"
              aria-hidden="true"
              >{{ item.glyph }}</span
            >
            <span class="min-w-0">
              <span class="block font-medium">{{ item.title }}</span>
              <span class="block truncate text-xs text-muted">{{ item.description }}</span>
            </span>
          </div>
        } @empty {
          <div class="px-2 py-1.5 text-sm text-muted">No matching blocks</div>
        }
      </div>
    }
  `,
})
export class TiptapEditorComponent implements OnDestroy, SlashMenuRenderer {
  readonly content = input.required<DocNode>();
  readonly editable = input(true);
  /** Emitted on every user change of the document. */
  readonly changed = output<void>();
  readonly ready = output<Editor>();

  private readonly host = viewChild.required<ElementRef<HTMLElement>>('host');
  private readonly linkInput = viewChild<ElementRef<HTMLInputElement>>('linkInput');
  private editor: Editor | null = null;
  private lastDoc: DocNode | null = null;

  readonly toolbarPos = signal<FloatingPos | null>(null);
  readonly activeMarks = signal<ReadonlySet<string>>(new Set());
  readonly linkEditing = signal(false);
  readonly linkDraft = signal('');

  readonly slashOpen = signal(false);
  readonly slashItems = signal<SlashCommand[]>([]);
  readonly slashIndex = signal(0);
  readonly slashPos = signal<FloatingPos>({ top: 0, left: 0 });
  private slashCommand: ((item: SlashCommand) => void) | null = null;

  readonly markButtons = [
    { mark: 'bold', label: 'Bold', shortcut: 'Ctrl/Cmd+B', text: 'B', cls: 'font-bold' },
    { mark: 'italic', label: 'Italic', shortcut: 'Ctrl/Cmd+I', text: 'I', cls: 'italic' },
    { mark: 'underline', label: 'Underline', shortcut: 'Ctrl/Cmd+U', text: 'U', cls: 'underline' },
    { mark: 'strike', label: 'Strikethrough', shortcut: 'Ctrl/Cmd+Shift+S', text: 'S', cls: 'line-through' },
    { mark: 'code', label: 'Inline code', shortcut: 'Ctrl/Cmd+E', text: '</>', cls: 'font-mono text-xs' },
  ] as const;

  constructor() {
    afterNextRender(() => this.createEditor());
    effect(() => {
      const editable = this.editable();
      if (this.editor && this.editor.isEditable !== editable) {
        this.editor.setEditable(editable, false);
      }
    });
  }

  private createEditor(): void {
    if (this.editor) {
      return;
    }
    const editor = new Editor({
      element: this.host().nativeElement,
      extensions: [...baseExtensions(), createSlashCommands(this)],
      content: this.content(),
      editable: this.editable(),
      editorProps: {
        attributes: {
          class: 'prose-notes',
          'aria-label': 'Page content',
          'aria-multiline': 'true',
          role: 'textbox',
          spellcheck: 'true',
        },
        handleKeyDown: (_view, event) => this.handleShortcut(event),
      },
      onUpdate: ({ transaction }) => {
        if (transaction.docChanged) {
          this.changed.emit();
        }
      },
      onSelectionUpdate: () => this.updateToolbar(),
      onBlur: () => {
        if (!this.linkEditing()) {
          this.toolbarPos.set(null);
        }
      },
    });
    this.editor = editor;
    this.ready.emit(editor);
  }

  ngOnDestroy(): void {
    if (this.editor) {
      // Keep the final document so late readers (pending saves) never see stale content.
      this.lastDoc = this.editor.getJSON() as DocNode;
      this.editor.destroy();
      this.editor = null;
    }
  }

  getJSON(): DocNode {
    if (!this.editor) {
      return this.lastDoc ?? this.content();
    }
    return this.editor.getJSON() as DocNode;
  }

  /** Replaces the document without emitting a change event. */
  setContent(doc: DocNode): void {
    this.editor?.commands.setContent(doc, { emitUpdate: false });
  }

  setEditable(editable: boolean): void {
    this.editor?.setEditable(editable, false);
  }

  focus(position: 'start' | 'end' = 'start'): void {
    this.editor?.commands.focus(position);
  }

  // ----- selection toolbar -----

  private updateToolbar(): void {
    const editor = this.editor;
    if (!editor || !editor.isEditable) {
      return;
    }
    const { from, to, empty } = editor.state.selection;
    if (empty || editor.isActive('codeBlock')) {
      if (!this.linkEditing()) {
        this.toolbarPos.set(null);
      }
      return;
    }
    const start = editor.view.coordsAtPos(from);
    const end = editor.view.coordsAtPos(to);
    const top = Math.max(8, Math.min(start.top, end.top) - 48);
    const left = Math.max(8, Math.min(window.innerWidth - 320, (start.left + end.left) / 2 - 120));
    this.toolbarPos.set({ top, left });
    const marks = new Set<string>();
    for (const m of ['bold', 'italic', 'underline', 'strike', 'code', 'link']) {
      if (editor.isActive(m)) {
        marks.add(m);
      }
    }
    this.activeMarks.set(marks);
  }

  toggleMark(mark: string): void {
    this.editor?.chain().focus().toggleMark(mark).run();
    this.updateToolbar();
  }

  startLink(): void {
    const editor = this.editor;
    if (!editor || editor.state.selection.empty) {
      return;
    }
    this.linkDraft.set((editor.getAttributes('link')['href'] as string | undefined) ?? '');
    this.linkEditing.set(true);
    if (!this.toolbarPos()) {
      this.updateToolbar();
    }
    setTimeout(() => this.linkInput()?.nativeElement.focus());
  }

  applyLink(event: Event): void {
    event.preventDefault();
    const raw = this.linkDraft().trim();
    if (!raw) {
      this.removeLink();
      return;
    }
    const href = normalizeHref(raw);
    if (!isSafeHref(href)) {
      this.linkDraft.set('');
      return;
    }
    this.editor?.chain().focus().extendMarkRange('link').setLink({ href }).run();
    this.linkEditing.set(false);
    this.updateToolbar();
  }

  removeLink(): void {
    this.editor?.chain().focus().extendMarkRange('link').unsetLink().run();
    this.linkEditing.set(false);
    this.updateToolbar();
  }

  cancelLink(): void {
    this.linkEditing.set(false);
    this.editor?.commands.focus();
  }

  private handleShortcut(event: KeyboardEvent): boolean {
    const mod = event.metaKey || event.ctrlKey;
    if (mod && event.altKey && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      this.startLink();
      return true;
    }
    if (event.key === 'Escape' && this.toolbarPos()) {
      this.toolbarPos.set(null);
      return false;
    }
    return false;
  }

  // ----- slash menu (SlashMenuRenderer) -----

  open(props: SuggestionProps<SlashCommand, SlashCommand>): void {
    this.slashIndex.set(0);
    this.update(props);
    this.slashOpen.set(true);
  }

  update(props: SuggestionProps<SlashCommand, SlashCommand>): void {
    this.slashItems.set(props.items);
    this.slashCommand = props.command;
    if (this.slashIndex() >= props.items.length) {
      this.slashIndex.set(0);
    }
    const rect = props.clientRect?.();
    if (rect) {
      const menuHeight = 320;
      const below = rect.bottom + 6;
      const top = below + menuHeight > window.innerHeight ? Math.max(8, rect.top - menuHeight - 6) : below;
      this.slashPos.set({ top, left: Math.max(8, Math.min(rect.left, window.innerWidth - 300)) });
    }
  }

  keyDown({ event }: SuggestionKeyDownProps): boolean {
    const count = this.slashItems().length;
    switch (event.key) {
      case 'ArrowDown':
        if (count) this.slashIndex.set((this.slashIndex() + 1) % count);
        return true;
      case 'ArrowUp':
        if (count) this.slashIndex.set((this.slashIndex() - 1 + count) % count);
        return true;
      case 'Enter':
      case 'Tab':
        if (count) {
          this.chooseSlash(this.slashIndex());
          return true;
        }
        return false;
      case 'Escape':
        // The Suggestion plugin exits on Escape itself and then calls close().
        return true;
      default:
        return false;
    }
  }

  close(): void {
    this.slashOpen.set(false);
    this.slashCommand = null;
  }

  chooseSlash(index: number): void {
    const item = this.slashItems()[index];
    if (item && this.slashCommand) {
      this.slashCommand(item);
    }
  }
}
