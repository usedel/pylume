# AGENTS.md

This file provides guidance to coding agents when working with code in this repository.

Pylume 是为「FastAPI + 爬虫 + 小脚本」开发者定制的单人自用 Python IDE。现行技术方案 `docs/python_ide_tech_plan_v3.md`，现行开发计划 `docs/python_ide_dev_plan_v2.md`（两者冲突时以开发计划为准）。

## 规则与规范（单一真源：`.codebuddy/rules/`）

CodeBuddy 自动加载 `RULE.mdc` 全文；其他 agent 遵循以下内联的架构铁律，并在改动对应目录前读取语言规范全文：

| 规则 | 适用范围 | 全文位置 |
|---|---|---|
| 架构铁律 | 全仓库（always apply） | 已内联于下节 |
| Python 代码规范 | `probe/` 及 `**/*.py` | `.codebuddy/rules/python-code-style/RULE.mdc` |
| Rust 代码规范 | `shell/src-tauri` | `.codebuddy/rules/rust-code-style/RULE.mdc` |
| TypeScript 代码规范 | `shell/src` | `.codebuddy/rules/typescript-code-style/RULE.mdc` |

### 架构铁律（内联全文，任何改动必须遵守）

**技术栈定位**：

| 层 | 选型 |
|---|---|
| 外壳 | Tauri 2 + Monaco（取代原 Zed 方案） |
| 静态语义 | Pyrefly（默认）/ basedpyright（备选），首日可切换 |
| 运行时 | PEP 669 `sys.monitoring` 采样 + 自研运行时 LSP `pylume-intel`（Phase 3） |
| 调试 | debugpy（随应用打包分发，版本锁 `ci/versions.toml`）+ 自研轻量 DAP 桥（ADR-0004，stdio adapter 模式） |
| 功能范围 | 补全 / 跳转 / Hover / 诊断 + 脚本运行与 traceback 点击跳转 + 调试（断点 / 单步 / 调用栈 / 变量，最小闭环） |

**架构第一原则（不可违反）**：

1. `probe` 与 `intel` 是**完全独立的进程/包**，不依赖外壳内部 API。
2. 一切自研组件都是**独立进程或独立包**，不侵入外壳与静态引擎内核。
3. 主干开发 + 短分支 PR；CI 全绿才可合并。工具链版本锁定在 `ci/versions.toml`，升级任何组件必须 PR + bench 回归全绿。

**文档约定**：

- 技术方案与开发计划冲突时，**以开发计划为准**并反馈修订；新旧版本文档冲突时，以版本号更高者为准。
- 重大设计决策先写 ADR（`docs/adr/`）；功能交付后更新对应验收记录（`docs/*_acceptance_record.md`）；技术债登记在 `docs/tech-debt.md`。
- 调试功能：计划 `docs/python_debug_dev_plan.md`（v1.3）· 验收 `docs/debug_acceptance_record.md` · 决策 `docs/adr/0004-dap-bridge-debugpy-bundled.md`。

### Python 规范核心红线（全文见 `.codebuddy/rules/python-code-style/RULE.mdc`）

- **零第三方依赖**（uv 管理，Python 3.13+）；`uv run pytest` 必须全绿。
- **开销红线 < 1.5x**（当前 1.35x）：采集路径改动 = 发现窗口 + 局部事件 + 降采样，窗口外零全局派发，改后必须 bench 回归。
- 类型紧凑表示**绝不 repr 值本身**；trace 库 `shape` 列存**空串而非 NULL**（SQLite 唯一约束对 NULL 不生效，否则 upsert 失效）。
- `_active` 计数**禁止在 RAISE 回调里递减**，只能在关窗决策点用 `_sync_active()` 从调用栈重算；改 `monitor` 必须跑 `test_monitor` 回归。
- trace 库读写设 `busy_timeout`，写库加 WAL + `synchronous=NORMAL`；wheel 打包必须含顶层 `sitecustomize.py`；argv[0] 守卫用 `os.path.normcase` 归一。
- **不侵入原则**：`PYLUME_PROBE_AUTOSTART=1` 才激活，未设置零介入；探针任何失败只打警告，**不改写用户进程退出码**。

### Rust 规范核心红线（全文见 `.codebuddy/rules/rust-code-style/RULE.mdc`）

