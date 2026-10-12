//! SQL persistence for pages and tags. All write operations run inside `BEGIN IMMEDIATE`
//! transactions to avoid SQLite lock-upgrade failures under concurrent writers.

use std::collections::HashMap;

use serde_json::{Value, json};
use sqlx::{SqliteConnection, SqlitePool};

use super::{
    content::{empty_document, extract_plain_text},
    model::{PageDetail, PageRow, PageSummary},
};
use crate::{
    db::{new_id, now},
    error::{AppError, AppResult},
    page_columns,
};

/// UI safeguard for tree depth (the data model itself has no limit).
pub const MAX_TREE_DEPTH: i64 = 64;
pub const MAX_TITLE_CHARS: usize = 500;
pub const MAX_ICON_CHARS: usize = 16;
pub const MAX_TAGS_PER_PAGE: usize = 32;
pub const MAX_TAG_CHARS: usize = 48;

pub async fn tags_by_page(conn: &mut SqliteConnection) -> AppResult<HashMap<String, Vec<String>>> {
    let rows: Vec<(String, String)> = sqlx::query_as(
        "SELECT pt.page_id, t.name FROM page_tags pt JOIN tags t ON t.id = pt.tag_id \
         ORDER BY t.name COLLATE NOCASE",
    )
    .fetch_all(&mut *conn)
    .await?;
    let mut map: HashMap<String, Vec<String>> = HashMap::new();
    for (page_id, name) in rows {
        map.entry(page_id).or_default().push(name);
    }
    Ok(map)
}

async fn tags_for(conn: &mut SqliteConnection, page_id: &str) -> AppResult<Vec<String>> {
    Ok(sqlx::query_scalar(
        "SELECT t.name FROM page_tags pt JOIN tags t ON t.id = pt.tag_id \
         WHERE pt.page_id = ? ORDER BY t.name COLLATE NOCASE",
    )
    .bind(page_id)
    .fetch_all(&mut *conn)
    .await?)
}

pub async fn list_pages(pool: &SqlitePool, include_deleted: bool) -> AppResult<Vec<PageSummary>> {
    let mut conn = pool.acquire().await?;
    let rows: Vec<PageRow> = if include_deleted {
        sqlx::query_as(concat!(
            "SELECT ",
            page_columns!(),
            " FROM pages ORDER BY sort_order, created_at"
        ))
        .fetch_all(&mut *conn)
        .await?
    } else {
        sqlx::query_as(concat!(
            "SELECT ",
            page_columns!(),
            " FROM pages WHERE deleted_at IS NULL ORDER BY sort_order, created_at"
        ))
        .fetch_all(&mut *conn)
        .await?
    };
    let mut tags = tags_by_page(&mut conn).await?;
    Ok(rows
        .into_iter()
        .map(|row| {
            let t = tags.remove(&row.id).unwrap_or_default();
            PageSummary::from_row(row, t)
        })
        .collect())
}

pub async fn find_row(conn: &mut SqliteConnection, id: &str) -> AppResult<Option<PageRow>> {
    Ok(sqlx::query_as(concat!(
        "SELECT ",
        page_columns!(),
        " FROM pages WHERE id = ?"
    ))
    .bind(id)
    .fetch_optional(&mut *conn)
    .await?)
}

async fn require_row(conn: &mut SqliteConnection, id: &str) -> AppResult<PageRow> {
    find_row(conn, id).await?.ok_or(AppError::NotFound)
}

pub async fn get_page(pool: &SqlitePool, id: &str, mark_opened: bool) -> AppResult<PageDetail> {
    let mut conn = pool.acquire().await?;
    if mark_opened {
        // Recents tracking only; deliberately does not change updated_at or revision.
        sqlx::query("UPDATE pages SET last_opened_at = ? WHERE id = ? AND deleted_at IS NULL")
            .bind(now())
            .bind(id)
            .execute(&mut *conn)
            .await?;
    }
    let row = require_row(&mut conn, id).await?;
    let content: String = sqlx::query_scalar("SELECT content_json FROM pages WHERE id = ?")
        .bind(id)
        .fetch_one(&mut *conn)
        .await?;
    let content_json: Value = serde_json::from_str(&content)
        .map_err(|e| AppError::Internal(anyhow::anyhow!("corrupt content_json for page: {e}")))?;
    let tags = tags_for(&mut conn, id).await?;
    Ok(PageDetail {
        summary: PageSummary::from_row(row, tags),
        content_json,
    })
}

