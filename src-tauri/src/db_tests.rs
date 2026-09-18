use crate::db;
use crate::feeds;
use std::env::temp_dir;
use uuid::Uuid;

fn sample_article(id: &str) -> db::Article {
    db::Article {
        id: id.into(),
        url: format!("https://example.com/{id}"),
        title: id.into(),
        title_zh: String::new(),
        source: "Test".into(),
        category: "tech".into(),
        published_at: None,
        content_text: "word ".repeat(100),
        fetched_at: "2020-01-01T00:00:00Z".into(),
        origin: "rss".into(),
        summary_zh: String::new(),
        last_opened_at: None,
        open_count: 0,
        ..Default::default()
    }
}

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
        summary_zh: String::new(),
        last_opened_at: None,
        open_count: 0,
        ..Default::default()
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
        summary_zh: String::new(),
        last_opened_at: None,
        open_count: 0,
        ..Default::default()
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
        summary_zh: String::new(),
        last_opened_at: None,
        open_count: 0,
        ..Default::default()
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
        summary_zh: String::new(),
        last_opened_at: None,
        open_count: 0,
        ..Default::default()
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

    let mut chrome = String::from("Skip to main content\n\n");
    for i in 1..40 {
        chrome.push_str(&format!("* [ Home topic {i} ][{i}]\n"));
    }
    chrome.push_str("\nA one-line dek.\n");
    let teaser = db::Article {
        id: "teaser".into(),
        url: "https://example.com/teaser".into(),
        title: "Teaser".into(),
        title_zh: String::new(),
        source: "T".into(),
        category: "tech".into(),
        published_at: None,
        content_text: chrome,
        fetched_at: "2020-01-01T00:00:00Z".into(),
        origin: "rss".into(),
        summary_zh: String::new(),
        last_opened_at: None,
        open_count: 0,
        ..Default::default()
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
        summary_zh: String::new(),
        last_opened_at: None,
        open_count: 0,
        ..Default::default()
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
            summary_zh: String::new(),
        last_opened_at: None,
        open_count: 0,
        ..Default::default()
        };
        db::insert_article_if_new(&conn, &a).unwrap();
    }

    let removed_short = feeds::purge_summary_only_articles(&conn).unwrap();
    assert_eq!(removed_short, 0, "imported short bodies must survive");
    let removed_lang = feeds::purge_non_english_articles(&conn).unwrap();
    assert_eq!(removed_lang, 0, "imported articles must survive language purge");
    assert_eq!(
        db::list_articles(&conn, None, Some(100), Some(0))
            .unwrap()
            .len(),
        2
    );

    let _ = std::fs::remove_file(path);
}

#[test]
fn collect_non_english_ids_does_not_delete() {
    let path = temp_dir().join(format!("le-collect-zh-{}.db", Uuid::new_v4()));
    let conn = db::open_db(path.clone()).expect("open");
    let zh = db::Article {
        id: "zh1".into(),
        url: "https://example.com/zh".into(),
        title: "如何学习 Rust 编程语言入门指南".into(),
        title_zh: String::new(),
        source: "T".into(),
        category: "tech".into(),
        published_at: None,
        content_text: "今天我们来讨论如何高效学习一门新的编程语言。首先需要理解基本概念，然后通过大量练习巩固知识。"
            .repeat(5),
        fetched_at: "2020-01-01T00:00:00Z".into(),
        origin: "rss".into(),
        summary_zh: String::new(),
        last_opened_at: None,
        open_count: 0,
        ..Default::default()
    };
    db::insert_article_if_new(&conn, &zh).unwrap();

    let ids = feeds::collect_non_english_rss_ids(&conn).unwrap();
    assert_eq!(ids, vec!["zh1".to_string()]);
    assert!(db::get_article(&conn, "zh1").unwrap().is_some());

    let removed = feeds::delete_articles(&conn, &ids).unwrap();
    assert_eq!(removed, 1);
    assert!(db::get_article(&conn, "zh1").unwrap().is_none());

    let _ = std::fs::remove_file(path);
}

