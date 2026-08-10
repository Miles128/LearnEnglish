# RSS 订阅管理（首页抽屉）设计

**日期：** 2026-08-11  
**状态：** Approved for implementation（用户确认方案 2，并要求直接落地）

## Goal

在「今日阅读」主界面用抽屉管理 RSS：查看/开关订阅、按分类用 LLM 发现候选源、自建分类、粘贴 URL 订阅。退订 = 关闭（可再开）。

## Non-goals

- 真实网页搜索引擎 API
- 硬删除订阅源
- 云同步 / 账号
- 付费墙破解

## UX

1. 顶栏「管理订阅」→ 右侧抽屉
2. 分类条：内置（科技/财经/国际/其他）+ 用户自建 +「+ 分类」
3. 「我的订阅」：开关启用/关闭；标记精选 / 自订
4. 「按分类发现」：当前分类 → LLM 推荐 → 本地校验 → 订阅
5. 可选粘贴 RSS URL 订阅
6. 设置页移除 RSS 勾选列表，引导到本抽屉

## Data

- `feed_sources`：+`origin` (`curated`|`user`)，+`description`
- `feed_categories`：`id`, `label`, `builtin`
- seed：只 upsert curated；**永不删除** `origin=user`；仅删除过时 curated

## Commands

- `list_feeds` / `set_feed_enabled`（扩展字段）
- `list_feed_categories` / `add_feed_category`
- `discover_feeds(category_id)` — LLM 候选
- `validate_feed(url)` — 试拉解析
- `subscribe_feed({name, category, url, description?})` — 写入 user 源

## Discovery flow

1. 确保 LLM 已配置
2. Prompt：该分类下免费全文英文新闻 RSS（JSON 数组 name/url/description）
3. 对每个 URL `validate_feed`；前端展示 ok / fail
4. 用户点订阅 → `subscribe_feed`（URL 已存在则启用并更新元数据）

## Errors

- 未配置 API Key → 明确提示去设置
- 校验失败 → 行内错误，不入库
- 重复 URL → 视为已订阅并启用
