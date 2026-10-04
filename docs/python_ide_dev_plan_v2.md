# Pylume 开发计划 v2

> 版本：v2.0 · 日期：2026-08-20 · 状态：进行中（Phase 4 打磨，进度见 §7）
> 取代 `python_ide_dev_plan.md`（v1.0，Phase 0/1 为 Zed 中心，已因换壳过时）
> 上游文档：`python_ide_tech_plan_v3.md`（技术方案 v3）
> 本文档面向开发团队，是排期与执行的唯一依据；技术方案与本文档冲突时，以本文档为准并反馈修订。

## 1. 项目概述

### 1.1 目标

为单人自用场景构建 Python IDE（代号 Pylume）：

- **外壳**：Tauri 2 + Monaco（Vanilla TS + Vite），2026-08-20 裁决；
- **静态语义**：Pyrefly（默认）/ basedpyright（备选），经自研 LSP 桥接层挂载（ADR-0003），第一天即可切换；
- **差异化核心**：运行时类型采样（PEP 669）+ 自研运行时智能 LSP（pylume-intel）；
- **功能范围**：补全 / 跳转 / Hover / 诊断 + 智能 live template + 脚本/项目运行（统一 PTY 控制台）与 traceback 点击跳转；
- **明确不做**：pytest 面板、AI 能力、插件市场、协作编辑；调试（DAP）推迟到 Phase 3 后评估。

### 1.2 关键验收指标（项目级，v2 修订）

| 指标 | 目标值 | 变更说明 |
|---|---|---|
| 编辑器冷启动 | < 1.5 s（release） | 原 <300 ms 为 Zed 基线，过时；重新实测 |
| 空闲内存（编辑器 + LSP 合计） | **≤ 600 MB** | 原 <400 MB 为 Zed 基线；spike 实测 ~420 MB，产品负责人已裁决放宽 |
| 有注解代码补全准确率 | ≥ 95% | 不变 |
| 跳转准确率 | ≥ 95% | 不变 |
| **运行过的无注解代码补全准确率** | **≥ 85%，且 ≥ PyCharm 同场景** | 不变（核心差异化指标） |
| 运行时探针开销 | < 1.5x 执行时间 | 不变 |

### 1.3 技术基线（全员统一）

| 项 | 要求 |
|---|---|
| 操作系统 | Windows 为主（用户环境），构建产物需在 Windows 验证 |
| Python | ≥ 3.12（PEP 669 依赖）；本机 uv 管理的 3.13.7 |
| 包管理 | uv + pyproject.toml（Python 侧）；cargo（Rust 侧）；npm（前端侧） |
| Rust | 1.96.0（x86_64-pc-windows-msvc） |
| 前端 | Node 22.12 / npm 10.9.2；TypeScript + Vite |
| 外壳 | Tauri 2.11.x + Monaco 0.52.2（本地打包，禁 CDN） |

## 2. 团队与协作（不变）

| 角色 | 人数 | 职责范围 |
|---|---|---|
| 产品负责人（用户本人） | 1 | 真实使用验证、每阶段验收打分、需求裁决 |
| Rust 工程师 | 1 | shell Rust 侧、LSP 桥、pylume-intel |
| Python 工具链工程师 | 1 | pylume-probe、trace 库、bench 脚本 |
| 基础设施（兼职） | 0.5 | CI、版本锁定、回归测试自动化 |

协作机制不变：kickoff / gate 评审 / 周报 / ADR。

## 3. 仓库与工程结构

```
open-charm/
├── docs/                    # 方案、开发计划、ADR、差距清单、验收报告
│   └── adr/
├── shell/                   # Tauri 2 + Monaco 外壳（Phase 1 重建）
├── bench/                   # 基准项目集 + 指标采集脚本 + 历次报告（Phase 1 重建）
├── probe/                   # pylume-probe（Phase 2 重建）
├── intel/                   # pylume-intel（Phase 3 重建）
└── ci/                      # 回归测试与自动化脚本（Phase 1 重建）
```

约定不变：probe 与 intel 是**完全独立的进程/包**，不依赖外壳内部 API（架构第一原则）；主干开发 + 短分支 PR；CI 全绿才可合并。

