# Pylume

[![CI](https://github.com/usedel/pylume/actions/workflows/ci.yml/badge.svg)](https://github.com/usedel/pylume/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/usedel/pylume)](https://github.com/usedel/pylume/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-Windows-blue.svg)](#快速开始)
[![Built with Tauri](https://img.shields.io/badge/Tauri-2-blue.svg?logo=tauri)](https://tauri.app)

为「FastAPI + 爬虫 + 小脚本」开发者定制的轻量 Python IDE。

[English](README.md)

多数 Python 编辑器只能从你写的注解推断类型。Pylume 还会从**代码真正跑起来时的结果**推断——所以没写注解的 `dict`、`Any`、爬虫返回的 payload 也能补全准确。

---

## 为什么做这个

我写很多小 Python——FastAPI 服务、爬虫、一次性脚本。很长一段时间里，这意味着要在两个工具之间挑一个，而它们让我难受的方式正好相反。

**我是真的喜欢 PyCharm。** 它对 Python 的理解仍然是我用过最好的：重构、导航、调试器。但有两件事挡在中间。

一是我每天真正用到的功能都在 **Pro 订阅**后面——FastAPI 与 Flask 支持、数据库工具、*Endpoints* 面板；免费层只覆盖核心 Python。二是它是 JVM 应用：冷启动慢、后台常驻索引进程，还没敲一行字内存占用就已经几百 MB 起。为了一个 200 行的爬虫开动这么大一台机器，太重了。

**VS Code 是相反的取舍。** 免费、启动快，但在你花一个晚上配置它之前，它就是个文本编辑器——装 Python 扩展、选解释器、把 lint / 格式化 / 调试一条条接起来，之后还得维护这套配置。它还是 Electron 应用，我不想让一个 Node.js 运行时横在我和我的 Python 之间。

Pylume 是我想要的那个东西：**一个开箱就懂 Python 的原生 Windows 应用**。没有订阅、不用淘扩展、用户机器上也不需要 JavaScript 工具链。

> **关于 Node.js，准确地说**：Pylume 以原生安装包分发（Tauri 2 + WebView2）。**使用**它不需要 Node.js，也不需要配 Python 环境——uv、Pyrefly、debugpy 随包分发或首次启动引导安装。只有**从源码构建** Pylume 才需要 Node 22，因为编辑器表面是 Monaco。

---

## 实际效果

这个文件里没有任何类型注解。跑一次，编辑器就知道了真实形状：

```python
import requests

def fetch_items(url):
    r = requests.get(url)        # r      -> Response     ⟳ runtime
    return r.json()["items"]     # items  -> list[dict]   ⟳ runtime

for item in fetch_items(url):    # item   -> dict         ⟳ runtime
    print(item["sku"])           # 键名来自真实 payload 的 shape
```

`⟳ runtime` 标记表示这条建议来自代码运行时真实产生的类型，而不是你写的注解。不做猜测式推断，也不往任何地方发送——采样结果只落在本地 SQLite 文件里。

## 界面

编辑器：Pyrefly 推断出的类型注解直接标在代码里，左侧是文件树与大纲：

![Pylume 编辑器](docs/screenshots/main.png)

在一个没写任何注解的 dict 上输入 `item.`，成员补全带着真实类型返回。
下方终端里能看到探针正在采样这些类型（`✓ 2 函数 · 3 类型观测` → 写入本地 trace 库）：

![运行时感知补全](docs/screenshots/completion.gif)

## 它有什么不一样

静态分析只能看到你写了什么注解。Pylume 会**看你实际跑出来的是什么**：

1. 运行脚本时，探针（`probe/`）用 PEP 669 `sys.monitoring` 以采样方式记录变量与调用的真实类型，写进本地 SQLite trace 库；
2. 运行时智能服务 `pylume-intel` 只读这个库并建倒排索引，作为一个**独立 LSP** 提供补全 / 跳转 / Hover；
3. 外壳把「静态引擎结果」与「运行时结果」按固定段位合并——来自运行时的条目带 `⟳ runtime` 标记，排在你习惯的位置。

对 `dict` / `Any` / 没写注解的爬虫返回值，这就是补全准与不准的差别。

## 横向对比

| | Pylume | PyCharm | VS Code + Python 扩展 |
|---|---|---|---|
| 无注解代码补全 | 运行时采样 | 静态推断 | 静态推断 |
| 开箱即用 | 是 | 需配解释器 | 需装扩展并配置 |
| 费用 | 免费（MIT） | 核心功能免费；FastAPI / 数据库工具 / Endpoints 需 **Pro 订阅** | 免费 |
| 运行时依赖 | 无（原生安装包） | JVM | Electron / Node.js |
| 平台 | **仅 Windows** | Windows / macOS / Linux | Windows / macOS / Linux |
| 擅长 | FastAPI、爬虫、小脚本 | 大型 Python 代码库 | 装够扩展什么都能做 |

Pylume 的定位比另两者窄得多。它不想成为通用 IDE，只想成为你为 200 行脚本打开的那一个。

## 功能

| 域 | 现状 |
|---|---|
| 编辑器 | Monaco 多标签 / 分屏 / 面包屑 / 书签 / 引用计数 / 行内值 |
| 语义 | 补全 · 跳转 · Hover · 诊断（Pyrefly 默认，basedpyright 可切换） |
| 运行时智能 | PEP 669 采样 + `pylume-intel`，无注解代码补全 |
| 运行 | 脚本 / 项目两种模式 + 统一 PTY 控制台 + 多实例并行 + traceback 点击跳转 |
| 调试 | debugpy 随包分发 + 自研 DAP 桥：断点 / 单步 / 调用栈 / 变量 |
| 其他 | Git（含远端克隆）· SQLite 工具 · Markdown 预览 · 依赖健康 · 库特别支持（re / 格式串 / JSON）· 多窗口 · 终端 · 全局搜索 · 工具插件 · 中英双语 |

**明确不做**：pytest 面板、AI 能力、插件市场、协作编辑。边界见 `docs/python_ide_dev_plan_v2.md` §1.1。

## 架构

```
shell/    Tauri 2 + Monaco 外壳（前端 Vanilla TS + Vite；后端 Rust src-tauri）
probe/    pylume-probe：PEP 669 运行时采样（独立 Python 包，零第三方依赖）
intel/    pylume-intel：消费 trace 库的运行时智能 LSP（独立 Rust 进程，stdio）
bench/    基准项目集 + 指标采集
ci/       版本锁定基线 versions.toml
docs/     方案 · 开发计划 · ADR · 验收记录
```

数据流：运行 → PTY 注入环境变量拉起 probe → 写 trace 库（`~/.pylume/traces/<project-hash>.db`）→ intel 只读建索引 → 外壳 LSP 桥合并进 Monaco。

自研组件一律是**独立进程 / 独立包**，不侵入外壳与静态引擎内核；静态引擎第一天就可切换。

## 快速开始

### 直接用

从 Releases 下载安装包（NSIS）安装即可——uv / pyrefly / debugpy 等依赖随包分发或首次启动引导安装，全新 Windows 开箱即用。

### 从源码构建

前置：Node 22 · Python 3.13（uv 管理）· Rust 1.96 · **Windows**（当前唯一支持的平台）。

```powershell
# 1) 拉取随包分发的 debugpy（按 ci/versions.toml 的 sha256 锁定，产物不入库）
powershell -File .\tools\fetch-debugpy.ps1

# 2) 前端 + 外壳开发模式
cd shell
npm install
npm run tauri dev

# 3) 一键打包（仓库根执行）
powershell -File .\build-release.ps1
```

安装包输出：`shell/src-tauri/target/release/bundle/nsis/`。日志：`~/.pylume/logs/pylume.log`。

### 常用命令

| 目的 | 命令 |
|---|---|
| 前端单测 | `cd shell && npm test` |
| E2E（mock 层） | `cd shell && npx playwright test` |
| 真机验收（手动） | `shell\e2e-real\run-*.bat` |
| Rust 外壳 | `cd shell/src-tauri && cargo test` |
| 探针 | `cd probe && uv sync && uv run pytest` |
| 运行时智能 | `cd intel && cargo build -p pylume-intel`（联调前必须 build，不是 test） |
| UI token 门禁 | `python tools/ui/audit_tokens.py` |

## 文档地图

| 入口 | 说明 |
|---|---|
| [`docs/delivery-overview.md`](docs/delivery-overview.md) | **交付总览**：20 个功能域 × 计划真源 × 验收记录 × 状态 |
| [`docs/python_ide_tech_plan_v3.md`](docs/python_ide_tech_plan_v3.md) | 技术方案（Tauri + Monaco 外壳架构） |
| [`docs/python_ide_dev_plan_v2.md`](docs/python_ide_dev_plan_v2.md) | 开发计划（含「不做清单」） |
| [`docs/adr/`](docs/adr/) | 架构决策记录：LSP 桥 · DAP + debugpy · 品牌色 · 双引擎 · PEP 669 · 补全合并 |
| [`docs/tech-debt.md`](docs/tech-debt.md) | 技术债台账 |

文档约定：技术方案与开发计划冲突时，以开发计划为准；同一文档新旧版本冲突时，以版本号更高者为准。

## 已知边界

- **Pydantic**：Pyrefly 不对 `BaseModel` 构造做静态校验，Pylume 用自研诊断补齐（类型错 / 缺失必填 / 未知字段），为轻量文本解析，跨文件继承链不合并。
- **真机 e2e 未进 CI**（nightly 只告警），自动化门禁只覆盖 Windows。
- 调试与运行功能各留少量人工验收项，见对应验收记录。

## 贡献

见 [`CONTRIBUTING.md`](CONTRIBUTING.md)。安全问题请走 [`SECURITY.md`](SECURITY.md)，不要开公开 issue。

## 许可证

[MIT](LICENSE)。第三方组件许可见 [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md)。

Pylume 与 JetBrains 无任何关联；PyCharm 为 JetBrains 的注册商标。