#[test]
fn purge_word_threshold_drops_short_rss_keeps_imports() {
    let path = temp_dir().join(format!("le-word-threshold-{}.db", Uuid::new_v4()));
    let conn = db::open_db(path.clone()).expect("open");

    let mut short = sample_article("short");
    short.word_count = 100;
    short.quality = "fulltext".into();
    let mut long = sample_article("long");
    long.word_count = 800;
    long.quality = "fulltext".into();
    let mut unknown = sample_article("unknown");
    unknown.word_count = 0;
    let mut imported_short = sample_article("imported");
    imported_short.word_count = 50;
    imported_short.origin = "file".into();

    for a in [&short, &long, &unknown, &imported_short] {
        db::insert_article_if_new(&conn, a).unwrap();
    }

    let removed = feeds::purge_rss_below_word_threshold(&conn).unwrap();
    assert_eq!(removed, 1, "only the stamped 100-word RSS article goes");
    assert!(db::get_article(&conn, "short").unwrap().is_none());
    assert!(db::get_article(&conn, "long").unwrap().is_some());
    assert!(
        db::get_article(&conn, "unknown").unwrap().is_some(),
        "unassessed rows must be handled by assessment, not blind word purge"
    );
    assert!(
        db::get_article(&conn, "imported").unwrap().is_some(),
        "user imports are never deleted by threshold purges"
    );

    let _ = std::fs::remove_file(path);
}

#[test]
fn refresh_article_content_updates_longer_body() {
    let path = temp_dir().join(format!("le-refresh-{}.db", Uuid::new_v4()));
    let conn = db::open_db(path.clone()).expect("open");
    let a = db::Article {
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
        summary_zh: String::new(),
        last_opened_at: None,
        open_count: 0,
        ..Default::default()
    };
    db::insert_article_if_new(&conn, &a).unwrap();
    db::set_article_summary_zh(&conn, "r1", "旧简介").unwrap();

    let longer = "word ".repeat(500);
    // The refresh path builds the update struct with an empty id; matching must
    // be by url, so a bogus id still upgrades the stored row.
    let update = db::Article {
        id: String::new(),
        url: "https://example.com/refresh".into(),
        title: "New Title".into(),
        title_zh: String::new(),
        source: "T".into(),
        category: "tech".into(),
        published_at: None,
        content_text: longer.clone(),
        fetched_at: "2024-01-01T00:00:00Z".into(),
        origin: "rss".into(),
        summary_zh: String::new(),
        last_opened_at: None,
        open_count: 0,
        ..Default::default()
    };
    let changed = db::refresh_article_content(&conn, &update).unwrap();
    assert!(changed);
    let stored = db::get_article(&conn, "r1").unwrap().expect("exists");
    assert_eq!(stored.title, "New Title");
    assert_eq!(stored.content_text, longer);
    assert_eq!(stored.title_zh, "旧题", "title_zh must be preserved");
    assert_eq!(stored.summary_zh, "", "stale summary cleared on body refresh");
    assert_eq!(stored.origin, "rss");

    // Idempotent: same body is a no-op.
    let changed_again = db::refresh_article_content(&conn, &update).unwrap();
    assert!(!changed_again);

    let _ = std::fs::remove_file(path);
}

#[test]
fn refresh_article_content_skips_url_imports() {
    let path = temp_dir().join(format!("le-refresh-url-{}.db", Uuid::new_v4()));
    let conn = db::open_db(path.clone()).expect("open");
    let original = "imported body ".repeat(40);
    let a = db::Article {
        id: "imp1".into(),
        url: "https://example.com/same-url".into(),
        title: "Imported".into(),
        title_zh: String::new(),
        source: "导入".into(),
        category: "other".into(),
        published_at: None,
        content_text: original.clone(),
        fetched_at: "2020-01-01T00:00:00Z".into(),
        origin: "url".into(),
        summary_zh: String::new(),
        last_opened_at: None,
        open_count: 0,
        ..Default::default()
    };
    db::insert_article_if_new(&conn, &a).unwrap();

    let update = db::Article {
        id: String::new(),
        url: "https://example.com/same-url".into(),
        title: "RSS overwrite".into(),
        title_zh: String::new(),
        source: "T".into(),
        category: "tech".into(),
        published_at: None,
        content_text: "word ".repeat(500),
        fetched_at: "2024-01-01T00:00:00Z".into(),
        origin: "rss".into(),
        summary_zh: String::new(),
        last_opened_at: None,
        open_count: 0,
        ..Default::default()
    };
    let changed = db::refresh_article_content(&conn, &update).unwrap();
    assert!(!changed);
    let stored = db::get_article(&conn, "imp1").unwrap().expect("exists");
    assert_eq!(stored.title, "Imported");
    assert_eq!(stored.content_text, original);
    assert_eq!(stored.origin, "url");

    let _ = std::fs::remove_file(path);
}

