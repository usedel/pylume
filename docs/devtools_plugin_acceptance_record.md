# 开发工具插件切片 · 验收记录（PR-1 ~ PR-4）

> 日期：2026-09-20（E2E 验收当日收口）· 依据：插件系统设计 v0.2 §9（工具插件垂直切片，**该文档已归档**）
> 环境：Windows · Rust (cargo check 2.11) · Node 22 (vitest 3.2.7 / Playwright 1.63) · tsc 5.6 严格模式
> 状态：**PR-1~4 全部落地；Playwright 用户旅程验收 7/7 全绿（连跑两轮零 flaky）。**

## 〇、概要

| 维度 | 结果 |
|---|---|
| 设计 | 插件系统设计 v0.2（已归档）：§9 十五个小节 + 14 项决策全部拍板落档 |
| 前端单测 | **490/490 全绿**（51 文件；基线 434 → 净增 56） |
| Rust 单测 | **176/176 全绿**（plugin_cmds 3：扫描过滤 / 空目录 / 路径逃逸）；cargo check 零警告 |
| E2E 验收 | **Playwright 7/7 全绿 ×2 轮**（`e2e/plugins/01-devtools-plugin.spec.ts`，覆盖 §9 全部用户旅程） |
| 类型 | `tsc --noEmit` 零错误 |
| 交付形态 | 内置 9 工具全部插件化（dogfooding）+ 第三方加载链路 + 示例插件 + 作者指南 |

## 一、交付物清单

| 层 | 文件 | 说明 |
|---|---|---|
| 前端·框架 | `devtools/kit.ts`（新增） | ToolKit UI 积木：body/row/toolbar/icon/textarea/input/output(Monaco)/button/copy/paste/clear/errorSlot/flash |
| 前端·框架 | `devtools/panel.ts`（重写） | picker（搜索+fuzzyScore+分组+最近使用）· 实例缓存 LRU≤5 · mount 错误卡片(重试) · 注册表变更联动 |
| 前端·框架 | `devtools/types.ts` / `registry.ts` / `host.ts` | Host 扩展（kit/readClipboard/选区三件套）· unregister/onRegistryChanged · host 工厂 |
| 前端·插件域 | `extensions/manifest.ts`（新增） | 校验器（纯函数）：schemaVersion/id/engines(>=X.Y.Z)/权限白名单/tools；checkEnginesCompatible |
| 前端·插件域 | `extensions/facade.ts`（新增） | 权限门控 PanelHost/InlineHost 工厂 · storage 命名空间 · monaco 显式授予 · PermissionDeniedError |
| 前端·插件域 | `extensions/loader.ts`（新增） | 发现→校验→Blob+cache-bust import→注册 · 扫描令牌防竞态 · 整包失败不半加载 · 热重载去抖 diff · 启停/重载/记录 |
| 前端·插件域 | `extensions/inline.ts` / `pluginsTab.ts`（新增） | inline 管线（撤销 toast）· 设置页插件 tab 渲染 |
| 前端·内置 | `devtools/builtin/`（新增 9 文件） | base64/urlcode/hash/jsonfmt/timestamp/uuid/curl2python/jsonpath + index(manifest) + pure(纯函数库) |
| 前端·接线 | `main.ts` / `settingsPanel.ts` / `index.html` / `style.css` / `keybindingDefaults.ts` | 菜单分类子菜单+插件管理入口 · Ctrl+Shift+T · 命令面板「工具:」条目 · 插件 tab 分类 |
| Rust | `src-tauri/src/plugin_cmds.rs`（新增） | list_plugin_dirs / read_plugin_file(路径收口) / watch_plugins_dir(去抖信号) / reveal |
| 示例 | `examples/devtools-plugin-sample/`（新增） | manifest + rot13(面板+inline) + word-count(面板) + README 安装指引 |
| docs | 插件作者指南（新增）· 本文件 · 插件系统设计 §9 状态标注（已归档） | 作者指南 · 验收归档 · 设计对账 |
| 删除 | `devtools/curl2python/index.ts` · `devtools/jsonpath/index.ts` | UI 壳迁 builtin/（parse/gen/tree 纯函数原位保留，其测试不受影响） |

