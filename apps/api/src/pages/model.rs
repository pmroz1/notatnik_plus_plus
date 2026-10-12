use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct PageRow {
    pub id: String,
    pub parent_id: Option<String>,
    pub title: String,
    pub icon: Option<String>,
    pub sort_order: i64,
    pub is_favorite: bool,
    pub created_at: String,
    pub updated_at: String,
    pub last_opened_at: Option<String>,
    pub deleted_at: Option<String>,
    pub deleted_root_id: Option<String>,
    pub revision: i64,
}

/// Column list matching [`PageRow`], usable inside `concat!` to build static SQL strings.
#[macro_export]
macro_rules! page_columns {
    () => {
        "id, parent_id, title, icon, sort_order, is_favorite, created_at, updated_at, \
         last_opened_at, deleted_at, deleted_root_id, revision"
    };
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PageSummary {
    pub id: String,
    pub parent_id: Option<String>,
    pub title: String,
    pub icon: Option<String>,
    pub sort_order: i64,
    pub is_favorite: bool,
    pub created_at: String,
    pub updated_at: String,
    pub last_opened_at: Option<String>,
    pub deleted_at: Option<String>,
    pub deleted_root_id: Option<String>,
    pub revision: i64,
    pub tags: Vec<String>,
}

impl PageSummary {
    pub fn from_row(row: PageRow, tags: Vec<String>) -> Self {
        Self {
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
            tags,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PageDetail {
    #[serde(flatten)]
    pub summary: PageSummary,
    pub content_json: Value,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreatePageRequest {
    #[serde(default)]
    pub parent_id: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub icon: Option<String>,
}

/// Field-specific metadata update. Absent fields are left untouched; `icon: null` clears it.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UpdateMetadataRequest {
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default, deserialize_with = "double_option")]
    pub icon: Option<Option<String>>,
    #[serde(default)]
    pub is_favorite: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SaveContentRequest {
    pub content_json: Value,
    pub expected_revision: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveContentResponse {
    pub revision: i64,
    pub updated_at: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MovePageRequest {
    pub parent_id: Option<String>,
    /// Zero-based position among the new siblings; clamped to the valid range.
    pub index: usize,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SetTagsRequest {
    pub tags: Vec<String>,
}

fn double_option<'de, D, T>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer).map(Some)
}
