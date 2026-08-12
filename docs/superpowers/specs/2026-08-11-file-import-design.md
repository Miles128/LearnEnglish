# 本地文件导入（TXT / PDF / DOCX）设计

日期：2026-08-11

## 目标

用户可从首页导入本地英文文档，作为普通文章进入阅读闭环（点词翻译、生词、认识度等）。

## 范围（MVP）

- 格式：`.txt`、`.pdf`（仅文本层）、`.docx`（不支持旧 `.doc`）
- 入口：首页「粘贴链接」旁「导入文件」按钮；一次一个文件；成功后跳转阅读页
- 不做：OCR、批量多选、归档子系统

## 架构

Rust 后端统一解析（与 `import_article_url` 对称）：

1. 前端 Tauri 文件对话框选文件
2. `import_article_file(path)` 读盘、按扩展名抽纯文本
3. 写入 `articles`，返回 `Article`

## 数据约定

| 字段 | 取值 |
|------|------|
| `url` | `file://import/<uuid>` |
| `title` | 文件名（去扩展名） |
| `source` | `导入` |
| `category` | `other` |
| `content_text` | 抽取纯文本 |

校验：≤20MB；正文 ≥ 现有 `MIN_FULLTEXT_CHARS`（400）；英文检测同 URL 导入。

## 解析

- **txt**：UTF-8，失败则 lossy
- **pdf**：文本抽取；无字 → 报错（扫描件）
- **docx**：`word/document.xml` 段落文本

## UI

- 首页：导入按钮；取消对话框静默
- 阅读页：`file://` URL 显示「本地导入」，不外链

## 非目标

OCR、`.doc`、云盘、自动分类、多文件批量
