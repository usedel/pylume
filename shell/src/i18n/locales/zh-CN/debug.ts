// 简体中文语言包「debug 域」（真源）：由 tools/i18n/apply_ts.py 从源码抽取、gen_domain.py 生成，勿手改（改动请回到源码与 data/debug_zh.json）。
// 复数条目（含 {count}）自动展开 .one/.other 两份——中文两形同文。
export const debug = {
  // ---- debug.action ----
  "debug.action.continue": "继续执行",
  "debug.action.stepOut": "单步跳出",
  // ---- debug.breakpoint ----
  "debug.breakpoint.conditionDetail": "{条件} {condition}",
  "debug.breakpoint.delete": "删除断点",
  "debug.breakpoint.deleteAria": "删除断点 {file}:{line}",
  "debug.breakpoint.disabled": "已禁用（勾选即启用）",
  "debug.breakpoint.enableAria": "启用断点 {file}:{line}",
  "debug.breakpoint.enabled": "已启用（取消勾选即禁用）",
  "debug.breakpoint.exceptionHeader": "异常断点",
  "debug.breakpoint.fileLineHint": "文件:行号",
  "debug.breakpoint.hitDetail": "{命中} {condition}",
  "debug.breakpoint.logDetail": "{日志} {message}",
  "debug.breakpoint.none": "无断点",
  "debug.breakpoint.noneHint": "点击编辑器行号左侧的空白处添加",
  "debug.breakpoint.raised": "任何异常抛出时暂停（更吵）",
  "debug.breakpoint.settingFailed": "异常断点设置",
  "debug.breakpoint.uncaught": "未捕获异常时暂停（推荐常开）",
  // ---- debug.common ----
  "debug.common.evaluateFailed": "无法求值",
  // ---- debug.console ----
  "debug.console.availablePlaceholder": "命中断点后可求值",
  "debug.console.evaluate": "求值",
  "debug.console.inputAria": "求值表达式",
  "debug.console.inputPlaceholder": "在断点处求值（Enter 执行，↑↓ 翻历史）",
  "debug.console.notPausedMessage": "求值表达式需要在命中断点暂停时进行。请先启动调试（{shortcut}）并运行到断点处。",
  "debug.console.notStopped": "未命中断点，无法求值（先运行到断点处）",
  "debug.console.outputAria": "调试控制台输出",
  "debug.console.promptLabel": "在断点处的上下文中求值（副作用会真实发生）",
  "debug.console.promptPlaceholder": "例如：len(items)、user.name",
  "debug.console.title": "调试控制台",
  // ---- debug.dap ----
  "debug.dap.requestFailed": "DAP 请求失败: {command}",
  "debug.dap.requestTimeout": "DAP 请求超时（{seconds}s）: {command}",
  "debug.dap.sessionEnded": "调试会话已结束",
  "debug.dap.waitEventTimeout": "等待 debugpy {event} 事件超时",
  "debug.dap.waitInitializedTimeout": "等待 debugpy initialized 事件超时",
  // ---- debug.section ----
  "debug.section.breakpoints": "断点",
  "debug.section.callStack": "调用栈",
  "debug.section.variables": "变量",
  // ---- debug.stack ----
  "debug.stack.noFramesHint": "调试适配器未返回栈帧",
  "debug.stack.noInfo": "无调用栈信息",
  "debug.stack.notDebugging": "未在调试",
  "debug.stack.notDebuggingHint": "按 {shortcut} 启动调试，命中断点后此处显示调用栈",
  "debug.stack.notDebuggingNoShortcut": "启动调试并命中断点后，此处显示调用栈",
  "debug.stack.running": "运行中…",
  "debug.stack.runningHint": "命中断点后此处显示调用栈",
  // ---- debug.status ----
  "debug.status.starting": "调试器启动中…（首次启动需加载 debugpy，请稍候）",
  // ---- debug.toolbar ----
  "debug.toolbar.continue": "继续",
  "debug.toolbar.pause": "暂停",
  "debug.toolbar.stepInto": "单步进入",
  "debug.toolbar.stepOut": "单步退出",
  "debug.toolbar.stepOver": "单步跳过",
  "debug.toolbar.stop": "停止调试",
  // ---- debug.variable ----
  "debug.variable.childrenFailed": "（子变量加载失败，点击折叠后重试）",
  "debug.variable.depthLimit": "（已展开到第 {depth} 层，折叠上级后可继续查看更深层级）",
  "debug.variable.editAria": "修改 {name} 的值（当前：{value}）",
  "debug.variable.editLabel": "新值（Python 表达式，在断点上下文中求值）",
  "debug.variable.editTip": "点击修改此变量的值",
  "debug.variable.editTitle": "修改变量 {name}",
  "debug.variable.empty": "（空）",
  "debug.variable.set": "设置",
  "debug.variable.updateFailed": "修改变量",
  // ---- debug.variables ----
  "debug.variables.noLocals": "无局部变量",
  "debug.variables.noLocalsHint": "此帧尚未创建局部变量",
  "debug.variables.notStopped": "变量仅在命中断点暂停时可见",
  // ---- debug.watch ----
  "debug.watch.delete": "删除监视",
  "debug.watch.deleteAria": "删除监视 {expr}",
  "debug.watch.empty": "调试暂停时自动求值（跨断点保留）",
  "debug.watch.inputAria": "添加监视表达式",
  "debug.watch.inputPlaceholder": "输入表达式后回车添加（暂停时求值）",
  "debug.watch.limit.one": "监视表达式最多 {count} 条，请先删除后再添加",
  "debug.watch.limit.other": "监视表达式最多 {count} 条，请先删除后再添加",
  "debug.watch.title": "监视（Watches）",
};

/** 本域文案 key：en-US/debug.ts 的 Record<DebugKey, string> 由它派生。 */
export type DebugKey = keyof typeof debug;
