# 拾言（Shiyan）

本地优先的 Mac 英语阅读 App：自动收录经典英文新闻全文，干净阅读，按需翻译，生词复习。

> 对内品牌：**拾言** · 对外/包名：**Shiyan** · 仓库暂名：`LearnEnglish`

## 为什么做

LingQ 等产品能力全但收费烦、界面重。拾言只做一件事：把**免费可读的经典新闻**自动抓到本地，用最少干扰学词。

## 功能

- 经典新闻源自动刷新（RSS 发现；摘要不够则抓公开文章页）
- 粘贴公开文章链接导入全文
- 按来源分板块；标题可带中文译名
- 按需翻译（全文 / 段落悬停 / 划词），默认不显示
- 生词库：词性、搭配、出处句、简化间隔复习
- 阅读页高亮「学习中」生词（可点击查看）
- 列表/阅读显示「约认识 N%」

## 不做（当前）

YouTube / 播客、账号同步、付费墙破解、全网狂爬。详见 [PRD](documents/PRD.md)。

## 快速开始

```bash
cp config.local.json.example config.local.json
# 填写 base_url / api_key / model

pnpm install
pnpm tauri dev
```

请使用弹出的**桌面窗口**，不要用浏览器打开 `localhost:1420`（否则没有 Tauri `invoke`）。

## 验证

```bash
pnpm test          # tsc --noEmit
pnpm build
cd src-tauri && cargo test
pnpm tauri build   # 可选：打 .app
```

## 配置

密钥写在项目根目录 `config.local.json`（已 gitignore）。模板：`config.local.json.example`。

## 技术栈

Tauri 2 · React · TypeScript · Vite · SQLite · OpenAI 兼容 Chat Completions

## 文档

- [PRD](documents/PRD.md)
- [Design Spec](docs/superpowers/specs/2026-08-10-learnenglish-mac-mvp-design.md)

## License

Private use / 以仓库 GitHub 设置为准（当前为 Public）。
