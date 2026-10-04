# 技术债登记

> 记录已识别但暂缓处理的技术债。每条含：起因、根因、建议方案、处理时机、涉及文件。
> 处理完成后请移除对应条目或移入「已归档」。

## 待处理

> 2026-08-28 全项目代码检查新增。按严重度排序，处理时机均为「可作为独立 PR，任一项前先跑对应测试矩阵」。

> 2026-09-09「运行体验对齐 PyCharm」（P0–P3 + stdin S1–S4）交付时新增。均为**可接受的小债**，非缺陷。
> 第 8 条（S3+S4 公共前置）已随 S3/S4 交付偿还，移入「已归档」；第 5 条已于 2026-09-10 随 CR-19 偿还并归档（此前在待处理区重复登记，2026-09-13 复核移除）。下方编号保持原样（TD-9~TD-12）。

> 2026-09-13 PyCharm 调研报告落地复核（PyCharm 调研报告，已归档）发现。均为「已宣称交付、实际未达对标效果」的缺口，经裁决**暂缓处理**。

> 2026-09-15 运行功能迁移收尾 + UI 细节改进（运行迁移计划，已归档）引出。均为「一致性 / 体验」债，非缺陷，全局落地时作为独立 PR。

> 2026-10-03 UI 视觉「高级感」改造（UI 视觉「高级感」改造六批 + 修记 A，专项计划已归档）交付后复核新增 **TD-022 / TD-023 / TD-024**。均为**自觉取舍或非缺陷的观感项**，交付时已在开发计划 §8.1.2 声明，本次复核补登记（此前只写在计划里，未进本文件）。

### TD-024 alpha 边框不满足 WCAG 1.4.11 非文本对比 3:1（P4，合规取舍；2026-10-03 UI 高级感批 5b 登记）

- **起因**：批 5b 把边框换成三档 alpha 叠色（`--border-hairline` / `--border-subtle` / `--border-strong`），实测对比 1.32~1.36:1，**低于** WCAG 1.4.11 要求的 3:1。
- **根因**：这是**存量事实**（旧值 1.29~1.51 同样不达标），不是本批引入的回归；且 alpha 边框在原理上不可能达到 3:1——要达标就得把边框做成接近实色，那正是「精致」要去掉的东西。聚焦态的识别由 `border-color: var(--accent)`（青绿 4.98:1）承担，语义准确。
- **建议方案**：维持现状并在原 UI 视觉计划 §7.7.4 保留登记（该文档已归档）；若将来要对外做无障碍合规声明，需单独评估（可能要为「高对比」另出一套实色边框主题）。
- **处理时机**：有合规诉求时；否则长期挂账。
- **涉及文件**：`shell/src/style.css`（`--border-*` 三档）、`tools/ui/audit_tokens.py`（阶梯轴/对比度判定）。

### ~~TD-023 `runWidget` 忙碌态切图标类导致按钮宽度变化~~ —— ✅ **已关闭（2026-10-04 实测：前提不成立）**

- **起因**：批 5c 统一圆角档位时**推断**——运行控件的忙碌态通过切换 codicon 图标类实现（▶ `codicon-run` → ⟳ `codicon-loading`），推断「两个字形宽度不同」会让按钮横向抖动。
- **实测结论（2026-10-04，浏览器探针）**：**前提不成立**。在 `.menubar-icon` 上下文里逐个量 14 个 codicon 字形（`run` / `run-all` / `loading` / `sync` / `refresh` / `debug-stop` / `tools` / `gear` / `debug` / `play` / `circle-filled` / `triangle-right` / `dashboard` / `check`），`#btn-run-script` 的 `getBoundingClientRect().width` **恒为 28px**；图标元素本身在 16px 字号下也**恒为 16px**。即 **@vscode/codicons 0.0.46-24 的字形推进宽度是统一的 1em**，换字形不改变布局。
- **过程中曾按旧推断落过一版修复**（`.menubar-icon .codicon { width: 1em }` + 单测 + e2e 宽度断言），**已全部回退**：那两条门禁在「有/无修复」下都通过（假绿），留着只会让人误以为已被覆盖——与原 UI 视觉计划 §7.7.1（批 5b 推翻"重点提升"前提）是同一类教训：**先验证前提再动手**。
- **不做的事**：不为已统一推进宽度的字体加定宽槽位（纯噪声）；若将来换图标集 / 自定义字形（非 1em 推进），再按本节方法重测一次即可。
- **涉及文件**：无（无代码改动）；证据与结论登记在原 UI 视觉计划 §6.5 与 §8.1.2（已归档）。

### TD-022 Monaco 浮层圆角无法跟随外壳 `--radius-*`（P4，一致性；2026-10-03 UI 高级感批 5c 登记）