#[test]
fn list_articles_returns_excerpt_not_full_body() {
    let path = temp_dir().join(format!("le-list-excerpt-{}.db", Uuid::new_v4()));
    let conn = db::open_db(path.clone()).expect("open");
    let body = "x".repeat(9000);
    let a = db::Article {
        id: "long1".into(),
        url: "https://example.com/long".into(),
        title: "Long".into(),
        title_zh: String::new(),
        source: "S".into(),
        category: "tech".into(),
        published_at: None,
        content_text: body.clone(),
        fetched_at: "2020-01-01T00:00:00Z".into(),
        origin: "rss".into(),
        summary_zh: String::new(),
        last_opened_at: None,
        open_count: 0,
        ..Default::default()
    };
    db::insert_article_if_new(&conn, &a).unwrap();

    let listed = db::list_articles(&conn, None, Some(1), Some(0)).unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(
        listed[0].excerpt.len(),
        db::LIST_EXCERPT_CHARS as usize,
        "home list should not ship the full body"
    );
    let stored = db::get_article(&conn, "long1").unwrap().expect("exists");
    assert_eq!(stored.content_text.len(), 9000);

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
        summary_zh: String::new(),
        last_opened_at: None,
        open_count: 0,
        ..Default::default()
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
fn reading_stats_counts_days_streak_and_time() {
    let path = temp_dir().join(format!("le-stats-{}.db", Uuid::new_v4()));
    let conn = db::open_db(path.clone()).expect("open");

    let mut a = sample_article("today");
    a.source = "NPR".into();
    a.word_count = 900;
    let mut b = sample_article("yesterday");
    b.source = "NPR".into();
    b.word_count = 500;
    let mut c = sample_article("old");
    c.source = "BBC".into();
    c.word_count = 700;
    for article in [&a, &b, &c] {
        db::insert_article_if_new(&conn, article).unwrap();
    }

    let fmt = |offset: i64| {
        (chrono::Utc::now() - chrono::Duration::days(offset))
            .to_rfc3339()
    };
    let set_opened = |id: &str, at: &str, dwell: i64, completed: i64| {
        conn.execute(
            "UPDATE articles SET last_opened_at=?1, dwell_ms=?2, read_completed=?3, open_count=1 WHERE id=?4",
            rusqlite::params![at, dwell, completed, id],
        )
        .unwrap();
    };
    set_opened("today", &fmt(0), 6 * 60_000 * 2, 1); // 12 min
    set_opened("yesterday", &fmt(1), 3 * 60_000 * 2, 0); // 6 min
    set_opened("old", &fmt(4), 2 * 60_000 * 2, 0); // 4 min, breaks the streak

    let stats = db::reading_stats(&conn).unwrap();
    assert_eq!(stats.articles_total, 3);
    assert_eq!(stats.completed_total, 1);
    assert_eq!(stats.streak_days, 2, "today + yesterday");
    assert_eq!(stats.minutes_total, 22);
    assert!(stats.minutes_7d >= 22);
    assert_eq!(stats.words_total, 900 + 500 + 700);
    assert_eq!(stats.days.len(), 14);
    assert_eq!(stats.days.last().unwrap().articles, 1, "today");
    assert_eq!(stats.days.last().unwrap().minutes, 12);
    assert_eq!(stats.days[13 - 1].articles, 1, "yesterday row");
    assert_eq!(stats.top_sources.first().unwrap().name, "NPR");
    assert_eq!(stats.top_sources.first().unwrap().minutes, 18);

    let _ = std::fs::remove_file(path);
}

#[test]
fn list_article_titles_dedup_window() {
    let path = temp_dir().join(format!("le-dedup-window-{}.db", Uuid::new_v4()));
    let conn = db::open_db(path.clone()).expect("open");

    let mut recurring_old = sample_article("old-briefing");
    recurring_old.fetched_at = (chrono::Utc::now() - chrono::Duration::days(30)).to_rfc3339();
    let mut recurring_new = sample_article("new-briefing");
    recurring_new.fetched_at = chrono::Utc::now().to_rfc3339();

    db::insert_article_if_new(&conn, &recurring_old).unwrap();
    db::insert_article_if_new(&conn, &recurring_new).unwrap();

    let since = (chrono::Utc::now() - chrono::Duration::days(14)).to_rfc3339();
    let recent = db::list_article_titles(&conn, Some(&since)).unwrap();
    assert_eq!(
        recent.len(),
        1,
        "windowed dedup seed must exclude stale rows"
    );
    assert_eq!(recent[0].0, "new-briefing");
    let all = db::list_article_titles(&conn, None).unwrap();
    assert_eq!(all.len(), 2);

    let _ = std::fs::remove_file(path);
}

#[test]
fn query_articles_filters_read_state_source_liked_and_tags() {
    let path = temp_dir().join(format!("le-query-{}.db", Uuid::new_v4()));
    let conn = db::open_db(path.clone()).expect("open");

    let mut unread = sample_article("unread");
    unread.source = "NPR".into();
    let mut read = sample_article("read");
    read.source = "NPR".into();
    let mut liked = sample_article("liked");
    liked.source = "404 Media".into();
    let mut tagged = sample_article("tagged");
    tagged.source = "404 Media".into();

    for a in [&unread, &read, &liked, &tagged] {
        db::insert_article_if_new(&conn, a).unwrap();
    }
    db::mark_article_opened(&conn, "read").unwrap();
    db::set_article_liked(&conn, "liked", true).unwrap();
    db::set_article_tags(&conn, "tagged", &["ai".into(), "chips".into()]).unwrap();

    let q = |query: db::ArticleQuery<'_>, limit: i64| {
        db::query_articles(&conn, &query, Some(limit), Some(0))
            .unwrap()
            .into_iter()
            .map(|a| a.id)
            .collect::<Vec<_>>()
    };

    let unread_only = q(
        db::ArticleQuery {
            read_state: db::ReadState::Unread,
            ..Default::default()
        },
        10,
    );
    assert_eq!(unread_only.len(), 3);
    assert!(!unread_only.contains(&"read".to_string()));

    let read_only = q(
        db::ArticleQuery {
            read_state: db::ReadState::Read,
            ..Default::default()
        },
        10,
    );
    assert_eq!(read_only, vec!["read".to_string()]);

    let by_source = q(
        db::ArticleQuery {
            source: Some("404 Media"),
            ..Default::default()
        },
        10,
    );
    assert_eq!(by_source.len(), 2);

    let liked_only = q(
        db::ArticleQuery {
            liked_only: true,
            ..Default::default()
        },
        10,
    );
    assert_eq!(liked_only, vec!["liked".to_string()]);

    let tags = vec!["ai".to_string()];
    let by_tag = q(
        db::ArticleQuery {
            tags: &tags,
            ..Default::default()
        },
        10,
    );
    assert_eq!(by_tag, vec!["tagged".to_string()]);

    let combined = q(
        db::ArticleQuery {
            source: Some("404 Media"),
            read_state: db::ReadState::Unread,
            ..Default::default()
        },
        10,
    );
    assert_eq!(combined.len(), 2);

    let _ = std::fs::remove_file(path);
}

