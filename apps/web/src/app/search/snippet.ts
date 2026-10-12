export interface SnippetPart {
  text: string;
  match: boolean;
}

/**
 * Splits a server snippet marked with U+0002 (start) / U+0003 (end) into parts.
 * Rendering the parts as text nodes avoids ever interpreting note content as HTML.
 */
export function parseSnippet(snippet: string): SnippetPart[] {
  const parts: SnippetPart[] = [];
  let match = false;
  let buf = '';
  for (const ch of snippet) {
    if (ch === '\u0002' || ch === '\u0003') {
      if (buf) {
        parts.push({ text: buf, match });
      }
      buf = '';
      match = ch === '\u0002';
    } else {
      buf += ch;
    }
  }
  if (buf) {
    parts.push({ text: buf, match });
  }
  return parts;
}
