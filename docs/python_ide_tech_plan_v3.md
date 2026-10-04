# Pylume：自用 Python IDE 技术方案 v3

> 版本：v3.0 · 日期：2026-08-20 · 状态：已与产品负责人对齐关键议题（外壳栈 / 内存红线 / Phase 1 范围 / 调试时机）
> 取代 `python_ide_tech_plan_v2.md`（v2 的 Zed 外壳部分已被换壳裁决推翻；probe/intel/验收指标等章节继续有效，本文仅重写外壳相关部分并引用之）

## 0. 与 v2 的关系

v2 的核心判断（运行时采样是立项核心、静态语义复用 pyrefly/basedpyright、自研组件全部独立成包）**全部继承**。唯一根本变化是外壳：

| 维度 | v2（已过时） | v3（本文） |
|---|---|---|
| 外壳 | Zed 渐进式（配置 → 扩展 → 薄 fork） | **Tauri 2 + Monaco**（换壳裁决，2026-08-20） |
| 智能 live template | 依赖 Zed，实测不可达 | **外壳内置，完全可控**（换壳直接动因） |
| 编辑器基本功 | Zed 免费提供 | 自建（文件树/标签页/终端/搜索/Git） |
| 内存预算 | < 400 MB（Zed 基线） | **≤ 600 MB**（spike 实测 ~420 MB + 余量） |
| 调试 | Zed 内置 debugpy 零成本 | 自建 DAP UI 成本高，**原定推迟到 Phase 3 后；Phase 4 已交付最小闭环**（见 ADR-0004） |

## 1. 项目定位（不变）

**一个为「FastAPI + 爬虫 + 小脚本」开发者定制的 Python IDE**：以 Tauri 2 + Monaco 为外壳、Pyrefly/basedpyright 为静态语义底座、**运行时类型采样（PEP 669）为差异化核心**，功能聚焦于**代码补全与跳转**（辅以脚本运行与错误点击跳转），目标是在用户真实代码形态（含大量无注解代码）上达到并局部超越 PyCharm 的补全与跳转体验。

### 1.1 设计目标（量化，v3 修订）

| 指标 | 目标值 | 说明 |
|---|---|---|
| 编辑器冷启动 | < 1.5 s（release，重新实测） | Zed 基线 300 ms 不再适用；WebView2 启动 + Monaco 加载 |
| 空闲内存（编辑器 + LSP 合计） | **≤ 600 MB** | spike 实测 ~420 MB（debug + Monaco 全量）；release + 按需加载有下降空间 |
| 有注解代码补全准确率 | ≥ 95% | 静态引擎达成 |
| **无注解代码补全准确率** | **≥ 85%（运行时采样覆盖过的代码路径）** | 核心差异化指标 |
| 跳转准确率 | ≥ 95% | — |
| 运行时探针开销 | < 1.5x 执行时间 | PEP 669 实测 1.1-1.3x，留余量 |

### 1.2 非目标（不变）

- ❌ 通用多语言 IDE；❌ 自研类型推断引擎；❌ 插件市场 / 协作编辑 / 远程开发；❌ 复刻 PyCharm 全部功能。

## 2. 外壳架构（v3 核心变更）

### 2.1 技术栈（已裁决）

| 层 | 选型 | 理由 |
|---|---|---|
| 壳进程 | **Tauri 2.11.x**（Rust） | spike 已验证；Windows WebView2 内置；主进程内存 ~39 MB |
| 前端 | **Vanilla TypeScript + Vite** | 与 spike 一脉相承；零框架运行时开销、内存最低；单人维护代码量可控（产品负责人裁决） |
| 编辑器 | **Monaco 0.52.2**（本地 npm 打包，去 CDN） | spike 已验证补全管线（sortText/preselect/上下文）完全可控 |
| 终端 | xterm.js（Phase 1 后期） | 基本功补齐项，非首期范围 |
| 调试 | **已立项并交付最小闭环**（debugpy 随包分发 + 自研 DAP 桥，见 `docs/python_debug_dev_plan.md` / ADR-0004） | 原裁决推迟到 Phase 3 后；Phase 4 已交付断点/单步/调用栈/变量 |

### 2.2 工程结构

```
open-charm/
├── shell/                    # Tauri 2 + Monaco 外壳（本次重建）
│   ├── src/                  # 前端 TS（Vite 构建）
│   │   ├── lsp/              # LSP 桥接层 TS 侧（ADR-0003）
│   │   └── ...
│   ├── src-tauri/            # Rust 壳进程
│   │   └── src/lsp.rs        # LSP 桥接层 Rust 侧（spawn/帧解析/事件转发）
│   ├── package.json
│   └── vite.config.ts
├── docs/                     # 方案、计划、ADR（现有）
├── probe/                    # pylume-probe（Phase 2 重建）
├── intel/                    # pylume-intel（Phase 3 重建）
├── bench/                    # 基准项目集（Phase 1 重建）
└── ci/                       # 回归测试（Phase 1 重建）
```

### 2.3 LSP 接入：自研轻量桥接层（ADR-0003）

**不使用 monaco-languageclient**（版本强耦合 monaco-editor 0.52↔9.x、引入整个 vscode 服务层、补全合并控制点深）。自研桥只实现所需 LSP 子集：

```
Monaco providers (TS) ←→ Tauri IPC (invoke/event) ←→ Rust lsp.rs (stdio + 帧解析) ←→ pyrefly lsp
```

