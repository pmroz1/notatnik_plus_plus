//! CSRF protection for cookie-authenticated, state-changing requests.
//!
//! Two independent checks are applied to every non-safe `/api` request:
//! 1. A custom `X-Requested-With: notatnik` header must be present. Browsers cannot add custom
//!    headers to cross-origin requests without a CORS preflight, which this server never grants.
//! 2. The `Origin` (or, if absent, `Referer`) must match the request's `Host` or an explicitly
//!    configured allowed origin.

use axum::{
    extract::{Request, State},
    http::{Method, header},
    middleware::Next,
    response::{IntoResponse, Response},
};

use crate::{AppState, error::AppError};

pub const CSRF_HEADER: &str = "x-requested-with";
pub const CSRF_HEADER_VALUE: &str = "notatnik";

pub async fn csrf_guard(State(state): State<AppState>, req: Request, next: Next) -> Response {
    if matches!(*req.method(), Method::GET | Method::HEAD | Method::OPTIONS) {
        return next.run(req).await;
    }
    let headers = req.headers();
    let custom_ok = headers
        .get(CSRF_HEADER)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.eq_ignore_ascii_case(CSRF_HEADER_VALUE));
    if !custom_ok {
        return AppError::Forbidden("Missing CSRF header".into()).into_response();
    }

    let host = headers
        .get(header::HOST)
        .and_then(|v| v.to_str().ok())
        .map(|h| h.to_ascii_lowercase());
    let origin = headers
        .get(header::ORIGIN)
        .and_then(|v| v.to_str().ok())
        .filter(|o| *o != "null")
        .map(|o| o.trim_end_matches('/').to_ascii_lowercase())
        .or_else(|| {
            headers
                .get(header::REFERER)
                .and_then(|v| v.to_str().ok())
                .and_then(origin_of_url)
        });

    let allowed = match origin {
        // Non-browser clients (curl, tests) send neither header; the custom header check above
        // still applies and cookies are never attached cross-site by such clients.
        None => true,
        Some(origin) => {
            state.config.allowed_origins.contains(&origin)
                || host
                    .as_deref()
                    .is_some_and(|host| origin_host(&origin) == Some(host))
        }
    };
    if !allowed {
        tracing::warn!("rejected cross-origin state-changing request");
        return AppError::Forbidden("Cross-origin request rejected".into()).into_response();
    }
    next.run(req).await
}

/// Extracts `scheme://host[:port]` from a URL string.
fn origin_of_url(url: &str) -> Option<String> {
    let (scheme, rest) = url.split_once("://")?;
    let authority = rest.split(['/', '?', '#']).next()?;
    Some(format!("{scheme}://{authority}").to_ascii_lowercase())
}

/// Returns the `host[:port]` part of an origin.
fn origin_host(origin: &str) -> Option<&str> {
    origin.split_once("://").map(|(_, host)| host)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_origins() {
        assert_eq!(
            origin_of_url("http://localhost:4200/pages/x?y=1").as_deref(),
            Some("http://localhost:4200")
        );
        assert_eq!(origin_host("https://notes.example"), Some("notes.example"));
        assert_eq!(origin_of_url("garbage"), None);
    }
}
