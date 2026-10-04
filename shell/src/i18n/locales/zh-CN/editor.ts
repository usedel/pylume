// 简体中文语言包「editor 域」（真源）：由 tools/i18n/apply_ts.py 从源码抽取、gen_domain.py 生成，勿手改（改动请回到源码与 data/editor_zh.json）。
// 复数条目（含 {count}）自动展开 .one/.other 两份——中文两形同文。
export const editor = {
  // ---- editor.crumb ----
  "editor.crumb.file": "文件 {text}",
  "editor.crumb.jump": "跳转到 {text}（第 {line} 行）",
  // ---- editor.md ----
  "editor.md.close": "关闭 Markdown 预览",
  "editor.md.exportTitle": "导出 Markdown 为 HTML",
  "editor.md.hintWithKey": "按 {key} 或点击右上角图标打开 Markdown 预览",
  "editor.md.open": "打开 Markdown 预览",
  "editor.md.openWithKey": "打开 Markdown 预览（{key}）",
  // ---- editor.nav ----
  "editor.nav.newest": "已在最新的导航位置",
  "editor.nav.oldest": "没有更早的导航位置",
  // ---- editor.rename ----
  "editor.rename.counting": "计算引用中…",
  "editor.rename.crossSummary": "将修改 {files} 个文件共 {total} 处：",
  "editor.rename.crossTitle": "跨文件重命名「{from}」→「{to}」",
  "editor.rename.done": "已重命名「{from}」→「{to}」：{files} 个文件 {total} 处",
  "editor.rename.failAction": "重命名",
  "editor.rename.fileLine.one": "· {path} × {count} 处",
  "editor.rename.fileLine.other": "· {path} × {count} 处",
  "editor.rename.inputAria": "输入新名称，Enter 确认，Esc 取消",
  "editor.rename.invalidName": "名称需为合法 Python 标识符（字母 / 下划线开头）",
  "editor.rename.keysHint": "Enter 确认 · Esc 取消",
  "editor.rename.localAndCross": "本文件 {local} 处 · 其他 {cross} 个文件",
  "editor.rename.localOnly": "将更新本文件 {local} 处",
  "editor.rename.moreFiles.one": "· …以及其他 {count} 个文件",
  "editor.rename.moreFiles.other": "· …以及其他 {count} 个文件",
  "editor.rename.noChanges": "引擎未返回任何改动",
  "editor.rename.noSymbol": "请先定位到要重命名的符号上",
  "editor.rename.notRenamable": "光标处不是可重命名的符号",
  "editor.rename.okAll": "全部修改",
  "editor.rename.paletteLabel": "重命名…",
  "editor.rename.pydanticToast": "pyrefly 暂不传播 Pydantic 字段的构造调用处引用，重命名可能只改声明处",
  "editor.rename.unstableNote": "⚠ 工作区索引未稳定，结果可能不完整。",
  "editor.rename.unstableSuffix": "{base} · 索引未稳定，结果可能不完整",
  "editor.rename.unstableToast": "工作区索引未稳定，重命名可能漏改未打开的文件——建议稍后用 Alt+F7 复查引用",
  // ---- editor.todo ----
  "editor.todo.noWorkspace": "未打开工作区",
  "editor.todo.noWorkspaceHint": "打开后此处列出 TODO / FIXME",
  "editor.todo.none": "没有待办标记",
  "editor.todo.noneHint": "代码里暂无 TODO / FIXME / HACK / BUG / XXX",
  "editor.todo.rescan": "重新扫描",
  "editor.todo.scanFailed": "扫描失败：{error}",
  "editor.todo.scanFailedShort": "扫描失败",
  "editor.todo.scanning": "扫描中…",
  "editor.todo.scanningHint": "正在遍历工作区文件",
  "editor.todo.summary.one": "{count} 项 · {tags}",
  "editor.todo.summary.other": "{count} 项 · {tags}",
  "editor.todo.zeroItems": "0 项",
  // ---- editor.vision ----
  "editor.vision.more.one": "…其余 {count} 处在「引用」面板查看",
  "editor.vision.more.other": "…其余 {count} 处在「引用」面板查看",
  "editor.vision.namedRefs.one": "{name} · {count} 处引用",
  "editor.vision.namedRefs.other": "{name} · {count} 处引用",
  "editor.vision.noRefs": "该符号暂无引用",
  "editor.vision.refs.one": "{count} 处引用",
  "editor.vision.refs.other": "{count} 处引用",
  "editor.vision.viewAll": "在下方面板查看全部",
  "editor.vision.zeroTitle": "无引用",
};

/** 本域文案 key：en-US/editor.ts 的 Record<EditorKey, string> 由它派生。 */
export type EditorKey = keyof typeof editor;
