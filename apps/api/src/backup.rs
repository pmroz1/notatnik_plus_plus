//! Lossless workspace export/import (versioned JSON) and online SQLite backups.

use std::collections::{HashMap, HashSet};

use axum::{
    Json,
    extract::{Query, State},
    http::header,
    response::IntoResponse,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::SqlitePool;

use crate::{
    AppState,
    auth::AuthUser,
    db::{self, new_id, now},
    error::{ApiJson, AppError, AppResult},
    pages::{
        content::{extract_plain_text, validate_document},
        repo::{self, MAX_TREE_DEPTH},
    },
};

pub const EXPORT_FORMAT: &str = "notatnik-workspace";
pub const EXPORT_VERSION: u32 = 1;
pub const REPLACE_CONFIRMATION: &str = "replace-all-pages";
const MAX_IMPORT_PAGES: usize = 100_000;

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceExport {
    pub format: String,
    pub version: u32,
    pub exported_at: String,
    pub pages: Vec<ExportedPage>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExportedPage {
    pub id: String,
    pub parent_id: Option<String>,
    pub title: String,
    pub icon: Option<String>,
    pub sort_order: i64,
    pub is_favorite: bool,
    pub created_at: String,
    pub updated_at: String,
    #[serde(default)]
    pub last_opened_at: Option<String>,
    #[serde(default)]
    pub deleted_at: Option<String>,
    #[serde(default)]
    pub deleted_root_id: Option<String>,
    pub revision: i64,
    #[serde(default)]
    pub tags: Vec<String>,
    pub content_json: Value,
}

#[derive(sqlx::FromRow)]
struct ExportRow {
    id: String,
    parent_id: Option<String>,
    title: String,
    icon: Option<String>,
    sort_order: i64,
    is_favorite: bool,
    created_at: String,
    updated_at: String,
    last_opened_at: Option<String>,
    deleted_at: Option<String>,
    deleted_root_id: Option<String>,
    revision: i64,
    content_json: String,
}

pub async fn build_export(pool: &SqlitePool) -> AppResult<WorkspaceExport> {
    let mut conn = pool.acquire().await?;
    let rows: Vec<ExportRow> = sqlx::query_as(
        "SELECT id, parent_id, title, icon, sort_order, is_favorite, created_at, updated_at, \
         last_opened_at, deleted_at, deleted_root_id, revision, content_json \
         FROM pages ORDER BY parent_id IS NOT NULL, sort_order, created_at",
    )
    .fetch_all(&mut *conn)
    .await?;
    let mut tags = repo::tags_by_page(&mut conn).await?;
    let mut pages = Vec::with_capacity(rows.len());
    for row in rows {
        let content_json = serde_json::from_str(&row.content_json).map_err(|e| {
            AppError::Internal(anyhow::anyhow!(
                "corrupt content_json in page {}: {e}",
                row.id
            ))
        })?;
        pages.push(ExportedPage {
            tags: tags.remove(&row.id).unwrap_or_default(),
            id: row.id,
            parent_id: row.parent_id,
            title: row.title,
            icon: row.icon,
            sort_order: row.sort_order,
            is_favorite: row.is_favorite,
            created_at: row.created_at,
            updated_at: row.updated_at,
            last_opened_at: row.last_opened_at,
            deleted_at: row.deleted_at,
            deleted_root_id: row.deleted_root_id,
            revision: row.revision,
            content_json,
        });
    }
    Ok(WorkspaceExport {
        format: EXPORT_FORMAT.into(),
        version: EXPORT_VERSION,
        exported_at: now(),
        pages,
    })
}

pub async fn export(
    _user: AuthUser,
    State(state): State<AppState>,
) -> AppResult<impl IntoResponse> {
    let export = build_export(&state.pool).await?;
    let filename = format!(
        "notatnik-export-{}.json",
        chrono::Utc::now().format("%Y%m%dT%H%M%SZ")
    );
    Ok((
        [
            (
                header::CONTENT_DISPOSITION,
                format!("attachment; filename=\"{filename}\""),
            ),
            (header::CACHE_CONTROL, "no-store".to_string()),
        ],
        Json(export),
    ))
}

fn validate_timestamp(value: &str, field: &str) -> AppResult<()> {
    chrono::DateTime::parse_from_rfc3339(value)
        .map(|_| ())
        .map_err(|_| AppError::bad_request(format!("Invalid {field} timestamp {value:?}")))
}

/// Validates an export and returns the pages ordered parents-first.
pub fn validate_export(export: &WorkspaceExport) -> AppResult<Vec<ExportedPage>> {
    if export.format != EXPORT_FORMAT {
        return Err(AppError::bad_request(format!(
            "Unsupported file format {:?}; expected {EXPORT_FORMAT:?}",
            export.format
        )));
    }
    if export.version != EXPORT_VERSION {
        return Err(AppError::bad_request(format!(
            "Unsupported export version {}; this server reads version {EXPORT_VERSION}",
            export.version
        )));
    }
    if export.pages.len() > MAX_IMPORT_PAGES {
        return Err(AppError::bad_request("Too many pages in import"));
    }
    let mut by_id: HashMap<&str, &ExportedPage> = HashMap::new();
    for page in &export.pages {
        repo::validate_uuid(&page.id)?;
        if by_id.insert(page.id.as_str(), page).is_some() {
            return Err(AppError::bad_request(format!(
                "Duplicate page id {}",
                page.id
            )));
        }
        repo::validate_title(&page.title)?;
        if let Some(icon) = &page.icon {
            repo::validate_icon(icon)?;
        }
        if page.revision < 1 {
            return Err(AppError::bad_request("Page revision must be at least 1"));
        }
        validate_timestamp(&page.created_at, "createdAt")?;
        validate_timestamp(&page.updated_at, "updatedAt")?;
        if let Some(ts) = &page.last_opened_at {
            validate_timestamp(ts, "lastOpenedAt")?;
        }
        if let Some(ts) = &page.deleted_at {
            validate_timestamp(ts, "deletedAt")?;
        }
        repo::normalize_tags(&page.tags)?;
        validate_document(&page.content_json)?;
    }

    // Parent references, cycles and depth.
    let mut depth: HashMap<&str, i64> = HashMap::new();
    for page in &export.pages {
        let mut chain: Vec<&str> = Vec::new();
        let mut seen: HashSet<&str> = HashSet::new();
        let mut current = page;
        let base = loop {
            if let Some(d) = depth.get(current.id.as_str()) {
                break *d;
            }
            if !seen.insert(current.id.as_str()) {
                return Err(AppError::bad_request("Page hierarchy contains a cycle"));
            }
            chain.push(current.id.as_str());
            match &current.parent_id {
                None => break -1,
                Some(parent_id) => {
                    current = by_id.get(parent_id.as_str()).ok_or_else(|| {
                        AppError::bad_request(format!(
                            "Page {} references missing parent {parent_id}",
                            current.id
                        ))
                    })?;
                }
            }
        };
        for (offset, id) in chain.iter().rev().enumerate() {
            let d = base + 1 + offset as i64;
            if d >= MAX_TREE_DEPTH {
                return Err(AppError::bad_request("Page hierarchy is nested too deeply"));
            }
            depth.insert(id, d);
        }
    }

    // Trash consistency: live pages must not live under trashed parents.
    let mut pages: Vec<ExportedPage> = export.pages.clone();
    for page in &mut pages {
        match &page.deleted_at {
            None => page.deleted_root_id = None,
            Some(_) => {
                let root_ok = page
                    .deleted_root_id
                    .as_deref()
                    .and_then(|r| by_id.get(r))
                    .is_some_and(|r| r.deleted_at.is_some());
                if !root_ok {
                    page.deleted_root_id = Some(page.id.clone());
                }
            }
        }
    }
    for page in &pages {
        if page.deleted_at.is_none()
            && let Some(parent) = page.parent_id.as_deref()
            && by_id[parent].deleted_at.is_some()
        {
            return Err(AppError::bad_request(format!(
                "Live page {} is inside a trashed page",
                page.id
            )));
        }
    }
    pages.sort_by_key(|p| depth[p.id.as_str()]);
    Ok(pages)
}

#[derive(Deserialize)]
pub struct ImportQuery {
    #[serde(default)]
    mode: Option<String>,
    #[serde(default)]
    confirm: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportSummary {
    mode: &'static str,
    imported_pages: usize,
    safety_backup: Option<String>,
}

pub async fn import(
    _user: AuthUser,
    State(state): State<AppState>,
    Query(q): Query<ImportQuery>,
    ApiJson(export): ApiJson<WorkspaceExport>,
) -> AppResult<impl IntoResponse> {
    let replace = match q.mode.as_deref().unwrap_or("merge") {
        "merge" => false,
        "replace" => {
            if q.confirm.as_deref() != Some(REPLACE_CONFIRMATION) {
                return Err(AppError::bad_request(format!(
                    "Replace mode deletes all existing pages; pass confirm={REPLACE_CONFIRMATION}"
                )));
            }
            true
        }
        other => {
            return Err(AppError::bad_request(format!(
                "Unknown import mode {other:?}"
            )));
        }
    };
    let pages = validate_export(&export)?;

    let safety_backup = if replace {
        let path = state.config.backup_dir().join(format!(
            "pre-import-{}.db",
            chrono::Utc::now().format("%Y%m%dT%H%M%S%.3fZ")
        ));
        db::backup_to(&state.pool, &path).await?;
        Some(
            path.file_name()
                .map(|f| f.to_string_lossy().into_owned())
                .unwrap_or_default(),
        )
    } else {
        None
    };

    let mut tx = state.pool.begin_with("BEGIN IMMEDIATE").await?;
    let id_map: HashMap<String, String> = if replace {
        sqlx::query("DELETE FROM pages").execute(&mut *tx).await?;
        sqlx::query("DELETE FROM tags").execute(&mut *tx).await?;
        pages.iter().map(|p| (p.id.clone(), p.id.clone())).collect()
    } else {
        // Merge mode never touches existing pages: every imported page gets a fresh id.
        pages.iter().map(|p| (p.id.clone(), new_id())).collect()
    };
    let root_offset: i64 = if replace {
        0
    } else {
        sqlx::query_scalar::<_, Option<i64>>(
            "SELECT MAX(sort_order) FROM pages WHERE parent_id IS NULL",
        )
        .fetch_one(&mut *tx)
        .await?
        .map_or(0, |m| m + 1)
    };

    for page in &pages {
        let sort_order = if page.parent_id.is_none() {
            root_offset + page.sort_order
        } else {
            page.sort_order
        };
        sqlx::query(
            "INSERT INTO pages (id, parent_id, title, icon, content_json, content_plain_text, \
             sort_order, is_favorite, created_at, updated_at, last_opened_at, deleted_at, \
             deleted_root_id, revision) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&id_map[&page.id])
        .bind(page.parent_id.as_ref().map(|p| &id_map[p]))
        .bind(&page.title)
        .bind(&page.icon)
        .bind(page.content_json.to_string())
        .bind(extract_plain_text(&page.content_json))
        .bind(sort_order)
        .bind(page.is_favorite)
        .bind(&page.created_at)
        .bind(&page.updated_at)
        .bind(&page.last_opened_at)
        .bind(&page.deleted_at)
        .bind(page.deleted_root_id.as_ref().map(|r| &id_map[r]))
        .bind(page.revision)
        .execute(&mut *tx)
        .await?;
        for tag in repo::normalize_tags(&page.tags)? {
            let tag_id = repo::upsert_tag(&mut tx, &tag).await?;
            sqlx::query("INSERT OR IGNORE INTO page_tags (page_id, tag_id) VALUES (?, ?)")
                .bind(&id_map[&page.id])
                .bind(tag_id)
                .execute(&mut *tx)
                .await?;
        }
    }
    tx.commit().await?;
    tracing::info!(pages = pages.len(), replace, "workspace imported");
    Ok(Json(ImportSummary {
        mode: if replace { "replace" } else { "merge" },
        imported_pages: pages.len(),
        safety_backup,
    }))
}

/// Creates a consistent database snapshot in the configured backup directory.
pub async fn create_backup(
    _user: AuthUser,
    State(state): State<AppState>,
) -> AppResult<impl IntoResponse> {
    let name = format!(
        "notes-{}.db",
        chrono::Utc::now().format("%Y%m%dT%H%M%S%.3fZ")
    );
    let path = state.config.backup_dir().join(&name);
    db::backup_to(&state.pool, &path).await?;
    let size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
    tracing::info!(file = %name, "database backup created");
    Ok(Json(json!({ "file": name, "sizeBytes": size })))
}