#[test]
fn content_audit_removes_synopsis_only_bodies_once() {
    let path = temp_dir().join(format!("le-audit-{}.db", Uuid::new_v4()));
    let conn = db::open_db(path.clone()).expect("open");

    // A 500-char synopsis that ends with a read-more marker (teaser).
    let mut teaser = sample_article("teaser");
    teaser.content_text = format!("word {} Continue reading…", "word ".repeat(90));
    teaser.word_count = 90;
    // A real full-text article.
    let mut full = sample_article("full");
    full.content_text = "word ".repeat(600);
    full.word_count = 600;

    db::insert_article_if_new(&conn, &teaser).unwrap();
    db::insert_article_if_new(&conn, &full).unwrap();

    let removed = feeds::audit_rss_bodies_once(&conn).unwrap();
    assert_eq!(removed, 1, "synopsis-only body should be purged");
    assert!(db::get_article(&conn, "teaser").unwrap().is_none());
    assert!(db::get_article(&conn, "full").unwrap().is_some());

    // One-shot: a second run does nothing even if junk appears later.
    let mut junk = sample_article("junk");
    junk.content_text = "word ".repeat(10);
    junk.word_count = 10;
    db::insert_article_if_new(&conn, &junk).unwrap();
    assert_eq!(feeds::audit_rss_bodies_once(&conn).unwrap(), 0);
    assert!(db::get_article(&conn, "junk").unwrap().is_some());

    let _ = std::fs::remove_file(path);
}

