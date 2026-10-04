# Pylume 交付总览（Delivery Overview）

> 版本：v1.1 · 日期：2026-10-04 · 状态：**现行**
> **这份文档的定位**：新会话 / 新人 / 任何接手者的**唯一入口**。回答两个问题：①项目做到哪一步了？②要改某个功能域，该读哪份文档？
> 冲突时以 `docs/python_ide_dev_plan_v2.md` 为准并反馈修订本文件。
> **30 秒读法**：直接看 §2 表的状态列 → 改哪块就跳 §3 找真源 → 交付数字别信文档、跑 §5 的脚本。
> **v1.1 变更（2026-10-04）**：docs 精简，47 篇 → 19 篇。各功能域的专项执行计划已归档，§2 表中真源列标「—（已归档）」的即为此类；保留下来的文档是跨功能域真源、验收依据，或**应用运行时资源**（后者不可删，见 §3.5）。

---

## 1. 一页速览

| 项 | 现状 |
|---|---|
| 定位 | 单人自用 Python IDE（FastAPI + 爬虫 + 小脚本） |
| 阶段 | **Phase 4 · 打磨期**（Phase 1/2/3 均已交付：外壳 / 语义引擎 / 运行时智能） |
| 规模 | 约 83K 行自研代码 · 192 个 Tauri 命令 · 11 篇 `docs/*.md` + 8 篇 ADR |
| 质量底座 | 前端 1070 用例 · Rust 333 测试 · probe 81 pytest · e2e 65 spec（mock 层）+ 9 个真机脚本（**手动**） |
| 版本锁定 | `ci/versions.toml` 锁 9 类依赖 |
| 尚未闭环 | ① **真机 e2e 不进 CI**（9 个脚本手动）② Gate D 差两格人工对标 ③ 调试 8 项 + 运行 2 项人工验收 ④ SQLite v1.4 Tab 化真机手测 + 双主题截图 ⑤ 依赖升级回归无自动化 |
| 下一步 | 待处理项见 `docs/tech-debt.md`（TD-021 五小项） |

---

## 2. 交付总览表

> 「交付日期」取该功能域**最后一批提交入库**的日期；无提交记录的取文档落款日期。
> 真源列标「已归档」= 该功能域的专项执行计划已随 2026-10-04 的 docs 精简归档，现以本表状态 + §3 的跨功能域真源为准。

| # | 功能域 | 交付日期 | 计划 / 方案文档（真源） | 验收记录 | 状态 |
|---|---|---|---|---|---|
| 1 | 外壳与编辑器基础（多标签 / 分屏 / 面包屑 / 书签 / 引用计数 / 行内值） | 2026-08-20 起 | `python_ide_tech_plan_v3.md` · `python_ide_dev_plan_v2.md` | — | ✅ |
| 2 | UI 缺陷与设计系统一致性（UI-01~30） | 2026-09-11 | 已归档 | — | ✅ 30/30 |
| 3 | **UI 视觉身份六批**（单色相轴 / 表面阶梯 / 字体 / Monaco 主题 / 材质） | **2026-10-03** | ADR-0005 | 真机 CDP 主题验收 32/32（`ae62b73`）· `tools/ui/audit_tokens.py` 98 项 | ✅ 六批全落地 |
| 4 | 菜单栏 | 2026-09-21 | 已归档 | — | ✅ 6/16 |
| 5 | 国际化（zh-CN / en-US） | 2026-10-01 | `i18n.md` | 编译期词条对齐单测 | ✅ 20 批抽取 |
| 6 | 依赖健康（扫描 / 修复 / 忽略清单） | 2026-09-16 | 已归档 | — | ✅ M1–M4 |
| 7 | 库特别支持（re 三件套 / 格式串 / JSON / 求值桥 / 参数表单） | 2026-09-28 | 已归档 | — | ✅ P0 四件套 + P1 五件套 |
| 8 | Pydantic 支持与改名传播 | 2026-09-28 | 已归档 | — | ✅ |
| 9 | DX 顺手功能储备 | 2026-09-27 | 已归档 | — | ✅ 全部收官 |
| 10 | Markdown 预览 | 2026-09 | 已归档 | — | ✅ |
| 11 | 运行（M1–M4：脚本 / 项目 / 统一 PTY / 多实例 / 历史） | 2026-09-15 | 已归档 | `run_acceptance_record.md` | ✅（2 项人工遗留） |
| 12 | 调试（D1–D5：断点 / 单步 / 栈 / 变量） | 2026-09-10 | `python_debug_dev_plan.md` v1.3 | `debug_acceptance_record.md`（含 §五 人工清单 8 项） | ✅（8 项人工遗留） |
| 13 | Git（迭代 0–6：远程 / worktree / rebase / cherry-pick / stash / log / blame / **远端克隆**） | 2026-10-01 | 已归档 | — | ✅（shelf / changelist 暂缓） |
| 14 | 终端（多会话 PTY，统一运行出口） | 2026-08 起 | 已归档（`terminal.rs` 为 PTY 单一来源） | `run_acceptance_record.md` | ✅ |
| 15 | **SQLite 数据库工具（B3）** | **2026-10-02** | 已归档 | v1.0 侧栏态真机 13/13 | ✅ v1.4 编辑器 Tab 化（门禁全绿）· ⏳ 真机手测待做 |
| 16 | 插件（devtools 工具切片 PR-1~4） | 2026-09-20 | 已归档 | `devtools_plugin_acceptance_record.md`（490 测试） | ✅ v1 信任模型；v2 未启动 |
| 17 | **运行时智能**（PEP 669 采样 + intel LSP） | 2026-09-10（索引整改） | `intel/README.md`（P3-T01~T10）· tech plan v3 第三节 · ADR-0007 / 0008 | `bench/reports/gate-d-runtime-completion.md`（23/23 = 100%） | ⚠️ **P3-T10 人工横向对标挂起** |
| 18 | 数据目录 v2 与系统盘治理 | 2026-08-29 | 已归档 | — | ✅ |
| 19 | 多窗口 | 2026-09-28 实施 / 2026-09-30 入库 | 已归档 | `e2e-real/multi-window-real.cjs` 16/16 PASS | ✅ 阶段 0/1/2 全交付 |
| 20 | 新手引导 | 2026-09-30 入库 | 已归档 | `e2e/ux/04-onboarding.spec.ts` OG-1..OG-9 | ✅ PR-S1/S2/S4 已交付；S3（可选 P2）未开工 |