pub fn validate_title(title: &str) -> AppResult<()> {
    if title.chars().count() > MAX_TITLE_CHARS {
        return Err(AppError::bad_request(format!(
            "Title must be at most {MAX_TITLE_CHARS} characters"
        )));
    }
    if title.chars().any(char::is_control) {
        return Err(AppError::bad_request(
            "Title must not contain control characters",
        ));
    }
    Ok(())
}

pub fn validate_icon(icon: &str) -> AppResult<()> {
    if icon.is_empty()
        || icon.chars().count() > MAX_ICON_CHARS
        || icon.chars().any(char::is_control)
    {
        return Err(AppError::bad_request(
            "Icon must be a short emoji or symbol",
        ));
    }
    Ok(())
}

pub fn validate_uuid(id: &str) -> AppResult<()> {
    uuid::Uuid::parse_str(id)
        .map(|_| ())
        .map_err(|_| AppError::bad_request("Invalid page id"))
}

/// Number of ancestors above `id` (0 for a root page).
async fn depth_of(conn: &mut SqliteConnection, id: &str) -> AppResult<i64> {
    let depth: i64 = sqlx::query_scalar(
        "WITH RECURSIVE anc(id, parent_id, depth) AS ( \
             SELECT id, parent_id, 0 FROM pages WHERE id = ? \
             UNION ALL \
             SELECT p.id, p.parent_id, anc.depth + 1 FROM pages p JOIN anc ON p.id = anc.parent_id \
             WHERE anc.depth < 10000 \
         ) SELECT COALESCE(MAX(depth), 0) FROM anc",
    )
    .bind(id)
    .fetch_one(&mut *conn)
    .await?;
    Ok(depth)
}

/// Height of the live subtree rooted at `id` (0 for a leaf).
async fn subtree_height(conn: &mut SqliteConnection, id: &str) -> AppResult<i64> {
    let height: i64 = sqlx::query_scalar(
        "WITH RECURSIVE sub(id, depth) AS ( \
             SELECT id, 0 FROM pages WHERE id = ? \
             UNION ALL \
             SELECT p.id, sub.depth + 1 FROM pages p JOIN sub ON p.parent_id = sub.id \
             WHERE sub.depth < 10000 \
         ) SELECT COALESCE(MAX(depth), 0) FROM sub",
    )
    .bind(id)
    .fetch_one(&mut *conn)
    .await?;
    Ok(height)
}

/// Ensures `parent_id` refers to a live page and the resulting depth is acceptable.
async fn check_parent(
    conn: &mut SqliteConnection,
    parent_id: &str,
    added_height: i64,
) -> AppResult<()> {
    let parent = find_row(conn, parent_id)
        .await?
        .ok_or_else(|| AppError::bad_request("Parent page does not exist"))?;
    if parent.deleted_at.is_some() {
        return Err(AppError::conflict(
            "parent_deleted",
            "Parent page is in the trash",
        ));
    }
    if depth_of(conn, parent_id).await? + 1 + added_height >= MAX_TREE_DEPTH {
        return Err(AppError::bad_request(format!(
            "Pages can be nested at most {MAX_TREE_DEPTH} levels deep"
        )));
    }
    Ok(())
}

async fn next_sort_order(conn: &mut SqliteConnection, parent_id: Option<&str>) -> AppResult<i64> {
    let max: Option<i64> = sqlx::query_scalar(
        "SELECT MAX(sort_order) FROM pages WHERE parent_id IS ? AND deleted_at IS NULL",
    )
    .bind(parent_id)
    .fetch_one(&mut *conn)
    .await?;
    Ok(max.map_or(0, |m| m + 1))
}

