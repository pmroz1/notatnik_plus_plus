# Decisions

Short records of trade-offs. Newest at the bottom.

1. **Monorepo without a monorepo tool.** `apps/web` (npm/Angular CLI) and `apps/api` (Cargo
   workspace member) are independent; the root `Cargo.toml` is only a workspace manifest.
2. **Single process in production.** The API serves the built SPA (`NOTES_STATIC_DIR`), so
   frontend and API share one origin and no CORS is configured. In development the Angular dev
   server proxies `/api` to the API (`proxy.conf.json`), keeping the browser on one origin too.
3. **Tiptap without a wrapper.** The framework-agnostic `@tiptap/core` API is used directly in
   an Angular component; no React, no third-party Angular wrapper, only MIT-licensed
   `@tiptap/*` packages. Slash menu built on `@tiptap/suggestion`; floating toolbar is our own
   component positioned from the selection coordinates.
4. **Canonical content = Tiptap JSON.** `content_plain_text` is derived on the server from the
   JSON (not trusted from the client) on every save/import, so search can never drift from the
   document. The server validates the document against an allowlist mirroring the editor
   extensions (`pages/content.rs` ↔ `editor/editor-extensions.ts`).
5. **Revision covers content only.** Content saves use compare-and-swap on `revision`.
   Title/icon/favorite/tags/move are field-specific last-write-wins updates and do not bump the
   revision; otherwise renaming in one tab would spuriously conflict with typing in another.
6. **Conflicts are never auto-resolved.** On 409 autosave pauses; the user chooses to copy or
   download their draft, load the latest server version (after a warning), or overwrite
   explicitly. There is no merge in the MVP.
7. **Recovery drafts in `localStorage`.** Key `notatnik.draft.<pageId>`; written while a page has
   unsaved edits, removed once the server acknowledges the content. Privacy trade-off: unsaved
   note text may sit in browser storage on that device until acknowledged or discarded. Drafts are
   deliberately *not* wiped on sign-out (that would lose unsaved work); use a private browser
   profile on shared machines.
8. **Standalone FTS5 table** (not external-content) keyed by `page_id`, maintained explicitly
   in the same transactions as page writes. External-content tables depend on rowids, which
   `VACUUM` may renumber for tables without `INTEGER PRIMARY KEY`.
9. **Trash by `deleted_root_id`.** Lets a subtree be trashed/restored as a unit while keeping
   separately trashed descendants separate. Restoring under a trashed or missing parent moves
   the page to the top level rather than orphaning it.
10. **Server-side sessions, no JWT.** 256-bit random token in an HttpOnly SameSite=Strict
    cookie; only its SHA-256 is stored. Default lifetime 14 days (`NOTES_SESSION_TTL_HOURS`).
11. **CSRF defence in depth.** SameSite=Strict + required `X-Requested-With: notatnik` header
    (forces a CORS preflight cross-origin) + `Origin`/`Referer` must match `Host` or
    `NOTES_ALLOWED_ORIGINS`.
12. **In-memory login rate limit per client IP.** 5 failures per minute. Behind a reverse proxy
    all clients share the proxy IP, which is acceptable for a single-user app (it only slows
    down guessing). `X-Forwarded-For` is intentionally not trusted.
13. **Backups via `VACUUM INTO`.** Produces a consistent, compacted copy while the server runs;
    restore is an offline CLI operation that keeps the previous database aside.
14. **Import modes.** `merge` assigns fresh UUIDs (duplicate IDs can never collide); `replace`
    keeps original IDs but requires an explicit confirmation token and writes a safety backup
    first.
15. **CSP and Angular styles.** Critical-CSS inlining is disabled in the build, and the CSP
    allows `style-src 'unsafe-inline'` because Angular injects component styles at runtime.
    Scripts stay `'self'` only.
16. **Markdown export is lossy and client-side** (`editor/markdown.ts`); JSON export remains the
    backup format.
17. **Deferred:** attachments/images (no upload UI is shown), page version history, Tauri
    desktop shell, OpenAPI spec (the maintained endpoint table is `docs/api.md`).
18. **Zoneless Angular + signals.** Fewer change-detection surprises around the editor, which
    mutates the DOM outside Angular.
19. **Vitest via the Angular CLI unit-test builder** for unit tests, Playwright (Chromium)
    against the real API + built SPA for end-to-end tests; each e2e run uses a fresh temporary
    data directory.
