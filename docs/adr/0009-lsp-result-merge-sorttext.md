# ADR-0009: LSP 结果合并策略（固定 sortText 段位 + 来源标注 + 运行时优先）

- 状态：**已定案**（决策自 2026-08-20 生效，段位其后逐步补全；2026-10-03 追溯补记）
- 日期：2026-08-20（补记 2026-10-03）
- 决策者：产品负责人裁决
- 上游：`docs/python_ide_tech_plan_v3.md` v3.0 · `.codebuddy/rules/typescript-code-style/RULE.mdc`（补全段位铁律）
- 落地：`shell/src/lsp/client.ts`（`registerLspCompletion` 合并与降级）· `intel/crates/pylume-intel/src/completion.rs` · `shell/src/live-templates/` · `shell/src/autoImport.ts` · `shell/src/importAlias.ts` · `shell/src/completion/keywordCompletion.ts`

## 背景

补全弹窗里有多个来源同时供词：智能模板 / postfix、autoImport、import 别名、运行时 intel、静态引擎、关键字。它们的**排序**是用户体感的核心——排序错了，"最该出现的那个"被压在下面，功能等于不存在。

Monaco 走 `sortText` 的 `localeCompare`，因此段位必须是**固定前缀 + 定长数字**，不能按来源动态算权重。

## 决策

1. **六段固定段位（顺序即优先级，单一真源）**：

   | 段位 | 来源 | 备注 |
   |---|---|---|
   | `0NN` | 智能 live template / postfix | 壳层自己的最高优先 |
   | `0y` | autoImport | 补全 import 语句 |
   | `0z` | import 别名学习表 | import 行上 |
   | `1xx` | **运行时 intel** | 运行时优先于静态 |
   | `2xx` | 静态引擎（pyrefly / basedpyright） | ADR-0006 |
   | `3xx` | 关键字兜底 | 仅非 LSP 引擎语言生效 |

2. **运行时优先是产品决策，不是性能妥协**：无注解代码里运行时观测是唯一可用信号（ADR-0007），静态引擎此时给不出字段；因此 intel 固定占 `1xx`，永远压过 `2xx`。
3. **来源必须可见、可辨**：intel 侧产出的条目 `detail` 带 `⟳ runtime` 徽标 + 类型 + 观测数（`⟳ runtime · dict[str, int] · 12 obs` / `⟳ runtime · scraper.parse_page · 30 hits`）；hover 渲染为 `**⟳ runtime** ... · N hits` + 参数观测段。用户随时能知道"这个候选来自运行时"。
4. **intel 自带排序分，宿主只兜底段尾**：intel 按 `score`（`hits` 降序）产出 `sort_text = "1{i:03}"`；**`stale` 条目降权 `score = hits / 2`**（陈旧数据不该压过新鲜数据）。宿主仅在 `sortText` 缺失时兜底 `"1998"`。
5. **降级而非报错**：intel 启动失败时静默降级（静态引擎照常），补全弹窗只少一段来源，用户无感。
6. **python 不叠关键字层**：python 的词已由上述段位覆盖，再叠一份会在弹窗里产生**重复项**；`3xx` 只服务无引擎语言（如 json）。

## 备选方案

| 方案 | 评估 | 结论 |
|---|---|---|
| 按来源动态打分（命中数、上下文权重算总分） | 分数会漂移、不可解释、不可测试；跨版本对比困难 | ❌ |
| 让静态优先、运行时仅补缺 | 无注解代码下静态给不出字段，运行时项会被淹没；等于放弃差异化 | ❌ |
| 混在一个 provider 里按注册顺序返回 | 顺序即优先级，无法表达"模板优先但可被运行时反超" | ❌ |
| **固定段位 + 来源标注 + intel 内部降权（选定）** | 顺序可断言（单测钉死）、可解释、可逐段扩展 | ✅ |
| 关键字层也用于 python | 弹窗出现重复项 | ❌ |

## 后果

- **正面**：顺序**可断言**（单测钉死段位关系，如 `"3000".localeCompare("2999") === 1`）；新来源只需申请段位，不动既有逻辑；用户看得见来源。
- **负面 / 取舍**：
  - 六段是**约定不是配置**，新增来源要改规则文件（`.codebuddy/rules/typescript-code-style`）——这是刻意的摩擦，防止段位随意膨胀；
  - `1xx` 优先意味着运行时观测**错误时会排在正确的静态结果之前**（降权只解决陈旧，不解决错误）→ 依赖 intel 侧推断精度与 `stale` 策略调参（`dev_plan_v2` §7 该项仍未做）。
- **约束（铁律）**：
  - 破坏段位的补全来源一律不做——任何新来源**必须明确钉段**；
  - 段位表述在代码注释、AGENTS.md、规则文件与本文档之间**必须一致**（本 ADR 为该表述的真源；`0y` / `3xx` 为后续补全段）；
  - 改段位须同步：`client.ts` 合并逻辑 + 各项单测 + 本 ADR + 规则文件。