pub async fn create_page(
    pool: &SqlitePool,
    parent_id: Option<&str>,
    title: &str,
    icon: Option<&str>,
) -> AppResult<String> {
    validate_title(title)?;
    if let Some(icon) = icon {
        validate_icon(icon)?;
    }
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;
    if let Some(parent_id) = parent_id {
        validate_uuid(parent_id)?;
        check_parent(&mut tx, parent_id, 0).await?;
    }
    let id = new_id();
    let ts = now();
    let sort_order = next_sort_order(&mut tx, parent_id).await?;
    sqlx::query(
        "INSERT INTO pages (id, parent_id, title, icon, content_json, content_plain_text, \
         sort_order, created_at, updated_at, last_opened_at) VALUES (?, ?, ?, ?, ?, '', ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(parent_id)
    .bind(title)
    .bind(icon)
    .bind(empty_document().to_string())
    .bind(sort_order)
    .bind(&ts)
    .bind(&ts)
    .bind(&ts)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(id)
}

pub async fn update_metadata(
    pool: &SqlitePool,
    id: &str,
    title: Option<&str>,
    icon: Option<Option<&str>>,
    is_favorite: Option<bool>,
) -> AppResult<()> {
    if let Some(title) = title {
        validate_title(title)?;
    }
    if let Some(Some(icon)) = icon {
        validate_icon(icon)?;
    }
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;
    require_row(&mut tx, id).await?;
    let ts = now();
    // Each field is updated separately so content_json is never rewritten here.
    if let Some(title) = title {
        sqlx::query("UPDATE pages SET title = ?, updated_at = ? WHERE id = ?")
            .bind(title)
            .bind(&ts)
            .bind(id)
            .execute(&mut *tx)
            .await?;
    }
    if let Some(icon) = icon {
        sqlx::query("UPDATE pages SET icon = ?, updated_at = ? WHERE id = ?")
            .bind(icon)
            .bind(&ts)
            .bind(id)
            .execute(&mut *tx)
            .await?;
    }
    if let Some(fav) = is_favorite {
        sqlx::query("UPDATE pages SET is_favorite = ? WHERE id = ?")
            .bind(fav)
            .bind(id)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    Ok(())
}

pub enum SaveOutcome {
    Saved { revision: i64, updated_at: String },
    Conflict { revision: i64, updated_at: String },
}

/// Compare-and-swap content update: succeeds only if the stored revision equals `expected`.
pub async fn save_content(
    pool: &SqlitePool,
    id: &str,
    content: &Value,
    expected: i64,
) -> AppResult<SaveOutcome> {
    let plain = extract_plain_text(content);
    let ts = now();
    let mut conn = pool.acquire().await?;
    let updated: Option<(i64, String)> = sqlx::query_as(
        "UPDATE pages SET content_json = ?, content_plain_text = ?, revision = revision + 1, \
         updated_at = ? WHERE id = ? AND revision = ? RETURNING revision, updated_at",
    )
    .bind(content.to_string())
    .bind(&plain)
    .bind(&ts)
    .bind(id)
    .bind(expected)
    .fetch_optional(&mut *conn)
    .await?;
    if let Some((revision, updated_at)) = updated {
        return Ok(SaveOutcome::Saved {
            revision,
            updated_at,
        });
    }
    let row = require_row(&mut conn, id).await?;
    Ok(SaveOutcome::Conflict {
        revision: row.revision,
        updated_at: row.updated_at,
    })
}

/// Live sibling ids under `parent_id` ordered by position, excluding `exclude`.
async fn sibling_ids(
    conn: &mut SqliteConnection,
    parent_id: Option<&str>,
    exclude: &str,
) -> AppResult<Vec<String>> {
    Ok(sqlx::query_scalar(
        "SELECT id FROM pages WHERE parent_id IS ? AND deleted_at IS NULL AND id <> ? \
         ORDER BY sort_order, created_at",
    )
    .bind(parent_id)
    .bind(exclude)
    .fetch_all(&mut *conn)
    .await?)
}

async fn renumber(conn: &mut SqliteConnection, ids: &[String]) -> AppResult<()> {
    for (index, id) in ids.iter().enumerate() {
        sqlx::query("UPDATE pages SET sort_order = ? WHERE id = ?")
            .bind(index as i64)
            .bind(id)
            .execute(&mut *conn)
            .await?;
    }
    Ok(())
}

/// Returns true if `candidate` is `id` or one of its descendants.
async fn is_self_or_descendant(
    conn: &mut SqliteConnection,
    id: &str,
    candidate: &str,
) -> AppResult<bool> {
    let found: i64 = sqlx::query_scalar(
        "WITH RECURSIVE anc(id, parent_id) AS ( \
             SELECT id, parent_id FROM pages WHERE id = ? \
             UNION \
             SELECT p.id, p.parent_id FROM pages p JOIN anc ON p.id = anc.parent_id \
         ) SELECT COUNT(*) FROM anc WHERE id = ?",
    )
    .bind(candidate)
    .bind(id)
    .fetch_one(&mut *conn)
    .await?;
    Ok(found > 0)
}

pub async fn move_page(
    pool: &SqlitePool,
    id: &str,
    new_parent: Option<&str>,
    index: usize,
) -> AppResult<()> {
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;
    let row = require_row(&mut tx, id).await?;
    if row.deleted_at.is_some() {
        return Err(AppError::conflict("page_deleted", "Page is in the trash"));
    }
    if let Some(parent) = new_parent {
        validate_uuid(parent)?;
        if is_self_or_descendant(&mut tx, id, parent).await? {
            return Err(AppError::bad_request(
                "A page cannot be moved inside itself or its descendants",
            ));
        }
        let height = subtree_height(&mut tx, id).await?;
        check_parent(&mut tx, parent, height).await?;
    }
    let mut siblings = sibling_ids(&mut tx, new_parent, id).await?;
    let index = index.min(siblings.len());
    siblings.insert(index, id.to_string());
    sqlx::query("UPDATE pages SET parent_id = ? WHERE id = ?")
        .bind(new_parent)
        .bind(id)
        .execute(&mut *tx)
        .await?;
    renumber(&mut tx, &siblings).await?;
    if row.parent_id.as_deref() != new_parent {
        let old_siblings = sibling_ids(&mut tx, row.parent_id.as_deref(), id).await?;
        renumber(&mut tx, &old_siblings).await?;
    }
    tx.commit().await?;
    Ok(())
}

/// Ids of the subtree rooted at `id` (including `id`) in breadth-first order.
async fn subtree_ids(
    conn: &mut SqliteConnection,
    id: &str,
    live_only: bool,
) -> AppResult<Vec<String>> {
    let ids = if live_only {
        sqlx::query_scalar(
            "WITH RECURSIVE sub(id, depth) AS ( \
                 SELECT id, 0 FROM pages WHERE id = ? \
                 UNION ALL \
                 SELECT p.id, sub.depth + 1 FROM pages p JOIN sub ON p.parent_id = sub.id \
                 WHERE p.deleted_at IS NULL \
             ) SELECT id FROM sub ORDER BY depth",
        )
        .bind(id)
        .fetch_all(&mut *conn)
        .await?
    } else {
        sqlx::query_scalar(
            "WITH RECURSIVE sub(id, depth) AS ( \
                 SELECT id, 0 FROM pages WHERE id = ? \
                 UNION ALL \
                 SELECT p.id, sub.depth + 1 FROM pages p JOIN sub ON p.parent_id = sub.id \
             ) SELECT id FROM sub ORDER BY depth",
        )
        .bind(id)
        .fetch_all(&mut *conn)
        .await?
    };
    Ok(ids)
}

/// Duplicates a live page together with its live descendants. Returns the new root id.
pub async fn duplicate_page(pool: &SqlitePool, id: &str) -> AppResult<String> {
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;
    let root = require_row(&mut tx, id).await?;
    if root.deleted_at.is_some() {
        return Err(AppError::conflict("page_deleted", "Page is in the trash"));
    }
    let ids = subtree_ids(&mut tx, id, true).await?;
    let mapping: HashMap<String, String> = ids.iter().map(|old| (old.clone(), new_id())).collect();
    let ts = now();

    // Make room right after the original.
    sqlx::query(
        "UPDATE pages SET sort_order = sort_order + 1 \
         WHERE parent_id IS ? AND sort_order > ? AND deleted_at IS NULL",
    )
    .bind(root.parent_id.as_deref())
    .bind(root.sort_order)
    .execute(&mut *tx)
    .await?;

    for old_id in &ids {
        let new_page_id = &mapping[old_id];
        let is_root = old_id == id;
        let new_parent = if is_root {
            root.parent_id.clone()
        } else {
            let parent: Option<String> =
                sqlx::query_scalar("SELECT parent_id FROM pages WHERE id = ?")
                    .bind(old_id)
                    .fetch_one(&mut *tx)
                    .await?;
            parent.and_then(|p| mapping.get(&p).cloned())
        };
        sqlx::query(
            "INSERT INTO pages (id, parent_id, title, icon, content_json, content_plain_text, \
             sort_order, is_favorite, created_at, updated_at) \
             SELECT ?, ?, CASE WHEN ? THEN title || ' (copy)' ELSE title END, icon, content_json, \
             content_plain_text, CASE WHEN ? THEN sort_order + 1 ELSE sort_order END, 0, ?, ? \
             FROM pages WHERE id = ?",
        )
        .bind(new_page_id)
        .bind(new_parent)
        .bind(is_root)
        .bind(is_root)
        .bind(&ts)
        .bind(&ts)
        .bind(old_id)
        .execute(&mut *tx)
        .await?;
        sqlx::query("INSERT INTO page_tags (page_id, tag_id) SELECT ?, tag_id FROM page_tags WHERE page_id = ?")
            .bind(new_page_id)
            .bind(old_id)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    Ok(mapping[id].clone())
}

/// Moves a live page and its live descendants to the trash.
pub async fn soft_delete(pool: &SqlitePool, id: &str) -> AppResult<()> {
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;
    let row = require_row(&mut tx, id).await?;
    if row.deleted_at.is_some() {
        return Err(AppError::conflict(
            "page_deleted",
            "Page is already in the trash",
        ));
    }
    let ts = now();
    sqlx::query(
        "WITH RECURSIVE sub(id) AS ( \
             SELECT id FROM pages WHERE id = ? \
             UNION ALL \
             SELECT p.id FROM pages p JOIN sub ON p.parent_id = sub.id WHERE p.deleted_at IS NULL \
         ) UPDATE pages SET deleted_at = ?, deleted_root_id = ? \
           WHERE id IN (SELECT id FROM sub) AND deleted_at IS NULL",
    )
    .bind(id)
    .bind(&ts)
    .bind(id)
    .execute(&mut *tx)
    .await?;
    let siblings = sibling_ids(&mut tx, row.parent_id.as_deref(), id).await?;
    renumber(&mut tx, &siblings).await?;
    tx.commit().await?;
    Ok(())
}

/// Restores a trash root and everything that was trashed together with it. If the original
/// parent is no longer live, the page is restored at the top level so nothing is orphaned.
pub async fn restore(pool: &SqlitePool, id: &str) -> AppResult<PageSummary> {
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;
    let row = require_row(&mut tx, id).await?;
    match row.deleted_root_id.as_deref() {
        None => {
            return Err(AppError::conflict(
                "not_deleted",
                "Page is not in the trash",
            ));
        }
        Some(root) if root != id => {
            return Err(AppError::conflict(
                "restore_parent_instead",
                "This page was deleted together with a parent page; restore that page instead",
            ));
        }
        Some(_) => {}
    }
    let parent_live = match row.parent_id.as_deref() {
        None => false,
        Some(parent) => find_row(&mut tx, parent)
            .await?
            .is_some_and(|p| p.deleted_at.is_none()),
    };
    let new_parent = if parent_live {
        row.parent_id.clone()
    } else {
        None
    };
    let sort_order = next_sort_order(&mut tx, new_parent.as_deref()).await?;
    sqlx::query(
        "UPDATE pages SET deleted_at = NULL, deleted_root_id = NULL WHERE deleted_root_id = ?",
    )
    .bind(id)
    .execute(&mut *tx)
    .await?;
    sqlx::query("UPDATE pages SET parent_id = ?, sort_order = ? WHERE id = ?")
        .bind(new_parent.as_deref())
        .bind(sort_order)
        .bind(id)
        .execute(&mut *tx)
        .await?;
    let restored = require_row(&mut tx, id).await?;
    let tags = tags_for(&mut tx, id).await?;
    tx.commit().await?;
    Ok(PageSummary::from_row(restored, tags))
}

/// Irreversibly deletes a trash root and its whole subtree. Live pages cannot be purged.
pub async fn delete_permanently(pool: &SqlitePool, id: &str) -> AppResult<u64> {
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;
    let row = require_row(&mut tx, id).await?;
    if row.deleted_root_id.as_deref() != Some(id) {
        return Err(AppError::conflict(
            "not_in_trash",
            "Only pages in the trash can be deleted permanently",
        ));
    }
    let ids = subtree_ids(&mut tx, id, false).await?;
    // Children are removed by ON DELETE CASCADE; the FTS index by triggers.
    sqlx::query("DELETE FROM pages WHERE id = ?")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM tags WHERE id NOT IN (SELECT tag_id FROM page_tags)")
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(ids.len() as u64)
}

pub fn normalize_tags(tags: &[String]) -> AppResult<Vec<String>> {
    let mut out: Vec<String> = Vec::new();
    for tag in tags {
        let tag = tag.trim();
        if tag.is_empty() {
            continue;
        }
        if tag.chars().count() > MAX_TAG_CHARS || tag.chars().any(char::is_control) {
            return Err(AppError::bad_request(format!(
                "Tags must be at most {MAX_TAG_CHARS} characters"
            )));
        }
        if !out.iter().any(|t| t.eq_ignore_ascii_case(tag)) {
            out.push(tag.to_string());
        }
    }
    if out.len() > MAX_TAGS_PER_PAGE {
        return Err(AppError::bad_request(format!(
            "A page can have at most {MAX_TAGS_PER_PAGE} tags"
        )));
    }
    Ok(out)
}

pub async fn upsert_tag(conn: &mut SqliteConnection, name: &str) -> AppResult<String> {
    if let Some(id) = sqlx::query_scalar::<_, String>("SELECT id FROM tags WHERE name = ?")
        .bind(name)
        .fetch_optional(&mut *conn)
        .await?
    {
        return Ok(id);
    }
    let id = new_id();
    sqlx::query("INSERT INTO tags (id, name) VALUES (?, ?)")
        .bind(&id)
        .bind(name)
        .execute(&mut *conn)
        .await?;
    Ok(id)
}

pub async fn set_tags(pool: &SqlitePool, id: &str, tags: &[String]) -> AppResult<Vec<String>> {
    let tags = normalize_tags(tags)?;
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;
    require_row(&mut tx, id).await?;
    sqlx::query("DELETE FROM page_tags WHERE page_id = ?")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    for name in &tags {
        let tag_id = upsert_tag(&mut tx, name).await?;
        sqlx::query("INSERT OR IGNORE INTO page_tags (page_id, tag_id) VALUES (?, ?)")
            .bind(id)
            .bind(tag_id)
            .execute(&mut *tx)
            .await?;
    }
    sqlx::query("DELETE FROM tags WHERE id NOT IN (SELECT tag_id FROM page_tags)")
        .execute(&mut *tx)
        .await?;
    let result = tags_for(&mut tx, id).await?;
    tx.commit().await?;
    Ok(result)
}

pub async fn list_tags(pool: &SqlitePool) -> AppResult<Vec<Value>> {
    let rows: Vec<(String, i64)> = sqlx::query_as(
        "SELECT t.name, COUNT(p.id) FROM tags t \
         JOIN page_tags pt ON pt.tag_id = t.id \
         LEFT JOIN pages p ON p.id = pt.page_id AND p.deleted_at IS NULL \
         GROUP BY t.id ORDER BY t.name COLLATE NOCASE",
    )
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(|(name, count)| json!({ "name": name, "pageCount": count }))
        .collect())
}
