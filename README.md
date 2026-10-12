# Notatnik++

A private, self-hosted, single-user notes app inspired by Notion's writing ergonomics:
nested pages, a fast rich-text editor with a `/` command menu, reliable autosave with conflict
detection, full-text search, favorites, recents, tags, trash, and lossless backups.

- **Frontend:** Angular 22 (standalone, zoneless, signals), Tiptap 3 / ProseMirror, Tailwind CSS 4, Angular CDK
- **Backend:** Rust (stable), Axum 0.8, Tokio, SQLx 0.9, SQLite (WAL + FTS5)
- **Auth:** one locally provisioned account, Argon2id, server-side sessions in HttpOnly cookies
- **No telemetry, no CDNs, no external accounts.** Everything is served from your machine.

See [ROADMAP.md](ROADMAP.md) for status, [docs/](docs) for architecture, API, decisions and
backup/restore.

## Features

- Nested page tree (sidebar) with expand/collapse, rename (F2 / double-click), context menu,
  drag-and-drop reordering/reparenting (cycle-safe), keyboard moves (Alt+Shift+Arrows)
- Favorites, recent pages, tags with tag filter
- Editor: title, emoji icon, paragraphs, H1–H3, bold/italic/underline/strike/inline code, links,
  bullet/numbered/task lists, quotes, code blocks, dividers, tables; floating format toolbar;
  `/` slash menu with filtering and keyboard navigation; Markdown input rules
- Autosave (700 ms debounce) with save indicator (Saved / Saving / Unsaved / Save failed /
  Conflict), retries with backoff, optimistic concurrency (`409` on revision mismatch),
  non-destructive conflict banner, local recovery drafts, unload warning
- Search (Ctrl/Cmd+K) over titles and body text with ranked results and highlighted snippets
- Trash: soft delete of subtrees, restore, permanent delete with confirmation
- Duplicate page (with subpages), Markdown export of a page, JSON export of a page
- Workspace JSON export/import (merge or confirmed replace), online SQLite backups
- Light / dark / system theme, responsive layout with mobile sidebar, keyboard accessible

Not included yet: images/attachments, version history, collaboration (see ROADMAP).

## Quick start with Docker (recommended)

Requires Docker with Compose v2.

```bash
docker compose up -d --build
# create your account (prompts for the password twice)
docker compose exec notatnik notes-api create-user --username yourname
```

Open <http://127.0.0.1:8080> and sign in. Data lives in the named volume `notes-data`
(`/data` in the container) and survives `docker compose down` / container recreation
(only `docker compose down -v` deletes it).