#[test]
fn retention_purge_drops_old_rss_but_keeps_liked_and_imports() {
    let path = temp_dir().join(format!("le-retention-{}.db", Uuid::new_v4()));
    let conn = db::open_db(path.clone()).expect("open");

    let recent = chrono::Utc::now().to_rfc3339();
    let old = (chrono::Utc::now() - chrono::Duration::days(40)).to_rfc3339();

    let mut old_rss = sample_article("old-rss");
    old_rss.published_at = Some(old.clone());
    let mut old_liked = sample_article("old-liked");
    old_liked.published_at = Some(old.clone());
    old_liked.liked = true;
    let mut old_import = sample_article("old-import");
    old_import.published_at = Some(old.clone());
    old_import.origin = "url".into();
    let mut new_rss = sample_article("new-rss");
    new_rss.published_at = Some(recent);

    for a in [&old_rss, &old_liked, &old_import, &new_rss] {
        db::insert_article_if_new(&conn, a).unwrap();
    }
    // `liked` is a signal column written via its own setter, not on insert.
    db::set_article_liked(&conn, "old-liked", true).unwrap();

    let removed = feeds::purge_expired_articles(&conn, 14).unwrap();
    assert_eq!(removed, 1, "only the old unliked RSS article goes");
    assert!(db::get_article(&conn, "old-rss").unwrap().is_none());
    assert!(db::get_article(&conn, "old-liked").unwrap().is_some());
    assert!(db::get_article(&conn, "old-import").unwrap().is_some());
    assert!(db::get_article(&conn, "new-rss").unwrap().is_some());

    // 0 = keep forever.
    assert_eq!(feeds::purge_expired_articles(&conn, 0).unwrap(), 0);

    let _ = std::fs::remove_file(path);
}

fn sample_phrase(id: &str, text: &str) -> db::PhraseItem {
    db::PhraseItem {
        id: id.into(),
        phrase: text.into(),
        meaning_zh: "测试释义".into(),
        usage: "collocation".into(),
        context_sentence: "It is on the house.".into(),
        article_id: None,
        status: "learning".into(),
        interval_days: 0.0,
        reps: 0,
        consecutive_know: 0,
        next_review_at: "2020-01-01T00:00:00Z".into(),
        created_at: "2020-01-01T00:00:00Z".into(),
    }
}

