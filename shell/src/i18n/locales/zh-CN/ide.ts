// 简体中文语言包「ide 域」（真源）：由 tools/i18n/apply_ts.py 从源码抽取、gen_domain.py 生成，勿手改（改动请回到源码与 data/ide_zh.json）。
// 复数条目（含 {count}）自动展开 .one/.other 两份——中文两形同文。
export const ide = {
  // ---- ide.bg ----
  "ide.bg.failLoad": "读取断点",
  "ide.bg.failSave": "保存断点",
  "ide.bg.tipBreakpoint": "断点",
  "ide.bg.tipCondition": "条件：{condition}",
  "ide.bg.tipHit": "命中次数：{hit}",
  "ide.bg.tipLog": "日志（不断下）：{message}",
  // ---- ide.cd ----
  "ide.cd.actionLabel": "与剪贴板对比",
  "ide.cd.clipboardEmpty": "剪贴板为空或不可读",
  "ide.cd.currentFile": "当前文件",
  "ide.cd.readFailed": "读取文件失败：{error}",
  "ide.cd.selection": "选区",
  "ide.cd.title": "{label} ↔ 剪贴板",
  // ---- ide ----
  "ide.completionKeyword": "关键字",
  "ide.debugValue": "调试值",
  // ---- ide.dsl ----
  "ide.dsl.hint": "提示：右键 → 「在正则测试器中打开」，或按 Ctrl+Alt+R 测试正则",
  "ide.dsl.needPyFormat": "格式串工具需要打开一个 Python 文件",
  "ide.dsl.needPyRegex": "正则测试器需要打开一个 Python 文件",
  "ide.dsl.noFormat": "当前文件未识别到格式串字面量",
  "ide.dsl.noRegex": "当前文件未识别到 re 正则字面量",
  // ---- ide.engine ----
  "ide.engine.indexing": "{name} · 索引中…",
  "ide.engine.indexingTitle": "静态引擎正在后台索引/查询，期间引用与重命名结果可能不完整",
  // ---- ide.fu ----
  "ide.fu.actionLabel": "查找引用",
  "ide.fu.chipAll": "全部",
  "ide.fu.emptyTitle": "无引用",
  "ide.fu.engineNotReady": "静态引擎未就绪（可能正在启动），结果可能不完整——稍后重试",
  "ide.fu.failed": "查找引用失败：{error}",
  "ide.fu.indexIncomplete": "工作区索引可能尚未完成，结果可能不完整——可稍后重新查询",
  "ide.fu.kindCall": "调用",
  "ide.fu.kindDefinition": "定义",
  "ide.fu.kindImport": "导入",
  "ide.fu.kindReference": "引用",
  "ide.fu.noRefs": "光标处符号未找到任何引用",
  "ide.fu.noSymbol": "请先定位到要查找引用的符号上",
  "ide.fu.renameBtn": "重命名",
  "ide.fu.renameTip": "重命名此符号及其所有引用（Shift+F6）",
  "ide.fu.unstableRetry": "索引未稳定，结果可能不完整——稍后重新查询",
  // ---- ide.fw ----
  "ide.fw.hint": "检测到 {framework} 项目（{file}）。{miss}可一键生成运行配置：",
  "ide.fw.missing": "尚未安装 {names}（可 uv add {first}）。",
  // ---- ide ----
  "ide.importAliasDetail": "import 别名",
  "ide.installPkg": "安装 \"{pkg}\" 包",
  "ide.installPkgShort": "安装 {pkg}",
  // ---- ide.json ----
  "ide.json.formatTitle": "格式化 JSON 字面量",
  "ide.json.minifyTitle": "压缩 JSON 字面量",
  "ide.json.needPy": "JSON 工具需要打开一个 Python 文件",
  "ide.json.notInLiteral": "光标不在 json.loads 字面量内",
  "ide.json.openJsonpath": "在 JSONPath 提取器中打开",
  "ide.json.parseFailed": "JSON 解析失败：{error}",
  // ---- ide.kb ----
  "ide.kb.columnSelectOff": "列选择模式已关闭",
  "ide.kb.columnSelectOn": "列选择模式已开启：鼠标拖拽将按矩形选择（再按退出）",
  "ide.kb.conflict": "快捷键「{label}」与「{dup}」冲突（{norm}）",
  "ide.kb.invalidFormat": "快捷键「{label}」格式无效：{raw}",
  // ---- ide.lens ----
  "ide.lens.argsCount.one": "⚙ {count} 个参数",
  "ide.lens.argsCount.other": "⚙ {count} 个参数",
  "ide.lens.openFormat": "在格式串工具中打开",
  "ide.lens.openRegex": "在正则测试器中打开",
  "ide.lens.testBoth": "🧪 测试（正则/格式串）",
  "ide.lens.testFormat": "🧪 测试格式串",
  "ide.lens.testRegex": "🧪 测试正则",
  // ---- ide.lsp ----
  "ide.lsp.intelClosed": "运行时智能已关闭",
  "ide.lsp.notReady": "LSP 引擎未就绪",
  "ide.lsp.processExited": "LSP 进程退出（code={code}）",
  "ide.lsp.requestTimeout": "LSP 请求超时（{sec}s）：{method}",
  "ide.lsp.stopped": "LSP 已停止",
  // ---- ide ----
  "ide.menuLoadFailed": "（加载失败）",
  // ---- ide.mv ----
  "ide.mv.error": "错误",
  "ide.mv.none": "没有可跳转的诊断（error / warning）",
  "ide.mv.otherErrors.one": "{count} 处类型/引用错误",
  "ide.mv.otherErrors.other": "{count} 处类型/引用错误",
  "ide.mv.progress": "{idx}/{total}{wrapped} {kind}：{brief}",
  "ide.mv.savedStatus": "{file}：{parts}（已保存）",
  "ide.mv.syntaxErrors.one": "{count} 处语法错误",
  "ide.mv.syntaxErrors.other": "{count} 处语法错误",
  "ide.mv.warning": "警告",
  "ide.mv.wrapped": "（已回绕）",
  // ---- ide.res ----
  "ide.res.summary.one": "合计 {mb} MB · 子进程 {count} 个",
  "ide.res.summary.other": "合计 {mb} MB · 子进程 {count} 个",
  // ---- ide.ruff ----
  "ide.ruff.actionLabel": "忽略此规则（行尾添加 # noqa）",
  "ide.ruff.added": "已添加 # noqa: {code}",
  "ide.ruff.alreadyIgnored": "该行已忽略 {code}",
  "ide.ruff.noCode": "该诊断没有规则码，无法用 # noqa 忽略",
  "ide.ruff.noDiagnostic": "光标处没有 ruff 诊断",
  // ---- ide.term ----
  "ide.term.closeRunTip": "关闭运行终端（先停止）",
  "ide.term.closeTip": "关闭终端",
  "ide.term.label": "终端 {n}",
  "ide.term.newTip": "新建终端",
  "ide.term.none": "尚无终端",
  "ide.term.noneHint": "点击上方「＋」新建，或在文件树中右键「在终端中打开」",
  "ide.term.project": "项目",
  "ide.term.projectN": "项目 {n}",
  "ide.term.runLabel": "运行 · {name}",
  "ide.term.shellAuto": "自动（PowerShell 优先，回退 cmd）",
  "ide.term.shellCmd": "命令提示符（cmd）",
  "ide.term.stopTip": "停止 {label}",
  // ---- ide.traceback ----
  "ide.traceback.openAction": "打开 traceback 文件",
  "ide.traceback.openFailed": "无法打开: {path}",
};

/** 本域文案 key：en-US/ide.ts 的 Record<IdeKey, string> 由它派生。 */
export type IdeKey = keyof typeof ide;
