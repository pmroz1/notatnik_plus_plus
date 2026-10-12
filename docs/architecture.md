# Architecture

Notatnik++ is a single-user web application: one Rust process serves a JSON API under `/api`
and the compiled Angular single-page app for every other path. All data lives in one SQLite
database in `NOTES_DATA_DIR`.

```
Browser (Angular 22 SPA + Tiptap 3)
   │  same origin, HttpOnly session cookie, X-Requested-With + Origin check
   ▼
notes-api (Axum 0.8 / Tokio)  ──  static files (apps/web/dist/web/browser)
   │  SQLx 0.9, parameterized queries
   ▼
SQLite  <data>/notes.db  (WAL, foreign_keys=ON, busy_timeout=10s, FTS5)
        <data>/backups/*.db (VACUUM INTO snapshots)
```

## Backend (`apps/api`)

| Module | Responsibility |
|---|---|
| `main.rs` | CLI (`serve`, `create-user`, `backup`, `verify-backup`, `restore`), tracing setup, graceful shutdown |
| `config.rs` | Environment configuration (`NOTES_*`) |
| `lib.rs` | Router, middleware stack (body limit, security headers, tracing, static files + SPA fallback) |
| `db.rs` | Pool creation, pragmas, migrations, `VACUUM INTO` backup + verification |
| `auth.rs` | Argon2id hashing, user provisioning, login/logout/me, session extractor, login rate limiter |
| `csrf.rs` | Middleware enforcing `X-Requested-With` + same-origin `Origin`/`Referer` on mutations |
| `error.rs` | `AppError` → consistent JSON error responses; internal errors are logged, not leaked |
| `pages/model.rs` | Request/response types (camelCase) |
| `pages/content.rs` | Editor-schema validation of Tiptap JSON and plain-text extraction |
| `pages/repo.rs` | All page SQL: tree ordering, moves with cycle/depth checks, trash/restore, duplicate, tags, FTS maintenance |
| `pages/mod.rs` | HTTP handlers for pages and tags |
| `search.rs` | FTS5 query building (escaped prefix terms) and ranking |
| `backup.rs` | Workspace export, validated transactional import, `POST /api/backup` |

There are deliberately no repository traits, service layers or event buses: handlers call
plain async functions that take a connection/transaction.

### Data model (`migrations/20261012000001_initial.sql`)

- `users(id, username UNIQUE, password_hash, created_at)`
- `sessions(token_hash PK, user_id → users ON DELETE CASCADE, created_at, expires_at, revoked_at)` —
  only the SHA-256 of the 256-bit random cookie token is stored.
- `pages(id, parent_id → pages, title, icon, content_json, content_plain_text, sort_order,
  is_favorite, created_at, updated_at, last_opened_at, deleted_at, deleted_root_id, revision)`
  with indexes on `(parent_id, sort_order)`, `updated_at`, `deleted_at`, `last_opened_at`,
  `deleted_root_id`.
- `tags(id, name UNIQUE COLLATE NOCASE)`, `page_tags(page_id, tag_id)` PK on both, cascades.
- `pages_fts` (FTS5, `unicode61 remove_diacritics 2`): `page_id UNINDEXED, title, body`,
  maintained explicitly by `repo.rs` in the same transaction as every title/content/trash
  change.

**Trash semantics.** Deleting a page sets `deleted_at` and `deleted_root_id = <page id>` on the
page and every live descendant in one transaction. A trash entry is a page whose
`deleted_root_id` equals its own id. Restore clears both columns for exactly the rows with that
`deleted_root_id`, so pages that were trashed separately earlier stay in the trash. If the
entry's parent is missing or trashed, the restored page moves to the top level, so nothing is
orphaned. Permanent delete only works on trash entries and removes the whole subtree
(`ON DELETE CASCADE` on `parent_id`).

**Revisions.** `revision` starts at 1 and is incremented only by content saves
(`UPDATE … WHERE id = ? AND revision = ?`). Metadata updates (title, icon, favorite, tags, move)
never touch `content_json` or `revision`.

## Frontend (`apps/web`)

Angular 22, standalone components, zoneless change detection, signals for state, OnPush
everywhere, Tailwind CSS 4, Angular CDK (menus, overlays, a11y, layout).

| Folder | Contents |
|---|---|
| `core/` | Typed `ApiService`, API types, `AuthService` + guard, CSRF and 401 interceptors, theme, toasts |
| `autosave/` | `PageSaveController` (per-page save state machine), `SaveCoordinator` (controllers outlive components), `DraftStore` (local recovery drafts) |
| `editor/` | `TiptapEditorComponent` (lifecycle, floating format toolbar, link editing, slash menu), extension list, slash commands, URL safety, Markdown export |
| `pages/` | `PagesStore` (page list signal + tree), page view/editor, home, trash, tree utilities, page actions |
| `shell/` | Layout, responsive sidebar, page tree with keyboard + drag-and-drop moves |
| `search/` | Ctrl/Cmd+K command/search dialog |
| `settings/` | Theme, export/import, backups, sign out |
| `shared/` | Confirm dialog, toasts, save indicator, download helpers |

### Editor lifecycle

`TiptapEditorComponent` creates the Tiptap `Editor` in `afterNextRender` against its host
element and destroys it in `ngOnDestroy`. The page view keys the editor by page id (`@for … track
id`), so switching pages always destroys the old instance and creates a fresh one — no editor is
ever re-used across pages and late events cannot leak to another page.

### Autosave pipeline

```
keystroke → editor update → controller.markDirty(doc)
              │ (state "unsaved", draft written to localStorage)
              ▼ debounce 700 ms
           PUT /content {contentJson, expectedRevision}
              │ only one request in flight per page; newer edits wait
              ├─ 200 → revision = response.revision; "saved" only if no edits happened meanwhile
              ├─ 409 → "conflict": autosave paused, local doc kept, banner offers copy/download,
              │        "Load latest" (after confirmation) or "Keep mine" (explicit overwrite)
              ├─ network/429/5xx → "error", retry after 1, 2, 5, 10, 20 s, then manual Retry
              └─ 401 → "error", user is sent to login; draft stays in localStorage
```

- Controllers are owned by `SaveCoordinator`, not by components, so navigating away keeps the
  pending save alive; the component flushes on destroy and the controller finishes in the
  background. A late response only updates its own controller.
- `beforeunload` warns while anything is unsaved; `pagehide` persists drafts.
- When a page is opened and a recovery draft exists: if the draft's base revision equals the
  server revision it is restored and saved automatically; otherwise a banner lets the user
  download/copy it, use it (as an explicit overwrite) or discard it.

### Security boundaries

- Cookies: `notes_session`, HttpOnly, SameSite=Strict, `Secure` in production.
- CSRF: custom header + same-origin check on all mutating requests.
- CSP: `default-src 'self'`, no inline scripts, `style-src 'self' 'unsafe-inline'` (Angular
  component styles), `frame-ancestors 'none'`, `connect-src 'self'`.
- Editor content is rendered by ProseMirror from validated JSON; HTML is never persisted. Pasted
  HTML goes through Tiptap's schema parser, which drops unknown nodes/attributes. Links are
  restricted to http(s)/mailto/relative on both client and server.
- No third-party requests: fonts are system fonts, no analytics, no CDNs.
