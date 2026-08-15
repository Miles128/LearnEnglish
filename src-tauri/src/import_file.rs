//! Import local `.txt` / `.pdf` / `.docx` files as articles.

use crate::db::{self, Article};
use crate::feeds::{self, MIN_FULLTEXT_CHARS};
use chrono::Utc;
use regex::Regex;
use rusqlite::Connection;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use uuid::Uuid;

const MAX_FILE_BYTES: u64 = 20 * 1024 * 1024;

pub fn import_article_from_file(db: &Mutex<Connection>, path: &str) -> Result<Article, String> {
    let path = PathBuf::from(path.trim());
    if path.as_os_str().is_empty() {
        return Err("未选择文件".into());
    }
    if !path.is_file() {
        return Err("文件不存在".into());
    }

    let meta = std::fs::metadata(&path).map_err(|e| format!("无法读取文件：{e}"))?;
    if meta.len() > MAX_FILE_BYTES {
        return Err("文件过大（上限 20MB）".into());
    }

    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();

    let bytes = std::fs::read(&path).map_err(|e| format!("无法读取文件：{e}"))?;
    let content_text = match ext.as_str() {
        "txt" => extract_txt(&bytes)?,
        "pdf" => extract_pdf(&bytes)?,
        "docx" => extract_docx(&bytes)?,
        "doc" => return Err("暂不支持旧版 .doc，请另存为 .docx".into()),
        _ => return Err("暂不支持该格式（仅 .txt / .pdf / .docx）".into()),
    };

    let content_text = normalize_whitespace(&content_text);
    if content_text.chars().count() < MIN_FULLTEXT_CHARS {
        return Err("内容太短，无法作为阅读文章".into());
    }

    let title = title_from_path(&path);
    if !feeds::is_english_article(None, &title, &content_text) {
        return Err("看起来不是英文文章".into());
    }

    let id = Uuid::new_v4().to_string();
    let article = Article {
        id: id.clone(),
        url: format!("file://import/{id}"),
        title,
        title_zh: String::new(),
        source: "导入".into(),
        category: "other".into(),
        published_at: None,
        content_text,
        fetched_at: Utc::now().to_rfc3339(),
        origin: "file".into(),
    };

    let conn = db.lock().map_err(|e| e.to_string())?;
    let inserted = db::insert_article_if_new(&conn, &article)?;
    if inserted {
        return Ok(article);
    }
    Err("导入失败：文章未写入".into())
}

