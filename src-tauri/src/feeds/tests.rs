use super::*;
use std::collections::HashSet;

#[test]
fn blocks_link_roundups_and_transcripts() {
    assert!(is_blocked_content("Weekly Links, 09/04/2026", "body"));
    assert!(is_blocked_content("Lit Hub Daily: September 11", "body"));
    assert!(is_blocked_content("Transcript: Seth Bernstein", "body"));
    assert!(is_blocked_content("LWiAI Podcast #256", "body"));
    // Pure link dump (density, not title).
    let dump = "https://a.example/x ".repeat(60);
    assert!(is_blocked_content("Some post", &dump));
    // Timestamp-dense transcript.
    let ts = "00:01 00:02 talk ".repeat(30);
    assert!(is_blocked_content("Interview", &ts));
    // A normal essay is kept.
    let essay = "plain prose about the world ".repeat(200);
    assert!(!is_blocked_content("A normal essay", &essay));
}

#[test]
fn public_http_url_accepts_normal_targets() {
    assert!(ensure_public_http_url("https://example.com/feed.xml").is_ok());
    assert!(ensure_public_http_url("http://93.184.216.34/a").is_ok());
}

#[test]
fn public_http_url_blocks_private_and_local_targets() {
    for bad in [
        "http://localhost/x",
        "http://127.0.0.1/x",
        "http://10.0.0.5/x",
        "http://192.168.1.1/x",
        "http://172.16.0.1/x",
        "http://169.254.169.254/latest/meta-data",
        "http://[::1]/x",
        "http://[fe80::1]/x",
        "http://[::ffff:127.0.0.1]/x",
        "ftp://example.com/x",
        "file:///etc/passwd",
    ] {
        assert!(ensure_public_http_url(bad).is_err(), "should block {bad}");
    }
}

fn dummy_feed(id: &str, enabled: bool) -> crate::db::FeedSource {
    crate::db::FeedSource {
        id: id.into(),
        name: id.into(),
        category: "world".into(),
        url: format!("https://example.com/{id}"),
        enabled,
        origin: "curated".into(),
        description: String::new(),
        ..Default::default()
    }
}

#[test]
fn select_enabled_uses_db_flag_only() {
    let enabled = select_enabled_feeds(vec![
        dummy_feed("on", true),
        dummy_feed("off", false),
    ]);
    assert_eq!(enabled.len(), 1);
    assert_eq!(enabled[0].id, "on");
}

#[test]
fn trust_bar_adapts_to_feed_fulltext_ratio() {
    assert_eq!(rss_trust_chars(0.9), 1200, "full-text feeds lower the bar");
    assert_eq!(rss_trust_chars(0.7), 1200);
    assert_eq!(
        rss_trust_chars(0.1),
        3200,
        "teaser-only feeds raise the bar"
    );
    assert_eq!(rss_trust_chars(0.0), 3200);
    assert_eq!(
        rss_trust_chars(-1.0),
        TRUST_RSS_FULLTEXT_CHARS,
        "unknown ratio keeps the default"
    );
    assert_eq!(rss_trust_chars(0.5), TRUST_RSS_FULLTEXT_CHARS);
}

#[test]
fn canonical_url_strips_tracking_and_noise() {
    assert_eq!(
        canonical_article_url(
            "https://example.com/story?utm_source=rss&utm_medium=feed&id=7#more"
        ),
        "https://example.com/story?id=7"
    );
    assert_eq!(
        canonical_article_url("https://Example.com/story/?fbclid=abc"),
        "https://example.com/story"
    );
    assert_eq!(
        canonical_article_url("https://example.com/a?gclid=x&fbclid=y"),
        "https://example.com/a"
    );
    // Non-http schemes and unparseable input pass through untouched.
    assert_eq!(canonical_article_url("mailto:a@b.c"), "mailto:a@b.c");
    assert_eq!(canonical_article_url("not a url"), "not a url");
}

