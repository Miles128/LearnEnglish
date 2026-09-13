# 拾言（Shiyan）

本地优先的 Mac 英语阅读 App：自动收录经典英文新闻全文，干净阅读，按需翻译，生词复习。对内品牌「拾言」，对外/包名 Shiyan，仓库暂名 LearnEnglish。

## 技术栈

- **桌面框架**: Tauri 2（仅面向 macOS）
- **前端**: React 19 + TypeScript + Vite 7 + react-router-dom 7（HashRouter）
- **后端**: Rust（rusqlite/bundled SQLite、reqwest blocking、feed-rs、readability、pdf-extract）
- **类型同步**: ts-rs 从 Rust 结构体生成 TS 绑定到 `src-tauri/bindings/`，前端经 `src/api/types.ts` re-export 使用
- **测试**: 前端 vitest；后端 cargo test

## 目录结构

```
src/                  React 前端
  main.tsx            入口：Provider + HashRouter 路由表
  App.tsx             布局壳：侧边栏 + 全局刷新进度条 + 测评强跳
  store.tsx           AppConfig / Vocab(学习中生词) 两个 Context
  api/                Tauri invoke 封装层（config/feeds/articles/vocab + 类型门面）
  pages/              Home(今日阅读) Reader(阅读) Vocab(生词复习) Settings Placement(词汇测评) ManageFeedsDrawer
  components/         SelectionPopover(划词浮窗) ImportRow SourceBoard
  annotateText.tsx    按CEFR/词频给难词加下划线
  wordLevels.ts       懒加载内置 CEFR+词频词典(word-levels.json)
  knownPercent.ts     「约认识 N%」估算
  tts.ts/useTts.ts    Web Speech 朗读
src-tauri/src/        Rust 后端
  lib.rs              应用入口：打开 SQLite(app_data_dir) 注入 DbState(Mutex<Connection>)，注册全部 command
  commands/           Tauri command 薄层：阻塞工作 spawn_blocking，进度走 event("refresh-progress"/"translate-progress")
  db/                 仓储层：mod(schema+migration) articles feeds curated_feeds(内置订阅源种子) translations vocab
  feeds.rs            RSS 刷新管线：抓取→正文启发式→英文过滤→入库；标题翻译批量补齐
  vocab.rs            OpenAI 兼容 LLM 客户端：段落/标题批量翻译、生词 enrichment、RSS 发现
  srs.rs              简化间隔重复：again/hard/easy，连续 easy≥3 且 14d 即 mastered
  import_file.rs      txt/pdf/docx 本地导入
  config.rs           config.local.json 读写(API key 等)，0600 权限
```

## 数据流与关键约定

- 前端一律经 `api/*` invoke 后端 command；后端分层 commands → (feeds/vocab/import_file 业务) → db 仓储，db 不做网络。
- 全局单连接 SQLite，`DbState(Mutex<Connection>)`；命令内 lock 后尽快释放，网络调用不持锁。
- 文章幂等去重按 `url UNIQUE`，`insert_article_if_new` 冲突即跳过；RSS 旧文只在 RSS 正文可信且更长时升级。
- 正文阈值：RSS 正文 ≥2000 字符且像可读文章才信任；否则须抓文章页。导航/关键词墙、链接列表、不足 400 字散文（MIN_FULLTEXT_CHARS）一律不入库，刷新时清掉。
- `origin` 字段区分 rss/url/file 导入；refresh 的清理(purge)只处理 rss 来源，永不删用户导入。
- LLM 配置在 `config.local.json`（gitignore）；无 Key 时翻译功能优雅降级。

开发时少编 Rust：只改 `src/`（排版、划词、样式）用 `pnpm dev`，浏览器看 Vite；`invoke` 不可用，不要在这里测刷新/翻译/入库。改 `src-tauri` 或要真实数据时才 `pnpm dev:desktop`（或 `pnpm tauri dev`）。桌面会话结束执行 `pnpm clean:rust`。

Verify before claiming done:

```bash
pnpm test
pnpm build
cd src-tauri && cargo test
```

Desktop smoke (macOS + Rust):

```bash
pnpm dev:desktop
```

开发缓存：`src-tauri/target` 是 Cargo 产物（不入库）。`profile.dev` 只保留本 crate 行号表、依赖不带 debug，避免 `target/debug` 涨到数 GB。不开发时 `pnpm clean:rust`。若启用 Time Machine，排除 `src-tauri/target`（`cargo clean` 会删掉该目录上的排除标记，下次生成后再 `tmutil addexclusion src-tauri/target`）。

Follow [documents/PRD.md](documents/PRD.md) scope and non-goals.
