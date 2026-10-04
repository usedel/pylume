# Pylume 调试功能开发计划（Debug / DAP 集成）

> 版本：v1.3 · 日期：2026-09-10 · 状态：已实施（D1~D5，验收记录 `docs/debug_acceptance_record.md`；人工验收清单待办）
> 归属：`docs/python_ide_dev_plan_v2.md` §7「调试评估」项的落地拆解
> 上游：`docs/python_ide_tech_plan_v3.md` §0（调试时机）/ §2（外壳技术栈）
> 本文档面向实施者，是调试功能排期与执行的唯一依据；与 `dev_plan_v2.md` 冲突时，以本计划为准并反馈修订。
> **v1.1 修订（2026-09-10，产品负责人裁决）**：debugpy 获取方式由「界面引导安装到用户环境」改为「**随应用打包分发**（VS Code 同模式，剔除构建产物裁剪）」。v1.0 §3.1「ABI 绑定导致必须装进用户环境」的结论经复核为**错误**（详见 §3.1 复核证据）；连锁修订 §2 决策表、§3.4/§3.5、§5.1.2、§5.2、§6.7、§7 D1/D5、§8、§9、§10、§11。
> **v1.2 修订（2026-09-10，实施反馈）**：实施 spike 实测修正三处——①§5.2 uv 兜底命令原样不可用（uv 把目录当可执行命令），改为 `uv run --no-project python <debugpy目录>/__main__.py …`；②§5.3 启动时序补 `attach` 请求（缺它 setBreakpoints 报 "Server is not available"，详见 §5.3 修订）；③§7 D1 打包脚本需同步改 `build-release.bat`（计划原文只列 ps1）。证据与全部实施偏差见 `docs/debug_acceptance_record.md` §二。
> **v1.3 修订（2026-09-10，真实环境验收反馈）**：§5.3 的 `--listen`+TCP 架构在真实环境（用户项目 + ConPTY）实测**不可用**——debugpy 内部 spawn 的 adapter 在 ConPTY 下不回连（两段式启动，内部 listener 30s 超时），且 Tauri 资源目录的 `\\?\` verbatim 前缀使 debugpy 自举 import 失败。**架构改为 stdio adapter**：Rust spawn `python <debugpy>/adapter`（管道，DAP 走 stdin/stdout，同 LSP 桥模式）；debuggee 以 `--connect` 连 adapter（地址经 `debugpyWaitingForServer` 事件获得），亦改管道 spawn（stdout 落输出面板）。调试相关进程全部脱离 ConPTY（实测 pydevd 网络线程在 ConPTY 下不建连）。完整根因链与新时序见 `docs/debug_acceptance_record.md` §〇。

---

## 1. 目标与范围

为 Pylume 增加 **Python 最小闭环调试能力**，让单人自用场景（FastAPI / 爬虫 / 小脚本）从「print + traceback 跳转」升级到「断点 + 单步 + 调用栈 + 变量」。

### 1.1 最小闭环（本期交付）

| 能力 | 说明 |
|---|---|
| 行断点 | Monaco gutter 红点，点击切换，调试前批量同步到 debugger |
| 断点暂停 | 断点命中暂停，当前行高亮 |
| 步进控制 | 继续 / 单步跳过（next）/ 单步进入（stepIn）/ 单步退出（stepOut）/ 停止 |
| 调用栈 | 查看线程与调用栈帧，点击帧跳转源码 |
| 局部变量 | 查看当前作用域 / 局部变量（含一层展开） |
| 当前行高亮 | stopped 后在编辑器标示当前执行行 |

### 1.2 明确不做（本期）

- 条件断点、日志点（logpoint）、异常断点、监视表达式 —— **D5 后评估**
- 调试控制台（REPL / evaluate 表达式）
- 变量实时编辑、多调试会话并行
- probe 采样与调试同时运行（调试态 probe 恒为 false，见 §3.2）

---

## 2. 已确认决策（产品负责人裁决，2026-09-09；v1.1 修订 2026-09-10）

| 决策点 | 结论 |
|---|---|
| 调试后端 | **debugpy**（微软官方 Python DAP 实现，VS Code 同款），独立进程，不侵入外壳内核 |
| 功能范围 | 最小闭环（见 §1.1） |
| debugpy 获取 | **随应用打包分发**（v1.1 修订，VS Code 同模式）：打包脚本从 PyPI 拉取锁定版本 wheel，解包合并 + 剔除构建产物后经 `bundle.resources` 入包；版本锁定 `ci/versions.toml` `[debugger]` 段；**不安装到用户环境、调试零网络** |
| debugpy 落点 | 应用资源目录 `debugpy/`（含 cp310–cp314 win_amd64 加速模块共存 + 纯 Python 回退）；调试命令直接以包目录为脚本参数拉起，`sys.path` 自举零污染（见 §3.1/§3.4/§5.2） |
| 依赖声明检测 | 保留但**降级为提示性质**（v1.1）：扫 `pyproject.toml` / `requirements*.txt`，命中则输出面板一次性提示（自带副本、不冲突），不弹窗不阻断（见 §3.5） |
| 调试 UI | 独立调试侧栏（左侧 activity-bar 第 4 项）+ 运行组旁新增「调试」按钮 |
| 运行通道 | 调试进程 stdout/stderr 复用 PTY（真 TTY），落到「运行终端」tab |

---

## 3. 技术约束与关键结论（实施前必读）

### 3.1 debugpy 是 in-process 调试器，且支持「零安装」分发（v1.1 复核修正）

debugpy 的启动模型是 `python <debugpy 目录> --listen <host>:<port> --wait-for-client <script> <args>`——**debugpy 模块被「运行用户脚本的那个解释器」import，与被调试脚本同进程**。

关键事实（2026-09-10 复核；v1.0 的「ABI 绑定 ⇒ 必须安装进用户环境」结论**错误**，据此废止）：

1. **「安装到任意目录」是 debugpy 官方支持的运行方式**。`debugpy/__main__.py` 头部注释列出三种运行方式，第三种即「安装在任意目录 + `python <dir>/debugpy` 直接运行」；脚本自举 `sys.path` 后**立即移除**注入项（`del sys.path[0]`），被调试进程的 import 命名空间零污染。VS Code 的 `ms-python.debugpy` 扩展正是此模式（`bundled/libs/debugpy/`，含 cp310–cp314 全部 win_amd64 加速模块）。
2. **加速模块缺失时自动回退纯 Python 实现**。`pydevd_trace_dispatch.py` / `pydevd_additional_thread_info.py` 均为 `try: cython → except ImportError: *_regular.py` 结构；PyPI 的 `py2.py3-none-any` 通用 wheel 仅内置 cp39-win 的 `.pyd`——大量用户本就运行在纯 Python 模式下，回退是官方常态而非异常分支（功能等价，仅调试开销略增）。
3. **多版本加速模块合并分发是官方机制**。`pydevd_cython_wrapper.py` 注释原文「to have multiple pre-compiled pyds distributed along the IDE」；VS Code bundled 目录即 cp310–cp314 `.pyd` 共存，运行时按解释器版本自动挑选。
4. **双先例**：VS Code（bundled debugpy）与 PyCharm（bundled pydevd；`pydevd-pycharm` PyPI 页明确「IDE 已内置时不应单独安装」，该包仅服务远程调试）均不向用户环境安装调试器。

推论（v1.1 修正后）：
1. **不能做成独立二进制**（原推论 1 保留）——debugpy 必须被被调试解释器 import，无法像 pyrefly 那样脱离解释器独立跑。
2. **应当以应用资源目录分发**（推翻原推论 2）：加速模块按版本共存、缺失回退纯 Python，跨解释器/多版本稳健，不存在「逐字节一致」约束。
3. 落点 = **应用资源目录**（§3.4 打包管线）：调试零安装、零网络、离线可用、切换 venv 无感。调试器实例恒用自带副本——包目录作为脚本参数时 `sys.path[0]` 优先于 venv site-packages，用户环境中即使存在 debugpy 也不影响调试会话。

### 3.2 沟通「运行互斥」（v3.4 收窄更新）

> v3.4 运行迁移后更新：piped 运行路径（`run_script` / `run_slot_busy`）已删，运行统一走 PTY；
> 互斥口径收窄为「调试 ↔ 脚本运行」（`terminal::script_run_busy()` 只看 `run-term-script` 会话），
> 项目实例（长驻服务）可与调试并存（§13.2 裁决 10）。

调试与脚本运行互斥：新增 `dap.rs::debug_busy()`；脚本运行在 `terminal::run_in_terminal` 中反向检查 `debug_busy()`，调试在 `debug_start` 中检查 `script_run_busy()`（详见 §7 D1）。

### 3.3 端口预分配（避免从 stdout 解析端口）

debugpy 打印 `Debugger listening on port N` 到 stdout；但调试态 stdout 需要接 PTY（真 TTY），Rust 侧不解析 PTY 内容。因此**不解析端口声明**，改为：

1. Rust 侧 `TcpListener::bind("127.0.0.1:0")` 拿到空闲端口；
2. drop listener（释放端口）；
3. 把该端口以 `--listen 127.0.0.1:<port>` 传给 debugpy；
4. Rust 侧 `TcpStream::connect("127.0.0.1:<port>")` 建立 DAP 连接（debugpy 在 `--wait-for-client` 后已监听）。

> 备选（不推荐）：从 PTY 的 `term-data` 事件用 `Debugger listening on port (\d+)` 正则提取端口。竞态与工程复杂度更高，仅作预案。

### 3.4 debugpy 打包管线（v1.1：替代原「安装到用户环境」方案）

v1.0 的「探测 + 引导 `pip install` 到用户解释器环境」方案**废止**：连同「`pip_install` 在 pyproject 场景走 `uv add` 写清单」的坑一并消除——新方案下**不存在任何安装路径**。防御性纪律：未来任何扩展**禁止**复用 `env_cmds::pip_install` 安装 debugpy。

打包管线（新增 `tools/fetch-debugpy.ps1`，由 `build-release.ps1` 调用，幂等）：

1. 读 `ci/versions.toml` `[debugger]` 段的锁定版本与 sha256（当前 `debugpy = "1.8.21"`）；
2. 下载 5 个平台 wheel：`debugpy-<ver>-cp310…cp314-cp*-win_amd64.whl`（`--only-binary`，逐个 sha256 校验）；
3. 解包合并到 `vendor/debugpy/`：`.py` 文件各 wheel 相同、覆盖无害；`.pyd` 按版本标签共存；保留 `dist-info`（许可合规，debugpy 为 MIT）；
4. **剔除构建产物**：`*.c` / `*.pdb` / `*.pxd` / `*.pyx` / `*.template.pyx` / `*.hpp` / `*.cpp` / `*.bat`（wheel 里带着仅是上游发布习惯，运行时永不加载）；
5. `vendor/debugpy/` 加入 `.gitignore`（拉取产物不入库，构建时按 sha256 锁定复现）；
6. `tauri.conf.json` `bundle.resources` 增加映射 `"../../vendor/debugpy/": "debugpy/"`。

体积实测（2026-09-10，debugpy 1.8.20 合并目录；基准安装包 `Pylume_0.1.0_x64-setup.exe` = 5.31 MB）：

| 策略 | 安装后增量 | 压缩后（下载）增量 |
|---|---|---|
| 原样照搬 bundled 目录 | 29.31 MB | ~8 MB |
| **方案 B：剔除构建产物（采纳）** | **8.74 MB** | **+2.67 MB** |
| 再剔除 `pydevd_attach_to_process` 子树（未采纳——损失 attach-to-PID 能力仅省 0.7 MB） | 6.31 MB | +1.99 MB |

> 未来跨平台（macOS/Linux）时按目标平台追加对应 wheel（各 +1.5~3 MB 压缩）；Python <3.10 无加速模块，自动纯 Python 回退（§3.1），功能等价。

### 3.5 依赖声明检测（v1.1 降级：提示性质）

原目的「防止我们把 debugpy 写进项目清单」随零安装方案自然消解。保留检测仅用于**解惑**：用户项目 `pyproject.toml` / `requirements*.txt` 若声明了 debugpy（多为其他工具遗留或模板习惯），Pylume 调试使用**自带副本**（§3.1），二者互不影响；输出面板一次性提示「无需安装，可按需移除声明」。纯文件扫描、无子进程、不弹窗、不阻断（实现见 §5.1.6）。

---

## 4. 总体架构

```
Monaco(前端)                          Rust 外壳                              Python 侧
┌──────────────────────┐          ┌──────────────────────────┐        ┌────────────────────┐
│ 调试侧栏 view-debug  │◄─事件/命令─►│ dap.rs (新增)            │──TCP──►│ debugpy 子进程       │
│  工具栏 / 调用栈 / 变量│          │  ·debug_start/debug_* 命令│  DAP   │  (in-process,        │
│  断点列表             │          │  ·TcpStream DAP 客户端    │ 帧流   │   用户解释器)         │
│ 断点 gutter (debugGutter)│◄───────│  ·端口预分配 + 会话登记   │        │   └ 用户脚本         │
└──────────────────────┘          │  ·事件转发 dap-*          │        └────────────────────┘
      ▲                           └──────────┬───────────────┘
      │                                      │ 复用
      │  PTY 复用（stdout 真 TTY）             └─ run_env::build_run_env(probe=false)
      └─ IntegratedTerminal.startRun(命令换 debugpy 启动)
