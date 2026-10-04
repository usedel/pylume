# Pylume 新手指南

> 版本：v1.0 · 日期：2026-09-30（随 PR-S1 交付）· 状态：**已交付**
> 面向第一次使用 Pylume 的你。从零到跑通第一个 Python 程序，大约需要三分钟。
> **本文档是 `docs/onboarding_dev_plan.md` v1.3 的 PR-S1 产物**：源文件经 Vite `?raw` 打包（`shell/src/welcomeGuide.ts:24`），由 `openOnboardingGuide()` 写入数据根 `docs/` 后打开并渲染 Markdown 预览——**每次打开都从仓库最新版覆写，无版本陈旧问题**。
> 入口三处：帮助菜单「新手指南」· 命令面板搜「新手指南」· 欢迎页「查看完整指南」链接。
> 修改本文档后**无需额外构建步骤**（?raw 走 Vite 依赖图，热更新即生效）；新增功能发现条目请同时更新 `shell/src/welcomeGuide.ts` 的巡礼策展数据（单一数据源纪律见计划 §2.0）。

---

## 1. 三分钟上手

### 第 1 步 · 新建项目

顶部菜单 **文件 → 新建项目**，或欢迎页的「新建项目」按钮。

- **位置**：项目落在哪个目录；
- **Git**：可勾选初始化 Git 仓库；
- **环境类型**：选择 uv 管理的虚拟环境（推荐）或系统解释器；
- **Python 版本**：没有合适的版本也不怕——uv 会自动下载安装。

### 第 2 步 · 运行脚本

打开任意 `.py` 文件后，三种方式任选：

| 方式 | 入口 |
|---|---|
| 工具栏 ▶ 按钮 | 标题栏运行组（悬停可见键位提示） |
| 菜单 | **运行 → 运行脚本** |
| 快捷键 | `Ctrl+F10`（运行当前文件）· `Ctrl+Shift+F10`（运行项目） |

编辑器行号左侧的 **▶ 小箭头**（gutter）可以直接运行光标所在文件；输出显示在底部控制台，traceback 中的 `File "…", line N` 可点击跳转。

### 第 3 步 · 下断点调试

1. 在目标行行号左侧**单击**出现红色断点（右键断点可加条件 / 命中次数 / Logpoint）；
2. 按 `F5` 启动调试；
3. 断下后：`F10` 单步跳过 · `F11` 单步进入 · `Shift+F11` 单步退出 · `Alt+F9` 运行到光标 · `Alt+F8` 求值表达式；
4. 左侧调试侧栏查看调用栈 / 变量 / 断点列表，底部**调试控制台**可交互求值。

---

## 2. uv 速查卡

### 为什么 Pylume 用 uv

- **快**：Rust 实现，装包比 pip 快一个量级，自带全局缓存；
- **省心**：`uv run` 按声明自动同步环境再执行，没有「装了忘了」的漂移；
- **托管解释器**：`uv venv` / `uv python install` 让你不必手动去官网下载 Python；
- **统一**：Pylume 界面上所有「安装」按钮内部就是 uv，终端里也能直接用。

### 命令对照表

| 你习惯的 pip 命令 | Pylume 推荐 | 说明 |
|---|---|---|
| `pip install requests` | `uv add requests` | 写入 pyproject 声明 + 更新 uv.lock |
| `pip install requests`（不想写声明） | `uv pip install requests` | 语法与 pip 相同，更快 |
| `pip install -r requirements.txt` | `uv pip install -r requirements.txt` | 兼容旧项目 |
| `pip uninstall requests` | `uv pip uninstall requests` | |
| `pip list --outdated` | `uv pip list --outdated` | |
| `python main.py` | `uv run main.py` | 自动按声明同步环境 |

**一句话边界**：Pylume 内所有「安装」按钮内部就是 uv；终端里敲 pip 也能用，只是慢且不写声明。

---

## 3. 功能发现（值得一试的能力）

| 功能 | 入口 |
|---|---|
| 开发工具箱（JSON 路径 / curl 转换 / 正则速测） | `Ctrl+Shift+T` |
| Live Templates 代码模板补全 | `Ctrl+J`（面板）· `Ctrl+Alt+T`（环绕选区） |
| 端点视图（FastAPI / Flask 项目自动出现） | 侧栏「端点」视图 |
| 依赖健康面板 | 状态栏体检图标 / 侧栏依赖健康视图 |
| 本地历史（每次保存自动留快照可回滚） | `Ctrl+Shift+H` |
| TODO 视图（自动收集项目待办标记） | 侧栏 TODO 视图 |
| 运行历史（回看历次输出） | `Ctrl+Shift+R` |
| 书签（标记并快速跳回重要位置） | `Ctrl+F11` 添加 · `Ctrl+Shift+F11` 列表 |
| 剪贴板 diff（对比复制前后的内容） | devtools 工具箱内 |
| Search Everywhere（文件 / 符号 / 命令混搜） | 双击 `Shift` |
| 全局搜索 | `Ctrl+Shift+F` |
| 调试控制台求值 | `Alt+F8` |
| 最近打开的文件 | `Ctrl+E` |
| Markdown 预览 | `Ctrl+Shift+V` |

（键位为出厂默认值，均可在 **设置 → 快捷键** 自定义。）

---

## 4. 常见问题

**Q：中文输入法下 Ctrl+Space 没有弹出补全？**
中文 IME 会吞掉 Ctrl+Space（切输入法的系统级冲突），Pylume 提供备选键 `Alt+/` 触发补全建议。

**Q：首启时数据放在哪个目录？**
帮助菜单 **打开数据目录** 可直接查看。设置、缓存、日志都在里面，首次启动会有落位提示。

**Q：uv 缺失会怎样？**
首次使用会弹出工具链引导，一键安装 uv 与静态引擎；不装也能编辑代码，但装包 / 环境管理能力会缺席。

**Q：终端里直接用 pip 行不行？**
行，能用。但推荐 `uv add` / `uv pip install`（见上文速查卡）——更快，且 `uv add` 会写入项目声明。

**Q：怎么回到欢迎页？**
帮助菜单 **欢迎页**，随时可回。
