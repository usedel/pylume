# Pylume Shell

Tauri 2 + Monaco 外壳（技术方案 v3 / ADR-0003）。

## 开发

```powershell
cd shell
npm install        # 首次
npm run tauri dev  # 开发模式（Vite 热更新 + Tauri 窗口）
```

## 构建

**一键打包（推荐）**——在项目根执行，自动完成清理 → intel release 构建 → 前端依赖 → Tauri 打包：

```powershell
powershell -File .\build-release.ps1                 # 完整打包
powershell -File .\build-release.ps1 -SkipNpmInstall # 依赖已装时跳过 npm install
```

**分步构建（开发调试）**：

```powershell
npm run build              # 前端（tsc + vite）
cd src-tauri; cargo build  # Rust 壳（debug）
npm run tauri build        # 完整发布包
```

> 发布包经 `bundle.resources` 引用 `intel/target/release/pylume-intel.exe` 与 `probe/src`，手动分步打包前需先执行 `cd intel; cargo build -p pylume-intel --release`（一键脚本会自动完成）。

## 架构

```
src/                      # 前端（Vanilla TS + Vite）
├── main.ts               # 入口：工作区生命周期 / 标签编辑器 / 运行 / LSP 接线 / 环境面板 / 搜索大纲 / 菜单 / 胶水
├── state.ts              # AppState 上下文对象（跨域共享状态，TD-007）
├── views.ts              # 侧栏视图注册表 + Activity Bar（TD-001）
├── fileTree.ts           # 文件树域（渲染/右键菜单/文件操作/过滤/键盘导航）
├── git.ts                # Git 域（SCM/暂存提交/diff/分支/远程/stash/log/blame）
├── termUi.ts             # 终端域（多会话 + 底部面板标签切换）
├── terminal.ts           # xterm.js + portable-pty 前端接线
├── settingsPanel.ts      # 设置面板（加载/保存/intel 开关）
├── search.ts             # 全局搜索（ripgrep 引擎，Ctrl+Shift+F）
├── monaco.ts             # Monaco 本地 worker 配置（去 CDN）
├── output.ts             # 输出面板 + traceback File "…", line N 点击跳转
├── dialog.ts / anim.ts / tooltip.ts / layout.ts / keybindings.ts / util.ts / format.ts / stdlib.ts / toolchain.ts
├── live-templates/       # Live Templates（M1–M4 + 上下文位置轴）
│   ├── index.ts          #   入口：三层配置加载 + registry + 触发器注册 + 面板 API
│   ├── schema.ts         #   Schema v2 + 校验 + v1 迁移 + positions（位置轴）
│   ├── builtin.ts        #   内置模板库（含爬虫组）+ 默认排序
│   ├── registry.ts       #   三层合并（内置/用户/工作区）+ 生效视图
│   ├── engine.ts         #   表达式引擎（纯函数，可单测）
│   ├── compiler.ts       #   $VAR$ → Monaco snippet 编译（纯函数）
│   ├── scope.ts          #   上下文判定（容器 + 位置 classifyPosition + 缩进兜底 + 字符串/注释）
│   ├── symbols.ts        #   documentSymbol 缓存（stale-while-revalidate）
│   ├── tabExpand.ts      #   缩写 + Tab 直接展开
│   ├── completion.ts     #   补全弹窗路径（sortText 0xx + preselect + `.` 分流后缀）
│   ├── postfix.ts        #   后缀补全：表达式提取 + 补全项构建（M3）
│   ├── surround.ts       #   环绕：Ctrl+Alt+T 选择器 + 选区缩进处理（M3）
│   ├── palette.ts        #   模板面板：Ctrl+J quick pick（M4）
│   ├── pycharmImport.ts  #   PyCharm XML 导入 + 表达式映射翻译（M4）
│   ├── snippet.ts        #   SnippetController2 注入助手（共享）
│   ├── ui/manager.ts     #   管理面板（分组筛选/批量启停/改名，M2 + 爬虫组）
│   └── __tests__/        #   vitest 单测（10 文件）
├── lsp/client.ts         # LSP 桥 TS 侧（JSON-RPC 关联 + Monaco providers + 双引擎诊断分桶）
└── devtools/             # 开发工具
src-tauri/src/
├── lib.rs                # Tauri 入口 + 命令注册
├── lsp.rs                # LSP 桥 Rust 侧（spawn stdio + 帧解析 + 事件转发 + 双引擎 intel/static）
│                          # + run_script 运行脚本（uv run / probe 注入，cwd 锚定文件目录）
├── fs_cmds.rs            # 文件树 / 读写 / 全局搜索（ripgrep）/ 模板配置读写
├── file_ops.rs           # 文件操作（增删改/重命名联动/回收站/reveal/剪贴板）
├── git_cmds.rs           # Git 操作（暂存/提交/diff/分支/远程/stash/log/blame）
├── git_status.rs         # Git 状态装饰（--porcelain，增量 paths）
├── terminal.rs           # 集成终端后端（portable-pty 多会话）
├── tool_paths.rs         # 外部命令定位（uv/pyrefly/ruff/git）
├── toolchain.rs          # 环境探测与一键安装（首次启动引导）
├── env_cmds.rs           # Python 环境面板命令
├── settings.rs           # 设置读写（含键位默认值）
├── util.rs               # data_root / no_window / unpoison 收敛
├── watcher.rs            # 文件监听（工作区 + 数据目录 config/）
└── main.rs               # binary 入口
```

