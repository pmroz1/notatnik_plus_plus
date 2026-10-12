//! End-to-end tests of the HTTP API against a temporary SQLite database.

use axum::{
    Router,
    body::Body,
    http::{Method, Request, StatusCode, header},
};
use http_body_util::BodyExt;
use notes_api::{AppState, app, auth, config::Config, db};
use serde_json::{Value, json};
use sqlx::SqlitePool;
use tempfile::TempDir;
use tower::ServiceExt;

const USER: &str = "owner";
const PASSWORD: &str = "correct horse battery staple";

struct TestApp {
    _dir: TempDir,
    router: Router,
    pool: SqlitePool,
    config: Config,
    cookie: Option<String>,
}

struct Resp {
    status: StatusCode,
    headers: axum::http::HeaderMap,
    body: Value,
}

impl TestApp {
    async fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let config = Config::for_data_dir(dir.path().to_path_buf());
        let pool = db::connect(&config.database_path()).await.unwrap();
        auth::provision_user(&pool, USER, PASSWORD, false)
            .await
            .unwrap();
        let router = app(AppState::new(pool.clone(), config.clone()));
        Self {
            _dir: dir,
            router,
            pool,
            config,
            cookie: None,
        }
    }

    async fn logged_in() -> Self {
        let mut app = Self::new().await;
        let res = app
            .request(
                Method::POST,
                "/api/auth/login",
                Some(json!({ "username": USER, "password": PASSWORD })),
            )
            .await;
        assert_eq!(res.status, StatusCode::OK, "{:?}", res.body);
        let set_cookie = res.headers[header::SET_COOKIE]
            .to_str()
            .unwrap()
            .to_string();
        assert!(set_cookie.contains("HttpOnly"));
        assert!(set_cookie.contains("SameSite=Strict"));
        app.cookie = Some(set_cookie.split(';').next().unwrap().to_string());
        app
    }

    async fn send(&self, req: Request<Body>) -> Resp {
        let res = self.router.clone().oneshot(req).await.unwrap();
        let status = res.status();
        let headers = res.headers().clone();
        let bytes = res.into_body().collect().await.unwrap().to_bytes();
        let body = if bytes.is_empty() {
            Value::Null
        } else {
            serde_json::from_slice(&bytes)
                .unwrap_or_else(|_| Value::String(String::from_utf8_lossy(&bytes).into_owned()))
        };
        Resp {
            status,
            headers,
            body,
        }
    }

    fn builder(&self, method: Method, uri: &str) -> axum::http::request::Builder {
        let mut b = Request::builder()
            .method(method)
            .uri(uri)
            .header(header::HOST, "localhost:8080")
            .header("x-requested-with", "notatnik");
        if let Some(cookie) = &self.cookie {
            b = b.header(header::COOKIE, cookie);
        }
        b
    }

    async fn request(&self, method: Method, uri: &str, body: Option<Value>) -> Resp {
        let b = self.builder(method, uri);
        let req = match body {
            Some(v) => b
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(v.to_string()))
                .unwrap(),
            None => b.body(Body::empty()).unwrap(),
        };
        self.send(req).await
    }

    async fn create_page(&self, title: &str, parent: Option<&str>) -> String {
        let res = self
            .request(
                Method::POST,
                "/api/pages",
                Some(json!({ "title": title, "parentId": parent })),
            )
            .await;
        assert_eq!(res.status, StatusCode::CREATED, "{:?}", res.body);
        res.body["id"].as_str().unwrap().to_string()
    }

    async fn save(&self, id: &str, doc: &Value, expected: i64) -> Resp {
        self.request(
            Method::PUT,
            &format!("/api/pages/{id}/content"),
            Some(json!({ "contentJson": doc, "expectedRevision": expected })),
        )
        .await
    }

    async fn list(&self, include_deleted: bool) -> Vec<Value> {
        let res = self
            .request(
                Method::GET,
                &format!("/api/pages?includeDeleted={include_deleted}"),
                None,
            )
            .await;
        assert_eq!(res.status, StatusCode::OK);
        res.body["pages"].as_array().unwrap().clone()
    }
}