```

分层职责：
- **Rust `dap.rs`（新增）**：DAP 客户端（TCP）、debugpy 子进程管理、**自带 debugpy 资源定位（`locate_debugpy_dir`，§5.1.2）**、端口预分配、断点/栈/变量等请求的转发与事件 emit。与 `lsp.rs` 对称，**不混入 lsp.rs**。
- **前端 `dap/client.ts`（新增）**：DAP 事件订阅、请求封装（与 `lsp/client.ts` 对称）。
- **前端 `debugGutter.ts`（新增）**：断点装饰（复用 runGutter 的 glyphMargin 先例）。
- **前端 `debugView.ts`（新增）**：调试侧栏渲染与交互。
- **应用资源 `debugpy/`（新增，打包产物）**：debugpy 锁定版本完整副本（cp310–cp314 win_amd64 加速模块 + 纯 Python 回退），经 `bundle.resources` 分发（§3.4），由用户解释器进程加载（§3.1）。

---

## 5. 详细设计

### 5.1 Rust 侧 `dap.rs`

#### 5.1.1 全局状态

```rust
struct DebugSession {
    child: Option<Child>,          // debugpy 进程
    stream: Option<TcpStream>,     // DAP TCP 连接
    port: u16,                     // 预分配端口
    seq: u64,                      // 会话序号（防重启串线，同 lsp.rs 先例）
}
static DEBUG: LazyLock<Mutex<Option<DebugSession>>> = LazyLock::new(|| Mutex::new(None));
static DEBUG_SEQ: AtomicU64 = AtomicU64::new(0);
```

单实例守卫：

```rust
pub(crate) fn debug_busy() -> bool {
    unpoison(DEBUG.lock()).is_some()
}
```

#### 5.1.2 启动（`debug_start` 命令）

签名建议：`async fn debug_start(app: AppHandle, path: String, workspace_root: Option<String>) -> Result<(), String>`（异步 + `spawn_blocking`，因含 spawn/PTY/TCP 子操作，见 `env_cmds` 的惯例；v1.1 后**无安装/网络子进程**）。

流程（顺序严格）：

1. `debug_busy()` 单实例 + `terminal::script_run_busy()` 脚本运行互斥检查（v3.4 收窄后，项目实例放行）。
2. 解析脚本路径 / 文件名（同 `run_in_terminal` 脚本分支的 `script_abs` / `fname` / `dir` 逻辑）。
3. 解析解释器（`env_cmds::get_interpreter`）与运行配置（`env_cmds::read_run_config`）。
4. **定位自带 debugpy**：`locate_debugpy_dir(&app)` 四级查找——`PYLUME_DEBUGPY_DIR` 环境变量 → `~/.pylume/runtime/debugpy` → Tauri 资源目录候选（`util::resource_candidates`）→ dev 仓库布局上溯 `vendor/debugpy`（同 `lsp.rs::locate_intel_binary` 先例）；返回含 `__main__.py` 的包目录。缺失 → 可诊断错误（安装包损坏 / dev 未运行 `tools/fetch-debugpy.ps1`），**无安装分支**。
5. **依赖声明检测（提示性质）**：扫 `workspace_root` 下 `pyproject.toml` / `requirements*.txt`（见 §5.1.6），命中则回传前端做一次性提示，不阻断。
6. **端口预分配**：`TcpListener::bind("127.0.0.1:0")` 取 port，drop。
7. **构造命令**（见 §5.2）。
8. `build_run_env(&app, &script_abs, workspace_root, &run_config, /*probe=*/false)` 得 env/args。
9. PTY 落地：复用 `terminal.rs` 的会话机制。建议在 `dap.rs` 内新增一个调试会话落地函数，直接 `openpty` + `spawn_command` + 起读/退出线程（可复用 `terminal::start_session` 的模式；若 `start_session` 未导出，说明实施时需把它调整为 `pub(crate)` 或在 dap.rs 内复刻）。
10. `TcpStream::connect` + 起 DAP 读线程（帧解析 → `dap-message` 事件，参考 `lsp.rs::read_frame`，DAP 帧头同为 `Content-Length:`）。

> 会话 id 约定：调试进程用独立的 `run-term-*` 前缀（复用 PTY 的 `RUN_TERM_PREFIX` 约定，或新增 `debug-term-`），与普通 shell / 运行终端区分。进程自然退出时由退出监视线程 emit，前端复位调试态。

#### 5.1.3 DAP 读线程

```rust
// 数据从 TcpStream 读，而非 Child stdout
let mut reader = BufReader::new(stream.try_clone()?);
loop {
    match read_frame(&mut reader) { /* Content-Length 帧 */ 
        Ok(Some(payload)) => { let _ = app.emit("dap-message", payload); }
        ...
    }
}
```

> `read_frame` 在 `lsp.rs` 是私有 `fn`；MVP 在 `dap.rs` 内复刻一份 `read_dap_frame`，不跨模块依赖 lsp.rs 私有项，避免改动 lsp.rs 带来回归。

#### 5.1.4 发送请求 / 通知（前端驱动，与 lsp.rs 对称）

```rust
#[tauri::command]
pub fn dap_send_request(id: i64, method: String, params: Value) -> Result<(), String>;
#[tauri::command]
pub fn dap_send_notification(method: String, params: Value) -> Result<(), String>;
```

实现同 `lsp.rs::send_message`，只是写 `TcpStream` 而非 stdin。

#### 5.1.5 停止（`debug_stop` / `disconnect`）

```rust
#[tauri::command]
pub fn debug_stop() -> Result<(), String>;
```

- 先 `kill_process_tree(&mut child)`（连带脚本子树）；
- 再 `stream.shutdown()`（关闭 TCP）；
- 清空 `DEBUG` 锁槽，触发前端 `debug-exited`（或由退出监视线程 emit）。

#### 5.1.6 依赖声明检测（`debug_detect_dep` 纯函数）

```rust
/// 返回 { found: bool, files: Vec<String> }
fn scan_debugpy_dep(workspace_root: &Path) -> (bool, Vec<String>);
```

- `pyproject.toml`：文本扫描 `[project.dependencies]` 段（含 poetry 的 `[tool.poetry.dependencies]`）中 `debugpy` 字样；忽略版本约束与引号。
- `requirements.txt` / 匹配 `requirements*.txt`：逐行匹配 `debugpy`，跳过 `#` 注释，兼容 `debugpy>=1.8`。
- 扫描逻辑做成**纯函数**，`#[cfg(test)]` 覆盖：不带版本、带版本约束、注释行、pyproject poetry 段、多处命中、无命中。

