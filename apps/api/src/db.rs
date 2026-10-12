//! SQLite connection pool, migrations and online backups.

use std::{path::Path, str::FromStr, time::Duration};

use anyhow::Context;
use sqlx::{
    SqlitePool,
    sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteSynchronous},
};

pub static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("./migrations");

pub async fn connect(path: &Path) -> anyhow::Result<SqlitePool> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("creating data directory {}", parent.display()))?;
    }
    let options = SqliteConnectOptions::from_str("sqlite://")?
        .filename(path)
        .create_if_missing(true)
        .foreign_keys(true)
        .journal_mode(SqliteJournalMode::Wal)
        .synchronous(SqliteSynchronous::Normal)
        .busy_timeout(Duration::from_secs(10));
    let pool = SqlitePoolOptions::new()
        .max_connections(8)
        .connect_with(options)
        .await
        .with_context(|| format!("opening database {}", path.display()))?;
    MIGRATOR.run(&pool).await.context("running migrations")?;
    Ok(pool)
}

/// Writes a consistent, compacted copy of the live database to `target` using `VACUUM INTO`.
/// Safe while the server is running (unlike copying the WAL-mode database file).
pub async fn backup_to(pool: &SqlitePool, target: &Path) -> anyhow::Result<()> {
    if target.exists() {
        anyhow::bail!("backup target {} already exists", target.display());
    }
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let target_str = target
        .to_str()
        .context("backup path must be valid UTF-8")?
        .to_string();
    sqlx::query("VACUUM INTO ?")
        .bind(target_str)
        .execute(pool)
        .await
        .context("VACUUM INTO failed")?;
    Ok(())
}

/// Runs `PRAGMA integrity_check` on a database file opened read-only.
pub async fn verify_database_file(path: &Path) -> anyhow::Result<()> {
    let options = SqliteConnectOptions::from_str("sqlite://")?
        .filename(path)
        .read_only(true);
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options)
        .await
        .with_context(|| format!("opening {}", path.display()))?;
    let result: String = sqlx::query_scalar("PRAGMA integrity_check")
        .fetch_one(&pool)
        .await?;
    let pages: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM pages")
        .fetch_one(&pool)
        .await
        .context("file does not look like a notes database")?;
    pool.close().await;
    if result != "ok" {
        anyhow::bail!("integrity check failed: {result}");
    }
    tracing::info!(pages, "backup verified");
    Ok(())
}

pub fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

pub fn new_id() -> String {
    uuid::Uuid::new_v4().to_string()
}
