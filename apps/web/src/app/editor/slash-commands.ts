import { Editor, Extension, Range } from '@tiptap/core';
import { PluginKey } from '@tiptap/pm/state';
import { Suggestion, SuggestionKeyDownProps, SuggestionProps } from '@tiptap/suggestion';

export interface SlashCommand {
  id: string;
  title: string;
  description: string;
  keywords: string[];
  /** Short glyph shown in the menu. */
  glyph: string;
  run: (editor: Editor, range: Range) => void;
}

export const SLASH_COMMANDS: SlashCommand[] = [
  {
    id: 'text',
    title: 'Text',
    description: 'Plain paragraph',
    keywords: ['paragraph', 'p'],
    glyph: '¶',
    run: (e, r) => e.chain().focus().deleteRange(r).setParagraph().run(),
  },
  {
    id: 'h1',
    title: 'Heading 1',
    description: 'Large section heading',
    keywords: ['title', 'h1', 'big'],
    glyph: 'H1',
    run: (e, r) => e.chain().focus().deleteRange(r).setHeading({ level: 1 }).run(),
  },
  {
    id: 'h2',
    title: 'Heading 2',
    description: 'Medium section heading',
    keywords: ['subtitle', 'h2'],
    glyph: 'H2',
    run: (e, r) => e.chain().focus().deleteRange(r).setHeading({ level: 2 }).run(),
  },
  {
    id: 'h3',
    title: 'Heading 3',
    description: 'Small section heading',
    keywords: ['h3'],
    glyph: 'H3',
    run: (e, r) => e.chain().focus().deleteRange(r).setHeading({ level: 3 }).run(),
  },
  {
    id: 'bullet',
    title: 'Bulleted list',
    description: 'Simple bulleted list',
    keywords: ['unordered', 'ul', 'bullets'],
    glyph: '•',
    run: (e, r) => e.chain().focus().deleteRange(r).toggleBulletList().run(),
  },
  {
    id: 'numbered',
    title: 'Numbered list',
    description: 'List with numbering',
    keywords: ['ordered', 'ol', '1.'],
    glyph: '1.',
    run: (e, r) => e.chain().focus().deleteRange(r).toggleOrderedList().run(),
  },
  {
    id: 'todo',
    title: 'To-do list',
    description: 'Track tasks with checkboxes',
    keywords: ['task', 'checkbox', 'check'],
    glyph: '☑',
    run: (e, r) => e.chain().focus().deleteRange(r).toggleTaskList().run(),
  },
  {
    id: 'quote',
    title: 'Quote',
    description: 'Capture a quotation',
    keywords: ['blockquote', 'citation'],
    glyph: '❝',
    run: (e, r) => e.chain().focus().deleteRange(r).toggleBlockquote().run(),
  },
  {
    id: 'code',
    title: 'Code block',
    description: 'Monospaced code snippet',
    keywords: ['snippet', 'pre', 'fence'],
    glyph: '</>',
    run: (e, r) => e.chain().focus().deleteRange(r).toggleCodeBlock().run(),
  },
  {
    id: 'divider',
    title: 'Divider',
    description: 'Horizontal separator',
    keywords: ['hr', 'rule', 'line', 'separator'],
    glyph: '—',
    run: (e, r) => e.chain().focus().deleteRange(r).setHorizontalRule().run(),
  },
  {
    id: 'table',
    title: 'Table',
    description: '3×3 table with header row',
    keywords: ['grid', 'cells'],
    glyph: '▦',
    run: (e, r) =>
      e.chain().focus().deleteRange(r).insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(),
  },
];

/** Case-insensitive filter by title, id and keywords; title-prefix matches first. */
export function filterSlashCommands(query: string, commands = SLASH_COMMANDS): SlashCommand[] {
  const q = query.trim().toLowerCase();
  if (!q) {
    return commands;
  }
  const scored = commands
    .map((c) => {
      const title = c.title.toLowerCase();
      let score = -1;
      if (title.startsWith(q)) score = 0;
      else if (c.id.startsWith(q) || c.keywords.some((k) => k.startsWith(q))) score = 1;
      else if (title.includes(q) || c.keywords.some((k) => k.includes(q))) score = 2;
      return { c, score };
    })
    .filter((x) => x.score >= 0);
  return scored.sort((a, b) => a.score - b.score).map((x) => x.c);
}

/** UI hooks implemented by the Angular component that renders the menu. */
export interface SlashMenuRenderer {
  open(props: SuggestionProps<SlashCommand, SlashCommand>): void;
  update(props: SuggestionProps<SlashCommand, SlashCommand>): void;
  keyDown(props: SuggestionKeyDownProps): boolean;
  close(): void;
}

export const slashPluginKey = new PluginKey('slashCommands');

/** Slash command extension built on the open-source Suggestion utility. */
export function createSlashCommands(renderer: SlashMenuRenderer) {
  return Extension.create({
    name: 'slashCommands',
    addProseMirrorPlugins() {
      return [
        Suggestion<SlashCommand, SlashCommand>({
          editor: this.editor,
          pluginKey: slashPluginKey,
          char: '/',
          startOfLine: false,
          allowSpaces: false,
          items: ({ query }) => filterSlashCommands(query),
          command: ({ editor, range, props }) => props.run(editor, range),
          allow: ({ editor }) => !editor.isActive('codeBlock'),
          render: () => ({
            onStart: (props) => renderer.open(props),
            onUpdate: (props) => renderer.update(props),
            onKeyDown: (props) => renderer.keyDown(props),
            onExit: () => renderer.close(),
          }),
        }),
      ];
    },
  });
}