- 杀子进程必须 `util::kill_process_tree`（裸 `child.kill()` 会留孙进程孤儿、停止按钮失效）；非退出路径用 async 版，仅应用退出钩子（RunEvent::Exit）用同步版。
- stdin/PTY writer **独立 `Arc<Mutex>`**：锁内只克隆 Arc，释放锁后再写（持全局锁做阻塞 IO = 子系统死锁）；跨线程锁走 `util::unpoison`，禁 `.lock().unwrap()`。
- 网络 git 操作用 `exec_git_timeout`；阻塞命令统一 async + `spawn_blocking`；LSP/DAP 退出监视以实例 `seq` 锁定，防同名重启串线。
- DAP **stdio adapter 模式，禁止退回 TCP `--listen`**（ConPTY 下 pydevd 不建连，实测 30s `10061`）。
- `\\?\` verbatim 路径必须剥前缀（`locate_debugpy_dir` / `project_hash`），否则 debugpy 自举失败、trace 库 hash 错位。
- **每次改动 `shell/src-tauri` 后必须主动 `cargo check` 通过再交付，不得等用户反馈编译错误。**

### TypeScript 规范核心红线（全文见 `.codebuddy/rules/typescript-code-style/RULE.mdc`）

- 补全四层合并 sortText 固定：模板 `0xx` → intel `1xx` → 静态 `2xx` → 关键字 `3xx`（python 除外，再叠会出现重复项）。
- `main.ts` 不堆逻辑，新交互一律落功能域模块；禁 `window.alert/confirm/prompt` 与 plugin-dialog 的 confirm/ask/message，统一走 `dialog.ts` 的 `openConfirm/openAlert`。
- 色值走语义 token、字号间距走 scale token（最小 11px）；按钮走 `.btn` 体系；**删任何样式类前先搜 TS 侧是否拿它当选择器钩子**。
- 异步纪律：守卫「检查 + 置位」必须同步完成（防连点穿透）；异步刷新带请求令牌（`searchToken` 范本）；多文件转发逐条 await 串行。
- 模块顶层禁止立即解析 DOM（用 `state.ts::lazyEl`）；路径比较走 `samePath`/`normalizePath`（禁手写 replace+toLowerCase）；disposable 一律入 `DisposableStore`；键位默认单一来源 `keybindingDefaults.ts`。

## 常用命令（Windows / PowerShell）

```powershell
# 前端 + 外壳开发（Vite 热更新 + Tauri 窗口）
cd shell && npm install
npm run tauri dev

# 前端构建 + 类型检查（tsc + vite build）
npm run build

# 前端单测（vitest，必须走此包装脚本：盘符归一 + no-experimental-webstorage）
npm test                                      # 全量
npm test -- src/__tests__/foo.test.ts        # 单文件
npm test -- src/__tests__/foo.test.ts -t "用例名"   # 单用例

# E2E（Playwright，testDir=shell/e2e，自动起 vite dev :5173 并复用已启动实例）
npx playwright test                          # 全量（串行，workers=1）
npx playwright test e2e/git/foo.spec.ts      # 单 spec

# Rust 外壳
cd shell/src-tauri && cargo build            # debug
cargo test

# intel（运行时 LSP）——联调 shell 前必须 build 而非 test
cd intel && cargo build -p pylume-intel   # cargo test 不刷新 shell 调用的 exe
cargo build -p pylume-intel --release     # 打包/性能验收用

# probe（运行时探针，Python 3.13.7，uv 管理）
cd probe && uv sync
uv run pytest                                # 全量；单测：uv run pytest tests/test_x.py::test_name

# 一键打包（根目录执行；自动 intel release 构建 → npm install → Tauri 打包）
powershell -File .\build-release.ps1 -SkipNpmInstall

