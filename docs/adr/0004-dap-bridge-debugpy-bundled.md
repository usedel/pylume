# ADR-0004: 调试接入采用自研轻量 DAP 桥 + debugpy 随应用打包分发（stdio adapter 模式）

- 状态：**已定案（2026-09-10）**
- 日期：2026-09-10
- 决策者：产品负责人裁决（获取方式 / 功能范围），开发团队实施并经真实环境验收反馈定型（传输架构）
- 上游：ADR-0003（自研轻量 LSP 桥，本决策复用同一「自研轻量桥」范式）
- 落地：`docs/python_debug_dev_plan.md` v1.3（开发计划）· `docs/debug_acceptance_record.md`（验收记录 D1–D5 / Gate E）

## 背景

Pylume 既有能力止于「脚本运行 + traceback 点击跳转」。单人自用场景（FastAPI / 爬虫 / 小脚本）需要升级到「断点 + 单步 + 调用栈 + 变量」的最小闭环调试。需要就三个层面定型：

1. **调试后端**：用哪个调试器、如何获取；
2. **接入方式**：如何把调试器挂到 Monaco 外壳（对标 ADR-0003 的 LSP 桥选型）；
3. **传输架构**：DAP 消息在 Rust / 调试器 / 被调试脚本之间怎么走。

其中第 3 点在实施中经真实环境实测发生了**架构级反转**（详见「决策 · 传输架构」），是本 ADR 记录的核心。

## 决策

### 1. 调试后端 = debugpy，随应用打包分发（零安装 / 零网络）

- 采用 **debugpy**（微软官方 Python DAP 实现，VS Code 同款），独立进程，不侵入外壳内核。
- **随应用打包分发**（VS Code `ms-python.debugpy` 同模式）：`tools/fetch-debugpy.ps1` 按 `ci/versions.toml [debugger]` 的 sha256 锁定拉取 cp310–cp314 五个 win_amd64 wheel，解包合并 + 剔除构建产物后经 `tauri.conf.json` `bundle.resources` 入包。
- **不安装到用户环境**：debugpy 以包目录作脚本参数拉起，`sys.path[0]` 自举后立即删除注入项，被调试脚本 import 空间零污染；加速模块（`.pyd`）按 Python 版本共存、缺失自动回退纯 Python。用户环境 site-packages 零写入、切换 venv 无感、离线可用。
- v1.0「ABI 绑定 ⇒ 必须安装进用户环境」的结论经复核为**错误**，据此废止「引导 pip/uv install」方案；防御性纪律：**永不**用 `env_cmds::pip_install` 安装 debugpy。

### 2. 接入方式 = 自研轻量 DAP 桥（对标 ADR-0003，不引入重型集成）

- **Rust 侧** `shell/src-tauri/src/dap.rs`：debugpy 会话管理 + DAP `Content-Length` 帧解析 + 经 Tauri 事件转发（`dap-message` / `debug-started` / `debug-exited`）。与 `lsp.rs` **对称但不混入**，帧解析独立复刻 `read_dap_frame`，不跨模块依赖 lsp.rs 私有项。
- **TS 侧** `shell/src/dap/client.ts`：请求/响应关联（单序号域，`id` 直接作出站 `seq`，响应以 `request_seq` 回显）+ 事件分发 + 会话状态机（`idle/starting/running/stopped/exited`）。与 `lsp/client.ts` 对称。
- **MVP 只实现 DAP 子集**：请求 `initialize/attach/setBreakpoints/configurationDone/threads/stackTrace/scopes/variables/continue/next/stepIn/stepOut/pause/disconnect`；事件 `initialized/stopped/continued/output/terminated/exited`（+ debugpy 私有 `debugpyWaitingForServer`）。

### 3. 传输架构 = stdio adapter + debuggee `--connect`（v1.3 架构反转，实测定型）

**最终架构**（全链路真实 debugpy 验证 2.2s 完成）：

```
Rust spawn stdio adapter（python <debugpy>/adapter，管道，不进 PTY）
→ initialize → attach {"listen":{"host":"127.0.0.1","port":0}}
→ [debugpyWaitingForServer {host,port}]（adapter 的 server socket 地址）
→ debug_attach_debuggee（Rust 管道 spawn：python <debugpy>/__main__.py --connect host:port --wait-for-client <脚本>）
→ [initialized] → setBreakpoints → configurationDone → stopped/continued/...
```