- **起因**：批 5c 把外壳圆角档位统一到 3/6/8/10/16px（`--radius-xs..xl`），但 Monaco 的**内置浮层**（补全框 / hover / 参数提示 / 右键菜单）由它自己的样式表绘制，**没有主题槽位**可以注入圆角，因此仍是出厂值（10px 左右，且不随外壳档位变化）。
- **根因**：Monaco 主题系统只暴露颜色槽位，几何属性（圆角 / 边框宽度）不在 `defineTheme` 的能力范围内；要改只能写 CSS 覆盖 `.monaco-editor .monaco-hover` 等内部选择器（属侵入第三方 DOM，与「不侵入内核」原则冲突）。
- **建议方案**：若一定要统一，按元素逐个写覆盖 CSS 并锁死 Monaco 版本（升级需回归）；当前裁决**不做**，接受这一处不一致——浮层与外壳圆角差 2~4px 在日常使用中不可辨。
- **处理时机**：有明确视觉投诉再说；升级 Monaco 时需重新评估。
- **涉及文件**：`shell/src/style.css`、`shell/src/monaco.ts`、原 UI 视觉计划 §7.8.4（已归档）。

### TD-021 推送前复核遗留的低优先项（P4，5 小项；2026-09-25 全量复核引出）

- **起因**：P0~P4 六个未推送提交推送前全量复核（子代理深审 + 人工求证）。两个中等问题（终端背压队列无上限、stop/exit 提示时序）与三个低级项（session 静默失败、异常断点失败不回滚、Watches 满额静默/无令牌、resourcePanel 死代码）已随当次修复提交偿还；以下 5 小项经裁决**暂缓**。
- **① terminal.ts 背压「字节预算」实为 UTF-16 字符数**：`pendingBytes += data.length`，CJK 输出下真实 UTF-8 字节约为 3 倍，256KB/4MB 阈值在中文场景放宽 ~3 倍。无功能错误，仅削峰粒度。修法：`Buffer.byteLength(data, "utf8")` 口径（需逐块缓存字节长度或改存 Uint8Array）。
- **② session.ts `restoring` 是布尔非令牌**：恢复 A 进行中切到工作区 B，A 的 `finally restoring=false` 会提前解锁，B 半恢复状态可能被防抖快照写回。场景罕见。修法：改为计数器/令牌。
- **③ sessions.rs 快照超 40 tab 保头弃尾**：`truncate(MAX_TABS)` 丢的是最近打开的 tab，与「恢复最近现场」直觉相反。修法：保尾（`tabs.slice(-MAX_TABS)`）并同步活动 tab 判定。
- **④ proc_stats 只统计直接子进程**：运行链存在中间层（cmd /c、shell 包装）时孙进程内存不计入合计，芯片口径偏小。修法：递归遍历进程树（注意 sysinfo 环处理）。
- **⑤ debugWatches.ts 顶层 `load()` 读 localStorage**：顶层副作用（有 try/catch 兜底）。修法：改惰性初始化。
- **处理时机**：各自独立成 PR，任一项先跑对应测试矩阵（terminal → perf/01；session → session/01；debug → debug specs + 真机）。
- **涉及文件**：`shell/src/terminal.ts`、`shell/src/session.ts`、`shell/src-tauri/src/sessions.rs`、`shell/src-tauri/src/proc_stats.rs`、`shell/src/debugWatches.ts`。

## 已归档

> 处理完成的历史条目，**每条压缩到一行结论**（保留落点与根因，删去实施过程与测试数据）；
> 编号对应原 TD 编号。完整实施细节见对应 commit 历史。
> 2026-09-10：代码审查整改计划（`code_review_remediation_plan.md`，CR-01~CR-30 共 30 项）已全部完成并删除，其中与本表重叠的条目见上；其遗留的可选优化项（第 13/14 条）已于 2026-09-13 全部偿还并归档。