### 5.2 调试启动命令构造

不直接复用 `run_env::resolve_run_command`（其 args 语义是「脚本」而非「debugpy 包裹」），但**必须复用 `build_run_env` 装配 env**（保证 PYTHONPATH 四段、编码、probe=false 与普通运行一致）。

已选解释器（`interpreter = Some(<interp>)`）——**debugpy 以自带包目录为脚本参数拉起**（§3.1 官方第三种运行方式，`sys.path` 自举零污染）：

```text
program = <interp>
args    = [<locate_debugpy_dir()>/__main__.py 所在包目录的运行入口>, ...（见下）
```

即（`<dbgpy>` = `locate_debugpy_dir()` 返回的包目录，含 `__main__.py`）：

```text
program = <interp>
args    = [<dbgpy>, "--listen", "127.0.0.1:<port>", "--wait-for-client",
           <script_abs>, <run_env.args...>]
```

> 等价于 `python <资源目录>/debugpy --listen … --wait-for-client <脚本> <参数>`。不用 `-m`（`-m` 要求 debugpy 已在 `sys.path`/site-packages 中）；直接以包目录为脚本参数时 `sys.path[0]` 即包目录，`__main__.py` 自举 import 后**立即删除该注入**，被调试脚本的 import 空间零污染。`build_run_env` 的 PYTHONPATH 四段**无需改动**。