- DAP 通信走 **adapter 的 stdin/stdout**（管道，同 LSP 桥模式），adapter 生命周期握在 Rust 手里；
- 被调试脚本（debuggee）以 `--connect` 连 adapter 的 server socket，**亦走管道 spawn**（stdout/stderr → 输出面板）；
- `attach` 带 `{"listen":{"host","port":0}}` 走「server 主动连入」路径，同时清空 adapter access_token（debugpy `servers.py` 双 None 跳过鉴权，debuggee 无需 token）。

## 备选方案

| 方案 | 评估 | 结论 |
|---|---|---|
| **debugpy `--listen` + 端口预分配 + TCP**（v1.0–v1.2 原设计） | debugpy `--listen` 是两段式：debuggee 进程内部再 spawn adapter 子进程并等它回连（内部 listener 30s 超时）。实测该内部 spawn 在 **ConPTY 下不工作**（应用内 30s `10061`；独立管道复现也要 12.8s）。二分验证（禁用全部注入 env 后 debuggee 仍不回连）证明与环境变量无关，是 pydevd 网络线程与 ConPTY 的兼容性问题——`--listen`/`--connect` 两种模式在 ConPTY 下都翻车 | ❌ **废弃**（v1.3 反转） |
| **debugpy 安装到用户环境**（v1.0 引导 pip/uv install） | 基于「ABI 绑定」的错误前提；污染用户环境、需网络、切换 venv 重装 | ❌ 废弃（复核证伪，见「决策 1」） |
| `uv run --no-project <debugpy目录> …`（目录直接作首参，v1.1 原文） | uv 把首参目录当可执行命令 spawn → `os error 3` | ❌ 修订为 `uv run --no-project python <debugpy>/__main__.py …` |
| monaco-languageclient 式重型调试集成 | 与 ADR-0003 否决理由一致（重、版本耦合、控制点深） | ❌ 不采用，沿用自研轻量桥 |
| **stdio adapter + debuggee `--connect`（管道）** | adapter 与 debugpy 内部 spawn 无关，绕开 ConPTY；进程生命周期由 Rust 掌控 | ✅ **选定** |

## 后果

- **正面**：调试零安装、零网络、离线可用、切换 venv 无感；与 LSP 桥（ADR-0003）同一「自研轻量桥」范式，架构一致；adapter 生命周期在 Rust 手里，不受 debugpy 内部 spawn 的 ConPTY 兼容问题影响。
- **负面 / 取舍**：
  - DAP 客户端子集自维护（握手时序、单序号域关联、状态机）；
  - **调试期 stdout/stderr 落输出面板，非真 TTY**——`input()` 终端交互暂不支持（ConPTY 与 pydevd 网络线程不兼容所致的连带取舍），列为后续增强；
  - **uv 兜底模式暂不支持调试**（需先在状态栏选择解释器）；
  - `attach` 响应推迟到 `configurationDone` 才返回，发出后不可等响应，须以 `initialized` 事件为可配置信号。
- **约束**：
  - debugpy 版本 + 五个 sha256 锁定 `ci/versions.toml [debugger]`，升级须删 `vendor/debugpy/` 重跑脚本 + bench 回归全绿后合并；
  - `vendor/debugpy/` 不入库（`.gitignore`），按 sha256 锁定复现；
  - **三态互斥**：`run_script` / `run_in_terminal` / `debug_start` 三处相互检查（`dap::debug_busy()` / `lsp::run_slot_busy()` / `terminal::run_terminal_busy()`）；
  - 进程/锁纪律沿用 Rust 规范：`adapter_stdin` 独立 `Arc<Mutex>` 持有（写阻塞不持全局锁，CR-03）；`debug_stop` 立即返回、清理后台化（CR-10，同步 taskkill 会卡 UI）；应用退出走同步 `debug_stop_for_exit`（CR-14）；`locate_debugpy_dir` 出口统一剥 `\\?\` verbatim 前缀（否则 debugpy 自举 import 失败）。

## 遗留（后续增强）

- 调试期 PTY 交互（`input()`）：需先解决 ConPTY 兼容或改用独立终端方案；
- 条件断点 / 日志点 / 异常断点 / 监视表达式 / 调试控制台（REPL evaluate）/ 变量实时编辑 / 多会话并行 —— 均为 D5 后评估项，本期不做；
- 与 PyCharm 同场景逐项对标 —— 后续评估项，本期仅交付最小闭环。
