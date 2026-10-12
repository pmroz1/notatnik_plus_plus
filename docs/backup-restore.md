# Backups, export and restore

Notatnik++ has two complementary safety nets:

| | Database backup | Workspace export |
|---|---|---|
| What | Consistent copy of the whole SQLite database (`notes.db`) | Versioned JSON with every page, hierarchy, metadata, tags and Tiptap content |
| Includes | Pages, trash, tags, user account and sessions | Pages (incl. trash) and tags — **no** account or sessions |
| Restore | `notes-api restore` (server stopped) | Settings → Import, or `POST /api/import` |
| Use for | Disaster recovery, migrating a server | Long-term, human-readable archive; moving pages between installations |

Never copy `notes.db` while the server runs: in WAL mode the newest data may still be in
`notes.db-wal`, so a plain file copy can be inconsistent. Use the commands below.

## Database backups (SQLite `VACUUM INTO`)

```bash
# While the server is running (safe: uses VACUUM INTO, then runs an integrity check)
notes-api backup                      # → <data dir>/backups/notes-<timestamp>.db
notes-api backup --out /mnt/usb/notes-2026-10-12.db

# From the UI: Settings → "Create backup now" (same mechanism, POST /api/backup)

# Docker
docker compose exec notatnik notes-api backup
docker compose cp notatnik:/data/backups ./backups-from-container
```

`NOTES_DATA_DIR` decides where `notes.db` and `backups/` live (default `./data`; `/data` in
the container). Copy files from `backups/` to another disk regularly — a backup on the same disk
does not protect against disk failure.

### Verify a backup

```bash
notes-api verify-backup ./data/backups/notes-20261012T101500.000Z.db
```

This opens the file read-only, runs `PRAGMA integrity_check` and checks that it contains the
Notatnik++ `pages` table.

### Restore a backup

1. **Stop the server** (`Ctrl+C`, or `docker compose stop`).
2. Run:
   ```bash
   notes-api restore ./data/backups/notes-20261012T101500.000Z.db --yes
   ```
   The backup is verified first; the current database is checkpointed and kept as
   `notes.db.pre-restore-<timestamp>` next to it, then replaced.
3. Start the server again. Users stay logged in only if their sessions exist in the backup.

Docker:

```bash
docker compose stop notatnik
docker compose run --rm notatnik restore /data/backups/notes-<timestamp>.db --yes
docker compose start notatnik
```

(To restore a file from the host, first copy it into the volume, e.g.
`docker compose cp ./notes-old.db notatnik:/data/backups/` while the container exists.)

### How to test a restore (recommended monthly)

```bash
export NOTES_DATA_DIR=$(mktemp -d)                 # scratch data dir, never your real one
notes-api restore /path/to/backups/notes-<timestamp>.db --yes
NOTES_BIND=127.0.0.1:8099 NOTES_STATIC_DIR=apps/web/dist/web/browser notes-api serve
# open http://127.0.0.1:8099, sign in, spot-check recent pages, then stop and delete the dir
```

The integration test `online_backup_is_a_valid_database` exercises the same backup + verify path,
and the Playwright test `e2e/restart.spec.ts` checks data survives a server restart.

## Workspace export (lossless JSON)

`GET /api/export` (Settings → "Download workspace JSON") returns:

```json
{
  "format": "notatnik-workspace",
  "version": 1,
  "exportedAt": "2026-10-12T10:00:00.000Z",
  "pages": [
    {
      "id": "…uuid…",
      "parentId": null,
      "title": "Projects",
      "icon": "📁",
      "sortOrder": 0,
      "isFavorite": true,
      "createdAt": "…", "updatedAt": "…", "lastOpenedAt": "…",
      "deletedAt": null, "deletedRootId": null,
      "revision": 7,
      "tags": ["work"],
      "contentJson": { "type": "doc", "content": [ … Tiptap JSON … ] }
    }
  ]
}
```

- `contentJson` is the canonical editor document; plain text is re-derived on import.
- Trashed pages are included (`deletedAt`/`deletedRootId`).
- Future format versions will increase `version`; importers reject unknown versions.

Markdown export (page menu → "Export as Markdown") is a convenience only and is lossy.

## Import

The whole file is validated before anything is written: format/version, unique UUIDs, parents
present in the file, no cycles, depth ≤ 64, timestamps, titles/icons/tags, and every document
against the editor schema. A single invalid page rejects the import (`400` with a message
pointing at the page). Everything is written in one transaction.

- **merge** (default, safe): every page gets a **new ID**, the internal hierarchy is kept, the
  imported top-level pages are appended after existing ones. Nothing existing is modified, so
  duplicate IDs can never collide; importing the same file twice yields two copies.
- **replace** (destructive): requires `confirm=replace-all-pages` (the UI asks you to type
  `replace`). The server first writes a `VACUUM INTO` safety backup (path returned as
  `safetyBackup`), then deletes all pages/tags and inserts the file's pages with their
  original IDs and revisions.