未选解释器（uv 兜底）——uv 拉起的解释器同样直接运行自带包目录：

```text
program = uv（经 tool_command("uv", ENV_UV) 解析）
args    = ["run", "--no-project", "python", <dbgpy>/__main__.py, "--listen", "127.0.0.1:<port>",
           "--wait-for-client", <fname>, <run_env.args...>]
```

> **v1.2 修订（spike 实测）**：v1.1 原文 `uv run --no-project <dbgpy> …`（目录直接作首参）不可用——uv 把首参目录当可执行命令 spawn，报 `os error 3 系统找不到指定的路径`。必须在 `<dbgpy>` 前显式加 `python`。`--no-project` 保留（零写入决策：不向项目 venv/uv.lock 写任何东西）；代价是「无解释器 + 有 pyproject」场景下调试运行在无项目依赖的临时环境（与普通运行 uv run 的语义差异，MVP 接受）。
> uv 兜底还需判 `tool_paths::is_available("uv", ENV_UV)`，缺失给可诊断错误（同 `run_in_terminal` 的 uv 缺席处理）。v1.1：不再需要 `--with debugpy`（零安装、零网络）。

### 5.3 DAP 协议（MVP 子集）

帧头：`Content-Length: N\r\n\r\n{json}`（与 LSP 相同）。