---

## 3. 文档地图（docs 精简后，共 19 篇）

### 3.1 现行真源（改架构前必读）

| 文档 | 作用 |
|---|---|
| `python_ide_tech_plan_v3.md` v3.0 | 技术方案：外壳架构 / 内存红线 / Phase 1 范围 / 调试时机 |
| `python_ide_dev_plan_v2.md` v2.0 | 开发计划：Phase 重排 + **§1.1 目标与不做清单**（pytest / AI 等裁决来源）+ §7 状态表 |
| `docs/adr/` | 架构决策 8 篇：0003 自研 LSP 桥 · 0004 DAP+debugpy · 0005 品牌/交互色统一 · 0006 双静态引擎 · 0007 intel 独立 LSP · 0008 PEP 669 采样 · 0009 补全合并策略 |
| `AGENTS.md`（仓库根） | 跨 agent 规则索引（技术栈铁律 + 三语言规范红线 + 常用命令） |

### 3.2 专项执行真源（仅保留仍在频繁回看的两篇）

| 功能域 | 文档 |
|---|---|
| 调试 | `python_debug_dev_plan.md` v1.3（`AGENTS.md` 引用其 v1.3 与对应验收记录） |
| 国际化 | `i18n.md`（新增文案三步流程：`AGENTS.md` 直接引用） |

> 其余功能域的专项执行计划已归档。要改某块代码，先读 `AGENTS.md` 的技术栈铁律，再按 §2 表的状态定位到代码本身。

### 3.3 验收记录（判断「真的做完没有」看这里）

`debug_acceptance_record.md` · `run_acceptance_record.md` · `devtools_plugin_acceptance_record.md` · `bench/reports/`（Gate D / 引擎性能 / 库支持探针 / Pydantic 探针）

### 3.4 治理与账本

`tech-debt.md`（待处理 TD-021 五小项 + 已归档 20 余条）

### 3.5 应用运行时资源（**不可删**）

下面两篇不是给人读的开发文档，而是被前端 `?raw` 导入、**打包进应用**的内容（用户点「新手引导」「插件详情」时显示的正文）：

| 文档 | 引用点 | 用途 |
|---|---|---|
| `onboarding_guide.md` | `shell/src/welcomeGuide.ts:24` | 新手引导的 uv 速查卡正文 |
| `devtools_plugin_guide.md` | `shell/src/extensions/pluginsTab.ts:19` | 插件详情页的作者指南正文 |

**删掉它们会直接让 `npm run build` 失败**（rollup 报 `Could not resolve "../../docs/xxx.md?raw"`）——2026-10-04 的 docs 精简踩过一次，已从备份恢复。清理 `docs/` 前先跑：

```bash
grep -rnE "docs/[A-Za-z0-9_./-]+\.md\?raw" shell/src/
```

---

## 4. 已知文档不一致登记

