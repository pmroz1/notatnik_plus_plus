//! Page HTTP handlers. Business rules live in `repo.rs`; document rules in `content.rs`.

pub mod content;
pub mod model;
pub mod repo;

use axum::{
    Json,
    extract::{Path, Query, State},
    http::StatusCode,
    response::IntoResponse,
};
use serde::Deserialize;
use serde_json::json;

use crate::{
    AppState,
    auth::AuthUser,
    error::{ApiJson, AppError, AppResult},
};
use model::{
    CreatePageRequest, MovePageRequest, SaveContentRequest, SaveContentResponse, SetTagsRequest,
    UpdateMetadataRequest,
};
use repo::SaveOutcome;

/// Rejects malformed ids early with 404 so they never reach SQL.
fn page_id(id: &str) -> AppResult<&str> {
    uuid::Uuid::parse_str(id)
        .map(|_| id)
        .map_err(|_| AppError::NotFound)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListQuery {
    #[serde(default)]
    include_deleted: bool,
}

pub async fn list(
    _user: AuthUser,
    State(state): State<AppState>,
    Query(q): Query<ListQuery>,
) -> AppResult<impl IntoResponse> {
    let pages = repo::list_pages(&state.pool, q.include_deleted).await?;
    Ok(Json(json!({ "pages": pages })))
}

pub async fn create(
    _user: AuthUser,
    State(state): State<AppState>,
    ApiJson(req): ApiJson<CreatePageRequest>,
) -> AppResult<impl IntoResponse> {
    let id = repo::create_page(
        &state.pool,
        req.parent_id.as_deref(),
        req.title.as_deref().unwrap_or(""),
        req.icon.as_deref(),
    )
    .await?;
    let page = repo::get_page(&state.pool, &id, false).await?;
    Ok((StatusCode::CREATED, Json(page)))
}

pub async fn get(
    _user: AuthUser,
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> AppResult<impl IntoResponse> {
    let page = repo::get_page(&state.pool, page_id(&id)?, true).await?;
    Ok(Json(page))
}

pub async fn update_metadata(
    _user: AuthUser,
    State(state): State<AppState>,
    Path(id): Path<String>,
    ApiJson(req): ApiJson<UpdateMetadataRequest>,
) -> AppResult<impl IntoResponse> {
    let id = page_id(&id)?;
    repo::update_metadata(
        &state.pool,
        id,
        req.title.as_deref(),
        req.icon.as_ref().map(|i| i.as_deref()),
        req.is_favorite,
    )
    .await?;
    let page = repo::get_page(&state.pool, id, false).await?;
    Ok(Json(page.summary))
}

pub async fn save_content(
    _user: AuthUser,
    State(state): State<AppState>,
    Path(id): Path<String>,
    ApiJson(req): ApiJson<SaveContentRequest>,
) -> AppResult<impl IntoResponse> {
    let id = page_id(&id)?;
    content::validate_document(&req.content_json)?;
    match repo::save_content(&state.pool, id, &req.content_json, req.expected_revision).await? {
        SaveOutcome::Saved {
            revision,
            updated_at,
        } => Ok(Json(SaveContentResponse {
            revision,
            updated_at,
        })),
        SaveOutcome::Conflict {
            revision,
            updated_at,
        } => Err(AppError::Conflict {
            code: "revision_conflict",
            message: "The page was changed elsewhere since it was loaded".into(),
            details: Some(json!({
                "currentRevision": revision,
                "expectedRevision": req.expected_revision,
                "updatedAt": updated_at,
            })),
        }),
    }
}

pub async fn duplicate(
    _user: AuthUser,
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> AppResult<impl IntoResponse> {
    let new_id = repo::duplicate_page(&state.pool, page_id(&id)?).await?;
    let page = repo::get_page(&state.pool, &new_id, false).await?;
    Ok((StatusCode::CREATED, Json(page.summary)))
}

pub async fn move_page(
    _user: AuthUser,
    State(state): State<AppState>,
    Path(id): Path<String>,
    ApiJson(req): ApiJson<MovePageRequest>,
) -> AppResult<impl IntoResponse> {
    repo::move_page(
        &state.pool,
        page_id(&id)?,
        req.parent_id.as_deref(),
        req.index,
    )
    .await?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn soft_delete(
    _user: AuthUser,
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> AppResult<impl IntoResponse> {
    repo::soft_delete(&state.pool, page_id(&id)?).await?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn restore(
    _user: AuthUser,
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> AppResult<impl IntoResponse> {
    let page = repo::restore(&state.pool, page_id(&id)?).await?;
    Ok(Json(page))
}

pub async fn delete_permanently(
    _user: AuthUser,
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> AppResult<impl IntoResponse> {
    let deleted = repo::delete_permanently(&state.pool, page_id(&id)?).await?;
    Ok(Json(json!({ "deletedPages": deleted })))
}

pub async fn set_tags(
    _user: AuthUser,
    State(state): State<AppState>,
    Path(id): Path<String>,
    ApiJson(req): ApiJson<SetTagsRequest>,
) -> AppResult<impl IntoResponse> {
    let tags = repo::set_tags(&state.pool, page_id(&id)?, &req.tags).await?;
    Ok(Json(json!({ "tags": tags })))
}

pub async fn list_tags(
    _user: AuthUser,
    State(state): State<AppState>,
) -> AppResult<impl IntoResponse> {
    Ok(Json(json!({ "tags": repo::list_tags(&state.pool).await? })))
}