#[test]
fn phrase_library_dedup_review_and_listing() {
    let path = temp_dir().join(format!("le-phrases-{}.db", Uuid::new_v4()));
    let conn = db::open_db(path.clone()).expect("open");

    db::insert_phrase(&conn, &sample_phrase("p1", "on the house")).unwrap();
    assert!(db::get_phrase_by_text(&conn, "On The House").unwrap().is_some());

    // Case-insensitive unique index blocks a differently-cased duplicate.
    let dup = db::insert_phrase(&conn, &sample_phrase("p2", "ON THE HOUSE"));
    assert!(dup.is_err(), "duplicate phrase must be rejected");

    // Due immediately (next_review_at in the past), listed once.
    let due = db::due_phrases(&conn).unwrap();
    assert_eq!(due.len(), 1);
    assert_eq!(due[0].phrase, "on the house");

    // SRS: easy schedule pushes it out of the due list.
    let mut item = db::get_phrase(&conn, "p1").unwrap().unwrap();
    crate::srs::apply_rating_phrase(&mut item, crate::srs::Rating::Easy);
    assert_eq!(item.interval_days, 1.0);
    db::update_phrase_review(&conn, &item).unwrap();
    assert!(db::due_phrases(&conn).unwrap().is_empty());

    // Status transitions + delete.
    db::set_phrase_status(&conn, "p1", "mastered").unwrap();
    assert_eq!(db::list_phrases(&conn, Some("mastered")).unwrap().len(), 1);
    db::delete_phrase(&conn, "p1").unwrap();
    assert!(db::list_phrases(&conn, None).unwrap().is_empty());

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
    db::upsert_article(&conn, &sample_article("a1")).unwrap();
    db::upsert_article(&conn, &sample_article("a2")).unwrap();
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

fn sample_vocab(id: &str, term: &str, created_at: &str) -> db::VocabItem {
    db::VocabItem {
        id: id.into(),
        term: term.into(),
        definition_zh: String::new(),
        word_type: "noun".into(),
        collocations: vec![],
        context_sentence: String::new(),
        article_id: None,
        status: "learning".into(),
        interval_days: 0.0,
        reps: 0,
        consecutive_know: 0,
        next_review_at: created_at.into(),
        created_at: created_at.into(),
    }
}

#[test]
fn collapse_duplicate_vocab_keeps_oldest_row() {
    let path = temp_dir().join(format!("le-vocab-dup-{}.db", Uuid::new_v4()));
    let conn = rusqlite::Connection::open(&path).unwrap();
    conn.execute_batch(
        "CREATE TABLE vocab (
            id TEXT PRIMARY KEY,
            term TEXT NOT NULL,
            definition_zh TEXT NOT NULL,
            word_type TEXT NOT NULL,
            collocations_json TEXT NOT NULL DEFAULT '[]',
            context_sentence TEXT NOT NULL DEFAULT '',
            article_id TEXT,
            status TEXT NOT NULL DEFAULT 'learning',
            interval_days REAL NOT NULL DEFAULT 0,
            reps INTEGER NOT NULL DEFAULT 0,
            consecutive_know INTEGER NOT NULL DEFAULT 0,
            next_review_at TEXT NOT NULL,
            created_at TEXT NOT NULL
        )",
    )
    .unwrap();
    db::insert_vocab(&conn, &sample_vocab("old", "Hello", "2020-01-01T00:00:00Z")).unwrap();
    db::insert_vocab(&conn, &sample_vocab("new", "hello", "2021-01-01T00:00:00Z")).unwrap();
    db::collapse_duplicate_vocab_terms(&conn).unwrap();
    let rows = db::list_vocab(&conn, None).unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].id, "old");
    let _ = std::fs::remove_file(path);
}

#[test]
fn vocab_term_unique_index_rejects_case_insensitive_dup() {
    let path = temp_dir().join(format!("le-vocab-uniq-{}.db", Uuid::new_v4()));
    let conn = db::open_db(path.clone()).expect("open");
    db::insert_vocab(&conn, &sample_vocab("v1", "Focus", "2020-01-01T00:00:00Z")).unwrap();
    let err = db::insert_vocab(&conn, &sample_vocab("v2", "focus", "2020-01-02T00:00:00Z"))
        .expect_err("duplicate term");
    assert!(
        err.to_string().to_lowercase().contains("unique"),
        "expected unique violation, got {err}"
    );
    let _ = std::fs::remove_file(path);
}

