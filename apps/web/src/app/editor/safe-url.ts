/**
 * Link URL policy shared by the editor and mirrored by the server
 * (`apps/api/src/pages/content.rs::is_safe_href`): http(s), mailto and scheme-less URLs only.
 */
export function isSafeHref(href: string): boolean {
  const value = href.trim();
  // eslint-disable-next-line no-control-regex
  if (!value || value.length > 2048 || /[\u0000-\u001f\u007f-\u009f]/.test(value)) {
    return false;
  }
  const colon = value.indexOf(':');
  if (colon === -1) {
    return true;
  }
  const scheme = value.slice(0, colon);
  if (/[/?#]/.test(scheme) || !/^[a-z0-9+.-]+$/i.test(scheme)) {
    return true;
  }
  return ['http', 'https', 'mailto'].includes(scheme.toLowerCase());
}

/** Adds https:// to bare domains typed by the user. */
export function normalizeHref(input: string): string {
  const value = input.trim();
  if (/^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith('/') || value.startsWith('#')) {
    return value;
  }
  return `https://${value}`;
}
