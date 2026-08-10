use crate::db;
use crate::feeds;
use std::env::temp_dir;
use uuid::Uuid;

#[test]
fn db_seeds_feeds_and_stores_article() {
    let path = temp_dir().join(format!("le-test-{}.db", Uuid::new_v4()));
    let conn = db::open_db(path.clone()).expect("open");
    let feeds = db::list_feeds(&conn).expect("feeds");
    assert!(feeds.len() >= 20, "expected expanded curated feeds, got {}", feeds.len());

    let article = db::Article {
        id: Uuid::new_v4().to_string(),
        url: "https://example.com/a".into(),
        title: "Hello".into(),
        title_zh: "你好".into(),
        source: "Test".into(),
        category: "tech".into(),
        published_at: None,
        content_text: "word ".repeat(100),
        fetched_at: chrono::Utc::now().to_rfc3339(),
    };
    db::upsert_article(&conn, &article).unwrap();
    let list = db::list_articles(&conn, Some("tech")).unwrap();
    assert_eq!(list.len(), 1);
    let _ = std::fs::remove_file(path);
}

#[test]
fn seed_feeds_adds_new_curated_sources() {
    let path = temp_dir().join(format!("le-test-seed-{}.db", Uuid::new_v4()));
    let conn = db::open_db(path.clone()).expect("open");
    let before = db::list_feeds(&conn).unwrap().len();
    // Simulate older DB missing a curated feed; re-open triggers seed INSERT OR IGNORE.
    conn.execute("DELETE FROM feed_sources WHERE id='longreads'", [])
        .unwrap();
    let mid = db::list_feeds(&conn).unwrap().len();
    assert_eq!(mid, before - 1);
    drop(conn);
    let conn = db::open_db(path.clone()).expect("reopen");
    let after = db::list_feeds(&conn).unwrap().len();
    assert_eq!(after, before);
    assert!(db::list_feeds(&conn)
        .unwrap()
        .iter()
        .any(|f| f.id == "longreads"));
    let _ = std::fs::remove_file(path);
}

#[test]
fn insert_article_if_new_is_idempotent() {
    let path = temp_dir().join(format!("le-idempotent-{}.db", Uuid::new_v4()));
    let conn = db::open_db(path.clone()).expect("open");

    let first = db::Article {
        id: "id-1".into(),
        url: "https://example.com/same".into(),
        title: "Original Title".into(),
        title_zh: "原文标题".into(),
        source: "Test".into(),
        category: "tech".into(),
        published_at: None,
        content_text: "original content that should stay".into(),
        fetched_at: "2020-01-01T00:00:00Z".into(),
    };
    assert!(db::insert_article_if_new(&conn, &first).unwrap());

    let second = db::Article {
        id: "id-2".into(),
        url: "https://example.com/same".into(),
        title: "Changed Title".into(),
        title_zh: String::new(),
        source: "Other".into(),
        category: "world".into(),
        published_at: Some("2024-01-01T00:00:00Z".into()),
        content_text: "should not overwrite".into(),
        fetched_at: "2024-06-01T00:00:00Z".into(),
    };
    assert!(!db::insert_article_if_new(&conn, &second).unwrap());

    let stored = db::get_article_by_url(&conn, "https://example.com/same")
        .unwrap()
        .expect("exists");
    assert_eq!(stored.id, "id-1");
    assert_eq!(stored.title, "Original Title");
    assert_eq!(stored.title_zh, "原文标题");
    assert_eq!(stored.content_text, "original content that should stay");
    assert_eq!(stored.fetched_at, "2020-01-01T00:00:00Z");

    let _ = std::fs::remove_file(path);
}

#[test]
fn list_article_urls_supports_incremental_skip() {
    let path = temp_dir().join(format!("le-urls-{}.db", Uuid::new_v4()));
    let conn = db::open_db(path.clone()).expect("open");
    let a = db::Article {
        id: "a1".into(),
        url: "https://example.com/one".into(),
        title: "One".into(),
        title_zh: String::new(),
        source: "T".into(),
        category: "tech".into(),
        published_at: None,
        content_text: "x".repeat(50),
        fetched_at: "2020-01-01T00:00:00Z".into(),
    };
    db::insert_article_if_new(&conn, &a).unwrap();
    let urls = db::list_article_urls(&conn).unwrap();
    assert!(urls.contains("https://example.com/one"));
    let _ = std::fs::remove_file(path);
}

#[test]
fn split_paragraphs_works() {
    let parts = feeds::split_paragraphs("A\n\nB\n\n\nC");
    assert_eq!(parts, vec!["A", "B", "C"]);
}

#[test]
fn filter_new_entries_skips_known_urls() {
    let known = std::collections::HashSet::from([
        "https://example.com/old".to_string(),
        "https://example.com/also".to_string(),
    ]);
    let candidates = vec![
        "https://example.com/old".to_string(),
        "https://example.com/new".to_string(),
        "https://example.com/also".to_string(),
        "https://example.com/fresh".to_string(),
    ];
    let (new_urls, skipped) = feeds::partition_new_urls(&candidates, &known);
    assert_eq!(skipped, 2);
    assert_eq!(
        new_urls,
        vec![
            "https://example.com/new".to_string(),
            "https://example.com/fresh".to_string()
        ]
    );
}
