# Roadmap

Status as of 2026-10-12. ✅ done · 🟡 partial · ⏳ not started

## M0 — Foundation ✅
- ✅ Cargo workspace + Angular 22 app, pinned lockfiles, lint/format/typecheck/test scripts
- ✅ SQLite with SQLx migrations, WAL, foreign keys, busy timeout
- ✅ Tiptap 3 integrated directly (no wrapper), JSON round trip, clean destroy
- ✅ README, `.env.example`, Dockerfile, Docker Compose

## M1 — Private account + pages ✅
- ✅ `create-user` CLI (no registration, no default password), Argon2id, rate-limited login
- ✅ Server-side sessions (hashed tokens, HttpOnly SameSite=Strict cookie, expiry, logout), CSRF checks
- ✅ Page CRUD, nested tree, sidebar, create/rename/navigate, typed API service, loading/error states

## M2 — Editor and data safety ✅
- ✅ Headings, marks, links, lists, task lists, quotes, code blocks, dividers, tables
- ✅ Slash menu, floating format toolbar, link editing, title and emoji icon
- ✅ Server-side schema validation + plain-text extraction
- ✅ Debounced autosave, serialized per-page saves, CAS revisions, 409 conflict UI, retries with
  backoff, unload warning, local recovery drafts
- ✅ Tests: unit (save controller, drafts), API integration (conflicts, concurrent saves),
  e2e (rapid typing, navigation while saving, failed saves, two tabs, reload, restart)

## M3 — Organization and navigation ✅
- ✅ FTS5 search with snippets; Ctrl/Cmd+K dialog with keyboard navigation
- ✅ Favorites, recents, duplicate, trash/restore/permanent delete
- ✅ Drag-and-drop and keyboard reordering/reparenting with cycle prevention
- ✅ Light/dark/system theme, responsive mobile sidebar
- ✅ Tags with filter

## M4 — Backups, deployment, quality 🟡
- ✅ Versioned JSON export / validated transactional import (merge, confirmed replace)
- ✅ `VACUUM INTO` backups (CLI + UI), verify, offline restore CLI; documented restore test
- ✅ Docker Compose with named volume (verified: data survives recreation; backup + restore in container)
- ✅ CI workflow (Rust, web, e2e, Docker build)
- 🟡 Accessibility: keyboard navigation and ARIA roles done; no formal screen-reader/axe audit yet
- 🟡 Performance: fine for hundreds of pages; not profiled with very large workspaces
  (sidebar renders the full tree, no virtualization)

## Later / not started ⏳
- Images and file attachments (no upload UI exists until implemented)
- Page version history / snapshots
- OpenAPI document (currently `docs/api.md` is the maintained reference)
- Optional Tauri desktop shell
- Multi-device offline sync, collaboration — out of scope
