# Vocab Placement Test (自适应词汇量测验)

## Goal

给用户一次约 **50 题** 的英文词义选择题（ABCD），用**连续难度自适应**估出大约认识多少词，并**自动写入**设置的 `freq_band` / `cefr_level`。同时让列表「约认识 N%」基于该词频档估算，而不是空生词库导致的假 100%。

## Non-goals

- IRT 题库标定 / 云端能力分
- 错题自动进生词库
- 多语言界面
- 改变阅读页下划线规则以外的难度逻辑（下划线仍用设置里的 CEFR + freq_band）

## Entry

| 时机 | 行为 |
|------|------|
| 首次打开且尚未完成测验 | 引导页 → 进入测验（可「稍后」跳过；跳过仍算未测，下次可再引导） |
| 设置页 | 「测一下词汇量」→ 重测；完成后覆盖写入设置 |

持久化标志（本地）：`vocab_placement_done`（或等价字段，见 Persistence）。未完成则显示引导。

## Item format

- 题干：英文单词（单词语）
- 选项：4 个中文释义（1 正确 + 3 干扰），随机打乱为 A/B/C/D
- 进度：`当前题 / 50`
- 词池：`word-levels.json` 中带非空 `zh`、无空格的词；排除极短/纯功能词黑名单（如 `a`, `the`, `of`, `to`, `and`, `or`, `in`, `on`, `at`, `is`, `are`, `be`, `i`, `you`, `he`, `she`, `it`, `we`, `they`）
- 干扰项：从**相近 frequency rank** 的其它词释义中抽样；与正解规范化后不同；同题内干扰互不相同
- 同一测验 session 内词不重复

## Adaptive algorithm (continuous L)

维护连续能力值 \(L\)：估计「大约认识的词频阈值」（越大越难）。

| 参数 | 值 |
|------|-----|
| 初始 \(L_0\) | `3000` |
| 夹逼 | `[400, 25000]` |
| 总题数 | `50`（固定停；不做中途早停） |
| 词难度 \(d\) | 该词 `rank`（FrequencyWords） |

### 选题

每题在未考词中选 \(d\) 接近 \(L\) 的词：

1. 目标难度 \(t = L \cdot U(0.85, 1.15)\)（抖动）
2. 在词池中取 \(|\log d - \log t|\) 最小的若干候选，再随机抽 1 个
3. 若该邻域词不足，放宽到全池按距离取

### 作答更新

题号 \(n = 1..50\)，衰减步长：

\[
\alpha_n = 0.18 \cdot (1 - \frac{n-1}{50}), \quad
\beta_n = 0.22 \cdot (1 - \frac{n-1}{50})
\]

（错题步长略大于对题，避免高估。）

- **对**：\(L \leftarrow \mathrm{clamp}(L \cdot (1+\alpha_n) \cdot 0.7 + d \cdot 1.15 \cdot 0.3)\)
- **错**：\(L \leftarrow \mathrm{clamp}(L \cdot (1-\beta_n) \cdot 0.7 + d \cdot 0.75 \cdot 0.3)\)

含义：乘性升降为主，并略向本题 \(d\) 拉一把（对则往更难侧、错则往更易侧）。

实现时用同一公式写死常量；单元测试覆盖：连续全对 \(L\) 上升、全错 \(L\) 下降、结果落在夹逼内。

### 结果映射 → 设置

测完取最终 \(L\)，就近映射到现有档：

| \(L\) 区间（含上界按中点分割） | `freq_band` | `cefr_level` |
|--------------------------------|-------------|--------------|
| → 中点分界：`√(1k·3k)`, `√(3k·5k)`, `√(5k·10k)`, `√(10k·20k)` | | |
| 低于 1k–3k 几何中点 | `1000` | `A2` |
| 否则低于 3k–5k 中点 | `3000` | `B1` |
| 否则低于 5k–10k 中点 | `5000` | `B2` |
| 否则低于 10k–20k 中点 | `10000` | `C1` |
| 否则 | `20000` | `C2` |

几何中点：\(\sqrt{a\cdot b}\)。例如 \(\sqrt{3000\cdot5000}\approx3873\)。

写入后立即 `save_config`（与设置页同一路径），并标记测验完成。

结果页展示：大约认识约 **N** 词（显示最终 \(L\) 四舍五入）、已设为 **Xk / CEFR**，按钮回今日阅读或设置。

## 「约认识 %」变更

旧逻辑：不在生词库 = 认识 → 库空则 ~100%。

新逻辑（主）：

1. 用设置 `freq_band`：正文 token 经词表 lookup：
   - 有条目且 `rank <= freq_band` → 认识
   - 有条目且 `rank > freq_band` → 不认识
   - 查不到（专名等 OOV）→ 认识（避免假难）
2. 学习中生词仍计为「暂不认识」（与阅读高亮一致），即使 rank 低于档位。
3. token &lt; 40 → 仍返回 `null`（不显示）。

公式不变：`round(100 * known / tokens)`。

## Persistence

在现有 `config.local.json`（经后端 `AppConfig`）增加可选字段，例如：

```json
{
  "vocab_placement_done": true,
  "vocab_placement_L": 4120,
  "vocab_placement_at": "2026-08-11T00:00:00Z"
}
```

- `vocab_placement_done`：控制是否首次引导
- `L` / `at`：可选，供设置页展示「上次测验」
- 缺省：`done=false`；`freq_band`/`cefr_level` 保持现有默认 B1 / 3k

## UI / IA

1. **引导页**（路由如 `/placement`）：一句话说明 → 开始 / 稍后
2. **测验页**：词 + 四选项 + 进度；点选项立即下一题（无「下一题」按钮）；不可回退改答案
3. **结果页**：L、映射档位、回首页
4. **设置**：显示当前档；按钮「重新测验」

视觉：跟随现有 App 样式（无新设计系统）。

## Architecture

| 层 | 职责 |
|----|------|
| `src/placement/`（或同等） | 纯函数：选题、更新 L、映射档位、组 ABCD；可单测 |
| `src/pages/Placement.tsx` | UI + session state |
| `src/wordLevels.ts` | 词池过滤 / lookup（复用已有 lexicon） |
| `src/knownPercent.ts` | 改为 freq_band + learning 联合估算 |
| `src-tauri` config | 扩展 `AppConfig` 字段读写 |
| `App.tsx` 路由 | `/placement`；启动时若未测完可 `Navigate` 到引导（尊重「稍后」当次 session 跳过） |

「稍后」：仅当前进程 session 内不再打断；下次冷启动仍可引导，直到 `vocab_placement_done=true`。

## Testing

- 单元：`updateL` 升降与 clamp；`mapLToBand` 边界；干扰项不与正解相同；约认识 % 在给定 band / learning 下可预期
- `pnpm test` + 既有 `cargo test` 仍过
- 手动：引导 → 50 题 → 设置已变 → 列表认识度不再恒为 100%

## Acceptance

- [ ] 未测用户可被引导完成约 50 题 ABCD
- [ ] 对升难度、错降难度（连续 L，非分档闯关）
- [ ] 测完自动写入 `freq_band` + `cefr_level`
- [ ] 设置可重测并覆盖
- [ ] 「约认识 %」基于词频档（+ 学习中生词扣减）
- [ ] `pnpm test` / `pnpm build` / `cargo test` 通过
