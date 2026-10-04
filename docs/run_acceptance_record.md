# 运行功能迁移验收记录（M1–M4，运行功能 Gate）

> 日期：2026-09-15（M4 收尾当日）· 依据：运行交互重构计划 v3.4 · 迁移计划（两份专项文档均已归档）
> 环境：Windows 10 19043 · Rust 1.96 · Node 22.12 · Python 3.13.7（uv 管理 venv）· dev 模式（`tauri dev` + WebView2 CDP 9222）
> 前置：M1（后端命令面）· M2（piped 删净 + 调试解耦）· M3（前端运行域重构 + Playwright 实测 11/11）已全部通过（明细见迁移计划执行记录）。

## 〇、M4 概要

M4 以「实测与文档收尾」为纲，最终交付：

| 维度 | 结果 |
|---|---|
| PTY 链路复测（CDP 自动化） | **16/16 PASS**（工作区切换 / 运行 / 历史 / probe 采集 / 多实例并发 / 二选一 / ⏹ / tab 停止） |
| probe 开销正式基准 | **1.35x PASS**（Gate C 红线 < 1.5x；31.0ms plain / 42.0ms probed，best of 3） |
| 多实例并发写库 | **8 进程并行零丢失**（WAL + busy_timeout；`runs.instance` 归属正确） |
| 实测暴露并修复 | **4 个真缺陷**（2 个 probe 采集/开销缺陷 + 1 个退出原因竞态 + 1 个 bench 基建损坏，见 §二） |
| 单测基线 | probe 70 / Rust 118 / 前端 319 全绿；tsc 零错误 |
| 文档收口 | debug 计划附录索引 / ide 计划 v2 条目 / probe README / §19 风险表全部闭环 |

## 一、交付物清单（M4 增量）

| 层 | 文件 | 说明 |
|---|---|---|
| probe | `src/pylume_probe/store.py` | `runs.instance` 列（§19-5 运行实例归属）+ 旧库自动迁移 + `save(instance=)` 环境变量回落 |
| probe | `src/pylume_probe/monitor.py` | 两处修复：窗口延长路径重置 `_quiet`（节流恢复）；静默关窗 `_MIN_DISCOVERY_FLOOR` 时间地板（sitecustomize 噪音免疫） |
| probe | `tests/test_instance_concurrency.py`（新增） | instance 归属 + 旧库迁移 + 8 进程并发写库 |
| probe | `tests/test_monitor.py` | 两个 M4 修复的回归钉 |
| shell Rust | `run_env.rs` / `terminal.rs` / `dap.rs` | probe 四件套（新增 `PYLUME_PROBE_INSTANCE`，terminal 按会话 id 注入 / 调试 None）；删死代码 `run_terminal_busy` / `soft_kill_pid` |
| shell 前端 | `runFlow.ts` / `runState.ts` | `stopping` 标志（\x03 竞态下「用户停止」不再误记 code） |
| shell 前端 | `runHistory.ts` / `main.ts` / `index.html` / `style.css` | M3 中间态收口：保存输出（P2-O）移入历史列表行；`#run-tabs-row` 残留 DOM 与 chip 样式删净 |
| bench | `bench_probe.py`（重建） / `bench_probe.ps1`（修复） | 基准目标脚本曾被覆盖为 scraper 副本（无计时输出）；ps1 补 CWD 锚定 + 纯 ASCII 化 |
| docs | 本文件 / 运行计划（已归档）§5.3·§19 / `python_debug_dev_plan.md` §10 / `python_ide_dev_plan_v2.md` §7 / `probe/README.md` | 验收归档 + 口径回改 + 索引更新 |

## 二、实测发现并修复的缺陷（M4）

### 1. probe 开销回归：quiet 节流失效（1.84x 超红线）

