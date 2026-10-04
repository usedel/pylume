// 简体中文语言包「welcome 域」（真源）：由 tools/i18n/apply_ts.py 从源码抽取、gen_domain.py 生成，勿手改（改动请回到源码与 data/welcome_zh.json）。
// 复数条目（含 {count}）自动展开 .one/.other 两份——中文两形同文。
export const welcome = {
  // ---- welcome.guide ----
  "welcome.guide.bookmarks": "书签：标记并快速跳回重要位置",
  "welcome.guide.changedToast": "该功能已变更，条目稍后随版本更新",
  "welcome.guide.collapseDismiss": "不感兴趣，收起",
  "welcome.guide.collapseDone": "全部完成，收起",
  "welcome.guide.devtools": "工具箱：JSON 路径 / curl 转换 / 正则速测",
  "welcome.guide.liveTemplates": "Live Templates：代码模板补全",
  "welcome.guide.localHistory": "本地历史：每次保存自动留快照可回滚",
  "welcome.guide.openFailed": "打开新手指南失败：{error}",
  "welcome.guide.progress": "{done}/{total} 已体验",
  "welcome.guide.qsDebug": "启动调试",
  "welcome.guide.qsDebugDesc": "行号旁单击下断点，断下后单步 / 查看变量",
  "welcome.guide.qsNewProject": "新建项目",
  "welcome.guide.qsNewProjectDesc": "选位置、Git 与 Python 版本，uv 环境一键就绪",
  "welcome.guide.qsRunScript": "运行脚本",
  "welcome.guide.qsRunScriptDesc": "打开 .py 文件后点击标题栏 ▶ 或行号旁小箭头",
  "welcome.guide.redo": "重新体验",
  "welcome.guide.runHistory": "运行历史：回看历次运行的完整输出",
  "welcome.guide.todo": "TODO 视图：自动收集项目待办标记",
  "welcome.guide.tryIt": "试一下",
  "welcome.guide.unbound": "未绑定",
  // ---- welcome.shortcuts ----
  "welcome.shortcuts.closeTab": "关闭标签",
  "welcome.shortcuts.deleteLine": "删除行",
  "welcome.shortcuts.findReferences": "查找引用",
  "welcome.shortcuts.formatDocument": "格式化文档",
  "welcome.shortcuts.globalSearch": "全局搜索",
  "welcome.shortcuts.gotoDefinition": "跳转到定义",
  "welcome.shortcuts.gotoFile": "转到文件",
  "welcome.shortcuts.gotoSymbol": "转到文件内符号",
  "welcome.shortcuts.navBack": "导航后退",
  "welcome.shortcuts.newFile": "新建文件",
  "welcome.shortcuts.openSettings": "打开设置",
  "welcome.shortcuts.recentEditLocations": "上一个编辑位置",
  "welcome.shortcuts.recentFiles": "最近打开的文件",
  "welcome.shortcuts.reopenTab": "重新打开关闭的标签",
  "welcome.shortcuts.runProject": "运行项目",
  "welcome.shortcuts.save": "保存文件",
  "welcome.shortcuts.triggerSuggest": "触发补全建议",
};

/** 本域文案 key：en-US/welcome.ts 的 Record<WelcomeKey, string> 由它派生。 */
export type WelcomeKey = keyof typeof welcome;