#[test]
fn near_duplicate_title_rules() {
    assert!(is_near_duplicate_title(
        "Fed Signals Open Door to Rate Cuts",
        "fed signals open door to rate cuts"
    ));
    assert!(is_near_duplicate_title(
        "Fed Signals Open Door to Rate Cuts in September Meeting Minutes",
        "Fed Signals Open Door to Rate Cuts in September Meeting Minutes"
    ));
    // Long headlines differing by a couple of words.
    let a = "The Federal Reserve Signaled It Could Cut Interest Rates at Its September Policy Meeting";
    let b = "The Federal Reserve Signaled It Might Cut Interest Rates at Its September Policy Meeting";
    assert!(is_near_duplicate_title(a, b));
    // Short headlines need exact matches.
    assert!(!is_near_duplicate_title(
        "Markets slide again",
        "Markets slide today"
    ));
    // Unrelated long headlines stay apart.
    assert!(!is_near_duplicate_title(
        "How remote work reshaped suburban housing markets across America",
        "A deep dive into the history of jazz piano in New Orleans"
    ));
    assert!(!is_near_duplicate_title("", "anything"));
}

#[test]
fn title_index_dedups_across_sources() {
    let mut index = TitleIndex::new(vec![]);
    index.insert("Fed Signals Open Door to Rate Cuts in September Meeting Minutes");
    assert!(index.is_dup("fed signals open door to rate cuts in september meeting minutes"));
    assert!(!index.is_dup("Earnings Season Begins With a Whimper"));
    index.insert("Earnings Season Begins With a Whimper Amid Rate Anxiety This Quarter");
    assert!(index.is_dup("Earnings Season Begins With a Whimper Amid Rate Anxiety This Quarter"));
}

#[test]
fn truncated_tails_force_page_fetch() {
    let body = "word ".repeat(500) + "Continue reading…";
    assert!(looks_truncated(&body));
    // Long readable body ending with a read-more marker is NOT trusted.
    assert!(choose_article_body(&body, None).is_none());
    // A clean page extract is still accepted.
    let full = "word ".repeat(500);
    assert!(choose_article_body(&body, Some(&full)).is_some());
    // Clean fulltext is unaffected.
    let clean = "word ".repeat(500);
    assert!(!looks_truncated(&clean));
    assert!(choose_article_body(&clean, None).is_some());
    assert!(!looks_truncated("short"));
}

#[test]
fn english_lang_tags() {
    assert!(super::filters::is_english_lang_tag("en"));
    assert!(super::filters::is_english_lang_tag("en-US"));
    assert!(super::filters::is_english_lang_tag("EN_GB"));
    assert!(!super::filters::is_english_lang_tag("zh-CN"));
    assert!(!super::filters::is_english_lang_tag("ja"));
    assert!(!super::filters::is_english_lang_tag("pt-BR"));
}

#[test]
fn rejects_chinese_content() {
    let title = "如何学习 Rust 编程语言入门指南";
    let content = "今天我们来讨论如何高效学习一门新的编程语言。首先需要理解基本概念，然后通过大量练习巩固知识。".repeat(5);
    assert!(!is_english_article(None, title, &content));
    assert!(!is_english_article(Some("zh-CN"), "Anything", &content));
}

#[test]
fn accepts_english_content() {
    let title = "How to learn Rust effectively";
    let content = "Today we discuss how to learn a new programming language effectively. First understand the fundamentals, then practice with real projects until the ideas stick.".repeat(3);
    assert!(is_english_article(None, title, &content));
    assert!(is_english_article(Some("en-US"), title, &content));
    assert!(!is_english_article(Some("fr"), title, &content));
}

#[test]
fn partition_skips_known() {
    let known = HashSet::from(["https://a".into()]);
    let (new_urls, skipped) =
        partition_new_urls(&["https://a".into(), "https://b".into()], &known);
    assert_eq!(skipped, 1);
    assert_eq!(new_urls, vec!["https://b".to_string()]);
}

#[test]
fn source_strips_www() {
    assert_eq!(
        source_from_url("https://www.theguardian.com/world/example"),
        "theguardian.com"
    );
    assert_eq!(source_from_url("not-a-url"), "导入");
}