fn rich_doc(marker: &str) -> Value {
    json!({
        "type": "doc",
        "content": [
            { "type": "heading", "attrs": { "level": 2 }, "content": [{ "type": "text", "text": "Heading" }] },
            { "type": "paragraph", "content": [
                { "type": "text", "text": marker },
                { "type": "text", "marks": [{ "type": "bold" }, { "type": "italic" }], "text": " styled" },
                { "type": "text", "marks": [{ "type": "link", "attrs": { "href": "https://example.com", "target": "_blank", "rel": "noopener noreferrer nofollow", "class": null } }], "text": " link" }
            ]},
            { "type": "bulletList", "content": [
                { "type": "listItem", "content": [{ "type": "paragraph", "content": [{ "type": "text", "text": "one" }] }] }
            ]},
            { "type": "taskList", "content": [
                { "type": "taskItem", "attrs": { "checked": true }, "content": [{ "type": "paragraph", "content": [{ "type": "text", "text": "task" }] }] }
            ]},
            { "type": "codeBlock", "attrs": { "language": "rust" }, "content": [{ "type": "text", "text": "let x = 1;" }] },
            { "type": "table", "content": [
                { "type": "tableRow", "content": [
                    { "type": "tableHeader", "attrs": { "colspan": 1, "rowspan": 1, "colwidth": null }, "content": [{ "type": "paragraph", "content": [{ "type": "text", "text": "H" }] }] }
                ]},
                { "type": "tableRow", "content": [
                    { "type": "tableCell", "attrs": { "colspan": 1, "rowspan": 1, "colwidth": null }, "content": [{ "type": "paragraph", "content": [{ "type": "text", "text": "C" }] }] }
                ]}
            ]},
            { "type": "blockquote", "content": [{ "type": "paragraph", "content": [{ "type": "text", "text": "quote" }] }] },
            { "type": "horizontalRule" }
        ]
    })
}

#[tokio::test]
async fn health_is_public() {
    let app = TestApp::new().await;
    let res = app.request(Method::GET, "/api/health", None).await;
    assert_eq!(res.status, StatusCode::OK);
    assert_eq!(res.body, json!({ "status": "ok" }));
    assert_eq!(res.headers[header::X_CONTENT_TYPE_OPTIONS], "nosniff");
}

#[tokio::test]
async fn unauthenticated_requests_are_rejected() {
    let app = TestApp::new().await;
    let id = uuid::Uuid::new_v4();
    let cases: Vec<(Method, String, Option<Value>)> = vec![
        (Method::GET, "/api/pages".into(), None),
        (
            Method::POST,
            "/api/pages".into(),
            Some(json!({ "title": "x" })),
        ),
        (Method::GET, format!("/api/pages/{id}"), None),
        (
            Method::PUT,
            format!("/api/pages/{id}/content"),
            Some(json!({ "contentJson": { "type": "doc" }, "expectedRevision": 1 })),
        ),
        (
            Method::PATCH,
            format!("/api/pages/{id}/metadata"),
            Some(json!({ "title": "x" })),
        ),
        (Method::DELETE, format!("/api/pages/{id}"), None),
        (Method::DELETE, format!("/api/pages/{id}/permanent"), None),
        (Method::GET, "/api/search?q=x".into(), None),
        (Method::GET, "/api/export".into(), None),
        (
            Method::POST,
            "/api/import".into(),
            Some(
                json!({ "format": "notatnik-workspace", "version": 1, "exportedAt": "2026-01-01T00:00:00Z", "pages": [] }),
            ),
        ),
        (Method::POST, "/api/backup".into(), None),
        (Method::GET, "/api/auth/me".into(), None),
    ];
    for (method, uri, body) in cases {
        let res = app.request(method.clone(), &uri, body).await;
        assert_eq!(res.status, StatusCode::UNAUTHORIZED, "{method} {uri}");
        assert_eq!(res.body["error"]["code"], "unauthorized");
    }
}