## 关键设计

- **补全三层合并**（sortText 段）：智能模板 `0xx` → 运行时 intel `1xx`（Phase 3 已交付，`⟳ runtime`）→ 静态引擎 `2xx`；
- **LSP 桥引擎无关**（ADR-0003）：pyrefly（`pyrefly lsp`）/ basedpyright（`basedpyright-langserver --stdio`）切换 = 前端命令表条目，工具栏下拉即切；
- **Live Templates**（M1-M4）：三范式齐备——插入（缩写 + Tab / 补全弹窗 / Ctrl+J 面板）、环绕（选中 + Ctrl+Alt+T）、后缀（`表达式.if` 等 + Tab/Enter 转换）；`$VAR$` 变量可挂表达式（fileName/date/user/大小写变换/enum→choice/regularExpression 等），编译为 Monaco snippet 复用占位符跳转；上下文判定 = LSP documentSymbol 缓存（主）+ 缩进启发式（兜底）；三层配置（内置 → `<data_root>/config/templates.json` → `<workspace>/.pylume/templates.json`）+ 管理面板（查看菜单「Live Templates」，编辑/启停/导入导出——导入兼容 JSON 与 PyCharm 导出 XML，保存即生效，外部修改热重载），格式见下；
- **运行**：`uv run <file>`，cwd 锚定文件所在目录（spike 踩坑 #6）；输出流式转发，traceback 帧渲染为可点击链接；
- **工作区记忆**：`<data_root>/config/recent-workspaces.json`；
- **磁盘占用治理**：数据根默认 `%LOCALAPPDATA%\Pylume`（`PYLUME_DATA_ROOT` 可重定向）；设置 → 「存储」页提供占用可视化、可再生内容清理（trace 库 / WebView 缓存 / 轮转日志 / uv 缓存）、首启落位提示与数据根迁移向导（该功能的专项计划已归档）。

## 模板配置示例（Schema v2，<data_root>/config/templates.json）

```json
{
  "version": 2,
  "templates": [
    {
      "id": "my.logf",
      "abbreviation": "logf",
      "description": "带文件名的日志",
      "body": "logger.info(\"$FILE$: $MSG$\")$END$",
      "scopes": ["python:module", "python:class", "python:function"],
      "kind": "normal",
      "enabled": true,
      "tabExpand": true,
      "variables": [
        { "name": "FILE", "expression": "fileName()", "skipIfDefined": true },
        { "name": "MSG", "defaultValue": "TODO" }
      ]
    },
    { "id": "builtin.try", "abbreviation": "try", "scopes": ["python:module"], "enabled": false, "body": "-" }
  ],
  "ordering": {
    "python:module": ["main", "def", "class", "logf", "for", "try", "with"]
  }
}
```

- 键 = `abbreviation + scope`；工作区层 > 用户层 > 内置；`enabled: false` 为墓碑（可禁用内置模板）；
- `body` 用 `$VAR$` 命名变量语法：`$END$` 终点、`$$` 字面美元符；变量在 `variables` 中声明（数组序 = Tab 跳转序），可挂 `expression`（fileName/date/user/camelCase/enum 等，见 `live-templates/engine.ts`）、`defaultValue`、`skipIfDefined`；
- `tabExpand: false`：仅走补全弹窗（关键字类缩写防误触）；
- `ordering`：按 scope 键整段替换补全排序；
- 旧 v1 格式（`templates` 对象 + `priority`）加载时自动迁移。

## 已知限制（Phase 1 后续迭代项）

- ~~didChange 为全量同步~~ → 曾改 range-based 增量，实测 pyrefly `contentChanges` 语义为「替换文档状态」，多次独立增量会错位（补全丢失），**已回退全量**（200ms 防抖 + `didSave`）；
- ~~诊断 markers 仅对已打开 tab 生效~~ → 已加**诊断缓存**，打开文件时应用已发布的诊断；
- ~~集成终端（xterm.js）/ Git 状态 / 全局搜索：Phase 1 后置项~~ → 均已提前交付：`terminal.ts` + `terminal.rs`（xterm.js + portable-pty 多会话）、`git_status.rs`（`git status --porcelain` 装饰）、`search.ts`（ripgrep 引擎）。

## 键位

| 键 | 功能 |
|---|---|
| `Tab` | 缩写直接展开（无弹窗时）/ snippet 占位符前进（展开后）/ 后缀模板转换（补全接受） |
| `Shift+Tab` | snippet 占位符后退 |
| `Esc` | 退出 snippet 会话 |
| `Ctrl+Alt+T` | 环绕模板选择（有选区时；数字键直选） |
| `Ctrl+J` | 模板面板：当前上下文全部模板 quick pick（PyCharm 同键位） |
| `Ctrl+S` | 保存当前文件（推送 didSave） |
| `Ctrl+F10` | 运行当前文件（PyCharm 键位） |
| `F12` / `Ctrl+点击` | 跳转定义（Ctrl+悬停仅显示下划线，不跳转） |
