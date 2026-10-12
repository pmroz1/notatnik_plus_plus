# HTTP API

All endpoints live under `/api`. Request and response bodies are JSON with **camelCase**
fields. Timestamps are RFC 3339 UTC strings, IDs are UUIDs.

## Conventions

- **Authentication**: every endpoint except `GET /api/health` and `POST /api/auth/login`
  requires the `notes_session` cookie (HttpOnly, SameSite=Strict, `Secure` when
  `NOTES_COOKIE_SECURE=true`). Missing/expired sessions get `401`.
- **CSRF**: every non-`GET`/`HEAD`/`OPTIONS` request must send
  `X-Requested-With: notatnik` **and** an `Origin` (or `Referer`) whose host matches the
  request `Host` (or an entry of `NOTES_ALLOWED_ORIGINS`). Otherwise `403 forbidden`.
- **Errors** always look like:
  ```json
  { "error": { "code": "revision_conflict", "message": "Human readable text" }, "details": { } }
  ```
  `details` is only present for some errors (e.g. conflicts).
- **Limits**: request bodies 4 MiB (import: 64 MiB); content JSON 2 MiB, depth 100,
  200 000 nodes; titles 500 chars; icons 16 chars; 32 tags × 48 chars per page; tree depth 64.
- Responses carry `Cache-Control: no-store` and security headers (CSP, `X-Frame-Options: DENY`,
  `X-Content-Type-Options: nosniff`, `Referrer-Policy: same-origin`).

## Endpoints

| Method & path | Body | Success | Notes |
|---|---|---|---|
| `GET /api/health` | – | `200 {"status":"ok"}` | No auth, no secrets. |
| `POST /api/auth/login` | `{username, password}` | `200 {username}` + cookie | wrong credentials → `403 forbidden`; `429 too_many_requests` with `Retry-After` after 5 failures/minute per client IP. |
| `POST /api/auth/logout` | – | `204` | Revokes the session server-side and clears the cookie. |
| `GET /api/auth/me` | – | `200 {username}` | |
| `GET /api/pages?includeDeleted=false` | – | `200 {pages: PageSummary[]}` | `includeDeleted=true` also returns trashed pages. |
| `POST /api/pages` | `{parentId?, title?, icon?}` | `201 PageDetail` | Appended as last child. Parent must exist and not be trashed. |
| `GET /api/pages/{id}` | – | `200 PageDetail` | Also records `lastOpenedAt` (recent pages). Trashed pages are readable. |
| `PATCH /api/pages/{id}/metadata` | `{title?, icon? (null clears), isFavorite?}` | `200 PageSummary` | Never touches content or `revision`. |
| `PUT /api/pages/{id}/content` | `{contentJson, expectedRevision}` | `200 {revision, updatedAt}` | Atomic compare-and-swap. Mismatch → `409 revision_conflict` with `details: {currentRevision, expectedRevision, updatedAt}`. Content is validated against the editor schema; plain text for search is extracted server-side. Trashed pages → `409 page_deleted`. |
| `POST /api/pages/{id}/duplicate` | – | `201 PageSummary` | Copies the live subtree; the copy's title gets ` (copy)`, placed right after the original. |
| `POST /api/pages/{id}/move` | `{parentId: string\|null, index}` | `204` | `index` is the position among the new siblings (excluding the moved page). Moving into itself/descendants → `400`; depth > 64 → `400`. |
| `DELETE /api/pages/{id}` | – | `204` | Soft delete: the page **and its live descendants** go to the trash together. |
| `POST /api/pages/{id}/restore` | – | `200 PageSummary` | Only for trash entries (pages deleted directly). Restores the whole subtree that was deleted with it. If the original parent is gone or trashed, the page is restored at the top level. Restoring a page that was trashed together with an ancestor → `409 restore_parent_instead`. |
| `DELETE /api/pages/{id}/permanent` | – | `200 {deletedPages}` | Irreversible. Only for trash entries; removes the subtree. |
| `PUT /api/pages/{id}/tags` | `{tags: string[]}` | `200 {tags}` | Replaces the tag set (case-insensitive de-duplication). |
| `GET /api/tags` | – | `200 {tags: [{name, pageCount}]}` | |
| `GET /api/search?q=…` | – | `200 {results: SearchResult[]}` | SQLite FTS5 over title (weight 10) and body text (weight 1), prefix matching per word, at most 30 results, trash excluded. `snippet` is plain text where matches are wrapped in U+0002 … U+0003. |
| `GET /api/export` | – | `200` workspace JSON (attachment) | See [backup-restore.md](backup-restore.md). |
| `POST /api/import?mode=merge` | workspace JSON | `200 {mode, importedPages, safetyBackup}` | Adds all pages as new copies with fresh IDs; existing data untouched. |
| `POST /api/import?mode=replace&confirm=replace-all-pages` | workspace JSON | `200 {…, safetyBackup}` | Writes a `VACUUM INTO` safety backup, then replaces all pages in one transaction (IDs preserved). |
| `POST /api/backup` | – | `200 {file, sizeBytes}` | Consistent database snapshot in `<data dir>/backups/`. |

Unknown `/api/*` paths return `404 not_found` as JSON.

### Types

```ts
interface PageSummary {
  id: string; parentId: string | null; title: string; icon: string | null;
  sortOrder: number; isFavorite: boolean; createdAt: string; updatedAt: string;
  lastOpenedAt: string | null; deletedAt: string | null; deletedRootId: string | null;
  revision: number; tags: string[];
}
interface PageDetail extends PageSummary { contentJson: TiptapDoc }
interface SearchResult { id: string; parentId: string | null; title: string; icon: string | null; snippet: string; rank: number }
```

`deletedRootId` identifies the deletion a trashed page belongs to: trash entries are pages with
`deletedRootId == id`.

### Accepted document schema

`contentJson` must be a Tiptap/ProseMirror document (`{"type":"doc","content":[…]}`) using only:

- nodes: `doc, paragraph, text, heading (level 1–3), bulletList, orderedList, listItem,
  taskList, taskItem (checked), blockquote, codeBlock (language), horizontalRule, hardBreak,
  table, tableRow, tableHeader, tableCell`
- marks: `bold, italic, underline, strike, code, link`

Link `href`s must be `http:`, `https:`, `mailto:` or relative. Anything else is rejected with
`400`. Keep this list in sync with `apps/web/src/app/editor/editor-extensions.ts` and
`apps/api/src/pages/content.rs`.