## 4. Phase 1 · 外壳重建期（第 1-8 周，约 2 个月）

**目标**：交付「Pylume Shell 1.0」——Tauri+Monaco 外壳最小闭环：编辑器 + 文件树 + 多标签 + 可配置智能 live template + pyrefly LSP（补全/跳转/Hover/诊断）+ 运行按钮 + traceback 点击跳转。

> 范围裁决（2026-08-20，产品负责人）：**最小闭环**。集成终端（xterm.js）、Git 状态、全局搜索后置到 Phase 1 后期或 Phase 4；调试推迟到 Phase 3 后。

| 编号 | 任务 | 角色 | 工作量 | 依赖 | 交付物 / 验收 |
|---|---|---|---|---|---|
| S1-T01 | 工程骨架：Vite + TS + Tauri 2 + Monaco 本地 npm 打包（去 CDN、worker 配置） | Rust 工程师 | 1 周 | — | `npm run build` + `cargo build` 全绿；dev 热更新可用 |
| S1-T02 | 编辑器核心：多标签页（单 Monaco 实例 + model 切换）+ 递归文件树 + 保存（Ctrl+S） | Rust 工程师 | 1.5 周 | S1-T01 | 打开/切换/保存闭环；文件树多层目录可导航 |
| S1-T03 | **智能 live template 正式化**：可配置 JSON（模板体 + 上下文优先级）+ 上下文感知排序 + preselect | Rust 工程师 | 1.5 周 | S1-T02 | 模板可增删改；module/class/function 上下文排序正确；`⚡ All templates` 强制全显 |
| S1-T04 | LSP 桥接层（ADR-0003）：Rust stdio 桥（spawn/帧解析/事件转发）+ TS JSON-RPC + Monaco providers（completion/hover/definition/diagnostics） | Rust 工程师 | 2 周 | S1-T02 | pyrefly 补全/跳转/Hover/诊断可用；增量同步（didChange）正确 |
| S1-T05 | 运行与 traceback：运行按钮（`uv run`，cwd 锚定文件目录）+ 输出面板 + `File "…", line N` 正则识别点击跳转 | Rust 工程师 | 1 周 | S1-T02 | 5 类错误（运行时/语法/导入/断言/嵌套调用）全部可点击跳转 |
| S1-T06 | Windows 专项：中文输入法兼容（WebView2 + Monaco）+ 内存/冷启动实测（release） | 全员 | 0.5 周 | S1-T04 | 输入法无异常；内存 ≤ 600 MB；冷启动 < 1.5 s |
| S1-T07 | bench 基准项目集重建 + 引擎版本锁定 + 回归 CI | Python 工程师 + 基础设施 | 1 周 | — | `bench/` 可一键产出指标报告；`ci/versions.toml` 锁定 |
| S1-T08 | **Gate B 评审** | 全员 | 0.5 天 | 全部 | 见验收标准 |

**Phase 1 验收标准（Gate B）：**

1. 智能 live template：上下文感知排序 + preselect 生效，模板可配置（换壳直接动因，最高优先级）；
2. pyrefly 补全/跳转/Hover/诊断经 LSP 桥可用，有注解代码补全 ≥ 95%、跳转 ≥ 95%（bench 实测）；
3. traceback 点击跳转 5 类错误全部通过；
4. 内存 ≤ 600 MB、冷启动 < 1.5 s（release 实测）；
5. 中文输入法无异常；
6. 引擎切换演练：pyrefly ⇄ basedpyright 改配置即生效。

## 5. Phase 2 · 运行时采样期（第 9-24 周，约 4 个月）

**目标与任务不变**（见 v1 计划 §6，P2-T01~T09）：交付 pylume-probe——PEP 669 采集、类型紧凑表示、采样限流、SQLite trace 库、与 `uv run` 集成自动注入。

**v2 增补**：运行集成（P2-T06）的注入点从「Zed task」改为「shell 运行按钮/task 系统」；trace 库路径约定 `~/.pylume/traces/` 不变。

**Gate C 验收标准不变**：探针开销 < 1.5x；trace 正确率抽检 ≥ 98%；采集无感；trace 库稳定。

## 6. Phase 3 · 混合智能期（第 25-40 周，约 4 个月）