#[test]
fn add_or_merge_vocab_reuses_existing_term() {
    let dir = temp_dir().join(format!("le-vocab-merge-{}", Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let state = db::DbState::open(db::db_path(dir.clone())).unwrap();
    let cfg = crate::config::AppConfig::default();
    let first = crate::vocab::add_or_merge_vocab(
        &state,
        &cfg,
        crate::vocab::AddVocabInput {
            term: "serendipity".into(),
            context_sentence: "A happy serendipity.".into(),
            article_id: None,
            definition_zh: Some("意外发现".into()),
            word_type: Some("noun".into()),
            collocations: Some(vec![]),
        },
    )
    .unwrap();
    let second = crate::vocab::add_or_merge_vocab(
        &state,
        &cfg,
        crate::vocab::AddVocabInput {
            term: "Serendipity".into(),
            context_sentence: String::new(),
            article_id: None,
            definition_zh: Some("意外发现".into()),
            word_type: Some("noun".into()),
            collocations: Some(vec!["pure serendipity".into()]),
        },
    )
    .unwrap();
    assert_eq!(first.id, second.id);
    assert!(second.collocations.contains(&"pure serendipity".to_string()));
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn apply_legacy_disabled_feeds_sets_enabled_false() {
    let path = temp_dir().join(format!("le-disabled-{}.db", Uuid::new_v4()));
    let conn = db::open_db(path.clone()).expect("open");
    let some = db::list_feeds(&conn).unwrap().into_iter().next().expect("seed");
    assert!(some.enabled);
    db::apply_legacy_disabled_feeds(&conn, &[some.id.clone()]).unwrap();
    let after = db::list_feeds(&conn)
        .unwrap()
        .into_iter()
        .find(|f| f.id == some.id)
        .unwrap();
    assert!(!after.enabled);
    let _ = std::fs::remove_file(path);
}

#[test]
fn article_foreign_keys_cascade_and_reject_orphans() {
    let path = temp_dir().join(format!("le-fk-{}.db", Uuid::new_v4()));
    let conn = db::open_db(path.clone()).expect("open");

    db::upsert_article(&conn, &sample_article("a1")).unwrap();
    db::save_translation(&conn, "a1", "paragraph", "0", "Hello", "你好", "test").unwrap();
    db::insert_vocab(
        &conn,
        &db::VocabItem {
            article_id: Some("a1".into()),
            ..sample_vocab("v1", "hello", "2020-01-01T00:00:00Z")
        },
    )
    .unwrap();

    let trans_fks: i64 = conn
        .query_row(
            "SELECT count(*) FROM pragma_foreign_key_list('translations')",
            [],
            |row| row.get(0),
        )
        .unwrap();
    let vocab_fks: i64 = conn
        .query_row(
            "SELECT count(*) FROM pragma_foreign_key_list('vocab')",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert!(trans_fks >= 1, "translations should reference articles");
    assert!(vocab_fks >= 1, "vocab should reference articles");

    let err = db::save_translation(&conn, "missing", "paragraph", "0", "x", "y", "test")
        .expect_err("orphan translation");
    assert!(
        err.to_string().to_lowercase().contains("foreign key"),
        "expected FK failure, got {err}"
    );

    conn.execute("DELETE FROM articles WHERE id='a1'", [])
        .unwrap();
    let remaining: i64 = conn
        .query_row(
            "SELECT count(*) FROM translations WHERE article_id='a1'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(remaining, 0, "translations should cascade-delete");
    let detached = db::get_vocab(&conn, "v1").unwrap().expect("vocab kept");
    assert_eq!(detached.article_id, None);

    let _ = std::fs::remove_file(path);
}

#[test]
fn article_view_loads_paragraphs_and_translations() {
    let path = temp_dir().join(format!("le-view-{}.db", Uuid::new_v4()));
    let conn = db::open_db(path.clone()).expect("open");
    db::upsert_article(&conn, &sample_article("a1")).unwrap();
    conn.execute(
        "UPDATE articles SET content_text = ?1 WHERE id = 'a1'",
        ["First para.\n\nSecond para."],
    )
    .unwrap();
    db::save_translation(&conn, "a1", "paragraph", "0", "First para.", "第一段", "test")
        .unwrap();

    let view = crate::commands::articles::load_article_view(&conn, "a1")
        .unwrap()
        .expect("present");
    assert_eq!(view.article.id, "a1");
    assert_eq!(view.paragraphs, vec!["First para.", "Second para."]);
    assert_eq!(view.translations.len(), 1);
    assert_eq!(view.translations[0].translated_text, "第一段");
    assert!(crate::commands::articles::load_article_view(&conn, "missing")
        .unwrap()
        .is_none());
    let _ = std::fs::remove_file(path);
}

#[test]
fn schema_adds_summary_zh_column() {
    let path = temp_dir().join(format!("le-summary-col-{}.db", Uuid::new_v4()));
    let conn = db::open_db(path.clone()).expect("open");
    let has: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM pragma_table_info('articles') WHERE name='summary_zh'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(has, 1, "articles.summary_zh should exist after migrate");
    let opened_col: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM pragma_table_info('articles') WHERE name='last_opened_at'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(opened_col, 1, "articles.last_opened_at should exist after migrate");
    let version: i64 = conn
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .unwrap();
    assert_eq!(version, 9);
    let phrases_table: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='phrases'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(phrases_table, 1, "phrases should exist after migrate");
    let meta_table: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='app_meta'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(meta_table, 1, "app_meta should exist after migrate");
    let tags_col: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM pragma_table_info('articles') WHERE name='tags_json'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(tags_col, 1, "articles.tags_json should exist after migrate");
    let quality_col: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM pragma_table_info('articles') WHERE name='quality'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(quality_col, 1, "articles.quality should exist after migrate");
    let ratio_col: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM pragma_table_info('feed_sources') WHERE name='fulltext_ratio'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(ratio_col, 1, "feed_sources.fulltext_ratio should exist after migrate");
    let _ = std::fs::remove_file(path);
}

#[test]
fn summary_zh_roundtrips_and_missing_query() {
    let path = temp_dir().join(format!("le-summary-zh-{}.db", Uuid::new_v4()));
    let conn = db::open_db(path.clone()).expect("open");
    let mut a = sample_article("s1");
    a.title_zh = "已有译题".into();
    a.summary_zh = String::new();
    db::insert_article_if_new(&conn, &a).unwrap();

    let missing = db::articles_missing_card_zh(&conn, 40).unwrap();
    assert_eq!(missing.len(), 1, "empty summary still needs a card fill");
    assert_eq!(missing[0].id, "s1");

    db::set_article_summary_zh(&conn, "s1", "这是一条不超过五十字的中文简介").unwrap();
    let stored = db::get_article(&conn, "s1").unwrap().expect("exists");
    assert_eq!(stored.title_zh, "已有译题");
    assert_eq!(stored.summary_zh, "这是一条不超过五十字的中文简介");
    assert!(db::articles_missing_card_zh(&conn, 40).unwrap().is_empty());

    let _ = std::fs::remove_file(path);
}

#[test]
fn mark_article_opened_is_implicit_and_repeatable() {
    let path = temp_dir().join(format!("le-opened-{}.db", Uuid::new_v4()));
    let conn = db::open_db(path.clone()).expect("open");
    db::insert_article_if_new(&conn, &sample_article("r1")).unwrap();

    let before = db::get_article(&conn, "r1").unwrap().expect("exists");
    assert!(before.last_opened_at.is_none());
    assert_eq!(before.open_count, 0);

    db::mark_article_opened(&conn, "r1").unwrap();
    let once = db::get_article(&conn, "r1").unwrap().expect("exists");
    assert!(once.last_opened_at.as_deref().unwrap().starts_with("20"));
    assert_eq!(once.open_count, 1);

    db::mark_article_opened(&conn, "r1").unwrap();
    let twice = db::get_article(&conn, "r1").unwrap().expect("exists");
    assert_eq!(twice.open_count, 2);
    assert!(twice.last_opened_at >= once.last_opened_at);

    assert!(db::mark_article_opened(&conn, "missing").is_err());
    let _ = std::fs::remove_file(path);
}

#[test]
fn learning_stats_uses_opens_and_new_vocab() {
    let path = temp_dir().join(format!("le-learn-stats-{}.db", Uuid::new_v4()));
    let conn = db::open_db(path.clone()).expect("open");

    let mut bbc = sample_article("bbc1");
    bbc.source = "BBC".into();
    bbc.category = "world".into();
    let mut npr = sample_article("npr1");
    npr.source = "NPR".into();
    npr.category = "world".into();
    db::insert_article_if_new(&conn, &bbc).unwrap();
    db::insert_article_if_new(&conn, &npr).unwrap();
    db::mark_article_opened(&conn, "bbc1").unwrap();
    db::mark_article_opened(&conn, "bbc1").unwrap();
    db::mark_article_opened(&conn, "npr1").unwrap();

    db::insert_vocab(
        &conn,
        &sample_vocab("v-new", "fresh", &chrono::Utc::now().to_rfc3339()),
    )
    .unwrap();
    db::insert_vocab(
        &conn,
        &sample_vocab("v-old", "stale", "2020-01-01T00:00:00Z"),
    )
    .unwrap();

    let stats = db::learning_stats(&conn).unwrap();
    assert_eq!(stats.opened_total, 2);
    assert_eq!(stats.opened_7d, 2);
    assert_eq!(stats.top_source.as_deref(), Some("BBC"));
    assert_eq!(stats.top_category.as_deref(), Some("world"));
    assert_eq!(stats.vocab_created_7d, 1);
    assert_eq!(stats.vocab_learning, 2);

    let empty_path = temp_dir().join(format!("le-learn-empty-{}.db", Uuid::new_v4()));
    let empty = db::open_db(empty_path.clone()).expect("open");
    let zero = db::learning_stats(&empty).unwrap();
    assert_eq!(zero.opened_total, 0);
    assert_eq!(zero.opened_7d, 0);
    assert!(zero.top_source.is_none());
    assert_eq!(zero.vocab_created_7d, 0);

    let _ = std::fs::remove_file(path);
    let _ = std::fs::remove_file(empty_path);
}