- **Rust 侧**：spawn 引擎进程（stdio）、`Content-Length` 帧解析、事件转发（`lsp-message` / `lsp-stderr` / `lsp-exit`）；
- **TS 侧**：JSON-RPC 关联（请求/响应/通知/取消）、Monaco provider 注册（completion / hover / definition / diagnostics）、位置换算（UTF-16 0 基 ↔ Monaco 1 基）；
- **引擎切换** = 更换 spawn 命令表条目，桥接层引擎无关（basedpyright / pylume-intel 直接复用）。

### 2.4 补全三层合并（外壳核心能力）

| 层 | sortText 前缀 | 来源标注 | 说明 |
|---|---|---|---|
| 智能 live template | `0xx` | `⟳ ctx=<module/class/function>` | 上下文感知排序 + preselect（spike 已验证） |
| 运行时智能（intel） | `1xx`（预留） | `⟳ runtime` | Phase 3 接入 |
| 静态引擎（pyrefly） | `2xx` | — | LSP 桥转发 |

- 模板体系**用户可配置**（JSON 文件：模板体 + 各上下文优先级），这是换壳的直接动因，优先级最高；
- 输入停止 200 ms 节流后再请求 LSP。

### 2.5 编辑器基本功（原 Zed 免费提供，现自建）

| 能力 | Phase 1 | 说明 |
|---|---|---|
| 文件树（多层/递归） | ✅ | Rust 命令 + 前端懒加载 |
| 多标签页 | ✅ | 单 Monaco 实例 + model 切换 |
| 运行按钮 + 输出面板 | ✅ | `uv run`，cwd 锚定文件目录（spike 已验证） |
| traceback 点击跳转 | ✅ | 输出面板正则识别 `File "…", line N`，5 类错误验收（材料可复用） |
| PyCharm 键位 | ✅ 基础集 | Ctrl+F10 运行、F12/Ctrl+点击跳转等 |
| 中文输入法兼容 | ✅ 早测 | WebView2 + Monaco 专项验证（遗留待办） |
| 集成终端（xterm.js） | ⏳ Phase 1 后期 | 非首期范围 |
| 全局搜索 / Git 状态 | ⏳ Phase 1 后期 | 非首期范围 |
| 主题 | ✅ 基础（vs-dark） | 后续可扩展 |

## 3. 系统架构（v3）

```
┌────────────────────────────────────────────────────────────┐
│  外壳层：Tauri 2 + Monaco（Vanilla TS + Vite）              │
│  编辑器 · 文件树 · 标签页 · 智能模板 · 运行/输出 · traceback │
├────────────────────────────────────────────────────────────┤
│  LSP 桥接层（自研，ADR-0003）                                │
│  Monaco providers ⇄ Tauri IPC ⇄ Rust stdio 桥              │
│  补全三层合并：模板 0xx / 运行时 1xx / 静态 2xx              │
├──────────────────────┬─────────────────────────────────────┤
│ 静态语义（外部进程）   │ 运行时智能（自研，独立进程）          │
│ Pyrefly / basedpyright│ pylume-intel（Rust, LSP）        │
│ Ruff · uv             │ pylume-probe（Python 注入探针）   │
│                       │ trace 库（SQLite）                   │
└──────────────────────┴─────────────────────────────────────┘
```

设计原则不变：**一切自研组件都是独立进程或独立包，不侵入外壳与静态引擎内核。**

## 4. Phase 1（外壳重建期）任务分解

> 详细排期见《开发计划 v2》。Phase 2/3（probe/intel）计划不变，顺延。

| 编号 | 任务 | 交付物 / 验收 |
|---|---|---|
| S1-T01 | 工程骨架：Vite + TS + Tauri 2 + Monaco 本地打包（去 CDN） | `npm run build` + `cargo build` 全绿 |
| S1-T02 | 编辑器核心：多标签 + 递归文件树 + 保存 | 打开/切换/保存闭环可用 |
| S1-T03 | 智能 live template 正式化：可配置 JSON + 上下文感知排序 + preselect | 模板可增删改，上下文排序正确 |
| S1-T04 | LSP 桥接层：Rust stdio 桥 + TS JSON-RPC + completion/hover/definition/diagnostics | pyrefly 补全/跳转/Hover/诊断可用 |
| S1-T05 | 运行与 traceback：运行按钮 + 输出面板 + `File "…", line N` 点击跳转 | 5 类错误全部可点击跳转（材料复用 `bench/sample/errors/`） |
| S1-T06 | Windows 专项：中文输入法 + 内存/冷启动实测 | 输入法无异常；内存 ≤ 600 MB |
| S1-T07 | **Gate B 评审** | 见开发计划 v2 |

## 5. 风险登记（v3 增补）

| 风险 | 概率 | 影响 | 应对 |
|---|---|---|---|
| 自研 LSP 桥协议子集不够用（rename/semantic tokens 等） | 中 | 中 | 按需扩协议；后备方案 monaco-languageclient（ADR-0003） |
| WebView2 中文输入法兼容问题 | 中 | 高 | S1-T06 早测；Monaco 上游 issue 已知问题跟踪 |
| 内存超 600 MB | 低 | 中 | Monaco 按需加载 worker；诊断/补全节流 |
| 外壳基本功自建工作量超预期 | 中 | 中 | 范围裁剪（终端/Git/搜索后置，已裁决） |
| Pyrefly 被 Meta 降权/停更 | 低 | 高 | 桥接层引擎无关，basedpyright 一键切换 |

## 6. 许可证（不变）

| 组件 | 协议 |
|---|---|
| Tauri 2 / Monaco / Pyrefly / Ruff / uv / basedpyright | MIT / Apache-2.0（原版使用，不修改） |
| pylume-probe / pylume-intel / shell | MIT（自研层） |