**目标与任务基本不变**（见 v1 计划 §7，P3-T01~T10），挂载对象从「Zed 多 LSP」改为「Monaco LSP 桥」：

- P3-T06 原「Zed 多 LSP 合并 spike」**作废**——合并策略在自家 Monaco 桥内实现（三层 sortText：模板 `0xx` / 运行时 `1xx` / 静态 `2xx`），无需 spike 验证第三方行为；
- 新增 P3-T06'：intel 挂载到 LSP 桥（spawn pylume-intel，补全项标注 `⟳ runtime`，sortText `1xx` 段）；
- 其余（trace 索引层、补全/跳转 provider、hover + inlay hints、新鲜度、降级开关、A/B 对标）不变。

**Gate D 验收标准不变**：运行过的无注解代码路径补全 ≥ 85% 且 ≥ PyCharm；动态架构样例跳转可用；运行时层可一键关闭。

## 7. Phase 4 · 打磨期（第 41 周起，持续）

> 进度（**2026-10-03 回填**，上一版 2026-08-24）：Phase 3（pylume-intel）P3-T01~T09 已交付，仅剩 **P3-T10 的两格 PENDING**——「≥ PyCharm 同场景人工横向对标」+「真实项目 trace 端到端」（确定性口径已 PASS：`bench/reports/gate-d-runtime-completion.md` 23/23 = 100%，红线 ≥85%）。项目已实际进入本阶段。
> **逐功能域的交付日期 · 计划真源 · 验收记录 · 状态，见 [`docs/delivery-overview.md`](delivery-overview.md)（20 个功能域总表）**；本表只保留打磨期任务与后续功能域的粗粒度状态。全局改进优先级见 `docs/tech-debt.md`。

