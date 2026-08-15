use crate::db;
use crate::feeds;
use std::env::temp_dir;
use uuid::Uuid;

#[test]
fn db_seeds_feeds_and_stores_article() {
    let path = temp_dir().join(format!("le-test-{}.db", Uuid::new_v4()));
    let conn = db::open_db(path.clone()).expect("open");
    let feeds = db::list_feeds(&conn).expect("feeds");
    assert!(
        feeds.len() >= 80,
        "expected curated news/blog feeds, got {}",
        feeds.len()
    );
    assert!(
        feeds.iter().any(|f| f.id == "mit-tr-ai"),
        "expected AI-focused tech feed"
    );
    assert!(
        feeds.iter().any(|f| f.id == "vox" || f.id == "the-atlantic"),
        "expected classic explainer/magazine feed"
    );
    assert!(
        !feeds.iter().any(|f| f.name.contains("Podcast") || f.id == "planet-money"),
        "podcasts should not be curated"
    );
    assert!(
        !feeds.iter().any(|f| f.id == "freecodecamp" || f.id == "rust-blog"),
        "programming blogs should be removed"
    );

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
        origin: "rss".into(),
    };
    db::upsert_article(&conn, &article).unwrap();
    let list = db::list_articles(&conn, Some("tech"), None, None).unwrap();
    assert_eq!(list.len(), 1);
    let _ = std::fs::remove_file(path);
}

#[test]
fn seed_feeds_adds_new_curated_sources() {
    let path = temp_dir().join(format!("le-test-seed-{}.db", Uuid::new_v4()));
    let conn = db::open_db(path.clone()).expect("open");
    let before = db::list_feeds(&conn).unwrap().len();
    // Simulate older DB missing a curated feed; re-open triggers seed INSERT OR IGNORE.
    conn.execute("DELETE FROM feed_sources WHERE id='propublica'", [])
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
        .any(|f| f.id == "propublica"));
    let _ = std::fs::remove_file(path);
}

#[test]
fn seed_feeds_removes_obsolete_sources() {
    let path = temp_dir().join(format!("le-test-obsolete-{}.db", Uuid::new_v4()));
    let conn = db::open_db(path.clone()).expect("open");
    conn.execute(
        "INSERT INTO feed_sources (id, name, category, url, enabled, origin, description) VALUES ('rust-blog','Rust Blog','tech','https://example.com/rust',1,'curated','')",
        [],
    )
    .unwrap();
    assert!(db::list_feeds(&conn)
        .unwrap()
        .iter()
        .any(|f| f.id == "rust-blog"));
    drop(conn);
    let conn = db::open_db(path.clone()).expect("reopen");
    assert!(
        !db::list_feeds(&conn)
            .unwrap()
            .iter()
            .any(|f| f.id == "rust-blog"),
        "obsolete curated feeds should be deleted on open"
    );
    let _ = std::fs::remove_file(path);
}