## 二、关键设计决策的落地核对（设计 → 实现）

| 决策（§10.2） | 落地 |
|---|---|
| #6 v1 同源 import + facade | loader Blob URL import；facade 权限门控；§9.6 铁律偏离声明在档 |
| #7 仅全局目录 | Rust `extensions_dir()` = `<data_root>/extensions`；扫描器唯一根 |
| #8 内置即插件 | `registerBuiltinPlugin`：静态模块+内联 manifest，与第三方同路径注册 |
| #9 Python 桥仅预留 | manifest 无 runtime 字段；schemaVersion 承担兼容 |
| #10 category 半开放 | `PRESET_CATEGORIES` + `categoryOrderKey`（「其他」tier 99 垫底——实现期修出并测试钉死） |
| #11 正则测试放弃 | 未实现；v1.1 备选（含 Python re 语义说明） |
| #12 host 分型 | `PanelHost extends BaseHost` / `InlineHost = BaseHost`（TS 类型级强制） |
| #13 monaco 收窄 | facade 仅显式 `monaco` 权限授予；kit.output 独立注入不受限 |
| #14 单文件 entry + 去抖 diff | manifest 明示禁插件内 import；Rust 只发目录信号，前端 400ms 去抖全量 diff |

## 三、实测发现并修复的缺陷