#[tokio::test]
async fn login_logout_and_session_expiry() {
    let mut app = TestApp::new().await;
    let bad = app
        .request(
            Method::POST,
            "/api/auth/login",
            Some(json!({ "username": USER, "password": "wrong password!!" })),
        )
        .await;
    assert_eq!(bad.status, StatusCode::FORBIDDEN);
    let unknown = app
        .request(
            Method::POST,
            "/api/auth/login",
            Some(json!({ "username": "nobody", "password": PASSWORD })),
        )
        .await;
    assert_eq!(unknown.status, StatusCode::FORBIDDEN);
    assert_eq!(bad.body, unknown.body, "no user enumeration");

    app = TestApp::logged_in().await;
    let me = app.request(Method::GET, "/api/auth/me", None).await;
    assert_eq!(me.body["username"], USER);

    // Only a hash of the token is stored.
    let token = app.cookie.clone().unwrap();
    let token = token.split('=').nth(1).unwrap();
    let stored: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sessions WHERE token_hash = ?")
        .bind(token)
        .fetch_one(&app.pool)
        .await
        .unwrap();
    assert_eq!(stored, 0);

    let out = app.request(Method::POST, "/api/auth/logout", None).await;
    assert_eq!(out.status, StatusCode::NO_CONTENT);
    let me = app.request(Method::GET, "/api/auth/me", None).await;
    assert_eq!(
        me.status,
        StatusCode::UNAUTHORIZED,
        "logout revokes the session"
    );

    let app = TestApp::logged_in().await;
    sqlx::query("UPDATE sessions SET expires_at = '2000-01-01T00:00:00.000Z'")
        .execute(&app.pool)
        .await
        .unwrap();
    let me = app.request(Method::GET, "/api/auth/me", None).await;
    assert_eq!(
        me.status,
        StatusCode::UNAUTHORIZED,
        "expired sessions are rejected"
    );
}

#[tokio::test]
async fn login_is_rate_limited() {
    let app = TestApp::new().await;
    for _ in 0..5 {
        let res = app
            .request(
                Method::POST,
                "/api/auth/login",
                Some(json!({ "username": USER, "password": "nope nope nope" })),
            )
            .await;
        assert_eq!(res.status, StatusCode::FORBIDDEN);
    }
    let res = app
        .request(
            Method::POST,
            "/api/auth/login",
            Some(json!({ "username": USER, "password": PASSWORD })),
        )
        .await;
    assert_eq!(res.status, StatusCode::TOO_MANY_REQUESTS);
    assert!(res.headers.contains_key(header::RETRY_AFTER));
}

#[tokio::test]
async fn csrf_checks_apply_to_mutations() {
    let app = TestApp::logged_in().await;
    // Missing custom header.
    let req = Request::builder()
        .method(Method::POST)
        .uri("/api/pages")
        .header(header::HOST, "localhost:8080")
        .header(header::COOKIE, app.cookie.clone().unwrap())
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from("{}"))
        .unwrap();
    assert_eq!(app.send(req).await.status, StatusCode::FORBIDDEN);
    // Foreign origin.
    let req = app
        .builder(Method::POST, "/api/pages")
        .header(header::ORIGIN, "https://evil.example")
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from("{}"))
        .unwrap();
    assert_eq!(app.send(req).await.status, StatusCode::FORBIDDEN);
    // Same origin.
    let req = app
        .builder(Method::POST, "/api/pages")
        .header(header::ORIGIN, "http://localhost:8080")
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from("{}"))
        .unwrap();
    assert_eq!(app.send(req).await.status, StatusCode::CREATED);
}

