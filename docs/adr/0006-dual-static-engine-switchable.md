# ADR-0006: 双静态引擎并存（Pyrefly 默认 / basedpyright 备选）+ 首日引擎无关抽象层

- 状态：**已定案**（决策自 2026-08-20 生效；2026-10-03 追溯补记）
- 日期：2026-08-20（补记 2026-10-03）
- 决策者：产品负责人裁决
- 上游：`docs/python_ide_tech_plan_v3.md` v3.0（Phase 1 范围与「静态语义」层选型）
- 落地：`shell/src-tauri/src/lsp.rs` · `settings.rs` · `toolchain.rs` · `bench/reports/engine-perf-comparison.md` · Pydantic 支持计划 v0.2（**已归档**）

## 背景

静态语义层是 IDE 的地基，一旦选定单一引擎即形成单点依赖：

1. **上游风险**：Pyrefly 由 Meta 维护，`dev_plan_v2` §9 风险登记册已列「Pyrefly 被 Meta 降权/停更」；单引擎无退路。
2. **能力分布不均**：两个引擎对同一代码的覆盖不同（如 Pydantic 构造参数校验与字段 `references`：pyrefly 缺失、basedpyright 覆盖 4/6；反向 basedpyright 在 `alias` 字段上误报，见 `fs_cmds.rs:1780`）。缺的那部分要么自研补齐、要么换引擎，必须能切。
3. **切换成本**：若把引擎差异渗进业务代码，后期换引擎等于重写。因此**第一版就要把"引擎"抽象掉**，而不是等出事再抽。

## 决策

1. **双引擎并存，第一天即可切换**：默认 Pyrefly，备选 basedpyright。设置项 `lsp_engine: String`（`settings.rs:153`），取值为 `"pyrefly" | "basedpyright"`。
2. **引擎差异集中在两处，不外溢**：
   - 启动命令与安装包名映射：`toolchain.rs::engine_command`（`pyrefly` / `basedpyright-langserver`）与 `engine_package`（`pyrefly` / `basedpyright`），供工具链引导一键安装使用；
   - LSP 桥只认"命令不同"：`lsp.rs` 头注释明确「引擎无关：pyrefly / basedpyright / pylume-intel 只是前端传入的命令不同」，桥内无任何引擎分支。
3. **不把 Pyrefly 换成第三方语义服务**：铁律「第三方只补充不替换」——引擎可换，但桥必须自研（ADR-0003 已否决 monaco-languageclient）。
4. **切换是用户显式动作**：工作区检测到 `pydantic` / `fastapi` 依赖时**提示推荐**切换，绝不静默改设置（`env_cmds.rs:1558-1561`）；用户可对工作区关闭该提示（`framework_hints`）。

## 备选方案

| 方案 | 评估 | 结论 |
|---|---|---|
| 只用 Pyrefly，缺能力自研 | 最省事，但把"上游停更"与"能力缺口"绑成单点 | ❌ 缺退路 |
| 只用 basedpyright | 上游更稳（可 pip 装、无 Meta 政策风险），但**性能与索引行为未做基准**，且本项目大量自研能力（`lsp.rs` 桥、probe trace 调优）已按 pyrefly 调优 | ❌ 作为默认过早 |
| 自研语义引擎 | 成本量级与探针+intel 相当，且要重写全部类型推断 | ❌ 与"差异化押在运行时"的方向冲突 |
| asdf / mise 统一工具链 | 多版本管理是团队/多项目需求；单人自用 Windows 场景由 `tool_paths.rs`（环境变量 → 用户自有目录 → PATH）已够 | ❌ 不引入 |

## 后果

- **正面**：引擎可换，"上游风险"从单点降为可选项；能力缺口可用另一引擎交叉验证（PyCharm 缺 `references=0` 场景就是靠 pyrefly/对照探针发现的）。
- **负面 / 取舍**：
  - 双引擎都要回归，CI 与 bench 成本 ×2 —— `bench/reports/engine-perf-comparison.md` 是当前唯一对照产物，**升级任一引擎须重跑**；
  - 用户可能选到与自己代码不匹配的引擎（如 Pydantic 项目用 basedpyright 仍有 `alias` 误报）→ 已在 `fs_cmds.rs` 自研层做"识别到即跳过"处理，两侧误报都不能靠引擎消失。
- **约束**：
  - 两个引擎版本都锁 `ci/versions.toml`；
  - 引擎切换 = 重启 LSP 实例（`engine` 键区分 `static` / `intel` 实例，见 ADR-0007）；
  - Pydantic 支持计划 v0.2（已归档）已**撤销「推荐切 basedpyright」**——改为在 pyrefly 缺失能力上自研补齐（构造校验 + 改名传播），避免把用户的引擎选择变成产品强制。
