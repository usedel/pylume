# Gate D 验收记录 · 运行时补全准确率（P3-T10）

> 日期：2026-08-24
> 评测载体：pylume-intel 确定性评测 `runtime_completion_accuracy`（completion.rs 内单测）
> 运行命令：`cargo test -p pylume-intel -- --nocapture runtime_completion_accuracy`
> 实测结果：**23/23 = 100.0%**（红线 ≥ 85% → PASS）

## 结论

| Gate D 指标 | 目标 | 实测 | 判定 |
|---|---|---|---|
| 运行过的无注解代码路径补全准确率 | ≥ 85% | 100.0%（23/23） | PASS |
| 动态架构样例跳转可用 | 可用 | P3-T04 已交付（definition 单测通过） | PASS |
| 运行时层可一键关闭 | 可关闭 | P3-T09 设置开关已交付（`runtime_intel_enabled`） | PASS |
| ≥ PyCharm 同场景 | ≥ | 待人工复核（见「剩余项」） | PENDING |

## 评测点集（23，覆盖无注解代码四类核心形态）

| # | 形态 | 光标样例 | 期望 |
|---|---|---|---|
| 1-4 | 函数返回 dict → 字段 | `data = parse_page(html)` + `data.` / `data.tit` / `data.li` | title / links |
| 5-10 | 工厂返回自定义实例 → 属性 | `o = make_order(c)` + `o.` / `o.cu` / `o.it` | id / customer / items / total |
| 11-15 | 商品字典字段 | `p = fetch_product(sku)` + `p.` / `p.na` / `p.pr` / `p.st` | sku / name / price / stock |
| 16-19 | 用户实例属性 | `u = get_user(uid)` + `u.` / `u.em` / `u.ro` | name / email / roles |
| 20-21 | for 循环变量（P3-T08 补强） | `for u in list_users():` + `u.` | name / email |
| 22-23 | 函数参数类型观测 | `def handle_order(order):` + `order.` | id / customer |

> 命中判定：期望 label 出现在 top-5 候选内。

## 评测形态说明

- seed 为「订单 + 爬虫」无注解项目的 deterministic trace 观测（6 个函数，含 dict / 自定义实例 / `list[User]` / 参数观测）；
- 六类形态分别对应 `type_infer` 的：调用返回值推断、字面量、函数参数、for 循环元素类型（P3-T08）；
- 评测点不依赖网络、不依赖 LSP 进程，可在 CI 复现。

## 剩余项（Gate D 人工验收）

1. **≥ PyCharm 同场景**：PyCharm 无 CLI 导出补全准确率，无法全自动对标。
   需产品负责人在 PyCharm 中打开 `bench/sample/unannotated_scraper/` 同一样例，
   对上述六类补全点人工复核，确认本地表现「≥ PyCharm」。本报告先给出本引擎 base 数值。
2. **真实项目端到端数据对标**：本评测为确定性 seed；真实使用中的准确率
   待产品负责人用实际项目运行采集（probe 注入）后复核，作为 Phase 4 新鲜度优化的基准。