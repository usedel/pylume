# ADR（Architecture Decision Records）

所有重大技术决策记录于此。编号规则：`NNN-kebab-title.md`，按时间顺序递增。

## 已记录决策

| 编号 | 标题 | 状态 | 日期 |
|---|---|---|---|
| [0003](0003-lsp-bridge-custom.md) | LSP 接入采用自研轻量桥接层（Rust stdio ↔ Tauri IPC ↔ Monaco providers） | 已定案 | 2026-08-20 |
| [0004](0004-dap-bridge-debugpy-bundled.md) | 调试接入采用自研轻量 DAP 桥 + debugpy 随应用打包分发（stdio adapter 模式） | 已定案 | 2026-09-10 |
| [0005](0005-brand-accent-unification.md) | 品牌色与交互色统一到青绿单色相轴（修订 D4 / UI-06 / 浅色层 accent 跨主题一致；accent 拆三角色） | 已定案 | 2026-10-03 |
| [0006](0006-dual-static-engine-switchable.md) | 双静态引擎并存（Pyrefly 默认 / basedpyright 备选）+ 首日引擎无关抽象层 | 已定案（补记） | 2026-08-20 |
| [0007](0007-intel-as-independent-lsp.md) | 运行时智能作为独立 LSP（pylume-intel）+ 独立 probe 包，不修改 Pyrefly 内核 | 已定案（补记） | 2026-08-20 |
| [0008](0008-pep669-sys-monitoring-sampling.md) | 运行时采样技术选型：PEP 669 `sys.monitoring`（三段式事件策略，开销红线 1.5x） | 已定案（补记） | 2026-08-21 |
| [0009](0009-lsp-result-merge-sorttext.md) | LSP 结果合并策略：固定 sortText 段位（0NN/0y/0z/1xx/2xx/3xx）+ `⟳ runtime` 来源标注 + 运行时优先 | 已定案（补记） | 2026-08-20 |

> 0006~0009 为 2026-10-03 追溯补记：决策本身自 2026-08-20~21 起生效并已落地实施，此前只在 `README.md`「待记录（候选）」里挂着。补记目的是让「重大决策写 ADR」这条铁律从今天起无欠账。

## 待记录（候选）

- （暂无——新增候选前先确认不与 0003~0009 重复；若属"尚在演进中的方向"，可先记为 v0.1 提议稿）

## 模板

```markdown
# ADR-NNN: <决策标题>

- 状态：提议 / 已定案 / 已废弃 / 被取代（指向新 ADR）
- 日期：YYYY-MM-DD
- 决策者：<角色>

## 背景

<为什么需要做这个决策>

## 决策

<选择了什么，一句话结论>

## 备选方案

<考虑过哪些方案，为何否决>

## 后果

<正反面影响与后续约束>
```