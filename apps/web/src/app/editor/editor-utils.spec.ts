import { Editor } from '@tiptap/core';
import { DocNode } from '../core/api.types';
import { baseExtensions } from './editor-extensions';
import { docToMarkdown } from './markdown';
import { isSafeHref, normalizeHref } from './safe-url';
import { SLASH_COMMANDS, filterSlashCommands } from './slash-commands';

describe('safe links', () => {
  it('allows http(s), mailto and relative links only', () => {
    expect(isSafeHref('https://example.org')).toBe(true);
    expect(isSafeHref('mailto:me@example.org')).toBe(true);
    expect(isSafeHref('/p/123')).toBe(true);
    expect(isSafeHref('javascript:alert(1)')).toBe(false);
    expect(isSafeHref('JaVaScRiPt:alert(1)')).toBe(false);
    expect(isSafeHref('data:text/html,hi')).toBe(false);
    expect(isSafeHref('java\nscript:alert(1)')).toBe(false);
    expect(isSafeHref('')).toBe(false);
  });

  it('adds https to bare domains', () => {
    expect(normalizeHref('example.org')).toBe('https://example.org');
    expect(normalizeHref('mailto:a@b.c')).toBe('mailto:a@b.c');
    expect(normalizeHref('/relative')).toBe('/relative');
  });
});

describe('slash commands', () => {
  it('returns everything for an empty query', () => {
    expect(filterSlashCommands('')).toEqual(SLASH_COMMANDS);
  });

  it('ranks title prefixes first and matches keywords', () => {
    const ids = filterSlashCommands('head').map((c) => c.id);
    expect(ids.slice(0, 3)).toEqual(['h1', 'h2', 'h3']);
    expect(filterSlashCommands('checkbox').map((c) => c.id)).toContain('todo');
    expect(filterSlashCommands('zzz')).toEqual([]);
  });
});

describe('editor schema', () => {
  let editor: Editor;

  afterEach(() => editor?.destroy());

  it('round-trips every supported node and mark through JSON', () => {
    const doc: DocNode = {
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Title' }] },
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'b', marks: [{ type: 'bold' }] },
            { type: 'text', text: 'i', marks: [{ type: 'italic' }] },
            { type: 'text', text: 's', marks: [{ type: 'strike' }] },
            { type: 'text', text: 'c', marks: [{ type: 'code' }] },
            {
              type: 'text',
              text: 'l',
              marks: [{ type: 'link', attrs: { href: 'https://example.org' } }],
            },
          ],
        },
        {
          type: 'bulletList',
          content: [
            {
              type: 'listItem',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x' }] }],
            },
          ],
        },
        {
          type: 'orderedList',
          attrs: { start: 1 },
          content: [
            {
              type: 'listItem',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'y' }] }],
            },
          ],
        },
        {
          type: 'taskList',
          content: [
            {
              type: 'taskItem',
              attrs: { checked: true },
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 't' }] }],
            },
          ],
        },
        {
          type: 'blockquote',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'q' }] }],
        },
        {
          type: 'codeBlock',
          attrs: { language: 'ts' },
          content: [{ type: 'text', text: 'let a = 1;' }],
        },
        { type: 'horizontalRule' },
        {
          type: 'table',
          content: [
            {
              type: 'tableRow',
              content: [
                {
                  type: 'tableHeader',
                  content: [{ type: 'paragraph', content: [{ type: 'text', text: 'h' }] }],
                },
              ],
            },
            {
              type: 'tableRow',
              content: [
                {
                  type: 'tableCell',
                  content: [{ type: 'paragraph', content: [{ type: 'text', text: 'd' }] }],
                },
              ],
            },
          ],
        },
      ],
    };
    editor = new Editor({ extensions: baseExtensions(), content: doc });
    const json = editor.getJSON() as DocNode;
    const types = new Set<string>();
    const walk = (n: DocNode) => {
      types.add(n.type);
      n.marks?.forEach((m) => types.add(m.type));
      n.content?.forEach(walk);
    };
    walk(json);
    for (const t of [
      'heading',
      'bold',
      'italic',
      'strike',
      'code',
      'link',
      'bulletList',
      'orderedList',
      'taskList',
      'taskItem',
      'blockquote',
      'codeBlock',
      'horizontalRule',
      'table',
      'tableHeader',
      'tableCell',
    ]) {
      expect(types.has(t), t).toBe(true);
    }
    // Reloading the serialized JSON is lossless.
    const again = new Editor({ extensions: baseExtensions(), content: json });
    expect(again.getJSON()).toEqual(json);
    again.destroy();
  });

  it('drops unsafe link protocols on load', () => {
    editor = new Editor({
      extensions: baseExtensions(),
      content: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              {
                type: 'text',
                text: 'evil',
                marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }],
              },
            ],
          },
        ],
      },
    });
    expect(editor.getHTML()).not.toContain('javascript:');
  });
});

describe('markdown export', () => {
  it('renders common blocks', () => {
    const md = docToMarkdown(
      {
        type: 'doc',
        content: [
          { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Sub' }] },
          {
            type: 'paragraph',
            content: [{ type: 'text', text: 'bold', marks: [{ type: 'bold' }] }],
          },
          {
            type: 'taskList',
            content: [
              {
                type: 'taskItem',
                attrs: { checked: true },
                content: [{ type: 'paragraph', content: [{ type: 'text', text: 'done' }] }],
              },
            ],
          },
          {
            type: 'codeBlock',
            attrs: { language: 'js' },
            content: [{ type: 'text', text: 'x()' }],
          },
        ],
      },
      'Title',
    );
    expect(md).toBe('# Title\n\n## Sub\n\n**bold**\n\n- [x] done\n\n```js\nx()\n```\n');
  });
});