> 维护原则：**发现即登记，登记即修**。本表是「文档债务」的唯一清单，修完更新状态。
> 第 1~9 条已于 2026-10-03 一轮收口；第 10 条为 2026-10-04 docs 精简产生。

| # | 不一致 | 涉及文件 | 状态 |
|---|---|---|---|
| 1 | README 索引缺 12 篇 + `ui_premium_design_report` 仍标「v1.0（待评审）」 | `README.md` | ✅ 2026-10-03 已修（该文档现已归档，索引同步收敛） |
| 2 | 状态戳「批 1 实施中」与正文「六批全部落地」冲突 | UI 视觉专项计划（已归档） | ✅ 2026-10-03 已修 |
| 3 | 状态戳「待真机手测」与「真机 13/13 PASS」冲突 | SQLite 工具专项计划（已归档） | ✅ 2026-10-03 已修（校正归属：13/13 属 v1.0 侧栏态，v1.4 真机待做） |
| 4 | §7 状态表进度戳停在 2026-08-24，未记录 Git 六迭代 / SQLite / UI 六批 / i18n 等交付 | `python_ide_dev_plan_v2.md:114` | ✅ 2026-10-03 已回填（13 行功能域补齐） |
| 5 | 「待记录（候选）」4 条实为已落地决策 | `docs/adr/README.md` | ✅ 2026-10-03 已补记 ADR-0006~0009 |
| 6 | CI `on.push.branches: [main]` 与主干 `master` 不匹配 | `.github/workflows/ci.yml:17` | ✅ 2026-10-03 已对齐为 `[master, main]`（**待推送后确认首次触发**） |
| 7 | 新手引导指南已交付 vs 计划「已立项未开工」 | 新手引导专项计划（已归档） | ✅ 2026-10-03 已回填 |
| 8 | `per_window.rs` 已落地 vs 计划「阶段 0/1/2 均未开工」 | 多窗口专项计划（已归档） | ✅ 2026-10-03 已回填 |
| 9 | 缺版本头（无版本/日期/状态行） | 新手引导指南（已归档） | ✅ 2026-10-03 已补 |
| 10 | docs 精简后，源码注释中仍保留指向已归档文档的指针（约 40 处，如 `python_library_support_dev_plan.md` 12 处、`sqlite_tool_dev_plan.md` 9 处） | `shell/src/**`、`shell/src-tauri/src/**` | ⏳ **已知并接受**：注释为导航性文字，不影响编译与运行，暂不改动以免引入回归 |

---

## 5. 门禁与数字复核（**别信文档里的数字，跑脚本**）

| 目的 | 命令 / 位置 |
|---|---|
| 前端单测 | `shell\scripts\gate-tests.mjs unit`（**不要直接跑 `vitest`** —— 本机会被判为 watch 并杀进程） |
| E2E（mock 层） | `shell\scripts\gate-tests.mjs e2e` / `e2e-ui`（9 spec 快档） |
| 真机层 | `shell\e2e-real\run-*.bat`（CDP 9223 + 隔离数据根） |
| UI token 门禁 | `tools\ui\audit_tokens.py`（98 项检查，退出码非 0 即失败） |
| UI 基线截图 | `shell\scripts\ui-baseline.mjs --tag X` → 系统 TEMP |
| Rust | `cd shell\src-tauri && cargo test`（改 `src-tauri` 后必须 `cargo check` 通过再交付） |
| probe | `cd probe && uv sync && uv run pytest`（零第三方依赖） |
| intel | `cd intel && cargo build -p pylume-intel`（联调前必须 build 而非 test） |
| 依赖扫描性能红线 | `cd shell\src-tauri && cargo test --release bench_dep_scan -- --ignored --nocapture`（≤ 2s） |
| 规模 / 命令数 / 文档数取数 | `node tools/stats/repo-stats.mjs` |

**复核触发条件**：HEAD 变动 ≥ 10 提交 · 任一专项验收收口 · 季度评审 · 任一计划状态从「未开工」转「已交付」。

---

## 6. 新会话上手路径（约 15 分钟）

1. 读仓库根 `AGENTS.md`（技术栈铁律 + 三语言红线 + 常用命令）；
2. 读本文件 §1 速览 + §2 表，知道项目做到哪一步；
3. 按你要改的域读 §3 对应真源（**先读计划再动代码**，计划里有 file:line 级落点）；
4. 动代码前查 `python_ide_dev_plan_v2.md` §1.1，确认该功能是否已被裁决「不做」（pytest 面板 / AI 能力 / 插件市场 / 协作编辑）；
5. 交付前跑 §5 对应门禁 + 更新本文件 §2 状态列与 §4 不一致登记。