| 编号 | 标题 | 完成日期 | 结论摘要 |
|---|---|---|---|
| TD-020 | 探针摘要重复打印/落库（P3） | 2026-09-28 | 根因：`argv[0]` 守卫拦不住 argv 相同的父子进程（uvicorn `--reload`），多进程各自触发 `atexit._finalize`。修复：`run_env.rs::build_run_env` 注入唯一 `PYLUME_PROBE_RUN_ID`，探针侧用 `O_CREAT\|O_EXCL` 墓碑文件去重 |
| 12 | pyproject 包名归一化（P4） | 2026-09-15 | `fs_cmds.rs` 新增 `normalize_project_name`（行扫描改写 `[project].name`，不引入 TOML 依赖）+ `is_name_field` 防误配；`ensure_pyproject` 后调用 |
| 17 | 输入框未统一 autocomplete（P4） | 2026-09-15 | `index.html` 10 处 + `settingsPanel` / `git` / `fileTree` / `manager` 的动态输入补 `autocomplete="off"` |
| 18 | 模态点遮罩关闭不一致（P4） | 2026-09-15 | 含可编辑内容的模态统一「点遮罩不关闭 + Esc 关闭」（`dialog.ts::openPrompt` / `settingsPanel` / `newProject` 三处）；选择/确认框保留点遮罩 = 取消 |
| 19 | 操作反馈散用输出面板（P4） | 2026-09-15 | 10 处 `console.*` 静默失败改 `toastFail`；输出面板保留作命令级审计 |
| 6 | 前端鲁棒性与设置单点（P3） | 2026-09-15 | ① `client.ts` URI 编解码加跨平台兜底；② 新增 `keybindingDefaults.ts` 单一来源，`keybindings.ts` 与 `DEFAULT_SETTINGS` 改为派生 |
| 9 | 运行配置孤儿条目（P3） | 2026-09-15 | 新增 `sweep_run_configs` 命令；`set_run_config` 保存时与 `openWorkspace` 开工作区时各清扫一次 |
| 11 | interpreter_version 未缓存（P3） | 2026-09-15 | `env_cmds.rs` 加 `VERSION_CACHE`（`LazyLock<Mutex<HashMap>>`，路径为键），空串不缓存、换解释器自然失效 |
| 16 | Docstring 自动生成缺口（P3） | 2026-09-15 | 新增 `docstring.ts`：`registerDocstringTrigger` 监听 `"""`+Enter + `enclosingSignature` + `buildDocstring`（Args/Returns 或 Attributes） |
| 4 | 跨包项目哈希大小写不一致（P2） | 2026-09-15 | 两端归一：`store.py::project_hash` 加 `os.path.normcase`、`file_ops.rs::project_hash` Windows 下 `to_lowercase()`（剥 verbatim 前缀之后） |
| 7 | CI 自动化缺失（P1） | 2026-09-15 | 新增 `ci.yml`（test job 4 矩阵 + package-smoke 打包与红线）；`collect-metrics.ps1` 末尾纳入非零退出断言 |
| 15 | 位置轴块头冒号误判续行（P2） | 2026-09-15 | `scope.ts` 从 `CONT_SUFFIX_RE` 移除 `:`，新增 `isBlockHeaderColon` 区分块头与续行冒号 |
| 10 | stdin 重定向存绝对路径（P3） | 2026-09-15 | 随 v3.4 运行迁移删除 stdin 配置体系，该债连同功能一并消除 |
| 1 | intel 全量线性扫描（P2） | 2026-09-10 | 索引层预建 `by_last_segment` / `by_second_last_segment` / `by_type_label` 倒排，7 处消费端改索引查询 + shape 解析缓存 |
| 2 | intel 锁 poison 与 async 持锁（P2） | 2026-09-10 | 改 `parking_lot::RwLock`（无中毒）+ `Arc` 快照锁外重计算 + 补全/hover/definition/inlay/诊断全部 `spawn_blocking` |
| 5 | probe 打包/注入健壮性（P2） | 2026-09-10 | hatch `force-include` 打包 `sitecustomize.py`；`mon.start()` 纳入 try/finally 恢复现场；argv[0] 守卫 `normcase` 归一 |
| 3 | intel did_change 依赖全量同步契约（P2） | 2026-09-09 | `ServerCapabilities` 显式声明 `TextDocumentSyncKind::FULL` |
| 14 | main.ts 运行态收敛与按域拆分（P3） | 2026-09-13 | ① 运行态 6 变量 + runningProfile 收敛为 `runState.ts` 的 `RunState` 判别联合；② 拆出 `runFlow` / `envPanel` / `runConfigPanel` / `menuBar` / `newProject` / `tracebackLink`，main.ts ~3169 → 1620 行 |
| 13 | 前端剩余循环 import 边（P3） | 2026-09-13 | `fileTree` / `settingsPanel` 改经 `setFileTreeHandlers` / `setSettingsPanelHandlers` 注入，`shell/src` 下已无 `from "./main"` 反向 import |
| 8 | 终端与运行按钮环境注入不一致（S3+S4 前置） | 2026-09-09 | 抽 `run_env.rs` 作单一装配来源（`build_run_env` / `assemble` / `resolve_run_command`），两条运行路径 env 逐项同源 |
| TD-009 | 全项目代码检查与修复（P0/P1 共 11 项） | 2026-08-28 | probe / intel / shell 修复全绿；Cargo.lock 纳入版本锁定 |
| TD-008 | 确认弹窗统一为自绘风格 | 2026-08-28 | 新增 `dialog.ts`，替换 8 处 confirm + 1 处 alert |
| TD-007 | main.ts 功能域级拆分（文件树/Git/终端/设置） | 2026-08-25 | 抽 `state.ts` + 4 个域模块，main.ts ~3119 → ~1196 行 |
| TD-006 | 上帝文件 main.ts 拆分（第一步） | 2026-08-25 | 抽 10 个纯函数到 `util.ts` + 补 7 个单测 |
| TD-005 | panic unwrap 与进程收尾收敛 | 2026-08-25 | 新增 `unpoison` + kill 后 `wait` 收尾 |
| TD-004 | intel 能力声明与索引加载修正 | 2026-08-25 | 删除未实现的 references 声明 + 索引 `spawn_blocking` 加载 + tokio 精简 |
| TD-003 | Rust 侧重复实现收敛 | 2026-08-25 | 抽 `util.rs` 统一 `pylume_home` / `no_window`，四处改 import 复用 |
| TD-002 | Git 集成增强（行内 diff / 远程 / 刷新性能） | 2026-08-25 | 新增 9 个命令 + diff 视图 + 增量刷新 |
