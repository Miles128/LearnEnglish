use crate::db;
use crate::feeds;
use std::env::temp_dir;
use uuid::Uuid;

#[test]
fn db_seeds_feeds_and_stores_article() {
    let path = temp_dir().join(format!("le-test-{}.db", Uuid::new_v4()));
    let conn = db::open_db(path.clone()).expect("open");
    let feeds = db::list_feeds(&conn).expect("feeds");
    assert!(!feeds.is_empty());

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
fn split_paragraphs_works() {
    let parts = feeds::split_paragraphs("A\n\nB\n\n\nC");
    assert_eq!(parts, vec!["A", "B", "C"]);
}
