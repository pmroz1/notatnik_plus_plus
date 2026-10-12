//! Consistent JSON error responses: `{"error": {"code": "...", "message": "..."}}`.

use axum::{
    Json,
    http::{HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
};
use serde_json::{Value, json};

#[derive(Debug)]
pub enum AppError {
    BadRequest(String),
    Unauthorized,
    Forbidden(String),
    NotFound,
    Conflict {
        code: &'static str,
        message: String,
        details: Option<Value>,
    },
    PayloadTooLarge(String),
    TooManyRequests {
        retry_after_secs: u64,
    },
    Internal(anyhow::Error),
}

pub type AppResult<T> = Result<T, AppError>;

impl AppError {
    pub fn bad_request(message: impl Into<String>) -> Self {
        Self::BadRequest(message.into())
    }

    pub fn conflict(code: &'static str, message: impl Into<String>) -> Self {
        Self::Conflict {
            code,
            message: message.into(),
            details: None,
        }
    }
}

impl From<sqlx::Error> for AppError {
    fn from(err: sqlx::Error) -> Self {
        Self::Internal(err.into())
    }
}

impl From<anyhow::Error> for AppError {
    fn from(err: anyhow::Error) -> Self {
        Self::Internal(err)
    }
}

fn body(code: &str, message: &str) -> Value {
    json!({ "error": { "code": code, "message": message } })
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        match self {
            AppError::BadRequest(msg) => {
                (StatusCode::BAD_REQUEST, Json(body("bad_request", &msg))).into_response()
            }
            AppError::Unauthorized => (
                StatusCode::UNAUTHORIZED,
                Json(body("unauthorized", "Authentication required")),
            )
                .into_response(),
            AppError::Forbidden(msg) => {
                (StatusCode::FORBIDDEN, Json(body("forbidden", &msg))).into_response()
            }
            AppError::NotFound => (
                StatusCode::NOT_FOUND,
                Json(body("not_found", "Resource not found")),
            )
                .into_response(),
            AppError::Conflict {
                code,
                message,
                details,
            } => {
                let mut value = body(code, &message);
                if let (Some(details), Some(obj)) = (details, value.as_object_mut()) {
                    obj.insert("details".into(), details);
                }
                (StatusCode::CONFLICT, Json(value)).into_response()
            }
            AppError::PayloadTooLarge(msg) => (
                StatusCode::PAYLOAD_TOO_LARGE,
                Json(body("payload_too_large", &msg)),
            )
                .into_response(),
            AppError::TooManyRequests { retry_after_secs } => {
                let mut res = (
                    StatusCode::TOO_MANY_REQUESTS,
                    Json(body(
                        "too_many_requests",
                        "Too many attempts. Please wait and try again.",
                    )),
                )
                    .into_response();
                if let Ok(v) = HeaderValue::from_str(&retry_after_secs.to_string()) {
                    res.headers_mut().insert(header::RETRY_AFTER, v);
                }
                res
            }
            AppError::Internal(err) => {
                tracing::error!(error = %err, "internal error");
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(body("internal", "Internal server error")),
                )
                    .into_response()
            }
        }
    }
}

impl From<axum::extract::rejection::JsonRejection> for AppError {
    fn from(rejection: axum::extract::rejection::JsonRejection) -> Self {
        use axum::extract::rejection::JsonRejection;
        match rejection {
            JsonRejection::BytesRejection(_) => {
                AppError::PayloadTooLarge("Request body is too large or unreadable".into())
            }
            other => AppError::BadRequest(other.body_text()),
        }
    }
}

/// `Json` extractor whose rejections use the application's JSON error format.
#[derive(axum::extract::FromRequest)]
#[from_request(via(axum::Json), rejection(AppError))]
pub struct ApiJson<T>(pub T);