| 任务 | 说明 | 状态 |
|---|---|---|
| 上游跟随 | Tauri / Monaco / Pyrefly / basedpyright / ruff 升级走回归 CI | ✅ 版本已锁定（`ci/versions.toml`）；**主干触发已修**（`ci.yml` 的 `on.push.branches` 2026-10-03 由 `[main]` 对齐为 `[master, main]`）；**`nightly.yml` 已建**（`schedule` 每日：真机全量 + bench 红线 + 预算门禁，失败只告警）；⏳ 升级回归演练仍未固化 |
| 体积与规模预算 | 给唯一逆势增长的文件与巨型文件装刹车 | ✅ **已交付**（2026-10-03）：`ci/budgets.toml` + `shell/scripts/budget-check.mjs` + `tools/stats/repo-stats.mjs`（阈值只允许显式 PR 抬升，含 `.ps1` 编码卫生检查）；本机 10 项全绿 |
| 外壳基本功补齐 | 集成终端（xterm.js + portable-pty 多会话）、Git 集成（状态装饰 + 暂存/提交/diff/分支起步，后续扩展远程/worktree/rebase 等）、全局搜索（`ignore` crate 遍历 + 自实现并行匹配） | ✅ 已交付 |
| 打包发布 + 首次启动环境引导 | 自研组件（`pylume-intel`、`probe/src`）随 NSIS 安装包分发（`bundle.resources`，运行时按 `locate_*` 查找资源目录）；外部命令（uv/pyrefly/ruff/git）统一经 `shell/src-tauri/src/tool_paths.rs` 解析（环境变量 → `~/.pylume/bin`/`~/.local/bin` → 系统 PATH）；全新系统缺 uv/pyrefly 时由 `toolchain.rs` 探测、前端弹「环境引导」一键安装到用户目录；`build-release.ps1` 一键打包（清理 → intel release 构建 → 前端依赖 → `tauri build` nsis） | ✅ 已交付（Phase 4 第 1~4 步） |
| 调试评估 | debugpy DAP 集成是否立项（Phase 3 后裁决） | ✅ 已立项并交付最小闭环（`docs/python_debug_dev_plan.md` v1.3：debugpy 1.8.21 随包分发 + DAP 桥 + 断点/步进/调用栈/变量；验收记录 `docs/debug_acceptance_record.md`，人工验收清单待办） |
| 运行交互重构 | 「两种运行 + 统一运行控制台」（脚本/项目运行 + PTY 终端控制台 + 多实例并行 + 运行历史按实例归属；probe 运行路径开启并实测 1.35x < 1.5x） | ✅ 已交付（迁移计划 M1-M4 全部完成；验收记录 `docs/run_acceptance_record.md`） |
| trace 新鲜度优化 | 基于真实使用数据调整降权/清理策略 | 🔄 **已取得首个实测依据**（2026-10-03）：`tools/intel/trace_stats.py`（只读分析器）已落地；本机此前无任何 `traces/*.db`，用 IDE 同款注入 env 跑真实代码产出 56 函数 / 177 观测；**stale 实验（改 1/2 文件后只跑另一半）测得 stale 占比 30.0%**；`completion.rs` 的 `f.hits / 2` 已提成具名常量 `STALE_HITS_DIVISOR`（值不变）+ 注释记录依据 + 新增单测钉住降权行为（33/33）。⏳ 系数最终值待真实项目 ≥1000 条观测后复核；人工对标工作单 `bench/reports/gate-d-ab-worklist.md` 已自动生成（Pylume 列已填好），⏳ 只差真人在 PyCharm 里勾 23 点 |
| 边角修复 | 产品负责人日常使用反馈驱动 | 🔄 持续中 |
| 边角修复 · live template 上下文位置轴 | 模板上下文从「容器单轴」升级为「容器 × 位置 × 词法」三维（专项计划已归档）；缺省位置 = statement+expression（排除 name），根治 `main` 撞函数名误触发 | ✅ 相位 A + 相位 B（PyCharm `<context>` 导入映射 + 管理面板适用环境多选）均已交付（2026-09-25；注记原在修订稿 §8/§9，该稿已归档） |
| 库特别支持 | `re` 三件套 / 格式串 / JSON / 求值桥 / 脚本参数表单（专项计划已归档） | ✅ 已交付（P0 四件套 + P1 五件套，2026-09-28） |
| 依赖健康 | 依赖风格识别 / 扫描 / 修复 / 忽略清单（专项计划已归档） | ✅ 已交付（M1–M4，2026-09-16） |
| Pydantic 支持 | 构造校验 + 改名传播（pyrefly `references=0` 场景的自研补充）（专项计划已归档） | ✅ 已交付（2026-09-28） |
| 菜单栏 | 菜单栏结构与命令面板收官（专项计划已归档） | ✅ 已交付（6/16，2026-09-21） |
| 界面设计改进 | UI 缺陷 / 设计系统一致性 / ARIA 无障碍 / 响应式（专项计划已归档） | ✅ 已交付（30/30 + 2 条清单外遗留，2026-09-11） |
| UI 视觉身份 | 单色相轴（ADR-0005）+ 表面五档阶梯 + 随包等宽字体 + Monaco 自定义主题 + 边框/曲线/圆角/材质（依据 ADR-0005；专项计划已归档） | ✅ 六批全部落地（2026-10-03；audit 98 项 0 FAIL · 真机主题 32/32 PASS） |
| Git 增强（迭代 0–6） | 远程 / worktree / rebase / cherry-pick / stash / log / blame / **远端克隆**（专项计划已归档） | ✅ 迭代 0–6 已交付（2026-10-01）；shelf / changelist 与完整凭据 UI 暂缓 |
| SQLite 数据库工具 | 侧栏资源管理器 + 编辑器 Tab 双形态 + rusqlite bundled + 默认只读 + 分页排序过滤（专项计划已归档） | ✅ v1.4 已交付（2026-10-02；门禁全绿 tsc 0 / vitest 994 / e2e db 30/30 / cargo 286）；⏳ v1.4 真机手测待做（§17.7；§10.3 的 13/13 属 v1.0 侧栏态） |
| 插件（工具切片） | manifest + host API + kit 积木 + 热重载（专项计划已归档） | ✅ PR-1~4 已交付（2026-09-20，490 测试）；**v2 议题未启动**（P1-6 只做工作区级插件目录） |
| 国际化 | zh-CN / en-US 双语（`docs/i18n.md`） | ✅ 已交付（20 批抽取，2026-10-01；en/zh 词条编译期对齐 + 单测兜底） |
| 多窗口 | 独立窗口与状态隔离（专项计划已归档） | ✅ 阶段 0/1/2 全部交付（2026-09-28 实施 / 09-30 入库；真机 `multi-window-real.cjs` 16/16 PASS；#4~#6 依赖健康缓存经拍板暂缓） |
| 新手引导 | 欢迎页三步卡 / 功能巡礼 / force-show / uv 速查卡（专项计划已归档） | ✅ PR-S1 / S2 / S4 已交付（2026-09-30；e2e `04-onboarding.spec.ts` OG-1..OG-9）；PR-S3（可选 P2）未开工 · PR-S5 登记不排期 |
| 文档治理 | 交付总览 / 全局评估 / 分歧台账 / 技术债登记 | ✅ `docs/delivery-overview.md` 已建（20 功能域总表 + 文档地图 + 不一致登记）；`dev_plan_v2` §7 已回填；ADR 0006~0009 已补记；取数口径已固化为 `tools/stats/repo-stats.mjs` + `ci/budgets.toml` |