**启动时序（launch 型，`--wait-for-client`；v1.2 修订：补 `attach`）：**

```
Rust spawn debugpy（stdout/stderr → PTY）
Rust TcpStream connect
前端: initialize 请求（clientID、adapterID=debugpy）→ 收响应
前端: attach 请求 {"justMyCode": true}（不等响应）
前端: 收 initialized 事件                    ← DAP 规范的可配置信号
前端: setBreakpoints（按文件分组，见 §6.4）
前端: configurationDone 请求  ← 此时 debugpy 开始执行脚本（attach 的响应也在此后返回）
之后事件驱动：
  stopped(reason=breakpoint) → 前端刷新栈/变量/当前行
  continued / output / terminated / exited → 前端相应处理
```

> **v1.2 修订（spike 实测）**：v1.1 原文时序缺 `attach`——CLI `--listen` 模式下 adapter 的 server 组件在收到 `attach` 前未连接，直接 `setBreakpoints` 报 **"Server is not available"**（`debugpy/adapter/clients.py`）。三个实测细节：①attach 的 arguments 必须为**非空 dict**（`pydevd_schema.AttachRequest` 把 `{}` 当 falsy），最小合法 `{"justMyCode": true}`；②attach 的响应**推迟到 configurationDone**（clients.py 返回 NO_RESPONSE），发出后不可等；③`initialized` 事件在 attach 之后发出，是 DAP 规范的「可开始配置」信号。

**请求（client → debugpy）**：`initialize`、`setBreakpoints`、`configurationDone`、`threads`、`stackTrace`、`scopes`、`variables`、`continue`、`next`、`stepIn`、`stepOut`、`pause`、`disconnect`。

**事件（debugpy → client）**：`initialized`、`stopped`、`continued`、`output`、`terminated`、`exited`。

MVP 走 `--wait-for-client` 命令行直接跑脚本，因此**不需要** `launch` 请求（program/args/cwd 已由命令行与 spawn 时的 env 给定）。

---

## 6. 前端设计

### 6.1 布局与 DOM（`index.html`）

1. **运行组旁新增调试按钮**（`#run-group` 之后、`.spacer` 之前）：

```html
<button id="btn-debug" class="menubar-icon" data-tip="调试"><i class="codicon codicon-debug" aria-hidden="true"></i></button>
```

2. **左侧 activity-bar 新增第 4 项**（`#tab-files` 等之后）：

```html
<button id="tab-debug" class="activity-item" data-tip="调试"><i class="codicon codicon-debug-alt" aria-hidden="true"></i></button>
```

3. **`#view-container` 新增 `#view-debug`**（与 `#view-files` 等平级）：

```html
<div id="view-debug" class="sidebar-view hidden">
  <div id="debug-toolbar">…继续/暂停/单步跳过/单步进入/单步退出/停止…</div>
  <div id="debug-stack"></div>    <!-- 调用栈 -->
  <div id="debug-vars"></div>     <!-- 变量 -->
  <div id="debug-breakpoints"></div><!-- 断点列表 -->
</div>
```

### 6.2 视图注册（`views.ts`）

扩展 `SidebarViewId`：

```ts
export type SidebarViewId = "files" | "search" | "git" | "debug";
```

在 `init` 中 `registerSidebarView({ id: "debug", rootId: "view-debug", tabId: "tab-debug", onShow, onHide })`。

### 6.3 JS 模块划分

| 文件 | 职责 | 对标现有 |
|---|---|---|
| `src/dap/client.ts` | DAP 事件订阅、请求封装、会话状态机 | `lsp/client.ts` |
| `src/debugGutter.ts` | 断点 glyphMargin 红点装饰 + 点击切换 | `runGutter.ts` |
| `src/debugView.ts` | 调试侧栏渲染（工具栏/栈/变量/断点）+ handlers 注入 | `runWidget.ts` / `termin　al UI` 模式 |

> v1.1：调试后端无 `debug_install` / 安装引导相关前端模块（零安装方案，见 §3.4）。

### 6.4 断点管理（`debugGutter.ts`）