- **现象**：重建基准脚本后 `bench_probe.ps1` 报 1.84x（Gate C 红线 1.5x）；轮数 2000→30000 比值稳定 ~1.84x（边际开销而非固定开销）。
- **诊断**（计数插桩）：60004 次 PY_START 派发中 **57999 次执行 `_sync_active` 全栈回溯**。
- **根因**：`_maybe_close_window` 的窗口延长路径（`_active>0` 保窗）不重置 `_quiet`——`_quiet` 越过 `_QUIET_CLOSE(2000)` 后只增不减，每次派发都命中决策点，CR-01 的「每窗口至多一次回溯」节流失效（`test_sync_active_count_throttled_by_window` 只锁了时间到期路径，没锁静默超限路径）。
- **修复**：延长路径补 `self._quiet = 0`；回溯 60004 → 29 次；基准 **1.35x PASS**。回归钉：`test_quiet_close_path_also_throttled_by_window`。

### 2. PTY 注入链 0 采集：sitecustomize 链噪音误关发现窗口（§19-1 实测项）

- **现象**：dev 应用 PTY 运行 bench_probe.py，probe 摘要 `✓ 0 函数 · 0 类型观测`（CLI inject 同脚本 6 函数）。
- **诊断**（逐层二分 + bootstrap 插桩）：宿主 PYTHONPATH 首段的第三方 sitecustomize（CodeBuddy 安全删除 shim）链式加载 probe 后继续执行自身逻辑，毫秒内涌入 2000+ 次库函数派发——全是「无新函数」，`_QUIET_CLOSE` 瞬间吃满 → 静默关窗（`in_window=False`、`armed=0`）→ 主脚本执行时全局 PY_START 已关、局部事件零 arm → 0 采集。关键排除项：argv[0] 守卫通过、`_classify` 判 True、`get_events=1025` 正常、shim 不占 monitoring tool id、正反斜杠路径无关。
- **修复**：静默关窗加 `_MIN_DISCOVERY_FLOOR = 0.25s` 时间地板（启动噪音在地板内免疫；主脚本 `<module>` 激活后由 `_active>0` 接管保窗；时间到期硬上限不受影响）。端到端复测：PTY 链路 6 函数全采集。回归钉：`test_sitecustomize_noise_does_not_close_window`。
- **边界澄清**：第三方 sitecustomize 遮蔽 probe sitecustomize 的通用风险（README 已知限制）在本场景**未发生**——shim 链式加载了 probe；真实风险是噪音关窗，已修复。打包分发场景（Explorer 启动）无宿主 PYTHONPATH，更无此问题。

### 3. 「用户停止」被误记为自然退出（\x03 竞态）

- **现象**：CDP 复测 tab 停止按钮——进程正确停止，但 `exit.kind="code"`（code=0xC000013A = STATUS_CONTROL_C_EXIT）、历史 `exitKind="code"`，应为 `stopped`（§7.2/§10）。
- **根因**：ConPTY 把 `\x03` 转成 CTRL_C_EVENT 后 Python 立即退出，`term-exit(code)` **先于** `stopRunInstanceById` 的 1200ms 宽限到达 → `onExit` → `settleExited(code)` 覆盖了 stopped 语义。
- **修复**：`RunInstance.stopping` 标志——`stopRunById` / `stopInstancesParallel` / 脚本覆盖语义在发 `\x03` 前置位；`settleExited` 的 code 分支在 stopping 下按 stopped 落档。复测 `exit.kind="stopped"` + `historyExit="stopped"` PASS。

### 4. bench 基建损坏（非产品缺陷）

- `bench_probe.py` 在仓库初始提交即被覆盖为 `scraper.py` 副本（无 `bench:` 计时输出，`bench_probe.ps1` 必然失败）——按 README 记载的「2000 轮 × 3 函数」负载重建；
- `bench_probe.ps1` 依赖调用方 CWD（`-File` 子进程不继承）+ 含中文注释（PS 5.1 GBK 解码坑，`fetch-debugpy.ps1` 同款先例）——补 `Set-Location $here` + 纯 ASCII 化；
- 清理旧版选区运行遗留临时文件 `__pylume_selection__.py`（M3 起临时文件带随机后缀且退出即清理）。

## 三、验收结果

### 4.1 probe PTY 实测（§19-1/5）

