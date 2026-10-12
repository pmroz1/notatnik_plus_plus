//! Full-text search over page titles and extracted plain text using SQLite FTS5.

use axum::{
    Json,
    extract::{Query, State},
    response::IntoResponse,
};
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::{AppState, auth::AuthUser, error::AppResult};

/// Markers wrapped around matched terms in snippets; the client splits on them and renders
/// plain text nodes (never HTML).
pub const MATCH_START: &str = "\u{2}";
pub const MATCH_END: &str = "\u{3}";

#[derive(Deserialize)]
pub struct SearchQuery {
    #[serde(default)]
    q: String,
}

#[derive(Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    id: String,
    parent_id: Option<String>,
    title: String,
    icon: Option<String>,
    snippet: String,
    rank: f64,
}

/// Turns free-form user input into a safe FTS5 query: every token becomes a quoted prefix
/// term and all terms must match. No FTS operators from user input are interpreted.
pub fn build_fts_query(input: &str) -> Option<String> {
    let terms: Vec<String> = input
        .split_whitespace()
        .filter(|t| t.chars().any(char::is_alphanumeric))
        .take(16)
        .map(|t| format!("\"{}\"*", t.replace('"', "\"\"")))
        .collect();
    if terms.is_empty() {
        None
    } else {
        Some(terms.join(" "))
    }
}

pub async fn search(
    _user: AuthUser,
    State(state): State<AppState>,
    Query(q): Query<SearchQuery>,
) -> AppResult<impl IntoResponse> {
    let input: String = q.q.chars().take(256).collect();
    let Some(fts) = build_fts_query(&input) else {
        return Ok(Json(json!({ "results": Vec::<SearchResult>::new() })));
    };
    let results: Vec<SearchResult> = sqlx::query_as(
        "SELECT p.id, p.parent_id, p.title, p.icon, \
                snippet(pages_fts, 2, char(2), char(3), '…', 16) AS snippet, \
                bm25(pages_fts, 0.0, 10.0, 1.0) AS rank \
         FROM pages_fts JOIN pages p ON p.id = pages_fts.page_id \
         WHERE pages_fts MATCH ? AND p.deleted_at IS NULL \
         ORDER BY rank LIMIT 30",
    )
    .bind(fts)
    .fetch_all(&state.pool)
    .await?;
    Ok(Json(json!({ "results": results })))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_safe_queries() {
        assert_eq!(build_fts_query("  "), None);
        assert_eq!(build_fts_query("hello wor").unwrap(), "\"hello\"* \"wor\"*");
        assert_eq!(build_fts_query("a\"b OR").unwrap(), "\"a\"\"b\"* \"OR\"*");
        assert_eq!(build_fts_query("-- ()"), None);
    }
}