#[test]
fn title_parses_html_title() {
    let html = "<html><head><title>  Hello World  | Site </title></head></html>";
    assert_eq!(title_from_html(html).as_deref(), Some("Hello World"));
}

#[test]
fn skips_rss_summary_when_page_fetch_fails() {
    // Mid-length teaser (≥ old 400 threshold) must not be kept if page is unavailable
    // (anti-crawl / paywall / short extract).
    let teaser = "a".repeat(500);
    assert!(teaser.chars().count() >= MIN_FULLTEXT_CHARS);
    assert!(teaser.chars().count() < TRUST_RSS_FULLTEXT_CHARS);
    assert!(choose_article_body(&teaser, None).is_none());
    assert!(choose_article_body(&teaser, Some("too short")).is_none());
}

#[test]
fn accepts_page_fulltext_over_rss_teaser() {
    let teaser = "teaser ".repeat(80); // ~560 chars
    let full = "full article body ".repeat(40); // ~720 chars
    assert!(full.chars().count() >= MIN_FULLTEXT_CHARS);
    let chosen = choose_article_body(&teaser, Some(&full)).expect("page body");
    assert_eq!(chosen, full);
}

#[test]
fn trusts_long_rss_fulltext_without_page() {
    let full_rss = "word ".repeat(500); // 2500 chars
    assert!(full_rss.chars().count() >= TRUST_RSS_FULLTEXT_CHARS);
    let chosen = choose_article_body(&full_rss, None).expect("rss full text");
    assert_eq!(chosen, full_rss);
}

#[test]
fn summary_only_body_matches_choose_without_page() {
    let teaser = "a".repeat(500);
    assert!(is_summary_only_body(&teaser));
    assert!(!is_summary_only_body(&"word ".repeat(500)));
    assert!(is_summary_only_body("short"));
}

fn chrome_nav_soup() -> String {
    let mut s = String::from("Skip to main content\n\n");
    for i in 1..40 {
        s.push_str(&format!("* [ Home topic {i} ][{i}]\n"));
    }
    s.push_str("\nA one-line dek about the story.\n");
    for i in 1..40 {
        s.push_str(&format!("[{i}]: https://example.com/{i}\n"));
    }
    s
}

fn link_dump_body() -> String {
    let mut s = String::from("#### Markets\n\n");
    for i in 1..20 {
        s.push_str(&format!("* [A market headline number {i} for readers][{i}]\n"));
    }
    s
}

fn short_real_post() -> String {
    "Culture provides scaffolding, and learning happens over time. \
The result is that we are each capable of extraordinary feats. \
People can fly planes, ski down mountains, or solve a crossword. \
Most people only exhibit this skill when there are months of exposure.\n\n\
That is the whole post."
        .repeat(2)
}

#[test]
fn rejects_page_chrome_and_keyword_teasers() {
    let chrome = chrome_nav_soup();
    assert!(chrome.chars().count() > TRUST_RSS_FULLTEXT_CHARS);
    assert!(!is_readable_article_body(&chrome));
    assert!(choose_article_body(&chrome, None).is_none());

    let teaser = format!(
        "In Chad, the Chari River has been badly affected by years of intensive sand \
extraction along its banks, particularly around the capital. The ministry banned \
the practice to protect wildlife.                            Keywords for this article"
    );
    assert!(!is_readable_article_body(&teaser));
}

#[test]
fn rejects_link_dump_even_when_long() {
    let dump = link_dump_body();
    assert!(dump.chars().count() > 400);
    assert!(!is_readable_article_body(&dump));
    assert!(choose_article_body(&dump, Some(&dump)).is_none());
}

#[test]
fn keeps_short_real_prose() {
    let post = short_real_post();
    assert!(post.chars().count() >= MIN_FULLTEXT_CHARS);
    assert!(post.chars().count() < TRUST_RSS_FULLTEXT_CHARS);
    assert!(is_readable_article_body(&post));
    assert_eq!(
        choose_article_body("teaser", Some(&post)).as_deref(),
        Some(post.as_str())
    );
}
