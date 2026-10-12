//! Validation of Tiptap/ProseMirror JSON documents and plain-text extraction for search.
//!
//! The allowlists below must stay in sync with the editor extensions configured in
//! `apps/web/src/app/editor/editor-extensions.ts`.

use serde_json::{Value, json};

use crate::error::AppError;

pub const MAX_CONTENT_BYTES: usize = 2 * 1024 * 1024;
const MAX_DEPTH: usize = 100;
const MAX_NODES: usize = 200_000;

const NODE_TYPES: &[&str] = &[
    "doc",
    "paragraph",
    "text",
    "heading",
    "bulletList",
    "orderedList",
    "listItem",
    "taskList",
    "taskItem",
    "blockquote",
    "codeBlock",
    "horizontalRule",
    "hardBreak",
    "table",
    "tableRow",
    "tableHeader",
    "tableCell",
];

const MARK_TYPES: &[&str] = &["bold", "italic", "strike", "code", "link", "underline"];

/// Nodes whose text is separated by line breaks in the extracted plain text.
const BLOCK_TYPES: &[&str] = &[
    "paragraph",
    "heading",
    "listItem",
    "taskItem",
    "blockquote",
    "codeBlock",
    "tableRow",
    "tableCell",
    "tableHeader",
];

pub fn empty_document() -> Value {
    json!({ "type": "doc", "content": [{ "type": "paragraph" }] })
}

/// Validates the structure of an editor document. Returns a descriptive error for the client.
pub fn validate_document(doc: &Value) -> Result<(), AppError> {
    let serialized_len = serde_json::to_string(doc)
        .map(|s| s.len())
        .unwrap_or(usize::MAX);
    if serialized_len > MAX_CONTENT_BYTES {
        return Err(AppError::PayloadTooLarge(format!(
            "Document exceeds {} bytes",
            MAX_CONTENT_BYTES
        )));
    }
    if doc.get("type").and_then(Value::as_str) != Some("doc") {
        return Err(AppError::bad_request(
            "Document root must have type \"doc\"",
        ));
    }
    let mut count = 0usize;
    validate_node(doc, 0, &mut count)
}

fn validate_node(node: &Value, depth: usize, count: &mut usize) -> Result<(), AppError> {
    *count += 1;
    if *count > MAX_NODES {
        return Err(AppError::bad_request("Document has too many nodes"));
    }
    if depth > MAX_DEPTH {
        return Err(AppError::bad_request("Document is nested too deeply"));
    }
    let obj = node
        .as_object()
        .ok_or_else(|| AppError::bad_request("Document node must be an object"))?;
    let node_type = obj
        .get("type")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::bad_request("Document node is missing a type"))?;
    if !NODE_TYPES.contains(&node_type) {
        return Err(AppError::bad_request(format!(
            "Unsupported node type {node_type:?}"
        )));
    }
    if depth > 0 && node_type == "doc" {
        return Err(AppError::bad_request("Nested doc node"));
    }
    if node_type == "text" {
        if !obj.get("text").is_some_and(Value::is_string) {
            return Err(AppError::bad_request("Text node without text"));
        }
    } else if obj.contains_key("text") {
        return Err(AppError::bad_request("Only text nodes may contain text"));
    }
    if node_type == "heading" {
        let level = obj
            .get("attrs")
            .and_then(|a| a.get("level"))
            .and_then(Value::as_u64);
        if !matches!(level, Some(1..=3)) {
            return Err(AppError::bad_request("Heading level must be 1, 2 or 3"));
        }
    }
    if let Some(attrs) = obj.get("attrs")
        && !attrs.is_object()
        && !attrs.is_null()
    {
        return Err(AppError::bad_request("Node attrs must be an object"));
    }
    if let Some(marks) = obj.get("marks") {
        let marks = marks
            .as_array()
            .ok_or_else(|| AppError::bad_request("marks must be an array"))?;
        for mark in marks {
            validate_mark(mark)?;
        }
    }
    if let Some(content) = obj.get("content") {
        let children = content
            .as_array()
            .ok_or_else(|| AppError::bad_request("content must be an array"))?;
        for child in children {
            validate_node(child, depth + 1, count)?;
        }
    }
    Ok(())
}

fn validate_mark(mark: &Value) -> Result<(), AppError> {
    let mark_type = mark
        .get("type")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::bad_request("Mark is missing a type"))?;
    if !MARK_TYPES.contains(&mark_type) {
        return Err(AppError::bad_request(format!(
            "Unsupported mark type {mark_type:?}"
        )));
    }
    if mark_type == "link" {
        let href = mark
            .get("attrs")
            .and_then(|a| a.get("href"))
            .and_then(Value::as_str)
            .unwrap_or("");
        if !is_safe_href(href) {
            return Err(AppError::bad_request("Link has an unsafe or empty URL"));
        }
    }
    Ok(())
}

