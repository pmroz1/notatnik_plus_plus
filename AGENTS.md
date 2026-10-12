# Engineering rules for agents and contributors

## Priorities
1. Never lose or silently overwrite notes. 2. Fast writing/navigation. 3. Privacy, simple
self-hosting. 4. Maintainable, tested code. 5. Keyboard accessibility.

## Layout
- `apps/api` — Rust crate `notes-api` (binary of the same name). Migrations in `apps/api/migrations`
  (never edit an applied migration; add a new one).
- `apps/web` — Angular 22 app; e2e tests in `apps/web/e2e`.
- `docs/` — architecture, API table, decisions, backup/restore. Keep `docs/api.md` accurate when
  routes change; record trade-offs in `docs/decisions.md`; update `ROADMAP.md` with progress.

## Must-keep invariants
- Tiptap JSON (`content_json`) is canonical. Plain text is derived server-side. Never persist HTML.
- Editor schema allowlist in `apps/api/src/pages/content.rs` must match the extensions in
  `apps/web/src/app/editor/editor-extensions.ts` (and slash commands). Adding an extension means
  updating both plus a round-trip test.
- Content saves are compare-and-swap on `revision` and return 409 on mismatch. Metadata
  endpoints must never write `content_json` or `revision`.
- The client never shows "Saved" before the server acknowledged that exact content; conflicts
  are never auto-resolved; recovery drafts are only removed after acknowledgement or an explicit
  user decision. Changes to `apps/web/src/app/autosave/` need unit tests.
- Every page write that changes title/content/trash state updates `pages_fts` in the same
  transaction (`repo.rs`).
- All `/api` routes except health and login require a session; mutations go through CSRF checks.
  Use bound SQL parameters only. Do not log note content, passwords or tokens.
- No third-party network requests (fonts, CDNs, analytics). No fake/placeholder UI.

## Commands (run before committing)
```bash
cargo fmt --all -- --check && cargo clippy --all-targets --all-features -- -D warnings && cargo test
cd apps/web && npm run format:check && npm run lint && npm run typecheck && npm test && npm run build
cd apps/web && npm run e2e          # requires the build; starts the API on :8090 itself
docker compose config
```

## Gotchas
- Tiptap's `commands.focus()` is asynchronous; call `editor.view.focus()` first when keystrokes
  must land immediately.
- The Suggestion plugin handles Escape itself; the slash menu only reacts to `onKeyDown`.
- Angular is zoneless; update signals, not plain fields, from editor callbacks.
- The API does not read `.env`; pass environment variables.
