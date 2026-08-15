use super::{curated_feeds, FeedCategory, FeedSource};
use rusqlite::{params, Connection, OptionalExtension};
use uuid::Uuid;

pub(crate) fn seed_feed_categories(conn: &Connection) -> Result<(), String> {
    let builtins = [
        ("tech", "科技"),
        ("finance", "财经"),
        ("world", "国际"),
        ("other", "其他"),
    ];
    for (id, label) in builtins {
        conn.execute(
            "INSERT OR IGNORE INTO feed_categories (id, label, builtin) VALUES (?1,?2,1)",
            params![id, label],
        )
        .map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE feed_categories SET label=?1, builtin=1 WHERE id=?2",
            params![label, id],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub(crate) fn seed_feeds(conn: &Connection) -> Result<(), String> {
    let seeds = curated_feeds();
    // Insert newly curated feeds; IGNORE keeps existing enable/disable.
    for f in &seeds {
        conn.execute(
            "INSERT OR IGNORE INTO feed_sources (id, name, category, url, enabled, origin, description) VALUES (?1,?2,?3,?4,1,'curated','')",
            params![f.id, f.name, f.category, f.url],
        )
        .map_err(|e| e.to_string())?;
        // Keep name/category/url/origin in sync if we retarget a curated id.
        conn.execute(
            "UPDATE feed_sources SET name=?1, category=?2, url=?3, origin='curated' WHERE id=?4",
            params![f.name, f.category, f.url, f.id],
        )
        .map_err(|e| e.to_string())?;
    }
    // Drop obsolete curated sources only — never delete user subscriptions.
    let keep: std::collections::HashSet<&str> = seeds.iter().map(|f| f.id.as_str()).collect();
    for existing in list_feeds(conn)? {
        if existing.origin != "user" && !keep.contains(existing.id.as_str()) {
            conn.execute("DELETE FROM feed_sources WHERE id=?1", params![existing.id])
                .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

pub fn list_feeds(conn: &Connection) -> Result<Vec<FeedSource>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id,name,category,url,enabled,origin,description FROM feed_sources ORDER BY category,name",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], map_feed)
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

pub fn set_feed_enabled(conn: &Connection, id: &str, enabled: bool) -> Result<(), String> {
    conn.execute(
        "UPDATE feed_sources SET enabled=?1 WHERE id=?2",
        params![if enabled { 1 } else { 0 }, id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn list_feed_categories(conn: &Connection) -> Result<Vec<FeedCategory>, String> {
    let mut stmt = conn
        .prepare("SELECT id,label,builtin FROM feed_categories ORDER BY builtin DESC, label")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], map_category)
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

/// Add a user category. `id` is slugified from label if empty.
pub fn add_feed_category(conn: &Connection, label: &str) -> Result<FeedCategory, String> {
    let label = label.trim();
    if label.is_empty() {
        return Err("分类名不能为空".into());
    }
    let id = slugify_id(label);
    if id.is_empty() {
        return Err("无法生成分类 id".into());
    }
    conn.execute(
        "INSERT INTO feed_categories (id, label, builtin) VALUES (?1,?2,0)",
        params![id, label],
    )
    .map_err(|e| {
        if e.to_string().contains("UNIQUE") {
            "分类已存在".into()
        } else {
            e.to_string()
        }
    })?;
    Ok(FeedCategory {
        id,
        label: label.into(),
        builtin: false,
    })
}

pub fn get_feed_category(conn: &Connection, id: &str) -> Result<Option<FeedCategory>, String> {
    conn.query_row(
        "SELECT id,label,builtin FROM feed_categories WHERE id=?1",
        params![id],
        map_category,
    )
    .optional()
    .map_err(|e| e.to_string())
}

/// Subscribe or re-enable a user feed. If URL exists, enable and refresh metadata.
pub fn subscribe_feed(
    conn: &Connection,
    name: &str,
    category: &str,
    url: &str,
    description: &str,
) -> Result<FeedSource, String> {
    let name = name.trim();
    let url = url.trim();
    let category = category.trim();
    if name.is_empty() || url.is_empty() || category.is_empty() {
        return Err("名称、分类与 URL 不能为空".into());
    }
    if get_feed_category(conn, category)?.is_none() {
        return Err(format!("未知分类：{category}"));
    }

    // Existing by URL?
    if let Some(existing) = find_feed_by_url(conn, url)? {
        conn.execute(
            "UPDATE feed_sources SET name=?1, category=?2, description=?3, enabled=1 WHERE id=?4",
            params![name, category, description, existing.id],
        )
        .map_err(|e| e.to_string())?;
        return Ok(FeedSource {
            id: existing.id,
            name: name.into(),
            category: category.into(),
            url: url.into(),
            enabled: true,
            origin: existing.origin,
            description: description.into(),
        });
    }

    let id = format!("user-{}", slugify_id(name));
    let id = if feed_id_exists(conn, &id)? {
        format!("user-{}", Uuid::new_v4())
    } else {
        id
    };

    conn.execute(
        "INSERT INTO feed_sources (id, name, category, url, enabled, origin, description) VALUES (?1,?2,?3,?4,1,'user',?5)",
        params![id, name, category, url, description],
    )
    .map_err(|e| e.to_string())?;

    Ok(FeedSource {
        id,
        name: name.into(),
        category: category.into(),
        url: url.into(),
        enabled: true,
        origin: "user".into(),
        description: description.into(),
    })
}

fn find_feed_by_url(conn: &Connection, url: &str) -> Result<Option<FeedSource>, String> {
    conn.query_row(
        "SELECT id,name,category,url,enabled,origin,description FROM feed_sources WHERE url=?1",
        params![url],
        map_feed,
    )
    .optional()
    .map_err(|e| e.to_string())
}

fn feed_id_exists(conn: &Connection, id: &str) -> Result<bool, String> {
    let n: i64 = conn
        .query_row(
            "SELECT COUNT(1) FROM feed_sources WHERE id=?1",
            params![id],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    Ok(n > 0)
}

fn map_feed(row: &rusqlite::Row<'_>) -> rusqlite::Result<FeedSource> {
    Ok(FeedSource {
        id: row.get(0)?,
        name: row.get(1)?,
        category: row.get(2)?,
        url: row.get(3)?,
        enabled: row.get::<_, i64>(4)? == 1,
        origin: row.get(5)?,
        description: row.get(6)?,
    })
}

fn map_category(row: &rusqlite::Row<'_>) -> rusqlite::Result<FeedCategory> {
    Ok(FeedCategory {
        id: row.get(0)?,
        label: row.get(1)?,
        builtin: row.get::<_, i64>(2)? == 1,
    })
}

pub fn slugify_id(raw: &str) -> String {
    let mut out = String::new();
    for ch in raw.chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch.to_ascii_lowercase());
        } else if ch == '-' || ch == '_' || ch.is_whitespace() {
            if !out.ends_with('-') && !out.is_empty() {
                out.push('-');
            }
        } else {
            // keep CJK / other letters as hex codepoints for stable ids
            out.push_str(&format!("u{:x}", ch as u32));
        }
    }
    out.trim_matches('-').chars().take(48).collect()
}