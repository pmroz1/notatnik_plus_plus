-- Initial schema for the private notes application.
-- Timestamps are UTC RFC 3339 strings with millisecond precision (lexicographically sortable).

CREATE TABLE users (
    id            TEXT PRIMARY KEY NOT NULL,
    username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    created_at    TEXT NOT NULL
);

CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY NOT NULL,          -- SHA-256 hex of the random cookie token
    user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    revoked_at TEXT
);
CREATE INDEX sessions_user_id_idx ON sessions (user_id);
CREATE INDEX sessions_expires_at_idx ON sessions (expires_at);

CREATE TABLE pages (
    id                 TEXT PRIMARY KEY NOT NULL,
    parent_id          TEXT REFERENCES pages (id) ON DELETE CASCADE,
    title              TEXT NOT NULL DEFAULT '',
    icon               TEXT,
    content_json       TEXT NOT NULL,
    content_plain_text TEXT NOT NULL DEFAULT '',
    sort_order         INTEGER NOT NULL DEFAULT 0,
    is_favorite        INTEGER NOT NULL DEFAULT 0 CHECK (is_favorite IN (0, 1)),
    created_at         TEXT NOT NULL,
    updated_at         TEXT NOT NULL,
    last_opened_at     TEXT,
    deleted_at         TEXT,
    -- Id of the page whose soft-deletion moved this page to the trash (itself for trash roots).
    deleted_root_id    TEXT,
    revision           INTEGER NOT NULL DEFAULT 1,
    CHECK (parent_id IS NULL OR parent_id <> id),
    CHECK ((deleted_at IS NULL) = (deleted_root_id IS NULL))
);
CREATE INDEX pages_parent_sort_idx ON pages (parent_id, sort_order);
CREATE INDEX pages_updated_at_idx ON pages (updated_at);
CREATE INDEX pages_deleted_at_idx ON pages (deleted_at);
CREATE INDEX pages_deleted_root_idx ON pages (deleted_root_id);
CREATE INDEX pages_last_opened_idx ON pages (last_opened_at);

CREATE TABLE tags (
    id   TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE
);

CREATE TABLE page_tags (
    page_id TEXT NOT NULL REFERENCES pages (id) ON DELETE CASCADE,
    tag_id  TEXT NOT NULL REFERENCES tags (id) ON DELETE CASCADE,
    PRIMARY KEY (page_id, tag_id)
);
CREATE INDEX page_tags_tag_idx ON page_tags (tag_id);

-- Standalone FTS5 index (not external-content) keyed by page id, so that VACUUM / VACUUM INTO
-- rowid renumbering can never desynchronise it from the pages table.
CREATE VIRTUAL TABLE pages_fts USING fts5 (
    page_id UNINDEXED,
    title,
    body,
    tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TRIGGER pages_fts_insert AFTER INSERT ON pages BEGIN
    INSERT INTO pages_fts (page_id, title, body) VALUES (new.id, new.title, new.content_plain_text);
END;

CREATE TRIGGER pages_fts_update AFTER UPDATE OF title, content_plain_text ON pages BEGIN
    DELETE FROM pages_fts WHERE page_id = old.id;
    INSERT INTO pages_fts (page_id, title, body) VALUES (new.id, new.title, new.content_plain_text);
END;

CREATE TRIGGER pages_fts_delete AFTER DELETE ON pages BEGIN
    DELETE FROM pages_fts WHERE page_id = old.id;
END;