## 8. 工程规范（不变）

1. **版本锁定**：Tauri / Monaco / pyrefly / basedpyright / ruff / uv 全部锁定版本，记录于 `ci/versions.toml`；升级必须 PR + bench 回归全绿。
2. **回归测试**：`ci/` 流水线包含——shell 前端单测、LSP 桥单测、probe 单测、intel 单测、bench 指标采集、引擎升级演练（每月一次）。
3. **不侵入原则**：禁止修改 Tauri / Monaco / Pyrefly 源码；禁止 probe 影响非显式运行的 Python 进程。
4. **文档**：每个交付物附 README；重大决策写 ADR；每阶段末出验收报告存 `docs/`。
5. **性能红线**：任何 PR 导致 bench 指标回退超过 10% 必须说明理由。

## 9. 风险登记册（v2 修订）

| 风险 | 概率 | 影响 | 应对 | 责任人 |
|---|---|---|---|---|
| 自研 LSP 桥协议子集不够用 | 中 | 中 | 按需扩协议；后备 monaco-languageclient（ADR-0003） | Rust 工程师 |
| WebView2 中文输入法兼容问题 | 中 | 高 | S1-T06 早测；跟踪 Monaco 上游 issue | Rust 工程师 |
| 内存超 600 MB | 低 | 中 | Monaco worker 按需加载；诊断/补全节流 | Rust 工程师 |
| 外壳基本功自建工作量超预期 | 中 | 中 | 范围已裁剪（终端/Git/搜索后置）；Gate B 复核 | 全员 |
| PEP 669 探针开销超标 | 中 | 高 | 限流策略；仅显式运行注入 | Python 工程师 |
| Pyrefly 被 Meta 降权/停更 | 低 | 高 | 桥接层引擎无关，basedpyright 一键切换 | 全员 |
| 运行时/静态补全冲突抖动 | 中 | 中 | 三层 sortText 确定性合并 + 来源标注 + 全局开关 | Rust 工程师 |
| 自用项目长期维护负担 | — | 中 | 自研组件全部独立成包/进程 | 全员 |

## 10. 里程碑总览

| 里程碑 | 时间点 | 交付物 | 闸门 |
|---|---|---|---|
| M1 外壳可用 | 第 8 周末 | Pylume Shell 1.0（最小闭环）+ bench 体系 | Gate B |
| M2 采集可用 | 第 24 周末 | pylume-probe + trace 库 | Gate C |
| M3 差异化达成 | 第 40 周末 | pylume-intel + A/B 报告 | Gate D |
| M4 持续打磨 | 第 41 周起 | 跟随上游、基本功补齐、边角修复 | — |

**总周期约 10 个月；每个闸门都是继续/止损的决策点，产品负责人拥有一票否决权。**

## 11. 启动清单（本周即可执行）

- [x] 产品负责人：裁决外壳栈（Vanilla TS + Vite）、内存红线（≤600 MB）、Phase 1 范围（最小闭环）、调试时机（Phase 3 后）——2026-08-20 完成；
- [x] 技术方案 v3 + 开发计划 v2 产出；
- [ ] S1-T01 工程骨架搭建（`shell/`）；
- [ ] S1-T06 中文输入法早测（可与 S1-T02 并行）；
- [ ] bench 样例项目重建（含 5 类错误材料）。
