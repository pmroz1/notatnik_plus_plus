//! Single-user authentication: Argon2id password hashes, server-side sessions stored as
//! SHA-256 token hashes, HttpOnly cookies and an in-memory login rate limiter.

use std::{
    collections::HashMap,
    net::SocketAddr,
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};

use anyhow::{Context, anyhow};
use argon2::{Argon2, PasswordHasher, PasswordVerifier};
use axum::{
    Extension, Json,
    extract::{ConnectInfo, FromRequestParts, State},
    http::{StatusCode, request::Parts},
    response::IntoResponse,
};
use axum_extra::extract::cookie::{Cookie, CookieJar, SameSite};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::SqlitePool;

use crate::{
    AppState,
    db::{new_id, now},
    error::{ApiJson, AppError, AppResult},
};

pub const SESSION_COOKIE: &str = "notes_session";
const MIN_PASSWORD_LEN: usize = 12;
const MAX_PASSWORD_LEN: usize = 1024;

// ---------- password hashing ----------

pub fn hash_password(password: &str) -> anyhow::Result<String> {
    Argon2::default()
        .hash_password(password.as_bytes())
        .map(|h| h.to_string())
        .map_err(|e| anyhow!("password hashing failed: {e}"))
}

pub fn verify_password(password: &str, hash: &str) -> bool {
    Argon2::default()
        .verify_password(password.as_bytes(), hash)
        .is_ok()
}

/// Hash used when the username does not exist so that response timing does not reveal it.
fn dummy_hash() -> &'static str {
    static DUMMY: OnceLock<String> = OnceLock::new();
    DUMMY.get_or_init(|| {
        let mut bytes = [0u8; 24];
        getrandom::fill(&mut bytes).expect("OS random number generator unavailable");
        hash_password(&hex::encode(bytes)).expect("hashing dummy password")
    })
}

pub fn validate_new_credentials(username: &str, password: &str) -> anyhow::Result<()> {
    let username_ok = !username.is_empty()
        && username.len() <= 64
        && username
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | '@'));
    if !username_ok {
        anyhow::bail!("username must be 1-64 characters: letters, digits, '.', '_', '-', '@'");
    }
    if password.chars().count() < MIN_PASSWORD_LEN {
        anyhow::bail!("password must be at least {MIN_PASSWORD_LEN} characters long");
    }
    if password.len() > MAX_PASSWORD_LEN {
        anyhow::bail!("password is too long");
    }
    Ok(())
}

/// Creates the account, or resets the password if `allow_reset` and the user exists.
/// Resetting a password revokes all existing sessions.
pub async fn provision_user(
    pool: &SqlitePool,
    username: &str,
    password: &str,
    allow_reset: bool,
) -> anyhow::Result<()> {
    validate_new_credentials(username, password)?;
    let password = password.to_string();
    let hash = tokio::task::spawn_blocking(move || hash_password(&password)).await??;
    let existing: Option<String> = sqlx::query_scalar("SELECT id FROM users WHERE username = ?")
        .bind(username)
        .fetch_optional(pool)
        .await?;
    match existing {
        Some(id) if allow_reset => {
            let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;
            sqlx::query("UPDATE users SET password_hash = ? WHERE id = ?")
                .bind(&hash)
                .bind(&id)
                .execute(&mut *tx)
                .await?;
            sqlx::query("DELETE FROM sessions WHERE user_id = ?")
                .bind(&id)
                .execute(&mut *tx)
                .await?;
            tx.commit().await?;
        }
        Some(_) => {
            anyhow::bail!("user {username:?} already exists (use --reset to change the password)")
        }
        None => {
            let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM users")
                .fetch_one(pool)
                .await?;
            if count > 0 {
                anyhow::bail!("an account already exists; this is a single-user application");
            }
            sqlx::query(
                "INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)",
            )
            .bind(new_id())
            .bind(username)
            .bind(&hash)
            .bind(now())
            .execute(pool)
            .await
            .context("creating user")?;
        }
    }
    Ok(())
}

// ---------- sessions ----------

fn hash_token(token: &str) -> String {
    hex::encode(Sha256::digest(token.as_bytes()))
}

fn new_token() -> String {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).expect("OS random number generator unavailable");
    hex::encode(bytes)
}

/// The authenticated user, extracted from the session cookie.
#[derive(Clone, Debug)]
pub struct AuthUser {
    pub id: String,
    pub username: String,
    pub token_hash: String,
}

impl FromRequestParts<AppState> for AuthUser {
    type Rejection = AppError;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, AppError> {
        let jar = CookieJar::from_headers(&parts.headers);
        let token = jar
            .get(SESSION_COOKIE)
            .map(|c| c.value().to_string())
            .ok_or(AppError::Unauthorized)?;
        if token.len() != 64 || !token.chars().all(|c| c.is_ascii_hexdigit()) {
            return Err(AppError::Unauthorized);
        }
        let token_hash = hash_token(&token);
        let row: Option<(String, String)> = sqlx::query_as(
            "SELECT u.id, u.username FROM sessions s JOIN users u ON u.id = s.user_id \
             WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > ?",
        )
        .bind(&token_hash)
        .bind(now())
        .fetch_optional(&state.pool)
        .await?;
        let (id, username) = row.ok_or(AppError::Unauthorized)?;
        Ok(AuthUser {
            id,
            username,
            token_hash,
        })
    }
}