# dep_scan 性能红线回放（bench 大仓样例，红线 ≤ 2s）
cd shell/src-tauri && cargo test --release bench_dep_scan -- --ignored --nocapture
```

安装包输出在 `shell/src-tauri/target/release/bundle/nsis/`。日志落盘 `~/.pylume/logs/pylume.log`。

## 整体架构

四个顶层代码目录 + 支撑目录，各司其职：

```
shell/   Tauri 2 + Monaco 外壳（前端 Vanilla TS + Vite；后端 Rust src-tauri）
probe/   pylume-probe：PEP 669 sys.monitoring 运行时采样（独立 Python 包）
intel/   pylume-intel：消费 trace 库的运行时智能 LSP（独立 Rust 进程，stdio）
bench/   基准项目集（sample/errors、unannotated_scraper、large_repo 等）+ 指标采集
ci/      版本锁定基线 versions.toml
tools/   构建辅助（fetch-debugpy.ps1 按 sha256 拉取打包 debugpy → vendor/debugpy/，不入库）
docs/    方案 / 开发计划 / ADR / 验收记录（新旧版本文档冲突以版本号更高者为准）
```

### 数据流（核心闭环）

1. **运行采集**：shell 点击运行 → `src-tauri/src/terminal.rs`（portable-pty 多会话 PTY）→ `run_env.rs::build_run_env` 注入环境变量（`PYTHONPATH` 前置 probe/src + `PYLUME_PROBE_AUTOSTART=1`）；
2. **probe**（`probe/src/pylume_probe/`）：发现窗口 + 局部事件 arm + 降采样，把运行时类型观测（紧凑表示：`dict[str, int]`、shape 指纹，绝不 repr 值）写入 SQLite trace 库 `~/.pylume/traces/<project-hash>.db`；
3. **intel**（`intel/pylume-intel-index/src/`）：只读打开 trace 库建倒排索引，提供补全/跳转/hover/inlay（LSP stdio）；
4. **shell LSP 桥**：`src-tauri/src/lsp.rs`（Rust 侧 spawn + 帧解析，engine 键区分 static/intel）+ `src/lsp/client.ts`（TS 侧 JSON-RPC + Monaco providers）。

**关键 hash 对齐**：`project_hash` 两端必须一致——Rust `fs::canonicalize` 在 Windows 返回 `\\?\` verbatim 前缀 + 大小写不敏感，probe 用 `os.path.realpath` + `os.path.normcase`；对齐逻辑在 `shell/src-tauri/src/file_ops.rs::strip_verbatim_prefix`，改动路径处理时不得破坏。同理 `lsp.rs::lsp_start` 必须给静态引擎传 `cwd`（workspaceRoot），否则 pyrefly 发现不了 `pyproject.toml`，references/rename 只覆盖已打开文件。

### 补全四层合并（sortText 段位，顺序固定）

智能 live template `0xx`（shell `src/live-templates/`）→ 运行时 intel `1xx`（标注 `⟳ runtime`）→ 静态引擎 `2xx`（pyrefly 默认 / basedpyright 备选，引擎切换 = LSP 桥命令表条目，引擎无关设计 ADR-0003）→ 关键字 `3xx`（零引擎兜底，python 除外）。intel 启动失败静默降级，静态引擎照常。

### shell 前后端职责（改动前先找对位置）

- 前端 `shell/src/`：`main.ts`（生命周期/接线胶水）、`state.ts`（AppState 跨域上下文）、`views.ts`（侧栏视图注册表）、`fileTree.ts`、`git.ts`、`termUi.ts`/`terminal.ts`、`search.ts`（ripgrep）、`live-templates/`（三层配置合并 + 表达式引擎）、`lsp/client.ts`、`dap/client.ts`、`devtools/`（插件）、i18n 语言包。
- 后端 `shell/src-tauri/src/`：`lib.rs`（命令注册）、`lsp.rs`（LSP 桥）、`dap.rs`（debugpy DAP 桥，stdio adapter）、`fs_cmds.rs`、`file_ops.rs`、`git_cmds.rs`/`git_status.rs`、`terminal.rs`（统一 PTY 运行入口）、`run_env.rs`（运行环境装配单一来源）、`tool_paths.rs`（uv/pyrefly/ruff/git 定位）、`toolchain.rs`（首启环境引导）、`settings.rs`、`util.rs`（data_root/no_window/kill_process_tree）。
- 打包自研组件经 `tauri.conf.json bundle.resources` 进安装包，运行时四级查找：环境变量 → `<data_root>/runtime` → Tauri 资源目录 → dev 仓库布局。
- 数据根默认 `%LOCALAPPDATA%\Pylume`（`PYLUME_DATA_ROOT` 可重定向）。

## 领域约定

### i18n（zh-CN / en-US 双语，已全覆盖）

扁平 key 语言包，Rust 错误提示与全部功能域动态文案纳管，en/zh 词条编译期对齐 + 单测兜底。新增文案走 `docs/i18n.md` 三步流程（映射 → 抽取脚本 `shell/tools/i18n/apply_ts.py` → 合并 zh 词条）；`console.*` 日志不纳管；命令面板等注册快照类文案需在 `onLocaleChange` 里重建。

### 测试分层

- **vitest 单测**：`shell/src/**/__tests__/`（纯逻辑）+ `probe/` pytest。
- **浏览器层 e2e**（`shell/e2e/`，按域分子目录）：vite dev + `e2e/mocks/tauri.ts` 注入 `window.__TAURI_INTERNALS__` mock，git_* 命令映射到 Playwright 侧管理的真实临时 git 仓库。用例只写用户旅程，不与单测重复。
- **真机层 e2e**（`shell/e2e-real/`）：CDP `connectOverCDP`（端口 9223）+ 隔离数据根，验真实 Tauri/debugpy 链路。
- e2e 输出目录固定在系统 TEMP（工作区路径会触发 safe-delete 确认门槛卡死测试）。