#[tokio::test]
async fn page_crud_and_metadata_do_not_touch_content() {
    let app = TestApp::logged_in().await;
    let id = app.create_page("First", None).await;
    let saved = app.save(&id, &rich_doc("hello"), 1).await;
    assert_eq!(saved.status, StatusCode::OK);
    assert_eq!(saved.body["revision"], 2);

    let res = app
        .request(
            Method::PATCH,
            &format!("/api/pages/{id}/metadata"),
            Some(json!({ "title": "Renamed", "icon": "📘", "isFavorite": true })),
        )
        .await;
    assert_eq!(res.status, StatusCode::OK, "{:?}", res.body);
    assert_eq!(res.body["title"], "Renamed");
    assert_eq!(res.body["icon"], "📘");
    assert_eq!(res.body["isFavorite"], true);
    assert_eq!(
        res.body["revision"], 2,
        "metadata does not bump the content revision"
    );

    let res = app
        .request(
            Method::PATCH,
            &format!("/api/pages/{id}/metadata"),
            Some(json!({ "icon": null })),
        )
        .await;
    assert_eq!(res.body["icon"], Value::Null);
    assert_eq!(res.body["title"], "Renamed", "absent fields are untouched");

    let page = app
        .request(Method::GET, &format!("/api/pages/{id}"), None)
        .await;
    assert_eq!(page.body["contentJson"], rich_doc("hello"));
    assert!(page.body["lastOpenedAt"].is_string());

    let bad = app
        .request(
            Method::PATCH,
            &format!("/api/pages/{id}/metadata"),
            Some(json!({ "title": "a\nb" })),
        )
        .await;
    assert_eq!(bad.status, StatusCode::BAD_REQUEST);
    assert_eq!(bad.body["error"]["code"], "bad_request");

    let missing = app
        .request(
            Method::GET,
            &format!("/api/pages/{}", uuid::Uuid::new_v4()),
            None,
        )
        .await;
    assert_eq!(missing.status, StatusCode::NOT_FOUND);
    let garbage = app
        .request(Method::GET, "/api/pages/not-a-uuid", None)
        .await;
    assert_eq!(garbage.status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn rich_content_round_trips_exactly() {
    let app = TestApp::logged_in().await;
    let id = app.create_page("Rich", None).await;
    let doc = rich_doc("round trip");
    assert_eq!(app.save(&id, &doc, 1).await.status, StatusCode::OK);
    let page = app
        .request(Method::GET, &format!("/api/pages/{id}"), None)
        .await;
    assert_eq!(page.body["contentJson"], doc);
    assert_eq!(page.body["revision"], 2);

    let invalid = json!({ "type": "doc", "content": [{ "type": "script" }] });
    assert_eq!(
        app.save(&id, &invalid, 2).await.status,
        StatusCode::BAD_REQUEST
    );
    let malformed = app
        .send(
            app.builder(Method::PUT, &format!("/api/pages/{id}/content"))
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from("{not json"))
                .unwrap(),
        )
        .await;
    assert_eq!(malformed.status, StatusCode::BAD_REQUEST);
    assert_eq!(malformed.body["error"]["code"], "bad_request");
}

#[tokio::test]
async fn stale_revision_is_a_conflict() {
    let app = TestApp::logged_in().await;
    let id = app.create_page("Shared", None).await;
    // Tab A saves first.
    assert_eq!(
        app.save(&id, &rich_doc("tab A"), 1).await.status,
        StatusCode::OK
    );
    // Tab B still believes revision 1.
    let res = app.save(&id, &rich_doc("tab B"), 1).await;
    assert_eq!(res.status, StatusCode::CONFLICT);
    assert_eq!(res.body["error"]["code"], "revision_conflict");
    assert_eq!(res.body["details"]["currentRevision"], 2);
    let page = app
        .request(Method::GET, &format!("/api/pages/{id}"), None)
        .await;
    assert_eq!(
        page.body["contentJson"],
        rich_doc("tab A"),
        "tab A's content is kept"
    );
}

#[tokio::test]
async fn concurrent_saves_with_same_revision_only_one_wins() {
    let app = TestApp::logged_in().await;
    let id = app.create_page("Race", None).await;
    let (doc_a, doc_b) = (rich_doc("A"), rich_doc("B"));
    let (a, b) = tokio::join!(app.save(&id, &doc_a, 1), app.save(&id, &doc_b, 1));
    let mut statuses = [a.status, b.status];
    statuses.sort();
    assert_eq!(statuses, [StatusCode::OK, StatusCode::CONFLICT]);
}

#[tokio::test]
async fn move_reorders_and_prevents_cycles() {
    let app = TestApp::logged_in().await;
    let a = app.create_page("A", None).await;
    let b = app.create_page("B", None).await;
    let child = app.create_page("Child", Some(&a)).await;
    let grandchild = app.create_page("Grandchild", Some(&child)).await;

    for target in [&a, &child, &grandchild] {
        let res = app
            .request(
                Method::POST,
                &format!("/api/pages/{a}/move"),
                Some(json!({ "parentId": target, "index": 0 })),
            )
            .await;
        assert_eq!(res.status, StatusCode::BAD_REQUEST, "cycle via {target}");
    }

    // Move B to the top, then nest the child under B.
    let res = app
        .request(
            Method::POST,
            &format!("/api/pages/{b}/move"),
            Some(json!({ "parentId": null, "index": 0 })),
        )
        .await;
    assert_eq!(res.status, StatusCode::NO_CONTENT);
    let res = app
        .request(
            Method::POST,
            &format!("/api/pages/{child}/move"),
            Some(json!({ "parentId": b, "index": 5 })),
        )
        .await;
    assert_eq!(res.status, StatusCode::NO_CONTENT);

    let pages = app.list(false).await;
    let find = |id: &str| pages.iter().find(|p| p["id"] == id).unwrap().clone();
    assert_eq!(find(&b)["sortOrder"], 0);
    assert_eq!(find(&a)["sortOrder"], 1);
    assert_eq!(find(&child)["parentId"], b.as_str());
    assert_eq!(find(&grandchild)["parentId"], child.as_str());
}

#[tokio::test]
async fn soft_delete_restore_and_permanent_delete() {
    let app = TestApp::logged_in().await;
    let parent = app.create_page("Parent", None).await;
    let child = app.create_page("Child", Some(&parent)).await;
    let grandchild = app.create_page("Grandchild", Some(&child)).await;
    app.save(&grandchild, &rich_doc("deepsecret"), 1).await;

    // Trash the grandchild on its own, then the parent.
    assert_eq!(
        app.request(Method::DELETE, &format!("/api/pages/{grandchild}"), None)
            .await
            .status,
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        app.request(Method::DELETE, &format!("/api/pages/{parent}"), None)
            .await
            .status,
        StatusCode::NO_CONTENT
    );
    assert!(app.list(false).await.is_empty(), "whole subtree hidden");
    let all = app.list(true).await;
    let roots: Vec<_> = all
        .iter()
        .filter(|p| p["deletedRootId"] == p["id"])
        .collect();
    assert_eq!(roots.len(), 2, "two independent trash entries");

    // Cannot create under or move into a trashed page.
    let res = app
        .request(
            Method::POST,
            "/api/pages",
            Some(json!({ "parentId": parent })),
        )
        .await;
    assert_eq!(res.status, StatusCode::CONFLICT);

    // A child trashed with its parent must be restored via the parent.
    let res = app
        .request(Method::POST, &format!("/api/pages/{child}/restore"), None)
        .await;
    assert_eq!(res.status, StatusCode::CONFLICT);

    // Restoring the grandchild while its parent is trashed puts it at the top level.
    let res = app
        .request(
            Method::POST,
            &format!("/api/pages/{grandchild}/restore"),
            None,
        )
        .await;
    assert_eq!(res.status, StatusCode::OK);
    assert_eq!(res.body["parentId"], Value::Null);

    let res = app
        .request(Method::POST, &format!("/api/pages/{parent}/restore"), None)
        .await;
    assert_eq!(res.status, StatusCode::OK);
    let live = app.list(false).await;
    assert_eq!(live.len(), 3);
    assert!(
        live.iter()
            .any(|p| p["id"] == child && p["parentId"] == parent)
    );

    // Permanent deletion only from trash; removes the subtree and the search index entries.
    let res = app
        .request(
            Method::DELETE,
            &format!("/api/pages/{parent}/permanent"),
            None,
        )
        .await;
    assert_eq!(res.status, StatusCode::CONFLICT);
    app.request(Method::DELETE, &format!("/api/pages/{parent}"), None)
        .await;
    let res = app
        .request(
            Method::DELETE,
            &format!("/api/pages/{parent}/permanent"),
            None,
        )
        .await;
    assert_eq!(res.status, StatusCode::OK);
    assert_eq!(res.body["deletedPages"], 2);
    assert_eq!(app.list(true).await.len(), 1);
    let fts: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM pages_fts")
        .fetch_one(&app.pool)
        .await
        .unwrap();
    assert_eq!(fts, 1, "FTS rows of purged pages are removed");
}

#[tokio::test]
async fn search_matches_titles_and_body_text() {
    let app = TestApp::logged_in().await;
    let a = app.create_page("Gardening plans", None).await;
    let b = app.create_page("Recipes", None).await;
    app.save(&b, &rich_doc("tomato soup with basil"), 1).await;

    let res = app.request(Method::GET, "/api/search?q=garden", None).await;
    let results = res.body["results"].as_array().unwrap();
    assert_eq!(results.len(), 1);
    assert_eq!(results[0]["id"], a.as_str());

    let res = app
        .request(Method::GET, "/api/search?q=tomato%20bas", None)
        .await;
    let results = res.body["results"].as_array().unwrap();
    assert_eq!(results.len(), 1);
    assert_eq!(results[0]["id"], b.as_str());
    assert!(
        results[0]["snippet"]
            .as_str()
            .unwrap()
            .contains("\u{2}tomato\u{3}")
    );

    // FTS syntax in user input is treated literally, not as an error.
    let res = app
        .request(Method::GET, "/api/search?q=%22OR%20NEAR(", None)
        .await;
    assert_eq!(res.status, StatusCode::OK);

    // Renames are reflected and trashed pages are excluded.
    app.request(
        Method::PATCH,
        &format!("/api/pages/{a}/metadata"),
        Some(json!({ "title": "Orchard" })),
    )
    .await;
    let res = app.request(Method::GET, "/api/search?q=garden", None).await;
    assert!(res.body["results"].as_array().unwrap().is_empty());
    app.request(Method::DELETE, &format!("/api/pages/{b}"), None)
        .await;
    let res = app.request(Method::GET, "/api/search?q=tomato", None).await;
    assert!(res.body["results"].as_array().unwrap().is_empty());
}

#[tokio::test]
async fn duplicate_copies_subtree() {
    let app = TestApp::logged_in().await;
    let root = app.create_page("Root", None).await;
    let child = app.create_page("Child", Some(&root)).await;
    app.save(&child, &rich_doc("child body"), 1).await;
    let res = app
        .request(Method::POST, &format!("/api/pages/{root}/duplicate"), None)
        .await;
    assert_eq!(res.status, StatusCode::CREATED);
    assert_eq!(res.body["title"], "Root (copy)");
    let copy_id = res.body["id"].as_str().unwrap().to_string();
    let pages = app.list(false).await;
    assert_eq!(pages.len(), 4);
    let copied_child = pages
        .iter()
        .find(|p| p["parentId"] == copy_id.as_str())
        .unwrap();
    let detail = app
        .request(
            Method::GET,
            &format!("/api/pages/{}", copied_child["id"].as_str().unwrap()),
            None,
        )
        .await;
    assert_eq!(detail.body["contentJson"], rich_doc("child body"));
}

#[tokio::test]
async fn tags_can_be_set_and_listed() {
    let app = TestApp::logged_in().await;
    let id = app.create_page("Tagged", None).await;
    let res = app
        .request(
            Method::PUT,
            &format!("/api/pages/{id}/tags"),
            Some(json!({ "tags": ["work", "Work", " ideas ", ""] })),
        )
        .await;
    assert_eq!(res.status, StatusCode::OK);
    assert_eq!(res.body["tags"], json!(["ideas", "work"]));
    let res = app.request(Method::GET, "/api/tags", None).await;
    assert_eq!(res.body["tags"].as_array().unwrap().len(), 2);
    app.request(
        Method::PUT,
        &format!("/api/pages/{id}/tags"),
        Some(json!({ "tags": [] })),
    )
    .await;
    let res = app.request(Method::GET, "/api/tags", None).await;
    assert!(
        res.body["tags"].as_array().unwrap().is_empty(),
        "unused tags are removed"
    );
}

#[tokio::test]
async fn export_and_import_round_trip() {
    let source = TestApp::logged_in().await;
    let root = source.create_page("Root", None).await;
    let child = source.create_page("Child", Some(&root)).await;
    let trashed = source.create_page("Trashed", Some(&root)).await;
    source.save(&child, &rich_doc("exported"), 1).await;
    source
        .request(
            Method::PUT,
            &format!("/api/pages/{child}/tags"),
            Some(json!({ "tags": ["t1"] })),
        )
        .await;
    source
        .request(Method::DELETE, &format!("/api/pages/{trashed}"), None)
        .await;

    let export = source.request(Method::GET, "/api/export", None).await;
    assert_eq!(export.status, StatusCode::OK);
    assert!(
        export.headers[header::CONTENT_DISPOSITION]
            .to_str()
            .unwrap()
            .contains("attachment")
    );
    assert_eq!(export.body["format"], "notatnik-workspace");
    assert_eq!(export.body["version"], 1);
    assert_eq!(export.body["pages"].as_array().unwrap().len(), 3);

    // Replace mode requires explicit confirmation.
    let target = TestApp::logged_in().await;
    let existing = target.create_page("Existing", None).await;
    let res = target
        .request(
            Method::POST,
            "/api/import?mode=replace",
            Some(export.body.clone()),
        )
        .await;
    assert_eq!(res.status, StatusCode::BAD_REQUEST);

    // Merge mode keeps existing pages and assigns fresh ids.
    let res = target
        .request(Method::POST, "/api/import", Some(export.body.clone()))
        .await;
    assert_eq!(res.status, StatusCode::OK, "{:?}", res.body);
    assert_eq!(res.body["importedPages"], 3);
    let pages = target.list(true).await;
    assert_eq!(pages.len(), 4);
    assert!(pages.iter().any(|p| p["id"] == existing));
    assert!(
        !pages.iter().any(|p| p["id"] == root),
        "merge never reuses ids"
    );
    // Importing the same file twice is safe.
    let res = target
        .request(Method::POST, "/api/import", Some(export.body.clone()))
        .await;
    assert_eq!(res.status, StatusCode::OK);

    // Replace mode restores the exact workspace with the original ids.
    let res = target
        .request(
            Method::POST,
            "/api/import?mode=replace&confirm=replace-all-pages",
            Some(export.body.clone()),
        )
        .await;
    assert_eq!(res.status, StatusCode::OK, "{:?}", res.body);
    assert!(
        res.body["safetyBackup"]
            .as_str()
            .unwrap()
            .starts_with("pre-import-")
    );
    let pages = target.list(true).await;
    assert_eq!(pages.len(), 3);
    let imported_child = pages.iter().find(|p| p["id"] == child).unwrap();
    assert_eq!(imported_child["parentId"], root.as_str());
    assert_eq!(imported_child["tags"], json!(["t1"]));
    let imported_trashed = pages.iter().find(|p| p["id"] == trashed).unwrap();
    assert!(imported_trashed["deletedAt"].is_string());
    let detail = target
        .request(Method::GET, &format!("/api/pages/{child}"), None)
        .await;
    assert_eq!(detail.body["contentJson"], rich_doc("exported"));
    let res = target
        .request(Method::GET, "/api/search?q=exported", None)
        .await;
    assert_eq!(
        res.body["results"].as_array().unwrap().len(),
        1,
        "search index rebuilt"
    );

    // Re-export equals the original (except for the timestamp).
    let again = target.request(Method::GET, "/api/export", None).await;
    let strip = |mut v: Value| {
        v.as_object_mut().unwrap().remove("exportedAt");
        for p in v["pages"].as_array_mut().unwrap() {
            p.as_object_mut().unwrap().remove("lastOpenedAt");
        }
        v
    };
    assert_eq!(strip(again.body), strip(export.body));
}

#[tokio::test]
async fn import_rejects_invalid_files() {
    let app = TestApp::logged_in().await;
    let a = uuid::Uuid::new_v4().to_string();
    let b = uuid::Uuid::new_v4().to_string();
    let page = |id: &str, parent: Option<&str>| {
        json!({
            "id": id, "parentId": parent, "title": "x", "icon": null, "sortOrder": 0,
            "isFavorite": false, "createdAt": "2026-01-01T00:00:00.000Z",
            "updatedAt": "2026-01-01T00:00:00.000Z", "revision": 1, "tags": [],
            "contentJson": { "type": "doc", "content": [] }
        })
    };
    let file = |pages: Vec<Value>| json!({ "format": "notatnik-workspace", "version": 1, "exportedAt": "2026-01-01T00:00:00Z", "pages": pages });
    let cases = vec![
        file(vec![page(&a, Some(&b)), page(&b, Some(&a))]),
        file(vec![page(&a, None), page(&a, None)]),
        file(vec![page(&a, Some(&b))]),
        json!({ "format": "other", "version": 1, "exportedAt": "x", "pages": [] }),
        json!({ "format": "notatnik-workspace", "version": 99, "exportedAt": "x", "pages": [] }),
    ];
    for case in cases {
        let res = app
            .request(Method::POST, "/api/import", Some(case.clone()))
            .await;
        assert_eq!(res.status, StatusCode::BAD_REQUEST, "{case}");
    }
    assert!(
        app.list(true).await.is_empty(),
        "nothing partially imported"
    );
}

#[tokio::test]
async fn online_backup_is_a_valid_database() {
    let app = TestApp::logged_in().await;
    let id = app.create_page("Backed up", None).await;
    app.save(&id, &rich_doc("in backup"), 1).await;
    let res = app.request(Method::POST, "/api/backup", None).await;
    assert_eq!(res.status, StatusCode::OK, "{:?}", res.body);
    let path = app
        .config
        .backup_dir()
        .join(res.body["file"].as_str().unwrap());
    db::verify_database_file(&path).await.unwrap();

    // The backup can be opened as a normal database and contains the content and FTS index.
    let restored = db::connect(&path).await.unwrap();
    let hits: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM pages_fts WHERE pages_fts MATCH 'backup'")
            .fetch_one(&restored)
            .await
            .unwrap();
    assert_eq!(hits, 1);
}

#[tokio::test]
async fn unknown_api_routes_return_json_404() {
    let app = TestApp::logged_in().await;
    let res = app.request(Method::GET, "/api/nope", None).await;
    assert_eq!(res.status, StatusCode::NOT_FOUND);
    assert_eq!(res.body["error"]["code"], "not_found");
}