impl axum::extract::OptionalFromRequestParts<AppState> for AuthUser {
    type Rejection = AppError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Option<Self>, AppError> {
        match <AuthUser as FromRequestParts<AppState>>::from_request_parts(parts, state).await {
            Ok(user) => Ok(Some(user)),
            Err(AppError::Unauthorized) => Ok(None),
            Err(other) => Err(other),
        }
    }
}

fn session_cookie(state: &AppState, value: String, max_age: Duration) -> Cookie<'static> {
    Cookie::build((SESSION_COOKIE, value))
        .http_only(true)
        .secure(state.config.cookie_secure)
        .same_site(SameSite::Strict)
        .path("/")
        .max_age(cookie::time::Duration::seconds(max_age.as_secs() as i64))
        .build()
}

// ---------- login rate limiting ----------

/// Fixed-window limiter for failed logins, keyed by client address.
pub struct LoginLimiter {
    max_failures: u32,
    window: Duration,
    entries: Mutex<HashMap<String, (Instant, u32)>>,
}

impl LoginLimiter {
    pub fn new(max_failures: u32, window: Duration) -> Self {
        Self {
            max_failures,
            window,
            entries: Mutex::new(HashMap::new()),
        }
    }

    /// Returns `Some(retry_after)` if the key is currently blocked.
    fn check(&self, key: &str) -> Option<Duration> {
        let mut entries = self.entries.lock().unwrap_or_else(|e| e.into_inner());
        let now = Instant::now();
        entries.retain(|_, (start, _)| now.duration_since(*start) < self.window);
        match entries.get(key) {
            Some((start, count)) if *count >= self.max_failures => {
                Some(self.window.saturating_sub(now.duration_since(*start)))
            }
            _ => None,
        }
    }

    fn record_failure(&self, key: &str) {
        let mut entries = self.entries.lock().unwrap_or_else(|e| e.into_inner());
        let entry = entries
            .entry(key.to_string())
            .or_insert((Instant::now(), 0));
        entry.1 += 1;
    }

    fn reset(&self, key: &str) {
        let mut entries = self.entries.lock().unwrap_or_else(|e| e.into_inner());
        entries.remove(key);
    }
}

// ---------- handlers ----------

#[derive(Deserialize)]
pub struct LoginRequest {
    username: String,
    password: String,
}

#[derive(Serialize)]
pub struct MeResponse {
    username: String,
}

pub async fn login(
    State(state): State<AppState>,
    connect_info: Option<Extension<ConnectInfo<SocketAddr>>>,
    jar: CookieJar,
    ApiJson(req): ApiJson<LoginRequest>,
) -> AppResult<impl IntoResponse> {
    let key = connect_info
        .map(|Extension(ConnectInfo(addr))| addr.ip().to_string())
        .unwrap_or_else(|| "unknown".into());
    if let Some(retry) = state.login_limiter.check(&key) {
        return Err(AppError::TooManyRequests {
            retry_after_secs: retry.as_secs().max(1),
        });
    }
    if req.username.len() > 64 || req.password.len() > MAX_PASSWORD_LEN {
        return Err(AppError::bad_request("Invalid username or password"));
    }

    let row: Option<(String, String, String)> =
        sqlx::query_as("SELECT id, username, password_hash FROM users WHERE username = ?")
            .bind(req.username.trim())
            .fetch_optional(&state.pool)
            .await?;
    let stored_hash = row
        .as_ref()
        .map(|(_, _, h)| h.clone())
        .unwrap_or_else(|| dummy_hash().to_string());
    let password = req.password;
    let valid = tokio::task::spawn_blocking(move || verify_password(&password, &stored_hash))
        .await
        .map_err(|e| AppError::Internal(e.into()))?;

    let Some((user_id, username, _)) = row.filter(|_| valid) else {
        state.login_limiter.record_failure(&key);
        tracing::warn!("failed login attempt");
        return Err(AppError::Forbidden("Invalid username or password".into()));
    };
    state.login_limiter.reset(&key);

    let token = new_token();
    let created = chrono::Utc::now();
    let expires =
        created + chrono::Duration::from_std(state.config.session_ttl).unwrap_or_default();
    // Opportunistically clean up expired sessions.
    sqlx::query("DELETE FROM sessions WHERE expires_at < ? OR revoked_at IS NOT NULL")
        .bind(now())
        .execute(&state.pool)
        .await?;
    sqlx::query(
        "INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
    )
    .bind(hash_token(&token))
    .bind(&user_id)
    .bind(created.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
    .bind(expires.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
    .execute(&state.pool)
    .await?;
    tracing::info!("user logged in");

    let jar = jar.add(session_cookie(&state, token, state.config.session_ttl));
    Ok((jar, Json(MeResponse { username })))
}

pub async fn logout(
    State(state): State<AppState>,
    jar: CookieJar,
    user: Option<AuthUser>,
) -> AppResult<impl IntoResponse> {
    if let Some(user) = user {
        sqlx::query("UPDATE sessions SET revoked_at = ? WHERE token_hash = ?")
            .bind(now())
            .bind(&user.token_hash)
            .execute(&state.pool)
            .await?;
    }
    let jar = jar.add(session_cookie(&state, String::new(), Duration::ZERO));
    Ok((jar, StatusCode::NO_CONTENT))
}

pub async fn me(user: AuthUser) -> Json<MeResponse> {
    Json(MeResponse {
        username: user.username,
    })
}
