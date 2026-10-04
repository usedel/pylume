# ADR-0007: 运行时智能作为独立 LSP（pylume-intel），不修改 Pyrefly 内核

- 状态：**已定案**（决策自 2026-08-20 生效；2026-10-03 追溯补记）
- 日期：2026-08-20（补记 2026-10-03）
- 决策者：产品负责人裁决
- 上游：`docs/python_ide_tech_plan_v3.md` v3.0（探针 / intel / 验收指标三章节）
- 落地：`intel/`（独立 cargo workspace）· `probe/`（独立 Python 包）· `shell/src-tauri/src/lsp.rs` · `docs/bench/reports`（`bench/reports/gate-d-runtime-completion.md`）

## 背景

Pylume 的差异化不是"又一个 Python IDE"，而是**用真实运行数据补上静态引擎看不到的那一半**（无注解代码的字段/属性/参数类型）。这层能力有两个天然诱惑：

1. 直接改 Pyrefly 源码，让它读 trace 数据 —— 违反「不侵入静态引擎内核」铁律，且升级即冲突；
2. 塞进外壳（Rust/TS）里做推理 —— 变成外壳的一部分，无法独立测试、独立升级、独立打包。

架构铁律第 1、2 条要求：`probe` 与 `intel` 是**完全独立的进程/包**，不依赖外壳内部 API；一切自研组件独立成进程或独立包。

## 决策

1. **采样与推理彻底分离，各自独立交付**：
   - `probe/` —— 独立 Python 包（**零第三方依赖**，uv 管理，Python 3.13.7），运行期注入用户进程采样，写 SQLite trace 库；
   - `intel/` —— 独立 Rust crate（独立 workspace，stdio LSP），**只读**打开 trace 库建倒排索引，对外提供补全 / 跳转 / hover / inlay / 运行时诊断。
2. **外壳只做 spawn 与帧解析**：与静态引擎共用 `lsp.rs`，用 `engine` 键区分实例（`"static"` / `"intel"`），事件 payload 带 engine 供前端分流。intel 启动失败**静默降级**（静态引擎照常工作）。
3. **不修改 Pyrefly 内核，也不 fork**：运行时结果与静态结果在同一份 LSP 协议层合并（策略见 ADR-0009），pyrefly 保持原样可随时替换。
4. **探针严格不侵入**：仅 `PYLUME_PROBE_AUTOSTART=1` 时激活，未设置零介入；探针任何失败只打警告，**不改写用户进程退出码**。

## 备选方案

| 方案 | 评估 | 结论 |
|---|---|---|
| fork / patch Pyrefly 读 trace | 能力最直接，但违反不侵入原则；pyrefly 升级每次都要重打补丁 | ❌ 否决 |
| 推理逻辑写在外壳（`lsp.rs` / TS）里 | 无新包，但 intel 无法独立 `cargo test` / `cargo build` 验证，联调成本转嫁到 shell | ❌ 否决 |
| probe 直接起 LSP（Python 侧自建服务） | 省一个包，但 Python LSP 生态与性能都不如 Rust 索引；且 probe 必须常驻 | ❌ 否决 |
| **独立 probe 包 + 独立 intel LSP + 外壳 spawn** | 两个新包各司其职，可独立构建/测试/打包；trace 库成为稳定契约面 | ✅ **选定** |

## 后果

- **正面**：intel 可 `cargo build -p pylume-intel --release` 单独出包进安装包；探针与外壳解耦，探针崩了 IDE 照常；能力边界写在各自 README 里。
- **负面 / 取舍**：
  - trace 库成为跨语言契约（Python 写 / Rust 读），**schema 变更要双边同步**；shape 列存**空串而非 NULL**（SQLite 唯一约束对 NULL 不生效，否则 upsert 失效）。
  - **`project_hash` 两端必须一致**：Rust `fs::canonicalize` 在 Windows 返回 `\\?\` verbatim 前缀且大小写不敏感，probe 用 `os.path.realpath` + `os.path.normcase`；对齐逻辑在 `file_ops.rs::strip_verbatim_prefix`。改路径处理不得破坏。
  - `lsp_start` **必须给静态引擎传 `cwd`（workspaceRoot）**：pyrefly 从 cwd 发现 `pyproject.toml` 才启动工作区索引，否则 references / rename 只覆盖已打开文件。
- **约束**：
  - intel 联调前必须 `cargo build`（`cargo test` 不刷新 shell 调用的 exe）；
  - 探针开销红线 < 1.5x（当前实测 1.35x），改采集路径必须跑 bench 回归；
  - 任何改 `intel` 索引 schema 的 PR 必须同步 probe 写入端 + `bench/reports/` 基线。