- 用 `createDecorationsCollection` 在 `glyphMargin` 画红点（复用 `runGutter.ts` 的模式，但独立一套装饰集合，勿与 run gutter 冲突；装饰类名如 `gutter-breakpoint`）。
- Monaco 支持 `deltaDecorations` 的 `beforeContentClassName`/`glyphMarginClassName` 定位到行；点击事件复用 `editor.onMouseDown` 的 `GUTTER_GLYPH_MARGIN` 命中判断（`runGutter.ts` 已有此先例）。
- 断点数据源：`Map<filePath, Set<lineNumber>>`（模块级）。切换文件 / 内容变化时 `refreshDebugGutter()` 重算。
- 同步到 debugger：`didChangeModelContent` 后，对当前文件发 `setBreakpoints`，params = `{ source: { path }, breakpoints: lines.map(l => ({ line: l })) }`。删除整文件断点 = `breakpoints: []`。

### 6.5 调试侧栏（`debugView.ts`）

状态机（模块级）：

```ts
type DebugPhase = "idle" | "starting" | "running" | "stopped" | "exited";
```

- `starting`：已 spawn、等待 initialize/configurationDone。
- `running`：脚本执行中（工具栏「继续/暂停」禁用，「单步」禁用）。
- `stopped`：断点命中，刷新调用栈 + 变量 + 当前行高亮。
- `exited`：会话结束，清空栈/变量。

调用栈渲染：`stopped` 后发 `threads` → 取主线程 → `stackTrace` → 列表帧；点击帧 → `openFile(path, line)` + 定位。

变量渲染：取栈顶 `frameId` → `scopes` → 对 locals scope 发 `variables` → 列表（name / value / type）。

### 6.6 快捷键（`keybindings.ts` 扩展，D4 交付）

| 动作 | 默认键 | 说明 |
|---|---|---|
| `debug` | `F5` | 启动调试（运行中则继续） |
| `debug_stop` | `Shift+F5` | 停止调试 |
| `debug_step_over` | `F10` | 单步跳过 |
| `debug_step_into` | `F11` | 单步进入 |
| `debug_step_out` | `Shift+F11` | 单步退出 |

需同步三处（现有约定）：`keybindings.ts` `KEYBINDING_META` 已注明「def / DEFAULT_SETTINGS.keybindings / Rust default_keybindings 三处保持同步」——新增键位须同样同步三处。

### 6.7 调试运行入口（`main.ts`）

新增 `runDebug()`：

1. `app.activeTab` 校验（Python 文件）+ `prepareRun(path)` 复用（自动保存 / 依赖预检 / 读运行配置）。
2. 先 `invoke("debug_detect", { workspaceRoot })`：
   - 若后端返回「自带 debugpy 缺失」→ 可诊断错误提示（安装包损坏 / dev 环境未运行 `tools/fetch-debugpy.ps1`），**无安装分支**（v1.1，见 §3.4）。
   - 若返回「依赖清单命中 debugpy」→ 输出面板一次性提示「使用自带副本，不冲突，可按需移除声明」，不弹窗不阻断（§3.5）。
3. 成功后：`runChannel` 扩展 or 新增 `debugState`，切到调试侧栏（`setSidebarTab("debug")`），终端承载 stdout。

> 调试态与现有 `running` 状态分开管理（`debugState` 独立），但三态互斥在后端强制。前端 `renderTabs` 的「运行中图标」与停止按钮需区分「运行中」vs「调试中」的 UI 呈现（D4）。

---

## 7. 分阶段任务

### D1 —— 调试运行入口 + debugpy 打包定位

**范围**：Rust `dap.rs` 骨架 + `debug_start` / `debug_detect` 命令 + `locate_debugpy_dir` 定位 + 依赖声明检测（提示性质）+ 会话登记 + 三态互斥 + **打包管线 `tools/fetch-debugpy.ps1`**（v1.1 调整）。

**实现要点**：

1. **打包管线先行**（§3.4）：新建 `tools/fetch-debugpy.ps1`（读 `ci/versions.toml` → 下载 cp310–cp314 五个 wheel → sha256 校验 → 解包合并到 `vendor/debugpy/` → 剔除构建产物）；`build-release.ps1` **与 `build-release.bat`（v1.2 补：计划原文漏列，仓库两份平行打包脚本必须同步）** 在 intel 构建之后、tauri build 之前插入调用；`tauri.conf.json` `bundle.resources` 加 `"../../vendor/debugpy/": "debugpy/"`；`.gitignore` 加 `vendor/`。
2. 新建 `shell/src-tauri/src/dap.rs`，`lib.rs` 注册 `mod dap;` 并加入 `invoke_handler`：
   - `dap::debug_detect`（`locate_debugpy_dir` 结果 + 依赖声明扫描结果，**无子进程探测**）
   - `dap::debug_start`（spawn + 端口预分配 + PTY 落地 + TCP 连接）
3. `locate_debugpy_dir(app)`：四级查找（`PYLUME_DEBUGPY_DIR` → `~/.pylume/runtime/debugpy` → `util::resource_candidates` → dev 仓库上溯 `vendor/debugpy`），同 `lsp.rs::locate_intel_binary` 先例；纯文件系统操作。
4. 互斥（v3.4 收窄）：在 `terminal.rs::run_in_terminal` 脚本分支加 `dap::debug_busy()` 检查；在 `debug_start` 里检查 `terminal::script_run_busy()`；项目实例与调试并存。
5. `debug_detect` 返回 `{ debugpyOk: bool, debugpyDir: string | null, depFound: bool, depFiles: string[] }`。
6. PTY 落地：把 `terminal.rs::start_session` 调整为 `pub(crate)`（或不导出而在 dap.rs 内复用 openpty 模式），会话 id 用新前缀。
7. 单测：`scan_debugpy_dep` 纯函数；端口预分配函数。
8. 文档：`ci/versions.toml` 增加 `[debugger]` 段锁定 debugpy 版本与 sha256；`dev_plan_v2.md` §7 调试项更新状态。

