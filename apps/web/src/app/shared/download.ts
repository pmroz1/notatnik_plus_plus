/** Triggers a browser download of locally generated content (no server round trip). */
export function downloadText(filename: string, content: string, mime = 'text/plain'): void {
  const blob = new Blob([content], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** File-system friendly name derived from a page title. */
export function safeFileName(title: string, fallback = 'untitled'): string {
  const cleaned = title
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}\-_ ]+/gu, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 80);
  return cleaned || fallback;
}