| # | 缺陷 | 修复 |
|---|---|---|
| 1 | `categoryOrderKey`「其他」与自定义同档字母序 → 排到自定义前 | 「其他」tier 99 恒垫底；`types.test.ts` 钉死 |
| 2 | kit/host 循环引用（host 初始化器内引用未赋值 const） | host 先声明后回填 kit（注释说明构造顺序约束） |
| 3 | PR-1 面板缓存键与 mount root 错配（共享 host.root 致工具互相覆盖 rootEl） | PR-3 `registerPluginTool` 改 `createPanelHost(manifest, dir, host.root, deps)`——每工具独立 root |
| 4 | `unpoison` 误传 Mutex 而非 LockResult；notify-debouncer-mini 0.6 API 差异 | 对照 watcher.rs 既有用法修正 |
| 5 | toast 选项签名不匹配（actionLabel/onAction 而非 label/run） | 按项目 ToastOptions 适配 |
| 6 | **键位漂移锁命中**：PR-1 前端新增 `open_devtools` 未同步 Rust `default_keybindings` | Rust 侧补条目 + 两处计数断言 36→38，176/176 全绿（漂移锁按设计发挥作用） |
| 7 | **热重载失效**：`scanPlugins` 对已注册插件直接重注册，`registerDevTool` 因 id 重复拒绝；旧面板实例不清理 | 重入时先 `unregisterPlugin`；`onRegistryChanged` 全清缓存 + 以新定义重挂；registry 通知去抖合并 |
| 8 | **热重载误伤**：目录任何变化都无条件 revoke+reimport，用户面板输入被清 | 真 diff：manifest JSON + 各 entry 内容 hash（`entryHashes`），无变化跳过；toast 仅状态变化时提示 |
| 9 | **gid 解析错位**：`gid.split(".")[1]` 对多段插件 id（反向域名）错位 → blob URL 泄漏 + `entryHashes` 残留 | 改前缀长度切割 `gid.slice(rec.id.length + 1)`，并补上此前遗漏的 `entryHashes.delete` |
| 10 | **panel.ts 顶层 DOM 解析**：`$("devtools-header")` 等顶层快照违反 CR-26（测试环境 import 即炸） | 全部改 `lazyEl`（Proxy 惰性解析，方法自动绑定） |
| 11 | **blob URL 拼 query 导致 import 必败**：`import(`${url}?v=...`)` 在 Chromium 下 `Failed to fetch` → **第三方插件从未加载成功**（单测不覆盖真实 import 链路） | 去掉 query——`createObjectURL` 每次新 UUID 天然免缓存；注释记录该 Chromium 行为 |
| 12 | **共享 host 的 root 清空**：工具 `host.root.textContent=""` 会清掉其他工具的缓存 rootEl | activateTool 构造 per-tool host 视图（`{ ...host, root: rootEl }`） |
| 13 | **热重载面板不重挂**：两次注册表通知间 `activeToolId` 已被首轮清空 | `lastActiveId` 记忆变量：首轮记忆、次轮凭记忆以新定义重挂 |
| 14 | **坏插件记录缺 error 详情**：`upsertRecord` 新建分支漏赋 `init.error` | 新建分支补 `error: init.error`（status 一并按 error 归位） |
| 15 | **热重载误报「无变化」**：快照只比 id/status/toolIds，同版本重载被误判跳过 | 快照加 `reloadSeq` 重载代数 |
| 16 | **picker Enter 未漫游时无操作**：Enter 只认 `.active` 高亮项，纯键盘「输入即 Enter」no-op | 无高亮时 fallback 第一项 |
| 17 | **内置插件停用后启用不恢复**：`enablePlugin`/`reloadPlugin` 统一走 `scanPlugins()`，内置插件不在磁盘上扫不到 | 按来源分流：builtin 走 `registerBuiltinPlugin`（模块表快留存于 loader 避循环依赖），global 走目录重扫；E2E 新增 08 号用例钉死 |
| 18 | **内置插件停用状态重启后丢失**：`registerBuiltinPlugin` 启动重注册不查停用清单 | 注册入口检查 `loadDisabled()`，命中则记 disabled 态并跳过注册 |
| 19 | **jsonfmt 工具栏按钮截断**：6 按钮在 360px 面板溢出，末位「复制」被 overflow:hidden 裁掉 | `.tool-toolbar` / `.tool-row` 加 `flex-wrap: wrap`（通用骨架全工具受益） |
| 20 | **timestamp / uuid 布局裸奔**：`ts-label`/`uuid-label` 无样式、内联 `style.width` 违反 token 纪律 | 重写布局：`.tool-label` 通用类 + scale token 定宽；复制按钮贴结果行 |
| 21 | **uuid「插入编辑器」无失败反馈**：无打开文件时静默无反应 | 补 `flashError(无打开文件)`（与 curl2python 对齐） |
| 22 | **hash「大写」tooltip 双轨违规**：永不 disabled 却用原生 `title`（UI-09 要求 data-tip + aria-label） | 迁移到 data-tip + aria-label |
| 23 | **互斥选择用切换按钮表达**：base64/urlcode、hash、jsonfmt 的二选一语义用两个 `.active` 按钮，用户难辨「互斥选择」与「独立动作」 | kit 新增 `radioGroup` 积木（WAI-ARIA radiogroup，aria-checked 单一真源 + 方向键移动即选中 + 圆点指示），四处迁移；独立开关保持 aria-pressed。作者指南更新：互斥选择禁用 `.active` 按钮拼法 |
| 24 | **导入落盘失败留半成品**：`copy_dir` 中途失败 → `extensions/<id>/` 残留，下次导入误报「已存在」 | 失败分支 `remove_dir_all` 回滚后再报错 |
| 25 | **导出失败留损坏 zip**：zip 写入中途失败留半成品文件 | 失败分支删除目标文件后再报错；`finish()` 所有权问题经 `export_inner` 拆分解决 |

## 四、测试明细（新增 56 项）

| 文件 | 数量 | 覆盖 |
|---|---|---|
| `devtools/__tests__/types.test.ts` | 5 | 预置序 / 自定义档 / 空归类 / 注册序保持 |
| `devtools/__tests__/kit.test.ts` | 8 | 输入规范兜底 · spacer · btn 体系 · iconButton 双补 · clearButton 混合目标 |
| `extensions/__tests__/manifest.test.ts` | 15 | 合法/非法 JSON · schemaVersion · id 规则 · engines 形式 · 权限白名单/去重 · 空工具拒绝 · 兼容比较 |
| `extensions/__tests__/facade.test.ts` | 8 | 权限拒绝（clipboard/selection/storage/fs:read）· storage 命名空间与清理 · monaco 显式授予 · host 分型 |
| `devtools/builtin/__tests__/pure.test.ts` | 21 | MD5 RFC 1321 六向量 · SHA-256 NIST 三向量 · Base64 UTF-8 往返(含 emoji) · URL 往返(+→空格) · 时间戳格式/非法 · UUID v4 |
| Rust `plugin_cmds::tests` | 3 | manifest 目录过滤 · 空目录正常态 · 路径逃逸阻断 |

