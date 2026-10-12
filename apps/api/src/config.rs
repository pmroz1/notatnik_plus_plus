//! Application configuration loaded from environment variables.

use std::{net::SocketAddr, path::PathBuf, time::Duration};

use anyhow::{Context, bail};

#[derive(Clone, Debug)]
pub struct Config {
    /// Directory that holds the SQLite database and the `backups/` folder.
    pub data_dir: PathBuf,
    /// Socket address the HTTP server binds to. Defaults to localhost only.
    pub bind: SocketAddr,
    /// Optional directory with the built Angular app, served from the same origin as the API.
    pub static_dir: Option<PathBuf>,
    /// Whether the session cookie gets the `Secure` attribute (enable behind HTTPS).
    pub cookie_secure: bool,
    /// Lifetime of a login session.
    pub session_ttl: Duration,
    /// Extra origins (scheme://host[:port]) allowed to send state-changing requests in
    /// addition to the request's own `Host`. Needed only for unusual proxy setups.
    pub allowed_origins: Vec<String>,
}

impl Config {
    pub fn database_path(&self) -> PathBuf {
        self.data_dir.join("notes.db")
    }

    pub fn backup_dir(&self) -> PathBuf {
        self.data_dir.join("backups")
    }

    pub fn from_env() -> anyhow::Result<Self> {
        let data_dir = PathBuf::from(env_or("NOTES_DATA_DIR", "./data"));
        let bind = env_or("NOTES_BIND", "127.0.0.1:8080")
            .parse()
            .context("NOTES_BIND must be a socket address such as 127.0.0.1:8080")?;
        let static_dir = std::env::var("NOTES_STATIC_DIR")
            .ok()
            .filter(|s| !s.trim().is_empty())
            .map(PathBuf::from);
        let cookie_secure = parse_bool(&env_or("NOTES_COOKIE_SECURE", "false"))
            .context("NOTES_COOKIE_SECURE must be true or false")?;
        let ttl_hours: u64 = env_or("NOTES_SESSION_TTL_HOURS", "336")
            .parse()
            .context("NOTES_SESSION_TTL_HOURS must be a positive integer")?;
        if ttl_hours == 0 {
            bail!("NOTES_SESSION_TTL_HOURS must be greater than zero");
        }
        let allowed_origins = env_or("NOTES_ALLOWED_ORIGINS", "")
            .split(',')
            .map(|s| s.trim().trim_end_matches('/').to_ascii_lowercase())
            .filter(|s| !s.is_empty())
            .collect();
        Ok(Self {
            data_dir,
            bind,
            static_dir,
            cookie_secure,
            session_ttl: Duration::from_secs(ttl_hours * 3600),
            allowed_origins,
        })
    }

    /// Configuration for tests: everything inside `data_dir`, no static files.
    pub fn for_data_dir(data_dir: PathBuf) -> Self {
        Self {
            data_dir,
            bind: ([127, 0, 0, 1], 0).into(),
            static_dir: None,
            cookie_secure: false,
            session_ttl: Duration::from_secs(3600),
            allowed_origins: Vec::new(),
        }
    }
}

fn env_or(key: &str, default: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| default.to_string())
}

fn parse_bool(value: &str) -> anyhow::Result<bool> {
    match value.trim().to_ascii_lowercase().as_str() {
        "1" | "true" | "yes" | "on" => Ok(true),
        "0" | "false" | "no" | "off" | "" => Ok(false),
        other => bail!("invalid boolean {other:?}"),
    }
}