The port is published on **127.0.0.1 only**. To change it, copy `.env.example` to `.env` and set
`NOTES_PUBLISH` (e.g. `127.0.0.1:9000`). Read [Remote access](#remote-access-and-https) before
exposing it to a network.

## Local setup without Docker

Prerequisites: Rust stable (≥ 1.85, tested with 1.99), Node.js 22 LTS with npm 10.

### Linux / macOS

```bash
# 1. Build the frontend
cd apps/web && npm ci && npm run build && cd ../..

# 2. Build the API
cargo build --release -p notes-api

# 3. Create your account (data goes to ./data by default)
./target/release/notes-api create-user --username yourname

# 4. Run (API + built frontend on one origin)
NOTES_STATIC_DIR=apps/web/dist/web/browser ./target/release/notes-api serve
```

Open <http://127.0.0.1:8080>.

### Windows (PowerShell)

```powershell
cd apps\web; npm ci; npm run build; cd ..\..
cargo build --release -p notes-api
.\target\release\notes-api.exe create-user --username yourname
$env:NOTES_STATIC_DIR = "apps\web\dist\web\browser"
.\target\release\notes-api.exe serve
```

For non-interactive provisioning use `--password-stdin` (e.g.
`printf '%s' "$PASS" | notes-api create-user --username yourname --password-stdin`). To change
the password later use `--reset` (this also signs out all sessions). There is no registration
endpoint and no default password.

### Development mode (hot reload)

```bash
# terminal 1 – API on 127.0.0.1:8080 (data in ./data)
cargo run -p notes-api -- create-user --username dev   # once
cargo run -p notes-api

# terminal 2 – Angular dev server on http://localhost:4200, proxies /api to :8080
cd apps/web && npm ci && npm start
```

## Configuration

The API reads environment variables only (it does not load `.env` itself; Docker Compose does).

| Variable | Default | Meaning |
|---|---|---|
| `NOTES_DATA_DIR` | `./data` (`/data` in Docker) | Holds `notes.db` and `backups/` |
| `NOTES_BIND` | `127.0.0.1:8080` (`0.0.0.0:8080` inside the container) | Listen address |
| `NOTES_STATIC_DIR` | unset (`/app/web` in Docker) | Built SPA to serve; unset = API only |
| `NOTES_COOKIE_SECURE` | `false` | Set `true` when served over HTTPS |
| `NOTES_SESSION_TTL_HOURS` | `336` | Session lifetime |
| `NOTES_ALLOWED_ORIGINS` | empty | Extra allowed origins for mutations (comma separated) |
| `RUST_LOG` | `info` | Log filter |
| `NOTES_PUBLISH` | `127.0.0.1:8080` | Docker Compose host binding |

## Usage tips

| Shortcut | Action |
|---|---|
| Ctrl/Cmd+K | Search & commands |
| Ctrl/Cmd+\ | Toggle sidebar |
| `/` in the editor | Insert block menu |
| Ctrl/Cmd+B / I / U, Ctrl/Cmd+Shift+S, Ctrl/Cmd+E | Bold / italic / underline / strike / code |
| Ctrl/Cmd+Alt+K (with selection) | Edit link |
| Enter / ↓ in the title | Jump into the content |
| F2 on a sidebar page | Rename |
| Alt+Shift+↑/↓/←/→ on a sidebar page | Move up/down, outdent/indent |
| Escape | Close dialogs, menus, mobile sidebar |

If the save indicator shows **Conflict**, the page was changed in another tab/device. Your text
is kept; use the banner to copy or download it, load the latest version, or explicitly keep
yours.

## Backups and restore

```bash
notes-api backup                    # safe while running (SQLite VACUUM INTO)
notes-api verify-backup FILE
notes-api restore FILE --yes        # with the server stopped; old DB is kept aside
```

Settings also offers "Create backup now", workspace JSON export and import. Docker variants
and how to test a restore: [docs/backup-restore.md](docs/backup-restore.md).

## Tests and checks

```bash
# Rust (repo root)
cargo fmt --all -- --check
cargo clippy --all-targets --all-features -- -D warnings
cargo test

# Angular (apps/web)
npm run format:check
npm run lint
npm run typecheck
npm test                       # Vitest unit tests via Angular CLI
npm run build

# End-to-end (apps/web; needs `npm run build` first; builds and starts the API itself
# on 127.0.0.1:8090 with a temporary data directory)
npx playwright install chromium   # once
npm run e2e

# Docker
docker compose config
docker compose build
```

CI (`.github/workflows/ci.yml`) runs all of the above.

## Remote access and HTTPS

By default everything binds to localhost. Before exposing Notatnik++ beyond your machine:

1. Put it behind a reverse proxy that terminates **HTTPS** (Caddy, nginx, Traefik) and forwards
   the original `Host` header. Example (Caddy): `notes.example.lan { reverse_proxy 127.0.0.1:8080 }`.
2. Set `NOTES_COOKIE_SECURE=true`. If your proxy rewrites `Host`, set
   `NOTES_ALLOWED_ORIGINS=https://notes.example.lan`.
3. Prefer a VPN (e.g. WireGuard/Tailscale) over exposing it to the public Internet.

## Security notes and limitations

- Single account; no 2FA. Use a long unique password.
- Login rate limiting is per client IP and in-memory; behind a proxy all clients share one IP.
- Unsaved edits are kept as temporary recovery drafts in the browser's `localStorage` until the
  server confirms them. On shared computers use a private browser profile.
- Notes are stored unencrypted in SQLite; use disk encryption for data at rest and protect
  backup files the same way.
- The CSP allows inline styles (required by Angular component styles); scripts are same-origin only.

## License

See [LICENSE](LICENSE).
