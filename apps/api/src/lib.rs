//! Private single-user notes API (Axum + SQLite).

pub mod auth;
pub mod backup;
pub mod config;
pub mod csrf;
pub mod db;
pub mod error;
pub mod pages;
pub mod search;

use std::{sync::Arc, time::Duration};

use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, State},
    http::{HeaderName, HeaderValue, header},
    middleware,
    routing::{delete, get, patch, post, put},
};
use serde_json::json;
use sqlx::SqlitePool;
use tower_http::{
    services::{ServeDir, ServeFile},
    set_header::SetResponseHeaderLayer,
    trace::TraceLayer,
};

use crate::{auth::LoginLimiter, config::Config, error::AppError};

/// Default request body limit (editor documents are capped at 2 MiB of JSON).
pub const DEFAULT_BODY_LIMIT: usize = 4 * 1024 * 1024;
/// Body limit for full-workspace imports.
pub const IMPORT_BODY_LIMIT: usize = 64 * 1024 * 1024;

#[derive(Clone)]
pub struct AppState {
    pub pool: SqlitePool,
    pub config: Arc<Config>,
    pub login_limiter: Arc<LoginLimiter>,
}

impl AppState {
    pub fn new(pool: SqlitePool, config: Config) -> Self {
        Self {
            pool,
            config: Arc::new(config),
            login_limiter: Arc::new(LoginLimiter::new(5, Duration::from_secs(60))),
        }
    }
}

async fn health(State(state): State<AppState>) -> Result<Json<serde_json::Value>, AppError> {
    sqlx::query("SELECT 1").execute(&state.pool).await?;
    Ok(Json(json!({ "status": "ok" })))
}

async fn api_not_found() -> AppError {
    AppError::NotFound
}

pub fn api_router(state: AppState) -> Router {
    let import_routes = Router::new()
        .route("/import", post(backup::import))
        .layer(DefaultBodyLimit::max(IMPORT_BODY_LIMIT));

    Router::new()
        .route("/health", get(health))
        .route("/auth/login", post(auth::login))
        .route("/auth/logout", post(auth::logout))
        .route("/auth/me", get(auth::me))
        .route("/pages", get(pages::list).post(pages::create))
        .route("/pages/{id}", get(pages::get).delete(pages::soft_delete))
        .route("/pages/{id}/metadata", patch(pages::update_metadata))
        .route("/pages/{id}/content", put(pages::save_content))
        .route("/pages/{id}/duplicate", post(pages::duplicate))
        .route("/pages/{id}/move", post(pages::move_page))
        .route("/pages/{id}/restore", post(pages::restore))
        .route("/pages/{id}/permanent", delete(pages::delete_permanently))
        .route("/pages/{id}/tags", put(pages::set_tags))
        .route("/tags", get(pages::list_tags))
        .route("/search", get(search::search))
        .route("/export", get(backup::export))
        .route("/backup", post(backup::create_backup))
        .layer(DefaultBodyLimit::max(DEFAULT_BODY_LIMIT))
        .merge(import_routes)
        .fallback(api_not_found)
        .layer(middleware::from_fn_with_state(
            state.clone(),
            csrf::csrf_guard,
        ))
        .layer(SetResponseHeaderLayer::overriding(
            header::CACHE_CONTROL,
            HeaderValue::from_static("no-store"),
        ))
        .with_state(state)
}

pub fn app(state: AppState) -> Router {
    let static_dir = state.config.static_dir.clone();
    let mut router = Router::new().nest("/api", api_router(state));
    if let Some(dir) = static_dir {
        let index = dir.join("index.html");
        router = router.fallback_service(ServeDir::new(dir).fallback(ServeFile::new(index)));
    }
    router
        .layer(SetResponseHeaderLayer::if_not_present(
            header::CONTENT_SECURITY_POLICY,
            HeaderValue::from_static(
                "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; \
                 img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; \
                 base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
            ),
        ))
        .layer(SetResponseHeaderLayer::if_not_present(
            header::X_CONTENT_TYPE_OPTIONS,
            HeaderValue::from_static("nosniff"),
        ))
        .layer(SetResponseHeaderLayer::if_not_present(
            header::X_FRAME_OPTIONS,
            HeaderValue::from_static("DENY"),
        ))
        .layer(SetResponseHeaderLayer::if_not_present(
            header::REFERRER_POLICY,
            HeaderValue::from_static("same-origin"),
        ))
        .layer(SetResponseHeaderLayer::if_not_present(
            HeaderName::from_static("cross-origin-opener-policy"),
            HeaderValue::from_static("same-origin"),
        ))
        .layer(TraceLayer::new_for_http())
}
