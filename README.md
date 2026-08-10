# LearnEnglish

Mac 桌面英语阅读学习 App（Tauri 2 + React + TypeScript）。

## 功能

- 精选免费全文 RSS（科技 / 财经 / 国际 / 其他）
- 刷新拉取、本地缓存全文
- 按需 LLM 翻译（全文 / 段落悬停 / 划词），默认不显示译文
- 生词库：词性/类型、常见搭配、简化间隔复习、已掌握归档

## 开发

```bash
cp config.local.json.example config.local.json
# 编辑 base_url / api_key / model

pnpm install
pnpm tauri dev
```

验证：

```bash
pnpm test          # tsc --noEmit
pnpm build
pnpm tauri build   # 可选：打 Mac 包
```

## 配置

密钥写在项目根目录 `config.local.json`（已 gitignore）。参见 `config.local.json.example`。

## 文档

- [PRD](documents/PRD.md)
- [Design Spec](docs/superpowers/specs/2026-08-10-learnenglish-mac-mvp-design.md)