## 五、Playwright E2E 验收（`e2e/plugins/01-devtools-plugin.spec.ts`，7/7 ×2 轮）

| # | 用户旅程 | 覆盖设计点 |
|---|---|---|
| 01 | 内置工具菜单分类子菜单（flyout 展开 + 分组正确） | §9.8 / 决策 #8 |
| 02 | picker 分组 + 搜索过滤 + Enter 激活 + **实例缓存（切换工具后输入保留）** | §9.9 / §9.13 |
| 03 | 第三方插件安装流：临时目录 → 首扫 → picker/菜单子菜单/命令面板三入口可达 + 面板 mount 生效 | §9.5 |
| 04 | inline 变换：文件树打开文件 → 选中行 → 命令面板「选区转大写」→ 原地替换 → **撤销按钮恢复** | §9.15 |
| 05 | 坏插件（未知权限）整包失败 + 好插件不受连累 + 设置页红字原因（目录名回落 + 错误详情） | §9.2 错误隔离 |
| 06 | **热重载**：磁盘改 entry → 模拟 watcher 事件 → 去抖 diff → toast → **激活面板以新定义重挂（V2 按钮出现）** | §9.15 |
| 07 | 设置页停用 → picker 入口消失 → 启用 → 恢复 | §9.14 |
| 08 | **内置插件停用 → 启用 → 菜单二级子菜单恢复**（#17 缺陷回归钉） | §9.7 / §9.14 |

E2E 基建扩展：mock 补 `plugin:*` 命令族（`plugin:app|version` / clipboard / ruff_lint / list_shells 兜底）；
helpers 增 `plugins` bridge 通道（list_plugin_dirs / read_plugin_file 真实磁盘映射 + `triggerPluginsChanged()`
模拟 Rust watcher 事件，复刻 `plugins-dir-changed` 链路）。

## 六、遗留与后续

| 项 | 说明 | 优先级 |
|---|---|---|
| ~~编辑器右键「变换选区 ▸」~~ | **已落地（2026-09-30）**：`extensions/inlineMenu.ts`——`MenuRegistry.appendMenuItem(EditorContext, { submenu })` 实现 Monaco 右键子菜单（addAction 不支持子菜单）；子项随插件注册表 `onRegistryChanged` 自动重建；`editorHasSelection` context key 门控（无选区隐藏）。E2E 用例 12/13 钉死（Shift+F10 唤出 → 子菜单 → 原地替换 → 撤销；无选区不显示）。**连带修复产品级缺陷**：Double Shift 重置监听改 capture 阶段（焦点在 Monaco 内时 keydown 被 stopPropagation，`Shift+End` 后紧接 `Shift+F10` 会误触发 Search Everywhere）。**同批落地 §9.9 上下文感知变体（v1.1）**：`Ctrl+Shift+T` 有选区时 picker 进 inline 模式（`DevTool.inlineLabel` 注册表投影 + 过滤 + 选中直执行 + 搜索回退全量）；E2E 用例 14/15 钉死 | ✅ |
| v1.1 工具备选 | **首批 9 工具已落地（2026-09-30）**：进制转换（BigInt）/ HTML 实体 / Unicode⇄明文（代理对合并）/ 大小写与命名风格 / 字数统计 / 行排序去重（crypto 洗牌）/ 颜色转换（含 ANSI 256）/ 密码生成 / 文本 Diff（LCS）。纯函数库 `builtin/textfns.ts`（69 项单测：标准向量 + 往返 + 随机分布性质）；4 个新增 inline 入口（数字转十六进制 / HTML 实体编码 / Unicode 还原 / 英文转大写）。正则测试已由库支持 PR-2 以真实 re 引擎交付 | 剩余备选：Lorem ipsum 等按需 |
| v2 议题 | iframe/Worker 沙箱 + 跨 realm facade · 工作区级插件目录 · Python 工具桥（Pyodide/OEP）· `.ocx` 安装包 | P3 |
