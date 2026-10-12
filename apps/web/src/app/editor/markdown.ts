import { DocNode } from '../core/api.types';

/**
 * Best-effort Markdown export of a single page. This is a convenience format only; the
 * lossless backup format is the JSON workspace export.
 */
export function docToMarkdown(doc: DocNode, title?: string): string {
  const blocks = (doc.content ?? []).map((n) => block(n, '')).filter((b) => b !== null);
  const body = blocks.join('\n\n');
  const heading = title?.trim() ? `# ${escapeText(title.trim())}\n\n` : '';
  return `${heading}${body}`.trimEnd() + '\n';
}

function block(node: DocNode, indent: string): string | null {
  switch (node.type) {
    case 'paragraph':
      return indent + inline(node.content);
    case 'heading': {
      const level = Number(node.attrs?.['level'] ?? 1);
      return `${indent}${'#'.repeat(Math.min(Math.max(level, 1), 6))} ${inline(node.content)}`;
    }
    case 'bulletList':
      return list(node, indent, () => '- ');
    case 'orderedList': {
      const start = Number(node.attrs?.['start'] ?? 1);
      return list(node, indent, (i) => `${start + i}. `);
    }
    case 'taskList':
      return list(node, indent, (_i, item) => (item.attrs?.['checked'] ? '- [x] ' : '- [ ] '));
    case 'blockquote':
      return (node.content ?? [])
        .map((c) => block(c, ''))
        .filter((b): b is string => b !== null)
        .join('\n\n')
        .split('\n')
        .map((line) => `${indent}> ${line}`.trimEnd())
        .join('\n');
    case 'codeBlock': {
      const lang = typeof node.attrs?.['language'] === 'string' ? node.attrs['language'] : '';
      const code = (node.content ?? []).map((t) => t.text ?? '').join('');
      const fence = code.includes('```') ? '~~~' : '```';
      return `${indent}${fence}${lang}\n${code}\n${indent}${fence}`;
    }
    case 'horizontalRule':
      return `${indent}---`;
    case 'table':
      return table(node);
    default:
      return node.content ? (node.content.map((c) => block(c, indent)).join('\n\n') ?? null) : null;
  }
}

function list(node: DocNode, indent: string, marker: (i: number, item: DocNode) => string): string {
  return (node.content ?? [])
    .map((item, i) => {
      const prefix = marker(i, item);
      const children = item.content ?? [];
      const [first, ...rest] = children;
      const head = first ? (block(first, '') ?? '') : '';
      const nested = rest
        .map((c) => block(c, indent + ' '.repeat(prefix.length)))
        .filter((b): b is string => b !== null);
      return [`${indent}${prefix}${head}`, ...nested].join('\n');
    })
    .join('\n');
}

function table(node: DocNode): string {
  const rows = (node.content ?? []).map((row) =>
    (row.content ?? []).map((cell) =>
      (cell.content ?? [])
        .map((p) => inline(p.content))
        .join(' ')
        .replace(/\|/g, '\\|'),
    ),
  );
  if (!rows.length) {
    return '';
  }
  const width = Math.max(...rows.map((r) => r.length));
  const pad = (r: string[]) => [...r, ...Array(width - r.length).fill('')];
  const [header, ...body] = rows;
  return [
    `| ${pad(header).join(' | ')} |`,
    `| ${Array(width).fill('---').join(' | ')} |`,
    ...body.map((r) => `| ${pad(r).join(' | ')} |`),
  ].join('\n');
}

function inline(nodes: DocNode[] | undefined): string {
  return (nodes ?? [])
    .map((n) => {
      if (n.type === 'hardBreak') {
        return '  \n';
      }
      let text = n.text ?? '';
      const marks = n.marks ?? [];
      const has = (t: string) => marks.some((m) => m.type === t);
      if (has('code')) {
        text = '`' + text + '`';
      } else {
        text = escapeText(text);
      }
      if (has('bold')) text = `**${text}**`;
      if (has('italic')) text = `*${text}*`;
      if (has('strike')) text = `~~${text}~~`;
      const link = marks.find((m) => m.type === 'link');
      if (link && typeof link.attrs?.['href'] === 'string') {
        text = `[${text}](${link.attrs['href'].replace(/\)/g, '%29')})`;
      }
      return text;
    })
    .join('');
}

function escapeText(text: string): string {
  return text.replace(/([\\`*_[\]#<>])/g, '\\$1');
}