**验收**：已于 2026-09-10 交付，逐项结果见 `docs/debug_acceptance_record.md`。

### D2 —— DAP 桥（协议收发）

**范围**：`dap.rs` 的 `read_dap_frame` / `dap_send_request` / `dap_send_notification` + 前端 `dap/client.ts` + `dap-message` / `debug-exited` 事件接线。

**实现要点**：

1. Rust `read_dap_frame`（仿 `lsp.rs::read_frame`）、`dap_send_request` / `dap_send_notification`（写 `TcpStream`）。
2. 前端 `dap/client.ts`：`listen("dap-message")` 分发；`request(method, params): Promise`（id 自增，Promise 表匹配响应）；`onEvent(method, cb)`；会话状态机。
3. 握手连通性验证：`debug_start` 后立即 `initialize` → 收响应 → 打日志。
4. 单测（Rust）：`read_dap_frame` 帧解析（同 `lsp.rs` 的 `reads_content_length_frame` 用例范式）。

**验收**：已于 2026-09-10 交付，逐项结果见 `docs/debug_acceptance_record.md`。

### D3 —— 断点管理

**范围**：`debugGutter.ts` + `setBreakpoints` 双向同步。

**实现要点**：

1. `debugGutter.ts`：红点装饰 + 点击切换（复用 runGutter 模式）；断点表 `Map<path, Set<line>>`。
2. `refreshDebugGutter()` 挂在 `activateTab` / `closeTabSilent` / `onDidChangeModelContent`（参照 `refreshRunGutter` 的调用点）。
3. 断点变化 → `setBreakpoints` 请求；`stopped` 后支持在暂停态继续增删断点（发 `setBreakpoints`）。
4. 点击 gutter 只在 `.py` / `.pyw` 生效（与 runGutter 一致）。

**验收**：已于 2026-09-10 交付，逐项结果见 `docs/debug_acceptance_record.md`。

### D4 —— 调试态 UI + 当前行高亮

**范围**：`debugView.ts` + `index.html` 布局 + `views.ts` 注册 + `main.ts` 接线 + 快捷键三处同步。

**实现要点**：

1. 侧栏 `#view-debug`：工具栏（继续/暂停/单步跳过/单步进入/单步退出/停止）+ 调用栈 + 变量 + 断点列表。
2. 当前行高亮：`stopped` 事件带 `line` + `source.path`，用 `createDecorationsCollection` 画 `current-line` 装饰（每次 stopped 先 clear 再设）。
3. 调试进程 stdout 走管道（v1.3 修订：ConPTY 下 pydevd 回连 socket 不工作，改管道模式），debuggee stdout/stderr 经管道转发为 `debug-stdout`/`debug-stderr` 事件 → 输出面板（§13.3；调试期 `input()` 暂不支持）。
4. 快捷键三处同步（`keybindings.ts` / `DEFAULT_SETTINGS` / Rust `default_keybindings`）加 §6.6 五项。
5. UI 态：调试运行中，运行组 ▶/⏹ 与 tab 运行图标不误标（区分 debug 态）；停止按钮在调试态路由到 `debug_stop`。

**验收**：已于 2026-09-10 交付，逐项结果见 `docs/debug_acceptance_record.md`。

### D5 —— 收尾：单测补全 + 验收记录

**范围**：补 Rust / 前端单测、边界场景修复、验收记录 `docs/` 存证。

**实现要点**：

1. 单测：`run_env` 复用断言（调试态 probe=false 且 PYTHONPATH 四段一致）、断点同步、帧解析、依赖扫描。
2. 边界：脚本启动失败 / debugpy 端口被抢 / 调试中关闭工作区 / 断点行被删除 / **资源目录被删（安装包损坏场景，报可诊断错误）**。
3. 产出验收记录（含与 PyCharm 同场景人工对标说明，标注「调试能力对标为后续评估项」；补充 §3.1 复核证据存档：VS Code bundled 目录、`__main__.py` 三模式注释、`pydevd_cython_wrapper.py` 回退逻辑）。

**验收**：已于 2026-09-10 交付，逐项结果见 `docs/debug_acceptance_record.md`。

---

## 8. 关键坑与规避

| # | 坑 | 规避 |
|---|---|---|
| 1 | ~~`pip_install` 有 pyproject 时走 `uv add` 写清单~~ | v1.1 已消解：零安装方案不存在安装路径（§3.4）；防御性纪律保留：**永不**用 `pip_install` 安装 debugpy |
| 2 | ~~debugpy 独立 venv 注入的 ABI 绑定~~ | v1.1 已消解：多版本 `.pyd` 共存 + 纯 Python 回退（§3.1），落点=应用资源目录 |
| 3 | 从 PTY 解析端口竞态 | 端口预分配，见 §3.3 |
| 4 | debugpy + probe 同时运行互动未实测 | 调试态 probe 恒 false |
| 5 | 端口预分配释放后被别的进程抢占 | 概率极低；debugpy bind 失败会退出，`debug_start` 报可读错误并允许重试 |
| 6 | DAP 帧解析与 LSP 混淆 | `dap.rs` 独立实现，不 import lsp.rs 私有项 |
| 7 | 调试中关闭工作区留下孤儿进程 | `teardownCurrent` / `resetWorkspaceUiState` 增加 `debug_stop`，进程树清理 |
| 8 | 断点行在编辑后错位 | 只在保存/内容变更后重发 `setBreakpoints`；MVP 不做断点随行迁移（行删除后 debugpy 会停在最接近的可执行行或忽略） |

