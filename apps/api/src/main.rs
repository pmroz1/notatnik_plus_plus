use std::{io::Read, net::SocketAddr, path::PathBuf};

use anyhow::{Context, bail};
use clap::{Parser, Subcommand};
use notes_api::{AppState, app, auth, config::Config, db};
use tracing_subscriber::EnvFilter;

#[derive(Parser)]
#[command(
    name = "notes-api",
    version,
    about = "Private single-user notes server"
)]
struct Cli {
    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Subcommand)]
enum Command {
    /// Run the HTTP server (default).
    Serve,
    /// Create the single user account (or reset its password with --reset).
    CreateUser {
        #[arg(long)]
        username: String,
        /// Read the password from standard input instead of an interactive prompt.
        #[arg(long)]
        password_stdin: bool,
        /// Reset the password of an existing user and revoke all of their sessions.
        #[arg(long)]
        reset: bool,
    },
    /// Write a consistent snapshot of the database (SQLite VACUUM INTO). Safe while running.
    Backup {
        /// Target file; defaults to <data dir>/backups/notes-<timestamp>.db
        #[arg(long)]
        out: Option<PathBuf>,
    },
    /// Check that a backup file is a healthy notes database.
    VerifyBackup { file: PathBuf },
    /// Replace the database with a verified backup. The server MUST be stopped first.
    Restore {
        file: PathBuf,
        /// Confirm that the server is stopped and the current database may be replaced.
        #[arg(long)]
        yes: bool,
    },
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| EnvFilter::new("info,tower_http=info,sqlx=warn")),
        )
        .init();
    let cli = Cli::parse();
    let config = Config::from_env()?;
    match cli.command.unwrap_or(Command::Serve) {
        Command::Serve => serve(config).await,
        Command::CreateUser {
            username,
            password_stdin,
            reset,
        } => {
            let password = read_password(password_stdin)?;
            let pool = db::connect(&config.database_path()).await?;
            auth::provision_user(&pool, username.trim(), &password, reset).await?;
            println!(
                "User {:?} {}.",
                username.trim(),
                if reset { "updated" } else { "created" }
            );
            Ok(())
        }
        Command::Backup { out } => {
            let pool = db::connect(&config.database_path()).await?;
            let target = out.unwrap_or_else(|| {
                config.backup_dir().join(format!(
                    "notes-{}.db",
                    chrono::Utc::now().format("%Y%m%dT%H%M%S%.3fZ")
                ))
            });
            db::backup_to(&pool, &target).await?;
            pool.close().await;
            db::verify_database_file(&target).await?;
            println!("Backup written to {}", target.display());
            Ok(())
        }
        Command::VerifyBackup { file } => {
            db::verify_database_file(&file).await?;
            println!("{} is a healthy notes database.", file.display());
            Ok(())
        }
        Command::Restore { file, yes } => restore(&config, &file, yes).await,
    }
}

fn read_password(from_stdin: bool) -> anyhow::Result<String> {
    if from_stdin {
        let mut buf = String::new();
        std::io::stdin().read_to_string(&mut buf)?;
        return Ok(buf.trim_end_matches(['\r', '\n']).to_string());
    }
    let first = rpassword::prompt_password("Password: ")?;
    let second = rpassword::prompt_password("Repeat password: ")?;
    if first != second {
        bail!("passwords do not match");
    }
    Ok(first)
}

async fn restore(config: &Config, file: &std::path::Path, yes: bool) -> anyhow::Result<()> {
    if !yes {
        bail!("restore replaces the current database; stop the server and re-run with --yes");
    }
    db::verify_database_file(file).await?;
    let target = config.database_path();
    if target.exists() {
        let aside = config.data_dir.join(format!(
            "notes.db.pre-restore-{}",
            chrono::Utc::now().format("%Y%m%dT%H%M%SZ")
        ));
        // Checkpoint WAL into the main file so the set-aside copy is self-contained.
        let pool = db::connect(&target).await?;
        sqlx::query("PRAGMA wal_checkpoint(TRUNCATE)")
            .execute(&pool)
            .await?;
        pool.close().await;
        std::fs::rename(&target, &aside)
            .with_context(|| format!("moving current database to {}", aside.display()))?;
        println!("Previous database kept at {}", aside.display());
    }
    for suffix in ["-wal", "-shm"] {
        let side = PathBuf::from(format!("{}{suffix}", target.display()));
        if side.exists() {
            std::fs::remove_file(&side)?;
        }
    }
    std::fs::copy(file, &target).context("copying backup into place")?;
    // Opening runs any newer migrations against the restored snapshot.
    let pool = db::connect(&target).await?;
    pool.close().await;
    println!("Restored {} -> {}", file.display(), target.display());
    Ok(())
}

async fn serve(config: Config) -> anyhow::Result<()> {
    let pool = db::connect(&config.database_path()).await?;
    let users: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM users")
        .fetch_one(&pool)
        .await?;
    if users == 0 {
        tracing::warn!(
            "no user account exists yet; create one with `notes-api create-user --username <name>`"
        );
    }
    let bind = config.bind;
    if !bind.ip().is_loopback() {
        tracing::warn!(%bind, "listening on a non-loopback address; put an HTTPS reverse proxy in front");
    }
    tracing::info!(data_dir = %config.data_dir.display(), %bind, "starting server");
    let state = AppState::new(pool.clone(), config);
    let listener = tokio::net::TcpListener::bind(bind)
        .await
        .with_context(|| format!("binding {bind}"))?;
    axum::serve(
        listener,
        app(state).into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(shutdown_signal())
    .await?;
    pool.close().await;
    tracing::info!("server stopped");
    Ok(())
}

async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let terminate = async {
        if let Ok(mut sig) =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        {
            sig.recv().await;
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();
    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }
}