/// Accepts http(s), mailto, and scheme-less (relative/fragment) URLs.
pub fn is_safe_href(href: &str) -> bool {
    let href = href.trim();
    if href.is_empty() || href.len() > 2048 || href.chars().any(char::is_control) {
        return false;
    }
    match href.split_once(':') {
        Some((scheme, _))
            if !scheme.contains(['/', '?', '#'])
                && scheme
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.')) =>
        {
            matches!(
                scheme.to_ascii_lowercase().as_str(),
                "http" | "https" | "mailto"
            )
        }
        _ => true,
    }
}

/// Extracts searchable plain text: block nodes are separated by newlines.
pub fn extract_plain_text(doc: &Value) -> String {
    let mut out = String::new();
    collect_text(doc, &mut out);
    let trimmed = out.trim();
    trimmed.to_string()
}

fn collect_text(node: &Value, out: &mut String) {
    let node_type = node.get("type").and_then(Value::as_str).unwrap_or("");
    match node_type {
        "text" => {
            if let Some(text) = node.get("text").and_then(Value::as_str) {
                out.push_str(text);
            }
            return;
        }
        "hardBreak" => {
            out.push('\n');
            return;
        }
        _ => {}
    }
    let is_block = BLOCK_TYPES.contains(&node_type);
    if is_block && !out.is_empty() && !out.ends_with('\n') {
        out.push('\n');
    }
    if let Some(children) = node.get("content").and_then(Value::as_array) {
        for child in children {
            collect_text(child, out);
        }
    }
    if is_block && !out.ends_with('\n') {
        out.push('\n');
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rich_doc() -> Value {
        json!({
            "type": "doc",
            "content": [
                { "type": "heading", "attrs": { "level": 1 }, "content": [{ "type": "text", "text": "Title" }] },
                { "type": "paragraph", "content": [
                    { "type": "text", "text": "Hello " },
                    { "type": "text", "text": "bold", "marks": [{ "type": "bold" }] },
                    { "type": "text", "text": " link", "marks": [{ "type": "link", "attrs": { "href": "https://example.com" } }] }
                ]},
                { "type": "taskList", "content": [
                    { "type": "taskItem", "attrs": { "checked": true }, "content": [
                        { "type": "paragraph", "content": [{ "type": "text", "text": "Done" }] }
                    ]}
                ]},
                { "type": "codeBlock", "attrs": { "language": "rust" }, "content": [{ "type": "text", "text": "fn main() {}" }] },
                { "type": "table", "content": [
                    { "type": "tableRow", "content": [
                        { "type": "tableHeader", "content": [{ "type": "paragraph", "content": [{ "type": "text", "text": "A" }] }] },
                        { "type": "tableCell", "content": [{ "type": "paragraph", "content": [{ "type": "text", "text": "B" }] }] }
                    ]}
                ]},
                { "type": "horizontalRule" }
            ]
        })
    }

    #[test]
    fn accepts_rich_document() {
        validate_document(&rich_doc()).unwrap();
    }

    #[test]
    fn extracts_plain_text() {
        let text = extract_plain_text(&rich_doc());
        assert!(text.starts_with("Title\nHello bold link\n"));
        assert!(text.contains("Done"));
        assert!(text.contains("fn main() {}"));
        assert!(text.contains("A\n"));
    }

    #[test]
    fn rejects_unknown_nodes_and_unsafe_links() {
        let bad = json!({ "type": "doc", "content": [{ "type": "iframe" }] });
        assert!(validate_document(&bad).is_err());
        let js = json!({ "type": "doc", "content": [{ "type": "paragraph", "content": [
            { "type": "text", "text": "x", "marks": [{ "type": "link", "attrs": { "href": "javascript:alert(1)" } }] }
        ]}]});
        assert!(validate_document(&js).is_err());
        let not_doc = json!({ "type": "paragraph" });
        assert!(validate_document(&not_doc).is_err());
        let bad_heading =
            json!({ "type": "doc", "content": [{ "type": "heading", "attrs": { "level": 5 } }] });
        assert!(validate_document(&bad_heading).is_err());
    }

    #[test]
    fn href_rules() {
        assert!(is_safe_href("https://a.b/c"));
        assert!(is_safe_href("mailto:x@y.z"));
        assert!(is_safe_href("/pages/abc"));
        assert!(is_safe_href("#anchor"));
        assert!(!is_safe_href("JavaScript:alert(1)"));
        assert!(!is_safe_href("data:text/html,x"));
        assert!(!is_safe_href(" vbscript:x"));
    }
}