fn title_from_path(path: &Path) -> String {
    path.file_stem()
        .and_then(|s| s.to_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("未命名文档")
        .to_string()
}

fn normalize_whitespace(text: &str) -> String {
    let collapsed: String = text
        .lines()
        .map(|l| l.trim_end())
        .collect::<Vec<_>>()
        .join("\n");
    let re = Regex::new(r"\n{3,}").unwrap();
    re.replace_all(collapsed.trim(), "\n\n").into_owned()
}

fn extract_txt(bytes: &[u8]) -> Result<String, String> {
    match std::str::from_utf8(bytes) {
        Ok(s) => Ok(s.to_string()),
        Err(_) => Ok(String::from_utf8_lossy(bytes).into_owned()),
    }
}

fn extract_pdf(bytes: &[u8]) -> Result<String, String> {
    let text = pdf_extract::extract_text_from_mem(bytes)
        .map_err(|e| format!("PDF 解析失败：{e}"))?;
    let trimmed = text.trim().to_string();
    if trimmed.chars().filter(|c| c.is_alphanumeric()).count() < 40 {
        return Err("未能从 PDF 提取文字（可能是扫描件，暂不支持 OCR）".into());
    }
    Ok(trimmed)
}

fn extract_docx(bytes: &[u8]) -> Result<String, String> {
    let cursor = std::io::Cursor::new(bytes);
    let mut archive =
        zip::ZipArchive::new(cursor).map_err(|_| "不是有效的 .docx 文件".to_string())?;
    let mut file = archive
        .by_name("word/document.xml")
        .map_err(|_| "docx 缺少正文（word/document.xml）".to_string())?;
    let mut xml = String::new();
    file.read_to_string(&mut xml)
        .map_err(|e| format!("读取 docx 失败：{e}"))?;
    Ok(docx_xml_to_text(&xml))
}

/// Pull paragraph text from WordprocessingML (`<w:p>` / `<w:t>`).
fn docx_xml_to_text(xml: &str) -> String {
    let mut out = String::new();
    let mut para = String::new();
    let mut in_t = false;
    let mut tag = String::new();
    let mut chars = xml.chars().peekable();

    while let Some(ch) = chars.next() {
        if ch == '<' {
            tag.clear();
            while let Some(c) = chars.next() {
                if c == '>' {
                    break;
                }
                tag.push(c);
            }
            let name = tag.split_whitespace().next().unwrap_or("");
            if name == "w:t" || name.starts_with("w:t ") {
                in_t = true;
            } else if name == "/w:t" {
                in_t = false;
            } else if name == "/w:p" {
                let line = para.trim();
                if !line.is_empty() {
                    if !out.is_empty() {
                        out.push_str("\n\n");
                    }
                    out.push_str(line);
                }
                para.clear();
            } else if name == "w:tab" || name.starts_with("w:tab ") {
                para.push('\t');
            } else if name == "w:br" || name.starts_with("w:br ") {
                para.push('\n');
            }
        } else if in_t {
            if ch == '&' {
                let mut ent = String::new();
                while let Some(&c) = chars.peek() {
                    chars.next();
                    if c == ';' {
                        break;
                    }
                    ent.push(c);
                    if ent.len() > 10 {
                        break;
                    }
                }
                para.push_str(decode_xml_entity(&ent));
            } else {
                para.push(ch);
            }
        }
    }

    if !para.trim().is_empty() {
        if !out.is_empty() {
            out.push_str("\n\n");
        }
        out.push_str(para.trim());
    }
    out
}

fn decode_xml_entity(ent: &str) -> &str {
    match ent {
        "amp" => "&",
        "lt" => "<",
        "gt" => ">",
        "quot" => "\"",
        "apos" => "'",
        _ => " ",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;
    use std::io::Write;

    #[test]
    fn extract_txt_utf8() {
        let s = extract_txt(b"Hello world from a text file.\n").unwrap();
        assert!(s.contains("Hello world"));
    }

    #[test]
    fn docx_xml_paragraphs() {
        let xml = r#"<?xml version="1.0"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:r><w:t>First paragraph.</w:t></w:r></w:p>
    <w:p><w:r><w:t>Second &amp; last.</w:t></w:r></w:p>
  </w:body>
</w:document>"#;
        let text = docx_xml_to_text(xml);
        assert_eq!(text, "First paragraph.\n\nSecond & last.");
    }

    #[test]
    fn import_txt_file_ok() {
        let dir = std::env::temp_dir().join(format!("shiyan-import-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("sample essay.txt");
        let body = "The quick brown fox jumps over the lazy dog. ".repeat(20);
        let mut f = std::fs::File::create(&path).unwrap();
        f.write_all(body.as_bytes()).unwrap();

        let db_path = dir.join("t.sqlite");
        let conn = db::open_db(db_path).unwrap();
        let db = Mutex::new(conn);

        let article = import_article_from_file(&db, path.to_str().unwrap()).unwrap();
        assert_eq!(article.title, "sample essay");
        assert_eq!(article.source, "导入");
        assert_eq!(article.category, "other");
        assert!(article.url.starts_with("file://import/"));
        assert!(article.content_text.chars().count() >= MIN_FULLTEXT_CHARS);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn reject_short_txt() {
        let dir = std::env::temp_dir().join(format!("shiyan-import-short-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("tiny.txt");
        std::fs::write(&path, b"hi").unwrap();
        let db_path = dir.join("t.sqlite");
        let conn = db::open_db(db_path).unwrap();
        let db = Mutex::new(conn);
        let err = import_article_from_file(&db, path.to_str().unwrap()).unwrap_err();
        assert!(err.contains("太短"), "{err}");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
