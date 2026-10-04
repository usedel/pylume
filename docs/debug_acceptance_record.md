# 调试功能验收记录（D1–D5，Gate E）

> 日期：2026-09-10（v1.2 架构修订当日收口）· 依据：`docs/python_debug_dev_plan.md` v1.2
> 环境：Windows 10 19043 · Rust 1.96 · Node 22.12 · Python 3.13.7（用户 venv：ai-learn 项目实测）

## 〇、v1.2 架构修订（真实环境实测后废弃 TCP/--listen 方案，采用 stdio adapter）

**用户实测报告**（2026-09-10）：调试中点停止按钮 → **界面无响应**。以此为起点在真实环境
（用户实际项目 `D:\PycharmProjects\ai-learn` + venv Python 3.13.7）完整复现并定位出
**四个叠加缺陷**，最终以架构级修订收口：

| # | 缺陷（全部实测复现） | 根因 | 修复 |
|---|---|---|---|
| 1 | 点停止 → UI 冻结数秒 | `debug_stop` 是同步 Tauri 命令：主线程执行 `taskkill /T /F`（对 debugpy 进程树可耗时数秒）+ ConPTY master drop（TERMS 锁内） | `debug_stop` 立即返回，清理全部后台线程（CR-10 纪律）；`kill_session`/`kill_session_internal` 改「锁内取出、锁外 drop」 |
| 2 | 调试会话 30s 连接超时（10061） | Tauri `resource_dir()` 返回 `\\?\` verbatim 路径，作为 `python <路径>` 参数使 debugpy 自举 import 失败（ModuleNotFoundError） | `locate_debugpy_dir` 出口统一剥 verbatim 前缀（含单测） |
| 3 | 同上（修 2 后依旧） | debugpy `--listen` 是两段式：debuggee 进程内部再 spawn adapter 子进程并等它回连（内部 listener 30s 超时）——**在 ConPTY 环境下该内部 spawn 完全不工作**（管道模式 12.8s 能连，系统繁忙时更久；ConPTY 下 30s+ 不连） | **架构反转**：Rust 自己 spawn stdio adapter（管道，DAP 走 adapter stdin/stdout，同 lsp.rs 模式）；debuggee 以 `--connect` 连 adapter 的 server socket（地址经 `debugpyWaitingForServer` 事件获得）；debuggee 亦改管道 spawn（stdout → 输出面板） |
| 4 | adapter 拒绝 debuggee 连接 | stdio 模式 adapter 生成随机 access_token，无 token 的 `--connect` 被 `Mismatched clientAccessToken` 拒绝 | `attach` 请求带 `{"listen":{"host":"127.0.0.1","port":0}}`：走「server 主动连入」路径（clients.py:477-486），同时清空 adapter token（servers.py 双 None 跳过鉴权） |

**新架构时序**（全链路真实 debugpy 验证，2.2s 完成）：
```
Rust spawn stdio adapter（管道）
→ initialize → attach{listen} → [debugpyWaitingForServer {host,port}]
→ debug_attach_debuggee（Rust 管道 spawn：python <debugpy>/__main__.py --connect host:port --wait-for-client <脚本>）
→ [initialized] → setBreakpoints → configurationDone → stopped/continued/...
```

**ConPTY 结论**（二分验证：禁用全部注入 env 后 debuggee 仍不回连 → 与环境变量无关）：
pydevd 的网络线程在 ConPTY 环境下无法正常建连（`--listen`/`--connect` 两种模式都翻车）。
调试相关进程（adapter + debuggee）全部走管道；**调试期脚本 stdout/stderr 落输出面板**，
终端交互（input()）暂不支持——列为后续增强（需先解决 ConPTY 兼容或改用独立终端方案）。

**遗留待办更新**：§五 人工验收清单中「print/input() 走 PTY 交互」一项受架构修订影响，
改为「调试输出落输出面板（已验证）；PTY 交互为后续增强」。

## 一、交付物清单

| 层 | 文件 | 说明 |
|---|---|---|
| 打包 | `tools/fetch-debugpy.ps1` | sha256 锁定拉取 cp310–cp314 五 wheel，解包合并 + 剔除构建产物，幂等 |
| 打包 | `ci/versions.toml [debugger]` | debugpy 1.8.21 + 五个 sha256 |
| 打包 | `build-release.ps1` / `build-release.bat` | 均插入 2.5 步调用（bat 为计划遗漏项，实施时补上） |
| 打包 | `tauri.conf.json` / `.gitignore` | bundle.resources 映射 + vendor/ 不入库 |
| Rust | `src-tauri/src/dap.rs`（新增） | DAP 客户端 + debugpy 会话管理（约 700 行含 15 单测） |
| Rust | `lsp.rs` / `terminal.rs` / `lib.rs` | 三态互斥接线 + `start_session`/`kill_session_internal`/`session_exists` 导出 + 退出清理 |
| 前端 | `src/dap/client.ts`（新增） | DAP 请求/事件封装 + 会话状态机 |
| 前端 | `src/debugGutter.ts`（新增） | 断点红点 + 点击切换 + setBreakpoints 同步 + 当前行高亮 |
| 前端 | `src/debugView.ts`（新增） | 调试侧栏（工具栏/调用栈/变量/断点列表） |
| 前端 | `index.html` / `views.ts` / `style.css` / `main.ts` / `keybindings.ts` / `state.ts` | 布局 + 视图注册 + 接线 + 快捷键三处同步 |

## 二、与计划的实施偏差（反馈修订项）

### 1. §5.3 启动时序：补 `attach` 请求（关键修正）

计划原文时序 `initialize → setBreakpoints → configurationDone` 在 debugpy CLI `--listen` 模式下**不成立**。实测（spike 复现）：

- 不发 `attach` 直接 `setBreakpoints` → **"Server is not available"**（adapter 的 server 组件在 attach 前未连接，见 `debugpy/adapter/clients.py`）；
- `attach` 的 arguments 必须为**非空 dict**（`pydevd_schema.AttachRequest` 把 `{}` 当 falsy → `missing argument 'arguments'`）；最小合法：`{"justMyCode": true}`；
- `attach` 的响应**推迟到 configurationDone 才返回**（`clients.py` 返回 `NO_RESPONSE`），发出后不可等响应，以 `initialized` 事件（DAP 规范）作为可配置信号。

正确时序（已在 `dap/client.ts` 实现并经 spike 全链路验证）：

```
connect → initialize → attach({"justMyCode":true}) → [initialized 事件]
→ setBreakpoints → configurationDone → stopped/continued/output/terminated/exited
```

### 2. §5.2 uv 兜底命令修订（spike 实测，2026-09-10）

计划原文 `uv run --no-project <debugpy目录> …` **不可用**：uv 把首参目录当可执行命令 spawn → `os error 3 系统找不到指定的路径`。

实测结论（五种形态）：

| 形态 | 结果 |
|---|---|
| `python <dbgpy>/__main__.py --wait-for-client <脚本>` | ✅ 挂起等待客户端，握手后正常执行（未连客户端时脚本不执行，符合 D1 验收） |
| `python <dbgpy>/__main__.py`（无 --wait-for-client） | ✅ 直接执行完毕（入口正确性证明） |
| `uv run --no-project <dbgpy目录> …` | ❌ os error 3（计划原文，废止） |
| `uv run --no-project python <dbgpy>/__main__.py …` | ✅ 挂起等待客户端（**采纳**：保留零写入决策，加显式 python） |
| `uv run python <dbgpy>/__main__.py …` | ✅ 同样可用（但可能写项目 venv/uv.lock，与「零写入」冲突，未采纳） |

采纳：`uv run --no-project python <资源目录>/debugpy/debugpy/__main__.py --listen 127.0.0.1:<port> --wait-for-client <fname> <args…>`。附注：uv 兜底分支下 `--no-project` 使调试运行在无项目依赖的临时环境——「无解释器 + 有 pyproject」场景的调试会缺第三方依赖（与普通运行的 uv run 语义差异），单人自用 MVP 接受此差异（此时用户本来也未配置解释器）。

### 3. §7 D1 打包脚本缺口：`build-release.bat` 未在计划中列出

仓库有 `.ps1`/`.bat` 两份平行打包脚本，计划只提到改 `build-release.ps1`。若只改 ps1，全新 clone 跑 bat 会在 tauri build 因资源缺失而断。实施时两份均已插入调用（步骤 2.5）。

### 4. 实施补充（非偏差，记录设计决策）

- **PTY 会话退出监视**：`start_session` 的退出监视线程只清 TERMS + emit term-exit；dap.rs 另起轮询线程（seq 锁定，200ms）监视会话消失，自动清 DEBUG 槽 + emit debug-exited——否则 debugpy 自然退出后 `debug_busy()` 永久占位，无法开启下次调试（§8 坑 7 的状态层变体）。
- **调试进程 pid 持有**：PTY child 由 TERMS 持有（`Box<dyn Child>`），dap.rs 只记 pid；`debug_stop` 走 `taskkill /T /F` 清进程树（与 `kill_process_tree` 同口径），`kill_session_internal` 只清槽不重复 kill（避免竞争）。
- **TCP 连接重试**：spawn → debugpy bind 有竞态，connect 以 100ms × 50 次重试（上限 5s），失败清会话并报可读错误（§8 坑 5 的缓解）。
- **DAP seq 单序号域**：`dap_send_request` 的前端 `id` 直接作为出站 `seq`（debugpy 响应以 `request_seq` 回显请求 `seq`），通知/响应用独立 100_000 起始的序号域隔离。
- **stdin=file 拒绝调试**：与 `run_in_terminal` 同口径 fail fast（PTY 无法接管文件）。
- **`output` 事件忽略**：stdout 已走 PTY 真 TTY，DAP output 事件不再显示（避免双份）。
- **PS 5.1 编码坑**：`fetch-debugpy.ps1` 必须纯 ASCII——无 BOM UTF-8 脚本的中文注释会被 ANSI(GBK) 解码吞掉换行、把代码行并进注释（实测坑，脚本头部已注明）；读 `versions.toml` 必须显式 `-Encoding UTF8`。

## 三、验收结果

### D1 验收

- [x] `tools/fetch-debugpy.ps1` 幂等可复现（sha256 锁定；二次运行跳过，`-Force` 强制重拉）；产物 278 文件 / 8.18 MB，无 `*.c`/`*.pdb` 等构建产物（剔除 32 个）
- [x] 安装包体积：vendor 目录 8.18 MB（计划实测口径 8.74 MB 同量级；压缩增量预期 ~2.7 MB ≤ 3 MB 上限）
- [x] `debug_start` 独立拉起自带 debugpy 并建立 TCP 连接（spike 验证：connect → initialize → 全握手）；`--wait-for-client` 未发 configurationDone 时脚本不执行（spike T1：挂起 30s 无输出）
- [x] `debug_detect` 返回 debugpyOk + 包目录；资源缺失时前端输出可诊断错误（无安装分支）
- [x] 零安装：调试全程无 pip/uv install 路径；debugpy 副本从应用资源目录加载（`sys.path[0]` 自举，用户环境 site-packages 无写入）
- [x] 三态互斥：`run_script`/`run_in_terminal`/`debug_start` 三处相互检查（代码接线验证）
- [x] 依赖清单命中 debugpy → `depFound:true` + 文件列表（单测 9 个覆盖 requirements/pyproject/poetry/注释/多命中/无命中）
- [x] `cargo test` 全绿（93 个，含新增 15 个）

### D2 验收

- [x] 前端能 `initialize` 并收到 debugpy 响应（spike [2]）
- [x] `dap-message` 事件到达前端，请求/响应 id 匹配（单序号域设计；spike [3]–[8] 全链路请求-响应匹配）
- [x] 帧解析单测全绿（4 个：双帧连续/空输入/缺头/超上限）

### D3 验收

- [x] gutter 红点增删（glyphMargin 装饰 + 点击切换，仅 .py/.pyw）
- [x] 断点同步：`setBreakpoints` verified:true（spike [3]）；`configurationDone` 后断点行暂停（spike [5]：line 3 命中，reason=breakpoint）
- [x] 断点表模块级持久（跨会话保留；`pushAllBreakpoints` 下次启动重放）
- 注：「切换文件/编辑后不串位」与「暂停态增删断点」属 UI 交互项，需运行应用人工验收（见 §五 待办）

### D4 验收

- [x] 侧栏四区（工具栏/调用栈/变量/断点列表）+ activity-bar 第 4 项 + 菜单栏调试按钮
- [x] 当前行高亮（stopped → 栈顶帧行装饰，continued 清除）
- [x] 调试进程 stdout 走 PTY（复用 `terminal::start_session`，id 前缀 `debug-term-`）
- [x] 快捷键五件套三处同步（KEYBINDING_META / DEFAULT_SETTINGS / default_keybindings，键位数断言 11→16）
- [x] 调试态与运行态区分（runWidget 停止按钮按 phase 路由；tab/按钮不误标）
- 注：「步进 UI 全可用 + 当前行随步进移动」「print/input 走 PTY 交互」需运行应用人工验收

### D5 验收

- [x] 单测全绿：Rust 93（新增 15）+ 前端 155；tsc / vite build 通过
- [x] 边界：stdin=file 拒绝（fail fast）；TCP 连接失败清会话；应用退出同步清调试进程（`debug_stop_for_exit`）；调试中关闭工作区 → `teardownCurrent` 停调试
- [ ] 边界：端口被抢重试（低概率，逻辑已覆盖：bind 失败 debugpy 退出 → connect 重试 5s 超时报错）
- 注：进程树无残留的系统性验证需运行应用（taskkill /T /F 路径与 lsp/terminal 同口径）

### Gate E 总验收对照（§9）

1. 最小闭环 6 项：协议层全部验证（spike），UI 层待人工验收
2. 打包分发 + 体积增量 ≤ 3MB + 零写入：✅（vendor 8.18MB/278 文件；无安装路径）
3. 依赖声明提示：✅（一次性输出面板提示，不弹窗不阻断）
4. 三态互斥 + 进程树清理：代码接线完成 ✅，人工验收待办
5. PTY stdout：复用已验证的 start_session 通道 ✅（run_in_terminal 同路径已上线）
6. 断点/栈/变量/高亮真实脚本验证：spike 级验证（多级函数调用：add→main→module，3 帧）✅，UI 级待人工
7. 快捷键五件套：三处同步 + keydown 路由 ✅，设置面板改键生效待人工
8. 单测全绿 + versions.toml 锁定 + 验收记录（本文档）：✅

## 四、PyCharm 同场景对标说明

「调试能力对标」为后续评估项（计划 §7 D5 原文）。本次仅交付最小闭环，不做逐项对标。

## 五、遗留待办（人工验收清单）

**真实环境最终验证（2026-09-10，用户实际项目 ai-learn + venv，CDP 驱动真实应用）已通过**：
```
断点设置 → F5 启动 → stopped at breakpoint → 调用栈渲染
→ 点停止按钮：516ms 清场、UI 最大帧间隔 17ms（零冻结）
→ 停止后可重启（互斥锁正确释放）→ 二次停止 ✓
```

运行应用后逐项确认（开发态需先 `powershell -File tools/fetch-debugpy.ps1`）：

1. 断点 gutter 点击增删、切文件/编辑不串位（E2E 已覆盖，人工抽查）
2. 断点暂停 → 侧栏调用栈 + 变量显示、编辑器当前行高亮（E2E 已覆盖）
3. 继续/单步跳过/单步进入/单步退出/停止按钮与快捷键（E2E 已覆盖键盘+按钮双路径）
4. ~~`print`/`input()` 彩色输出与交互（PTY）~~ → **v1.2 修订**：调试输出落输出面板（已验证）；PTY 交互为后续增强
5. 调试中普通运行被拒绝（三态互斥）（代码接线已验证，人工抽查） → **✅ 2026-10-03 已自动化**：`e2e-real/debug-real.cjs` 新增 `R-REAL-9`（运行按钮 `aria-disabled=true` + `data-tip="调试进行中，请先停止调试"`，点击被静默拦截：无 toast、调试态不变）
6. 调试退出后进程树无残留（E2E bridge 侧已验证 debuggee 被杀；人工抽查任务管理器） → **✅ 2026-10-03 已自动化**：`R-REAL-8` 实测 python 进程 3 → 2
7. 设置面板改键后调试快捷键生效 → **✅ 2026-10-03 已自动化**：`R-REAL-11`（设置面板录入 F6 → 无冲突 → `settings.json` 落盘 F6）+ `R-REAL-12`（**新键 F6 能启动调试并命中断点，旧键 F5 无效果**）
8. `build-release.ps1` 全流程出包 + 安装后调试可用（真安装包验收） → **✅ 2026-10-03 已完成**：出包链路修复后打出安装包（8.63 MB），安装至 `D:\Pylume`（四项自研组件随包落地：`pylume-shell.exe` 20.58 MB / `pylume-intel.exe` 4.75 MB / `probe/src` / `debugpy`），`e2e-real/release-real.cjs` 对**安装后的程序**实测 **7/7 PASS**（含 debugpy 随包可用、运行脚本真实输出 `RESULT 11 22`）

### 5.1 第 8 项阻塞说明（2026-10-03）

### 5.1 第 8 项出包阻塞与解决（2026-10-03）

**当时的现象**：`npx tauri build` 稳定链接失败（`LNK2019: __imp_memchr / __imp_strchr / __imp_strrchr` 未解析，全部来自 bundled SQLite 的 `sqlite3.o`；`LNK1120: 3 个未解析`）。

**根因（两层）**：① 本机 PATH 里的 MSVC 是 VS2015 RTM，其 `VC\lib` 既无 `ucrt.lib` 也无 `__imp_*` 符号（UCRT 自 VS2015 后期起改为随 Windows SDK 分发）；② **tauri CLI spawn cargo 时用自己的 MSVC 探测覆盖 rustc 的探测结果**，只留 VS2015 的 lib —— 因此所有"给 cargo/tauri 传环境变量"的修法都会被覆盖掉（实测 4 种均无效：`LIBPATH` / `LIB` / `WindowsSdkDir` / `RUSTFLAGS=+crt-static`）。已排除代码问题：手动 `cargo build --release` 链接成功。

**修法（方案 A + 进程级环境装配）**：

1. 安装 **VS Build Tools 2022**（MSVC 14.44.35207 + Windows SDK 10.0.26100.0）到 `D:\VSBuildTools`。
   ⚠️ **踩坑**：非管理员安装会导致**实例未写入注册表**（`vswhere` 返回空），cargo/cc 仍探测到 VS2015 —— 必须以管理员身份安装，让 `vswhere` 能查到实例。
2. 新增 **`tools/msvc-env.ps1`**（`Import-MsvcEnv`）：用 `vswhere` 定位工具链，在**进程环境**里前置 `link.exe` 与 SDK 的 `LIB` / `INCLUDE`。选进程环境而非 `.cargo/config.toml`，正是因为 tauri 只覆盖自己 spawn 的子进程环境、而 `.cargo/config.toml` 里的 `link-arg` 在含空格路径上会被 rustc 截断（表现为 `LNK1181` 找不到 `Files.obj`）。
3. `build-release.ps1` 在任何 cargo/tauri 调用**之前** dot-source 该脚本；同时新增 `Invoke-Native` 包装 —— PowerShell 的 `$ErrorActionPreference="Stop"` 会把 cargo/npm 写到 stderr 的进度行（`Finished release profile …`）当成致命错误，导致构建 5 秒后假失败。

**解决后实测**：`npx tauri build` 成功出包（8.63 MB）；安装至 `D:\Pylume`，四项自研组件随包落地（`pylume-shell.exe` 20.58 MB · `pylume-intel.exe` 4.75 MB · `probe/src` · `debugpy`）；`e2e-real/release-real.cjs` 对**安装后的程序**实测 **7/7 PASS**。

- 完整根因、证据、候选修法对比：[`bench/reports/release-build-blocker.md`](../bench/reports/release-build-blocker.md)
- 附带发现：安装包 `/S` **静默安装无效**（退出码 0 但无文件、无注册表项），故验收走"安装后程序 + CDP"，不用静默安装。
- `e2e-real/release-real.cjs` 默认从注册表 `HKCU\...\Uninstall\Pylume\InstallLocation` 读安装路径（NSIS 允许 `/D=` 覆盖，不能写死 `%LOCALAPPDATA%\Pylume`）；可用 `OC_RELEASE_EXE` 覆盖为构建产物路径。

### 5.2 本轮真机验收附带发现的产品缺陷

| 编号 | 缺陷 | 证据 | 严重度 |
|---|---|---|---|
| **D-7** | 调试中「运行脚本」**菜单项未置灰**（按钮路径正确置灰）。`main.ts:1789` 的 `disabled` 只看 `scriptBusy`、漏了 `debugging`，而 `disabledReason` 却含"调试进行中"——自相矛盾。后果：菜单项可点 → 走 `runScript()` → 由 Rust `terminal.rs:339` 兜底报错 → 用户看到 toast + 终端红字，而非预期的置灰 | `e2e-real/debug-real.cjs` `R-REAL-10`（诊断项） | 中（体验不一致，非功能失效） |
| **D-8** | 改键后**调试工具栏 tooltip 的键位副文本不刷新**。键位副文本只在 `renderToolbar()` 时更新（`debugView.ts:101` 注释已说明），而 `settingsPanel.ts:924-927` 保存后的刷新清单里没有调试工具栏。后果：`F5 → F6` 保存后，功能已生效（`R-REAL-12` 证明），但 tooltip 要等下一次 phase 变化才显示新键 | `R-REAL-11` detail：`落盘 F6` 但 `data-tip-key` 仍为 `F5` | 低（仅显示滞后） |

> 另两条 `#btn-debug` 调试中点击是**静默 no-op**（既不置灰也无提示，`main.ts:2676-2677`）、window 级 keydown 路由（`main.ts:2328-2340`）无调试态判定——这两点符合"三态互斥收窄裁决 10"的设计意图（项目实例放行），不算缺陷，但**菜单/快捷键路径的反馈与按钮路径不一致**（见 D-7）值得统一。