#[test]
fn seed_feeds_preserves_user_subscriptions() {
    let path = temp_dir().join(format!("le-test-user-feed-{}.db", Uuid::new_v4()));
    let conn = db::open_db(path.clone()).expect("open");
    let feed = db::subscribe_feed(
        &conn,
        "My Climate Blog",
        "tech",
        "https://example.com/climate/rss.xml",
        "user pick",
    )
    .unwrap();
    assert_eq!(feed.origin, "user");
    drop(conn);
    let conn = db::open_db(path.clone()).expect("reopen");
    let feeds = db::list_feeds(&conn).unwrap();
    assert!(
        feeds.iter().any(|f| f.id == feed.id && f.origin == "user"),
        "user subscriptions must survive curated seed"
    );
    let cats = db::list_feed_categories(&conn).unwrap();
    assert!(cats.iter().any(|c| c.id == "tech" && c.builtin));
    let custom = db::add_feed_category(&conn, "气候").unwrap();
    assert!(!custom.builtin);
    assert!(!custom.id.is_empty());
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
        origin: "rss".into(),
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
        origin: "rss".into(),
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
        origin: "rss".into(),
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

#[test]
fn purge_summary_only_removes_teasers_keeps_fulltext() {
    let path = temp_dir().join(format!("le-purge-summary-{}.db", Uuid::new_v4()));
    let conn = db::open_db(path.clone()).expect("open");

    let teaser = db::Article {
        id: "teaser".into(),
        url: "https://example.com/teaser".into(),
        title: "Teaser".into(),
        title_zh: String::new(),
        source: "T".into(),
        category: "tech".into(),
        published_at: None,
        content_text: "a".repeat(500), // mid-length RSS summary
        fetched_at: "2020-01-01T00:00:00Z".into(),
        origin: "rss".into(),
    };
    let full = db::Article {
        id: "full".into(),
        url: "https://example.com/full".into(),
        title: "Full".into(),
        title_zh: String::new(),
        source: "T".into(),
        category: "tech".into(),
        published_at: None,
        content_text: "word ".repeat(500), // ≥ 2000 chars
        fetched_at: "2020-01-01T00:00:00Z".into(),
        origin: "rss".into(),
    };
    db::insert_article_if_new(&conn, &teaser).unwrap();
    db::insert_article_if_new(&conn, &full).unwrap();

    let removed = feeds::purge_summary_only_articles(&conn).unwrap();
    assert_eq!(removed, 1);
    assert!(db::get_article(&conn, "teaser").unwrap().is_none());
    assert!(db::get_article(&conn, "full").unwrap().is_some());

    let _ = std::fs::remove_file(path);
}

#[test]
fn purge_never_touches_user_imported_articles() {
    let path = temp_dir().join(format!("le-purge-import-{}.db", Uuid::new_v4()));
    let conn = db::open_db(path.clone()).expect("open");

    for (id, url, origin) in [
        ("u1", "https://example.com/url-import", "url"),
        ("f1", "file://import/xyz", "file"),
    ] {
        let a = db::Article {
            id: id.into(),
            url: url.into(),
            title: "Imported".into(),
            title_zh: String::new(),
            source: "导入".into(),
            category: "other".into(),
            published_at: None,
            content_text: "a".repeat(500), // would be purged if origin were rss
            fetched_at: "2020-01-01T00:00:00Z".into(),
            origin: origin.into(),
        };
        db::insert_article_if_new(&conn, &a).unwrap();
    }

    let removed_short = feeds::purge_summary_only_articles(&conn).unwrap();
    assert_eq!(removed_short, 0, "imported short bodies must survive");
    let removed_lang = feeds::purge_non_english_articles(&conn).unwrap();
    assert_eq!(removed_lang, 0, "imported articles must survive language purge");
    assert_eq!(db::list_all_articles(&conn).unwrap().len(), 2);

    let _ = std::fs::remove_file(path);
}

#[test]
fn refresh_article_content_updates_longer_body() {
    let path = temp_dir().join(format!("le-refresh-{}.db", Uuid::new_v4()));
    let conn = db::open_db(path.clone()).expect("open");
    let mut a = db::Article {
        id: "r1".into(),
        url: "https://example.com/refresh".into(),
        title: "Old".into(),
        title_zh: "旧题".into(),
        source: "T".into(),
        category: "tech".into(),
        published_at: None,
        content_text: "short body".into(),
        fetched_at: "2020-01-01T00:00:00Z".into(),
        origin: "rss".into(),
    };
    db::insert_article_if_new(&conn, &a).unwrap();

    let longer = "word ".repeat(500);
    a.title = "New Title".into();
    a.content_text = longer.clone();
    a.fetched_at = "2024-01-01T00:00:00Z".into();
    let changed = db::refresh_article_content(&conn, &a).unwrap();
    assert!(changed);
    let stored = db::get_article(&conn, "r1").unwrap().expect("exists");
    assert_eq!(stored.title, "New Title");
    assert_eq!(stored.content_text, longer);
    assert_eq!(stored.title_zh, "旧题", "title_zh must be preserved");
    assert_eq!(stored.origin, "rss");

    // Idempotent: same body is a no-op.
    let changed_again = db::refresh_article_content(&conn, &a).unwrap();
    assert!(!changed_again);

    let _ = std::fs::remove_file(path);
}

#[test]
fn list_articles_paginates() {
    let path = temp_dir().join(format!("le-page-{}.db", Uuid::new_v4()));
    let conn = db::open_db(path.clone()).expect("open");
    for i in 0..5 {
        let a = db::Article {
            id: format!("p{i}"),
            url: format!("https://example.com/{i}"),
            title: format!("T{i}"),
            title_zh: String::new(),
            source: "S".into(),
            category: "tech".into(),
            published_at: None,
            content_text: "x".repeat(50),
            fetched_at: format!("2020-01-0{}T00:00:00Z", i + 1),
            origin: "rss".into(),
        };
        db::insert_article_if_new(&conn, &a).unwrap();
    }
    let page1 = db::list_articles(&conn, None, Some(2), Some(0)).unwrap();
    let page2 = db::list_articles(&conn, None, Some(2), Some(2)).unwrap();
    let page3 = db::list_articles(&conn, None, Some(2), Some(4)).unwrap();
    assert_eq!(page1.len(), 2);
    assert_eq!(page2.len(), 2);
    assert_eq!(page3.len(), 1);
    let ids: Vec<String> = page1
        .iter()
        .chain(page2.iter())
        .chain(page3.iter())
        .map(|a| a.id.clone())
        .collect();
    assert_eq!(ids.len(), 5);
    assert!(ids.iter().all(|id| id.starts_with('p')));
    let _ = std::fs::remove_file(path);
}

#[test]
fn vocab_dedup_by_term_and_delete_article_detaches() {
    let path = temp_dir().join(format!("le-vocab-{}.db", Uuid::new_v4()));
    let conn = db::open_db(path.clone()).expect("open");

    let item = db::VocabItem {
        id: "v1".into(),
        term: "Ubiquitous".into(),
        definition_zh: "无处不在的".into(),
        word_type: "adjective".into(),
        collocations: vec!["ubiquitous in".into()],
        context_sentence: "It is ubiquitous.".into(),
        article_id: Some("a1".into()),
        status: "learning".into(),
        interval_days: 0.0,
        reps: 0,
        consecutive_know: 0,
        next_review_at: "2020-01-01T00:00:00Z".into(),
        created_at: "2020-01-01T00:00:00Z".into(),
    };
    db::insert_vocab(&conn, &item).unwrap();

    // Case-insensitive lookup re-adding the same term returns the same row.
    let found = db::get_vocab_by_term(&conn, "ubiquitous").unwrap().expect("exists");
    assert_eq!(found.id, "v1");

    // Merge meta into existing entry.
    let mut merged = found;
    merged.definition_zh = String::new(); // existing keeps its def
    merged.collocations = vec!["ubiquitous in".into(), "ubiquitous across".into()];
    merged.article_id = Some("a2".into());
    db::update_vocab_meta(&conn, &merged).unwrap();
    let after = db::get_vocab(&conn, "v1").unwrap().expect("exists");
    assert_eq!(after.collocations.len(), 2);
    assert_eq!(after.article_id.as_deref(), Some("a2"));

    // Deleting an article detaches vocab rows instead of deleting them.
    db::delete_article(&conn, "a2").unwrap();
    let detached = db::get_vocab(&conn, "v1").unwrap().expect("still exists");
    assert_eq!(detached.article_id, None);

    let _ = std::fs::remove_file(path);
}