| 项 | 结果 |
|---|---|
| PTY 下 probe 不污染 stdout | ✅ 探针摘要走 stderr（终端与历史快照中与 stdout 输出清晰分离，ANSI 剥离正常） |
| 开销 < 1.5x | ✅ **1.35x**（修复 quiet 节流前 1.84x） |
| PTY 注入链采集完整 | ✅ 6 函数 · 11 类型观测（修复 sitecustomize 噪音关窗前 0 函数） |
| 多实例并发写库（§19-5） | ✅ 8 进程并行 `save` 零丢失、归属不串、WAL 生效（自动化用例）；dev 应用端到端：`runs.instance` 按 `run-term-script` / `run-term-project-1` 正确归属 |

### 4.2 稳定性复测（§19-2/3/4）

| 项 | 结果 |
|---|---|
| traceback 混排匹配（§19-2） | ✅ M3 A11（崩溃脚本 traceback 入历史 + 可点跳转）+ M4 全程终端输出正常；回显行/ANSI/告警混排下 link provider 未见漏配 |
| ConPTY `\x03` 生效性（§19-4） | ✅ 长驻 sleep 脚本：⏹ 与 tab 停止按钮均成功停止（CTRL_C_EXIT 立即触发 + 宽限强杀兜底）；退出原因修复后正确记 stopped |
| 长驻覆盖终止（§19-3） | ✅ 多实例场景下覆盖终止（⏹ 停最近 / 二选一停全部 / tab 独立停）全部符合 §10；体验观察项保留（后续日常使用持续） |

### 4.3 前端单测收口

前端 **319 用例全绿**（41 文件）；`tsc --noEmit` 零错误。M3 遗留中间态收口：

- `#run-tabs-row` 残留 DOM（含不可达的「保存当前输出」按钮）删除；保存输出（P2-O）移入历史列表行（每条记录一个保存按钮，语义从「保存最近一条」升级为「保存该条」）。

### 4.4 文档与注释（§17-19）

- `python_debug_dev_plan.md` §10 附录：被删符号（`run_script` / `run_slot_busy` / `RUN_CHILD` / `stopRunTerminal` 等）已更新为 PTY 时代实际集成点（含 §13.2 互斥收窄、§13.4 probe=false、output.ts 调试承载）；
- `python_ide_dev_plan_v2.md` §7 新增「运行交互重构」条目（指向本文与 run 方案）；
- 运行计划（已归档）§5.3 probe 三件套 → **四件套**（`PYLUME_PROBE_INSTANCE`）；§19-1/5 风险项标注结论；
- `probe/README.md`：M4 修复批次（两个缺陷的根因/修复/回归钉）+ Gate C 表更新（1.35x / 70 单测 / WAL 并发）；
- 运行域注释锚定：M3 已按 v3.4 章节号改写（`runFlow.ts` / `runState.ts` / `runWidget.ts` / `termUi.ts` / `output.ts` 等，见 M3 执行记录），M4 无新增 v2/v3.x 残留引用（grep 复核）。

### M4 验收门

- [x] probe 实测记录归档（本文件）✅；
- [x] 全部 §19 风险项有结论：1（probe PTY）✅ 通过（含两个缺陷修复）；2（traceback 匹配）✅；3（长驻覆盖）✅（体验观察转日常）；4（\x03 生效性）✅；5（多实例并发）✅ 落地 instance 归属 + WAL 并发实测；6（ANSI 剥离）M3 已验 ✅；7（多实例复杂度）M3 已验 ✅；8（关 tab 杀进程）M3 已验 ✅；9（调试输出断链）M2 已验 ✅；
- [x] CI 全绿：Rust `cargo test` 118 ✅ · 前端 `npm test` 319 + `tsc --noEmit` 零错误 ✅ · probe `uv run pytest` 70 ✅。

## 四、遗留与后续

| 项 | 说明 |
|---|---|
| §19-3 体验观察 | 「长驻脚本被覆盖终止」的长期体验观察转日常使用（行为已符合 §6.4/§10，无阻塞项） |
| 手测清单残余（M2 遗留） | Logpoint 三路回归、应用退出孤儿进程人工核验——调试侧遗留项，不阻塞运行 Gate（M2 记录在案） |
| M3 未覆盖边界 | preparing 期关 tab（毫秒窗口难自动化）已有 canceled + 补杀 + abortProbe 三层防护（M3 复查记录 #1/#2），人工构造验证成本 > 收益，接受单测 + 代码审查覆盖 |

**结论：运行功能迁移（M1–M4）全部完成，Gate 通过。**