---

## 9. 验收

Gate E 总验收标准与逐项对照见 `docs/debug_acceptance_record.md` §三；
该文件同时维护 §五「遗留待办（人工验收清单）」8 项。本节不再重复维护验收标准，
以免与验收记录形成双份。

---

## 10. 附录：现有集成点索引

> **v3.4 运行迁移（运行交互重构，专项计划已归档）后更新**：piped 运行路径（`run_script` /
> `stop_script` / `run_slot_busy` / `RUN_CHILD` 等）已删净，运行统一走 PTY；下表为
> 调试链路当前实际依赖的集成点（运行口径以运行交互重构计划为准，该文档已归档）。

**Rust（`shell/src-tauri/src/`）**

| 文件 | 关键符号 | 用途 |
|---|---|---|
| `lib.rs` | `invoke_handler!` | 注册新命令 |
| `lsp.rs` | `read_frame` / `send_message` / `lsp_start` / `lsp_stop` | Content-Length 帧范式（dap.rs 内复刻同款，不跨模块依赖） |
| `terminal.rs` | `run_in_terminal(kind)` / `start_session` / `script_run_busy` / `RUN_TERM_PREFIX` / `term-data`·`term-exit` | PTY 会话 + 真 TTY 运行通道（调试互斥按 §13.2 收窄至脚本运行会话） |
| `env_cmds.rs` | `get_interpreter` / `read_run_config` / `RunProfile` / `pip_install` / `run_uv_streaming` / `tool_command` | 解释器 / 运行配置（`pip_install` 与调试无关，v1.1 起无 debugpy 安装路径） |
| `run_env.rs` | `build_run_env` / `resolve_run_command` / `RunEnv` | 环境统一装配（必须复用；调试链路 probe=false + instance=None，§13.4） |
| `tool_paths.rs` | `tool_command` / `resolve_tool` / `is_available` / `ENV_UV` | uv 定位与 PyPI 镜像注入 |
| `util.rs` | `kill_process_tree` / `no_window` / `unpoison` / `IncrementalUtf8Decoder` | 进程清理 / 隐藏窗口 / 锁 / 增量 UTF-8 |

**前端（`shell/src/`）**

| 文件 | 关键符号 | 用途 |
|---|---|---|
| `main.ts` | `runDebug`（复用 `runFlow.prepareRun`）/ `activateTab` / `openFile` / `renderTabs` | 调试接线 / 编辑器操作（§13.1：prepareRun 为运行与调试共用） |
| `runFlow.ts` | `prepareRun` / `runScript` / `runProject` / `stopRunById` | 运行域（v3.4 多实例模型；调试互斥判定 `isRunBusy` 只看脚本运行） |
| `state.ts` | `app` / `Settings` / `DEFAULT_SETTINGS` / `$` / `outputEl` | 共享状态 / DOM 工具 |
| `views.ts` | `SidebarViewId` / `registerSidebarView` / `setSidebarTab` | 侧栏视图注册（扩展 debug） |
| `runGutter.ts` | `wireRunGutter` / `refreshRunGutter` / `createDecorationsCollection` | gutter 装饰 + 点击命中范式 |
| `runWidget.ts` | `RunWidgetState` / handlers 注入模式 | 按钮状态机范式（四控件：运行脚本 / 运行项目 / 停止 / 配置） |
| `terminal.ts` | `IntegratedTerminal.startRun` / `setTerminalLinkHandler` | 前端 PTY 会话 |
| `termUi.ts` | `runScriptInTerminal` / `stopRunInstanceById` / `wireBottomPanel` / `wireTerminalEvents` | 底部面板接线 / 终端运行（多实例按 id 绑定） |
| `output.ts` | `appendOutputLine` | 输出面板（v3.4 后仅承载调试输出：`debug-stdout` / `debug-stderr` 事件，§13.3） |
| `dap/client.ts` | request/event 封装范式 | DAP client 对标 |
| `dialog.ts` | `openConfirm` / `openChoice` | 确认弹窗（v1.1：调试流程不再依赖安装引导弹窗；保留用于其他场景） |
| `keybindings.ts` | `KEYBINDING_META` / `setKeybindingHandler` | 快捷键（三处同步） |

**遵守规范**：Rust 侧遵循 `.codebuddy/rules/rust-code-style/RULE.mdc`；TS 侧遵循 `.codebuddy/rules/typescript-code-style/RULE.mdc`；所有耗时子进程走 `spawn_blocking` + 明确超时（参考 `env_cmds` 的 `UV_TIMEOUT` / `run_with_timeout` 先例），避免阻塞 idle。v1.1 后调试路径**无安装/网络子进程**（§3.4 零安装），`debug_detect` 为纯文件系统操作。

---

## 11. 实施顺序与里程碑

D1 → D2 → D3 → D4 顺序实施，**已于 2026-09-10 全部交付**
（逐项验收见 `docs/debug_acceptance_record.md`）。
